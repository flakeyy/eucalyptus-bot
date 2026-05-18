const AdmZip = require("adm-zip");
const { inspectModJar, extractModDeps } = require("../utility/mod_inspector.js");

// Build an in-memory JAR with the given entries: { path: stringContent }.
function makeJar(entries) {
  const zip = new AdmZip();
  for (const [ filePath, content ] of Object.entries(entries)) {
    zip.addFile(filePath, Buffer.from(content));
  }
  return zip.toBuffer();
}

// ─── inspectModJar ──────────────────────────────────────────────────────────

describe("inspectModJar — client/server side detection", () => {
  test("fabric: environment=client → isClientOnly true", () => {
    const buf = makeJar({ "fabric.mod.json": JSON.stringify({ id: "x", environment: "client" }) });
    expect(inspectModJar(buf)).toEqual({ isClientOnly: true, loader: "fabric", source: "fabric.mod.json" });
  });

  test("fabric: no environment field → isClientOnly false (safe default)", () => {
    const buf = makeJar({ "fabric.mod.json": JSON.stringify({ id: "x" }) });
    expect(inspectModJar(buf)).toMatchObject({ isClientOnly: false, loader: "fabric" });
  });

  test("quilt: quilt_loader.environment=client → isClientOnly true", () => {
    const buf = makeJar({ "quilt.mod.json": JSON.stringify({ quilt_loader: { id: "x", environment: "client" } }) });
    expect(inspectModJar(buf)).toMatchObject({ isClientOnly: true, loader: "quilt" });
  });

  test("forge: minecraft dependency side=CLIENT → isClientOnly true", () => {
    const toml =
      "[[mods]]\nmodId=\"x\"\n" +
      "[[dependencies.x]]\nmodId=\"minecraft\"\nside=\"CLIENT\"\n";
    const buf = makeJar({ "META-INF/mods.toml": toml });
    expect(inspectModJar(buf)).toMatchObject({ isClientOnly: true, loader: "forge" });
  });

  test("forge: minecraft dependency without CLIENT side → isClientOnly false", () => {
    const toml = "[[mods]]\nmodId=\"x\"\n[[dependencies.x]]\nmodId=\"minecraft\"\n";
    const buf = makeJar({ "META-INF/mods.toml": toml });
    expect(inspectModJar(buf)).toMatchObject({ isClientOnly: false, loader: "forge" });
  });

  test("neoforge: reads META-INF/neoforge.mods.toml in preference to forge fallback", () => {
    const buf = makeJar({
      "META-INF/neoforge.mods.toml": "[[mods]]\nmodId=\"x\"\n[[dependencies.x]]\nmodId=\"minecraft\"\nside=\"CLIENT\"\n"
    });
    expect(inspectModJar(buf, "neoforge")).toMatchObject({ isClientOnly: true, loader: "neoforge" });
  });

  test("multi-loader JAR + loaderType=fabric: prefers fabric.mod.json", () => {
    // Forge metadata says client-only; Fabric metadata says it's a both-sides mod.
    const buf = makeJar({
      "fabric.mod.json": JSON.stringify({ id: "x" /* no environment → both */ }),
      "META-INF/mods.toml": "[[mods]]\nmodId=\"x\"\n[[dependencies.x]]\nmodId=\"minecraft\"\nside=\"CLIENT\"\n"
    });
    expect(inspectModJar(buf, "fabric")).toMatchObject({ isClientOnly: false, loader: "fabric" });
  });

  test("loaderType=quilt with no quilt.mod.json falls back to fabric.mod.json", () => {
    const buf = makeJar({ "fabric.mod.json": JSON.stringify({ id: "x", environment: "client" }) });
    expect(inspectModJar(buf, "quilt")).toMatchObject({ isClientOnly: true, loader: "fabric" });
  });

  test("no metadata files → no-metadata sentinel", () => {
    const buf = makeJar({ "other.txt": "irrelevant" });
    expect(inspectModJar(buf)).toEqual({ isClientOnly: false, loader: null, source: "no-metadata" });
  });

  test("non-zip buffer → error sentinel", () => {
    expect(inspectModJar(Buffer.from("not a zip"))).toEqual({ isClientOnly: false, loader: null, source: "error" });
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
