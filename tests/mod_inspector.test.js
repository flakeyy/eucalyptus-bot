const AdmZip = require("adm-zip");
const { inspectModJar, isClientOnlyMod, extractModDeps } = require("../utility/mod_inspector.js");

// Build an in-memory JAR with the given entries: { path: stringContent }.
function makeJar(entries) {
  const zip = new AdmZip();
  for (const [ filePath, content ] of Object.entries(entries)) {
    zip.addFile(filePath, Buffer.from(content));
  }
  return zip.toBuffer();
}

const mixinConfig = ({ client = [], mixins = [], server = [] }) =>
  JSON.stringify({ package: "com.example.mixin", client, mixins, server });

// ─── inspectModJar ──────────────────────────────────────────────────────────

describe("inspectModJar — explicit declarations", () => {
  test("fabric: environment=client → explicit client", () => {
    const buf = makeJar({ "fabric.mod.json": JSON.stringify({ id: "x", environment: "client" }) });
    expect(inspectModJar(buf)).toEqual({ verdict: "client", confidence: "explicit", loader: "fabric", source: "env-client" });
  });

  test("quilt: minecraft.environment=client → explicit client", () => {
    const buf = makeJar({ "quilt.mod.json": JSON.stringify({ quilt_loader: { id: "x" }, minecraft: { environment: "client" } }) });
    expect(inspectModJar(buf, "quilt")).toMatchObject({ verdict: "client", confidence: "explicit" });
  });

  test("quilt: legacy quilt_loader.environment=client is still honored", () => {
    const buf = makeJar({ "quilt.mod.json": JSON.stringify({ quilt_loader: { id: "x", environment: "client" } }) });
    expect(inspectModJar(buf, "quilt")).toMatchObject({ verdict: "client", confidence: "explicit" });
  });

  test("forge: top-level clientSideOnly=true → explicit client (3dskinlayers/entityculling pattern)", () => {
    const toml = "clientSideOnly=true\n[[mods]]\nmodId=\"x\"\n[[dependencies.x]]\nmodId=\"minecraft\"\nside=\"BOTH\"\n";
    const buf = makeJar({ "META-INF/mods.toml": toml });
    expect(inspectModJar(buf, "forge")).toEqual({ verdict: "client", confidence: "explicit", loader: "forge", source: "clientSideOnly" });
  });

  test("neoforge: reads META-INF/neoforge.mods.toml in preference to forge fallback", () => {
    const buf = makeJar({
      "META-INF/neoforge.mods.toml": "clientSideOnly=true\n[[mods]]\nmodId=\"x\"\n"
    });
    expect(inspectModJar(buf, "neoforge")).toMatchObject({ verdict: "client", confidence: "explicit", loader: "neoforge" });
  });

  test("fabric: no environment field → unknown", () => {
    const buf = makeJar({ "fabric.mod.json": JSON.stringify({ id: "x" }) });
    expect(inspectModJar(buf)).toMatchObject({ verdict: "unknown", loader: "fabric", source: "no-signal" });
  });
});

describe("inspectModJar — strong heuristics", () => {
  test("universal JAR: forge load with embedded fabric env=client → strong client (ambientsounds pattern)", () => {
    const buf = makeJar({
      "fabric.mod.json": JSON.stringify({ id: "x", environment: "client" }),
      "META-INF/mods.toml": "[[mods]]\nmodId=\"x\"\n[[dependencies.x]]\nmodId=\"minecraft\"\nside=\"BOTH\"\n"
    });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "client", confidence: "strong", source: "cross-loader-env" });
  });

  test("overwhelmingly client mixin set → strong client (fancymenu/oculus pattern)", () => {
    const buf = makeJar({
      "META-INF/mods.toml": "[[mods]]\nmodId=\"x\"\n[[dependencies.x]]\nmodId=\"minecraft\"\nside=\"BOTH\"\n",
      "x.mixins.json": mixinConfig({ client: Array(20).fill("ClientMixin") })
    });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "client", confidence: "strong", source: "client-mixins" });
  });

  test("client mixins below the dominance threshold → no mixin verdict (simple-voice-chat pattern)", () => {
    const buf = makeJar({
      "fabric.mod.json": JSON.stringify({ id: "x" }),
      "x.mixins.json": mixinConfig({ client: Array(9).fill("C"), mixins: [ "Common" ] })
    });
    expect(inspectModJar(buf, "fabric")).toMatchObject({ verdict: "unknown" });
  });

  test("datapack content vetoes the mixin heuristic", () => {
    const buf = makeJar({
      "META-INF/mods.toml": "[[mods]]\nmodId=\"x\"\n",
      "x.mixins.json": mixinConfig({ client: Array(20).fill("C") }),
      "data/x/recipes/thing.json": "{}"
    });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "unknown" });
  });

  test("small all-client mixin set → weak only (server libraries like CodeChickenLib ship a few client mixins)", () => {
    const buf = makeJar({
      "META-INF/mods.toml": "[[mods]]\nmodId=\"x\"\n",
      "x.mixins.json": mixinConfig({ client: Array(4).fill("ClientMixin") })
    });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "client", confidence: "weak", source: "client-mixins" });
  });

  test("a single client mixin is not enough evidence (geckolib pattern)", () => {
    const buf = makeJar({
      "META-INF/mods.toml": "[[mods]]\nmodId=\"x\"\n",
      "x.mixins.json": mixinConfig({ client: [ "OnlyOne" ] })
    });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "unknown" });
  });
});

