const AdmZip = require("adm-zip");
const {
  scanCrashRisk,
  collectServerEntrypoints,
  assessCrashRisk,
  openZip
} = require("../utility/crash_risk.js");

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
