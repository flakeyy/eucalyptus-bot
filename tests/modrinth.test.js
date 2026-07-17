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
  beforeAll(async () => {
    // No live Modrinth hits in unit tests — empty version_files keeps pack env.
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    result = await modrinth.resolveModrinthInstall(makeMrpack(index, entries));
  });
  afterAll(() => jest.restoreAllMocks());

  test("reads loader and mc version from dependencies", () => {
    expect(result.kind).toBe("plan");
    expect(result.plan.loaderType).toBe("fabric");
    expect(result.plan.mcVersion).toBe("1.20.1");
  });

  test("includes all mods/ JARs, passing the index's server env through as provider metadata", () => {
    const byPath = Object.fromEntries(result.plan.modFiles.map(m => [ m.path, m ]));
    expect(Object.keys(byPath).sort()).toEqual([ "mods/a.jar", "mods/c.jar", "mods/n.jar" ]);
    expect(byPath["mods/a.jar"].providerServerSide).toBe("required");
    expect(byPath["mods/n.jar"].providerServerSide).toBeNull();
    expect(byPath["mods/c.jar"].providerServerSide).toBe("unsupported");
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

  test("returns null for a non-mrpack buffer", async () => {
    expect(await modrinth.resolveModrinthInstall(Buffer.from("nope"))).toBeNull();
  });

  test("prefers Modrinth project server_side over pack env when the hash resolves", async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          a: { project_id: "p1", files: [ { primary: true, url: "https://cdn/a.jar", filename: "a.jar" } ] }
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ([ { id: "p1", server_side: "unsupported" } ])
      });
    const plan = await modrinth.resolveModrinthInstall(makeMrpack(index, entries));
    const a = plan.plan.modFiles.find(m => m.path === "mods/a.jar");
    expect(a.providerServerSide).toBe("unsupported"); // project wins over env.server=required
    jest.restoreAllMocks();
  });
});

// ─── API helpers ─────────────────────────────────────────────────────────────

describe("analyzeModrinthFiles", () => {
  afterEach(() => jest.restoreAllMocks());

  test("maps each hash to its project's server_side and derives clientOnlyHashes", async () => {
    const versionMap = {
      "hash-a": { project_id: "p1", files: [ { primary: true, url: "https://cdn/a.jar", filename: "a.jar" } ] },
      "hash-b": { project_id: "p2", files: [ { primary: true, url: "https://cdn/b.jar", filename: "b.jar" } ] }
    };
    const projects = [
      { id: "p1", server_side: "unsupported" },
      { id: "p2", server_side: "optional" }
    ];
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => versionMap })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => projects });

    const res = await modrinth.analyzeModrinthFiles([ "hash-a", "hash-b" ]);
    expect(res.serverSideByHash.get("hash-a")).toBe("unsupported");
    expect(res.serverSideByHash.get("hash-b")).toBe("optional");
    expect([ ...res.clientOnlyHashes ]).toEqual([ "hash-a" ]);
    expect(res.fallbackUrls.get("hash-b")).toEqual({ url: "https://cdn/b.jar", filename: "b.jar" });
    expect([ ...res.foundHashes ].sort()).toEqual([ "hash-a", "hash-b" ]);
  });

  test("degrades to empty results on API failure", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    const res = await modrinth.analyzeModrinthFiles([ "hash-a" ]);
    expect(res.serverSideByHash.size).toBe(0);
    expect(res.clientOnlyHashes.size).toBe(0);
  });
});

describe("getServerSideBySlugs", () => {
  afterEach(() => jest.restoreAllMocks());

  test("returns a slug → server_side map for found projects", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => [
        { slug: "legendary-tooltips", server_side: "unsupported" },
        { slug: "jei", server_side: "optional" }
      ]
    });
    const res = await modrinth.getServerSideBySlugs([ "legendary-tooltips", "jei", "cf-only-mod" ]);
    expect(res.get("legendary-tooltips")).toBe("unsupported");
    expect(res.get("jei")).toBe("optional");
    expect(res.has("cf-only-mod")).toBe(false);
  });

  test("chunks large slug lists across multiple requests", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] });
    await modrinth.getServerSideBySlugs(Array.from({ length: 150 }, (_, i) => `mod-${i}`));
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test("returns an empty map on API failure", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network down"));
    const res = await modrinth.getServerSideBySlugs([ "a" ]);
    expect(res.size).toBe(0);
  });
});

describe("projectServerSideForCurseforge", () => {
  test("passes through Modrinth project side labels unchanged", () => {
    expect(modrinth.projectServerSideForCurseforge("required")).toBe("required");
    expect(modrinth.projectServerSideForCurseforge("optional")).toBe("optional");
    expect(modrinth.projectServerSideForCurseforge("unsupported")).toBe("unsupported");
  });

  test("maps non-strings to null", () => {
    expect(modrinth.projectServerSideForCurseforge(null)).toBeNull();
    expect(modrinth.projectServerSideForCurseforge(undefined)).toBeNull();
  });
});

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