describe("inspectModJar — weak heuristics", () => {
  test("forge: minecraft dependency side=CLIENT → weak client", () => {
    const toml = "[[mods]]\nmodId=\"x\"\n[[dependencies.x]]\nmodId=\"minecraft\"\nside=\"CLIENT\"\n";
    const buf = makeJar({ "META-INF/mods.toml": toml });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "client", confidence: "weak", source: "dep-side-client" });
  });

  test("forge: forge dependency side=CLIENT → weak client (oculus/controlling pattern)", () => {
    const toml = "[[mods]]\nmodId=\"x\"\n[[dependencies.x]]\nmodId=\"forge\"\nside=\"CLIENT\"\n[[dependencies.x]]\nmodId=\"minecraft\"\nside=\"BOTH\"\n";
    const buf = makeJar({ "META-INF/mods.toml": toml });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "client", confidence: "weak", source: "dep-side-client" });
  });

  test("forge: every declared dependency side is CLIENT → weak client (embeddium pattern)", () => {
    const toml = "[[mods]]\nmodId=\"x\"\n[[dependencies.x]]\nmodId=\"oculus\"\nside=\"CLIENT\"\n[[dependencies.x]]\nmodId=\"other\"\nside=\"CLIENT\"\n";
    const buf = makeJar({ "META-INF/mods.toml": toml });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "client", confidence: "weak", source: "all-deps-client" });
  });

  test("fabric: only client/modmenu entrypoints → weak client (entityculling pattern)", () => {
    const buf = makeJar({ "fabric.mod.json": JSON.stringify({ id: "x", entrypoints: { client: [ "a.b.C" ], modmenu: [ "a.b.M" ] } }) });
    expect(inspectModJar(buf, "fabric")).toMatchObject({ verdict: "client", confidence: "weak", source: "client-entrypoints" });
  });

  test("fabric: main entrypoint present → entrypoint heuristic does not fire", () => {
    const buf = makeJar({ "fabric.mod.json": JSON.stringify({ id: "x", entrypoints: { main: [ "a.b.M" ], client: [ "a.b.C" ] } }) });
    expect(inspectModJar(buf, "fabric")).toMatchObject({ verdict: "unknown" });
  });

  test("server-content evidence vetoes dep-side heuristics (supplementaries pattern)", () => {
    const toml = "[[mods]]\nmodId=\"x\"\n[[dependencies.x]]\nmodId=\"minecraft\"\nside=\"CLIENT\"\n";
    const buf = makeJar({
      "META-INF/mods.toml": toml,
      "x.mixins.json": mixinConfig({ client: Array(33).fill("C"), mixins: Array(74).fill("M") }),
      "data/x/recipes/thing.json": "{}"
    });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "unknown" });
  });
});

describe("inspectModJar — loader preference and fallbacks", () => {
  test("multi-loader JAR + loaderType=fabric: forge dep sides do not leak across loaders", () => {
    const buf = makeJar({
      "fabric.mod.json": JSON.stringify({ id: "x" }),
      "META-INF/mods.toml": "[[mods]]\nmodId=\"x\"\n[[dependencies.x]]\nmodId=\"minecraft\"\nside=\"CLIENT\"\n"
    });
    // Dep-side declarations are weak signals scoped to their own loader; only
    // explicit env/clientSideOnly declarations cross loaders (as "strong").
    expect(inspectModJar(buf, "fabric")).toMatchObject({ verdict: "unknown" });
  });

  test("loaderType=quilt with no quilt.mod.json falls back to fabric.mod.json", () => {
    const buf = makeJar({ "fabric.mod.json": JSON.stringify({ id: "x", environment: "client" }) });
    expect(inspectModJar(buf, "quilt")).toMatchObject({ verdict: "client", confidence: "explicit" });
  });

  test("no metadata files → no-metadata sentinel", () => {
    const buf = makeJar({ "other.txt": "irrelevant" });
    expect(inspectModJar(buf)).toEqual({ verdict: "unknown", confidence: null, loader: null, source: "no-metadata" });
  });

  test("non-zip buffer → error sentinel", () => {
    expect(inspectModJar(Buffer.from("not a zip"))).toEqual({ verdict: "unknown", confidence: null, loader: null, source: "error" });
  });
});

