const AdmZip = require("adm-zip");
const {
  scanCrashRisk,
  collectServerEntrypoints,
  collectForgeModRoots,
  assessCrashRisk,
  buildPrefixOracle,
  openZip
} = require("../utility/crash_risk.js");
const { makeClassFile } = require("./fixtures/classfile.js");

function makeJar(files) {
  const zip = new AdmZip();
  for (const [ name, data ] of Object.entries(files)) {
    zip.addFile(name, Buffer.isBuffer(data) ? data : Buffer.from(data));
  }
  return zip.toBuffer();
}

describe("collectServerEntrypoints", () => {
  test("reads fabric main/server entrypoints", () => {
    const buf = makeJar({
      "fabric.mod.json": JSON.stringify({
        id: "x",
        entrypoints: {
          main: [ "com.example.Main" ],
          server: [ "com.example.Server" ],
          client: [ "com.example.Client" ]
        }
      })
    });
    expect(collectServerEntrypoints(openZip(buf)).sort()).toEqual([
      "com/example/Main",
      "com/example/Server"
    ]);
  });

  test("reads nested JiJ fabric.mod.json entrypoints", () => {
    const nested = makeJar({
      "fabric.mod.json": JSON.stringify({
        id: "lib",
        entrypoints: { server: [ "lib.LibServer" ] }
      })
    });
    const buf = makeJar({
      "fabric.mod.json": JSON.stringify({ id: "host", entrypoints: { main: [ "host.Host" ] } }),
      "META-INF/jars/lib.jar": nested
    });
    const eps = collectServerEntrypoints(openZip(buf));
    expect(eps).toContain("host/Host");
    expect(eps).toContain("lib/LibServer");
  });
});

describe("scanCrashRisk / assessCrashRisk", () => {
  const oracle = {
    has: name => name === "net/minecraft/client/Minecraft" || name === "net/minecraft/class_310",
    isClientApiPackage: name => typeof name === "string" && name.startsWith("net/minecraft/client/")
  };

  test("returns no risk when there is no server/main entrypoint", () => {
    const buf = makeJar({
      "fabric.mod.json": JSON.stringify({ id: "x", entrypoints: { client: [ "a.Client" ] } })
    });
    expect(scanCrashRisk(buf, oracle)).toMatchObject({ risk: false, reason: "no-server-entrypoint" });
  });

  test("assessCrashRisk is a no-op without an oracle", () => {
    expect(assessCrashRisk(Buffer.from("x"), null)).toEqual({
      risk: false, detail: null, reason: "no-oracle"
    });
  });

  test("does not flag a server entrypoint with no client-only refs", () => {
    // Entrypoint class missing from the JAR — graph stops; no client hit.
    const buf = makeJar({
      "fabric.mod.json": JSON.stringify({
        id: "x",
        entrypoints: { server: [ "com.example.Safe" ] }
      })
    });
    expect(scanCrashRisk(buf, oracle).risk).toBe(false);
  });
});

describe("Forge @Mod construction roots", () => {
  const oracle = buildPrefixOracle();

  test("collectForgeModRoots finds @Mod-annotated classes", () => {
    const buf = makeJar({
      "com/example/MyMod.class": makeClassFile({ className: "com/example/MyMod", modMarker: true }),
      "com/example/Helper.class": makeClassFile({ className: "com/example/Helper" })
    });
    expect(collectForgeModRoots(openZip(buf))).toEqual([ "com/example/MyMod" ]);
  });

  test("flags a @Mod class whose <clinit> eagerly constructs a client class (Blur pattern)", () => {
    const buf = makeJar({
      "mcmod.info": "[{ \"modid\": \"x\" }]",
      "com/example/ClientMod.class": makeClassFile({
        className: "com/example/ClientMod",
        modMarker: true,
        initNewClass: "net/minecraft/client/Minecraft"
      })
    });
    const result = scanCrashRisk(buf, oracle);
    expect(result.risk).toBe(true);
    expect(result.reason).toBe("init-reaches-client-only");
    expect(result.detail).toContain("net/minecraft/client/Minecraft");
  });

  test("does not flag a @Mod class with a clean construction path (Pam's pattern)", () => {
    const buf = makeJar({
      "mcmod.info": "[{ \"modid\": \"x\" }]",
      "com/example/ContentMod.class": makeClassFile({
        className: "com/example/ContentMod",
        modMarker: true,
        initNewClass: "com/example/Recipes"
      }),
      "com/example/Recipes.class": makeClassFile({ className: "com/example/Recipes" })
    });
    expect(scanCrashRisk(buf, oracle).risk).toBe(false);
  });

  test("fabric entrypoints take precedence over Forge roots in universal JARs", () => {
    const buf = makeJar({
      "fabric.mod.json": JSON.stringify({ id: "x", entrypoints: { main: [ "com.example.Main" ] } }),
      "com/example/ForgeOnlyClient.class": makeClassFile({
        className: "com/example/ForgeOnlyClient",
        modMarker: true,
        initNewClass: "net/minecraft/client/Minecraft"
      })
    });
    // Roots = fabric main only; the forge-only class is never visited.
    expect(scanCrashRisk(buf, oracle).risk).toBe(false);
  });
});

describe("buildPrefixOracle (legacy fallback)", () => {
  const oracle = buildPrefixOracle();

  test("matches client API package prefixes but no mapped names", () => {
    expect(oracle.isClientApiPackage("net/minecraft/client/Minecraft")).toBe(true);
    expect(oracle.isClientApiPackage("com/mojang/blaze3d/Blaze3D")).toBe(true);
    expect(oracle.isClientApiPackage("net/minecraft/server/MinecraftServer")).toBe(false);
    expect(oracle.has("net/minecraft/class_310")).toBe(false);
  });
});
