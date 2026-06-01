jest.mock("../utility/logger.js", () => ({
  log: jest.fn(),
  debug: jest.fn(),
  debugExtended: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

const AdmZip = require("adm-zip");
const modrinth = require("../utility/modrinth.js");

// Builds an in-memory .mrpack zip from an index object plus extra raw entries.
function makeMrpack(index, entries = {}) {
  const zip = new AdmZip();
  if (index !== null) zip.addFile("modrinth.index.json", Buffer.from(JSON.stringify(index)));
  for (const [ path, content ] of Object.entries(entries)) {
    zip.addFile(path, Buffer.from(content));
  }
  return zip.toBuffer();
}

// ─── Loader / version mapping ────────────────────────────────────────────────

describe("mapModrinthLoader", () => {
  test.each([
    [ [ "fabric" ], "fabric" ],
    [ [ "quilt" ], "quilt" ],
    [ [ "forge" ], "forge" ],
    [ [ "neoforge" ], "neoforge" ],
    [ [ "datapack", "forge" ], "forge" ]
  ])("maps %j to %s", (loaders, expected) => {
    expect(modrinth.mapModrinthLoader(loaders)).toBe(expected);
  });

  test("returns null for unknown/empty", () => {
    expect(modrinth.mapModrinthLoader([ "rift" ])).toBeNull();
    expect(modrinth.mapModrinthLoader([])).toBeNull();
    expect(modrinth.mapModrinthLoader(null)).toBeNull();
  });
});

describe("loaderFromMrpackDeps / mcVersionFromMrpackDeps", () => {
  test("reads the loader key, skipping minecraft", () => {
    expect(modrinth.loaderFromMrpackDeps({ minecraft: "1.20.1", "fabric-loader": "0.15.0" })).toBe("fabric");
    expect(modrinth.loaderFromMrpackDeps({ minecraft: "1.21", neoforge: "21.0.0" })).toBe("neoforge");
    expect(modrinth.loaderFromMrpackDeps({ minecraft: "1.20.1" })).toBeNull();
  });

  test("reads the minecraft version", () => {
    expect(modrinth.mcVersionFromMrpackDeps({ minecraft: "1.20.1" })).toBe("1.20.1");
    expect(modrinth.mcVersionFromMrpackDeps({})).toBeNull();
  });
});

// ─── URL parsing ─────────────────────────────────────────────────────────────

describe("parseModrinthUrl", () => {
  test.each([
    [ "https://modrinth.com/modpack/cobblemon-fabric", "cobblemon-fabric" ],
    [ "modrinth.com/modpack/fabulously-optimized/version/abc", "fabulously-optimized" ],
    [ "https://modrinth.com/project/some-pack", "some-pack" ]
  ])("parses %s", (input, expected) => {
    expect(modrinth.parseModrinthUrl(input)).toBe(expected);
  });

  test.each([
    [ "https://curseforge.com/minecraft/modpacks/star-technology" ],
    [ "cobblemon-fabric" ],
    [ "" ],
    [ null ]
  ])("returns null for %s", input => {
    expect(modrinth.parseModrinthUrl(input)).toBeNull();
  });
});

// ─── mrpack detection / parsing ──────────────────────────────────────────────

describe("isMrpackZip / parseMrpackIndex", () => {
  test("detects a modrinth.index.json entry", () => {
    expect(modrinth.isMrpackZip(makeMrpack({ formatVersion: 1 }))).toBe(true);
    expect(modrinth.isMrpackZip(makeMrpack(null, { "manifest.json": "{}" }))).toBe(false);
    expect(modrinth.isMrpackZip(Buffer.from("not a zip"))).toBe(false);
  });

  test("parses the index json", () => {
    const idx = { formatVersion: 1, name: "Pack", dependencies: { minecraft: "1.20.1" } };
    expect(modrinth.parseMrpackIndex(makeMrpack(idx))).toEqual(idx);
    expect(modrinth.parseMrpackIndex(Buffer.from("garbage"))).toBeNull();
  });
});

// ─── resolveModrinthInstall ──────────────────────────────────────────────────

describe("resolveModrinthInstall", () => {
  const index = {
    formatVersion: 1,
    dependencies: { minecraft: "1.20.1", "fabric-loader": "0.15.0" },
    files: [
      { path: "mods/a.jar", hashes: { sha1: "a" }, env: { client: "required", server: "required" }, downloads: [ "https://cdn.modrinth.com/a.jar" ] },
      { path: "mods/c.jar", hashes: { sha1: "c" }, env: { client: "required", server: "unsupported" }, downloads: [ "https://cdn.modrinth.com/c.jar" ] },
      { path: "mods/n.jar", hashes: { sha1: "n" }, downloads: [ "https://cdn.modrinth.com/n.jar" ] },
      { path: "config/x.toml", hashes: { sha1: "x" }, env: { client: "required", server: "required" }, downloads: [ "https://cdn.modrinth.com/x.toml" ] },
      { path: "resourcepacks/r.zip", hashes: { sha1: "r" }, env: { client: "required", server: "unsupported" }, downloads: [ "https://cdn.modrinth.com/r.zip" ] }
    ]
  };
  const entries = {
    "overrides/config/o.toml": "from-overrides",
    "overrides/options.txt": "opts",
    "server-overrides/config/o.toml": "from-server-overrides",
    "server-overrides/server.properties": "props",
    "client-overrides/options.txt": "client-opts"
  };

  let result;
  beforeAll(() => {
    result = modrinth.resolveModrinthInstall(makeMrpack(index, entries));
  });

  test("reads loader and mc version from dependencies", () => {
    expect(result.kind).toBe("plan");
    expect(result.plan.loaderType).toBe("fabric");
    expect(result.plan.mcVersion).toBe("1.20.1");
  });

  test("includes all mods/ JARs, tagging server-unsupported ones with a side fallback", () => {
    const byPath = Object.fromEntries(result.plan.modFiles.map(m => [ m.path, m ]));
    expect(Object.keys(byPath).sort()).toEqual([ "mods/a.jar", "mods/c.jar", "mods/n.jar" ]);
    expect(byPath["mods/a.jar"].sideFallback).toBeNull();
    expect(byPath["mods/n.jar"].sideFallback).toBeNull();
    expect(byPath["mods/c.jar"].sideFallback).toBe("unsupported");
  });

  test("keeps server-side non-mod files but drops client-only ones", () => {
    const paths = result.plan.extraFiles.map(f => f.path);
    expect(paths).toContain("config/x.toml");
    expect(paths).not.toContain("resourcepacks/r.zip");
  });

  test("merges overrides and server-overrides (server wins), skipping client-overrides", () => {
    const byPath = Object.fromEntries(result.plan.overrideEntries.map(e => [ e.path, e.data.toString() ]));
    expect(byPath["config/o.toml"]).toBe("from-server-overrides");
    expect(byPath["options.txt"]).toBe("opts");
    expect(byPath["server.properties"]).toBe("props");
    // client-overrides/options.txt must not override the server-side options.txt
    expect(byPath["options.txt"]).not.toBe("client-opts");
  });

  test("returns null for a non-mrpack buffer", () => {
    expect(modrinth.resolveModrinthInstall(Buffer.from("nope"))).toBeNull();
  });
});

// ─── API helpers ─────────────────────────────────────────────────────────────

describe("getModrinthModpack", () => {
  afterEach(() => jest.restoreAllMocks());

  test("returns the project when it is a modpack", async () => {
    const project = { id: "AABBCC", title: "Cool Pack", project_type: "modpack", loaders: [ "fabric" ] };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => project });
    await expect(modrinth.getModrinthModpack("cool-pack")).resolves.toEqual(project);
  });

  test("returns null when the project is not a modpack", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "x", project_type: "mod" }) });
    await expect(modrinth.getModrinthModpack("jei")).resolves.toBeNull();
  });

  test("returns null on 404", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(modrinth.getModrinthModpack("missing")).resolves.toBeNull();
  });

  test("throws on other API errors", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(modrinth.getModrinthModpack("boom")).rejects.toThrow("Modrinth API error: HTTP 500");
  });
});

describe("getModrinthVersions", () => {
  afterEach(() => jest.restoreAllMocks());

  test("returns the versions array", async () => {
    const versions = [ { id: "v1", name: "1.0.0" } ];
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => versions });
    await expect(modrinth.getModrinthVersions("AABBCC")).resolves.toEqual(versions);
  });

  test("throws on API error", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(modrinth.getModrinthVersions("AABBCC")).rejects.toThrow("Modrinth API error: HTTP 503");
  });
});