// ─── isClientOnlyMod ────────────────────────────────────────────────────────

describe("isClientOnlyMod — combining JAR verdicts with provider metadata", () => {
  const verdict = confidence => ({ verdict: "client", confidence, loader: "forge", source: "test" });
  const unknown = { verdict: "unknown", confidence: null, loader: null, source: "no-signal" };

  test("explicit and strong verdicts are trusted over the provider", () => {
    expect(isClientOnlyMod(verdict("explicit"), "required")).toBe(true);
    expect(isClientOnlyMod(verdict("strong"), "optional")).toBe(true);
  });

  test("weak verdicts yield to a provider that says the mod runs on servers", () => {
    expect(isClientOnlyMod(verdict("weak"), "optional")).toBe(false);
    expect(isClientOnlyMod(verdict("weak"), "required")).toBe(false);
    expect(isClientOnlyMod(verdict("weak"), "unsupported")).toBe(true);
    expect(isClientOnlyMod(verdict("weak"), null)).toBe(true);
    expect(isClientOnlyMod(verdict("weak"))).toBe(true);
  });

  test("with no JAR signal the provider's unsupported is followed", () => {
    expect(isClientOnlyMod(unknown, "unsupported")).toBe(true);
    expect(isClientOnlyMod(unknown, "optional")).toBe(false);
    expect(isClientOnlyMod(unknown, null)).toBe(false);
  });
});

// ─── extractModDeps ─────────────────────────────────────────────────────────

describe("extractModDeps — modId and required dependencies", () => {
  test("fabric: returns id and filters out system mods (minecraft, java)", () => {
    const buf = makeJar({ "fabric.mod.json": JSON.stringify({
      id: "mymod",
      depends: { minecraft: ">=1.20", java: ">=17", fabric: "*", otherlib: "1.0" }
    }) });

    const result = extractModDeps(buf);
    expect(result.modId).toBe("mymod");
    expect(result.requiredDeps.sort()).toEqual([ "fabric", "otherlib" ].sort());
  });

  test("quilt: handles both string and object dependency entries", () => {
    const buf = makeJar({ "quilt.mod.json": JSON.stringify({
      quilt_loader: {
        id: "mymod",
        depends: [ "lib_a", { id: "lib_b" }, { id: "minecraft" } ]
      }
    }) });

    const result = extractModDeps(buf);
    expect(result.modId).toBe("mymod");
    expect(result.requiredDeps.sort()).toEqual([ "lib_a", "lib_b" ].sort());
  });

  test("forge: skips mandatory=false, type=\"optional\", and side=\"CLIENT\" deps", () => {
    const toml =
      "[[mods]]\nmodId=\"mymod\"\n" +
      "[[dependencies.mymod]]\nmodId=\"required_lib\"\n" +
      "[[dependencies.mymod]]\nmodId=\"optional_lib\"\nmandatory=false\n" +
      "[[dependencies.mymod]]\nmodId=\"typed_optional\"\ntype=\"optional\"\n" +
      "[[dependencies.mymod]]\nmodId=\"client_only_dep\"\nside=\"CLIENT\"\n" +
      "[[dependencies.mymod]]\nmodId=\"minecraft\"\n"; // system, filtered

    const result = extractModDeps(makeJar({ "META-INF/mods.toml": toml }));
    expect(result.modId).toBe("mymod");
    expect(result.requiredDeps).toEqual([ "required_lib" ]);
  });

  test("returns null modId and empty deps for an invalid zip", () => {
    expect(extractModDeps(Buffer.from("not a zip"))).toEqual({ modId: null, requiredDeps: [] });
  });

  test("returns null modId and empty deps for a JAR with no metadata", () => {
    expect(extractModDeps(makeJar({ "README.txt": "hi" }))).toEqual({ modId: null, requiredDeps: [] });
  });
});
