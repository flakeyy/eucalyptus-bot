jest.mock("../utility/logger.js", () => ({
  log: jest.fn(),
  debug: jest.fn(),
  debugExtended: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

jest.mock("../config.json", () => ({ mod_id_blocklist: [ "blockedmod" ], mod_id_allowlist: [ "allowedmod" ] }), { virtual: true });

jest.mock("../utility/modpack_http.js", () => ({
  downloadFile: jest.fn(),
  uploadBufferToServer: jest.fn()
}));

jest.mock("../utility/server_functions.js", () => ({
  getFileUploadUrl: jest.fn(),
  decompressFile: jest.fn(),
  chmodServerFiles: jest.fn(),
  deleteServerFiles: jest.fn()
}));

jest.mock("../utility/mod_inspector.js", () => ({
  inspectModJarCached: jest.fn(),
  // Real decision logic: the engine tests should exercise how inspections and
  // provider metadata combine, not a stub of it.
  isClientOnlyMod: jest.requireActual("../utility/mod_inspector.js").isClientOnlyMod,
  extractModDeps: jest.fn(),
  flushModInspectorCache: jest.fn()
}));

jest.mock("../utility/crash_risk.js", () => ({
  getOracle: jest.fn().mockResolvedValue(null),
  assessCrashRisk: jest.fn().mockReturnValue({ risk: false, detail: null, reason: null })
}));

const AdmZip = require("adm-zip");
const { installFilePlan, buildProgressBar } = require("../utility/modpack_install.js");
const http = require("../utility/modpack_http.js");
const sf = require("../utility/server_functions.js");
const inspector = require("../utility/mod_inspector.js");
const crashRisk = require("../utility/crash_risk.js");

// Each downloaded "JAR" is just Buffer.from(its download URL) so mocks can branch on content.
const ctx = (overrides = {}) => ({
  i: {},
  serverId: "abc",
  userId: "u1",
  loaderType: "forge",
  mcVersion: null,
  updateProgress: jest.fn().mockResolvedValue(undefined),
  ...overrides
});

const modFile = (name, sha1, providerServerSide = null) => ({
  path: `mods/${name}`,
  filename: name,
  downloadUrl: `https://cdn.example.com/${name}`,
  sha1,
  providerServerSide
});

const clientVerdict = (confidence, source = "test") => ({ verdict: "client", confidence, loader: "forge", source });
const unknownVerdict = { verdict: "unknown", confidence: null, loader: null, source: "no-metadata" };

// Returns the entry names inside the most recent uploaded mod-batch zip.
function lastBatchEntries() {
  const call = [ ...http.uploadBufferToServer.mock.calls ].reverse().find(c => c[1].startsWith("_mods_batch_"));
  if (!call) return null;
  return new AdmZip(call[2]).getEntries().map(e => e.entryName);
}

beforeEach(() => {
  jest.clearAllMocks();
  http.downloadFile.mockImplementation(async url => Buffer.from(url));
  http.uploadBufferToServer.mockResolvedValue({ ok: true, status: 200 });
  sf.getFileUploadUrl.mockResolvedValue("https://wings.example.com/upload");
  sf.decompressFile.mockResolvedValue(204);
  sf.chmodServerFiles.mockResolvedValue(204);
  sf.deleteServerFiles.mockResolvedValue(204);
  inspector.extractModDeps.mockReturnValue({ modId: null, requiredDeps: [] });
  inspector.inspectModJarCached.mockReturnValue(unknownVerdict);
  crashRisk.getOracle.mockResolvedValue(null);
  crashRisk.assessCrashRisk.mockReturnValue({ risk: false, detail: null, reason: null });
});

describe("installFilePlan", () => {
  test("uploads server-side mods and skips client-only ones", async () => {
    inspector.inspectModJarCached.mockImplementation(sha1 =>
      sha1 === "client" ? clientVerdict("explicit", "env-client") : unknownVerdict
    );

    const plan = {
      modFiles: [ modFile("a.jar", "a"), modFile("c.jar", "client") ],
      extraFiles: [],
      overrideEntries: [],
      unavailable: []
    };

    const res = await installFilePlan(ctx(), plan);

    expect(res).toEqual({ unavailable: [], installed: 1, total: 1, crashRiskWarnings: [] });
    expect(lastBatchEntries()).toEqual([ "mods/a.jar" ]);
  });

  test("skips mods whose required dependency was skipped (client-dep chain)", async () => {
    inspector.inspectModJarCached.mockImplementation((_sha1, buf) =>
      buf.toString().includes("lib.jar") ? clientVerdict("explicit", "env-client") : unknownVerdict
    );
    inspector.extractModDeps.mockImplementation(buf => {
      const s = buf.toString();
      if (s.includes("lib.jar")) return { modId: "libmod", requiredDeps: [] };
      if (s.includes("dep.jar")) return { modId: "depmod", requiredDeps: [ "libmod" ] };
      return { modId: null, requiredDeps: [] };
    });

    const plan = {
      modFiles: [ modFile("lib.jar", "1"), modFile("dep.jar", "2") ],
      extraFiles: [],
      overrideEntries: [],
      unavailable: []
    };

    const res = await installFilePlan(ctx(), plan);

    expect(res.installed).toBe(0);
    expect(http.uploadBufferToServer).not.toHaveBeenCalled();
  });

  test("rescues a weakly-skipped library that an installed mod requires (athena/oritech pattern)", async () => {
    // lib.jar is skipped by a weak heuristic, but content.jar (installed) requires it:
    // both must install instead of both being dropped.
    inspector.inspectModJarCached.mockImplementation((_sha1, buf) =>
      buf.toString().includes("lib.jar") ? clientVerdict("weak", "client-mixins") : unknownVerdict
    );
    inspector.extractModDeps.mockImplementation(buf => {
      const s = buf.toString();
      if (s.includes("lib.jar")) return { modId: "libmod", requiredDeps: [] };
      if (s.includes("content.jar")) return { modId: "contentmod", requiredDeps: [ "libmod" ] };
      return { modId: null, requiredDeps: [] };
    });

    const res = await installFilePlan(ctx(), {
      modFiles: [ modFile("lib.jar", "1"), modFile("content.jar", "2") ],
      extraFiles: [], overrideEntries: [], unavailable: []
    });

    expect(res.installed).toBe(2);
    expect(lastBatchEntries().sort()).toEqual([ "mods/content.jar", "mods/lib.jar" ]);
  });

  test("rescues a provider-unsupported library required by installed content (fusion/rechiseled pattern)", async () => {
    // Fusion: no JAR client signal (main entrypoint vetoes mixins) but Modrinth says
    // unsupported → skipped as provider-env, then rescued because Rechiseled needs it.
    inspector.inspectModJarCached.mockReturnValue(unknownVerdict);
    inspector.extractModDeps.mockImplementation(buf => {
      const s = buf.toString();
      if (s.includes("fusion.jar")) return { modId: "fusion", requiredDeps: [] };
      if (s.includes("rechiseled.jar")) return { modId: "rechiseled", requiredDeps: [ "fusion" ] };
      return { modId: null, requiredDeps: [] };
    });

    const res = await installFilePlan(ctx(), {
      modFiles: [
        modFile("fusion.jar", "1", "unsupported"),
        modFile("rechiseled.jar", "2", "required")
      ],
      extraFiles: [], overrideEntries: [], unavailable: []
    });

    expect(res.installed).toBe(2);
    expect(lastBatchEntries().sort()).toEqual([ "mods/fusion.jar", "mods/rechiseled.jar" ]);
  });

  test("does not rescue strong-skipped mods: their dependents are chained out instead", async () => {
    // fancymenu pattern: strong client verdict, an addon requires it → both skipped.
    inspector.inspectModJarCached.mockImplementation((_sha1, buf) =>
      buf.toString().includes("fancy.jar") ? clientVerdict("strong", "client-mixins") : unknownVerdict
    );
    inspector.extractModDeps.mockImplementation(buf => {
      const s = buf.toString();
      if (s.includes("fancy.jar")) return { modId: "fancymenu", requiredDeps: [] };
      if (s.includes("addon.jar")) return { modId: "fancyaddon", requiredDeps: [ "fancymenu" ] };
      return { modId: null, requiredDeps: [] };
    });

    const res = await installFilePlan(ctx(), {
      modFiles: [ modFile("fancy.jar", "1"), modFile("addon.jar", "2") ],
      extraFiles: [], overrideEntries: [], unavailable: []
    });

    expect(res.installed).toBe(0);
  });

  test("provider 'unsupported' skips a mod when the JAR has no signal", async () => {
    inspector.inspectModJarCached.mockReturnValue(unknownVerdict);
    const res = await installFilePlan(ctx(), {
      modFiles: [ modFile("x.jar", "x", "unsupported") ],
      extraFiles: [], overrideEntries: [], unavailable: []
    });
    expect(res.installed).toBe(0);
  });

  test("provider 'optional'/'required' overrides a weak JAR verdict but not a strong one", async () => {
    // Weak verdict + provider says server-compatible → installed.
    inspector.inspectModJarCached.mockReturnValue(clientVerdict("weak", "dep-side-client"));
    let res = await installFilePlan(ctx(), {
      modFiles: [ modFile("weak.jar", "w", "optional") ],
      extraFiles: [], overrideEntries: [], unavailable: []
    });
    expect(res.installed).toBe(1);

    // Strong verdict wins even when the provider claims server support.
    jest.clearAllMocks();
    http.downloadFile.mockImplementation(async url => Buffer.from(url));
    http.uploadBufferToServer.mockResolvedValue({ ok: true });
    sf.getFileUploadUrl.mockResolvedValue("https://wings.example.com/upload");
    sf.decompressFile.mockResolvedValue(204);
    inspector.extractModDeps.mockReturnValue({ modId: null, requiredDeps: [] });
    inspector.inspectModJarCached.mockReturnValue(clientVerdict("strong", "client-mixins"));
    res = await installFilePlan(ctx(), {
      modFiles: [ modFile("strong.jar", "s", "optional") ],
      extraFiles: [], overrideEntries: [], unavailable: []
    });
    expect(res.installed).toBe(0);
  });

  test("weak JAR verdict with no provider metadata skips the mod", async () => {
    inspector.inspectModJarCached.mockReturnValue(clientVerdict("weak", "client-entrypoints"));
    const res = await installFilePlan(ctx(), {
      modFiles: [ modFile("weak.jar", "w") ],
      extraFiles: [], overrideEntries: [], unavailable: []
    });
    expect(res.installed).toBe(0);
  });

  test("allowlisted mods install even when detection says client-only", async () => {
    inspector.inspectModJarCached.mockReturnValue(clientVerdict("explicit", "env-client"));
    inspector.extractModDeps.mockReturnValue({ modId: "allowedmod", requiredDeps: [] });
    const res = await installFilePlan(ctx(), {
      modFiles: [ modFile("allowed.jar", "a") ],
      extraFiles: [], overrideEntries: [], unavailable: []
    });
    expect(res.installed).toBe(1);
  });

  test("skips mods whose own modId is in the blocklist", async () => {
    inspector.extractModDeps.mockReturnValue({ modId: "blockedmod", requiredDeps: [] });
    const res = await installFilePlan(ctx(), {
      modFiles: [ modFile("blocked.jar", "b") ],
      extraFiles: [], overrideEntries: [], unavailable: []
    });
    expect(res.installed).toBe(0);
  });

  test("uploads overrides as overrides.zip and extracts at the root", async () => {
    await installFilePlan(ctx(), {
      modFiles: [],
      extraFiles: [],
      overrideEntries: [ { path: "config/foo.toml", data: Buffer.from("x=1") } ],
      unavailable: []
    });
    const overridesCall = http.uploadBufferToServer.mock.calls.find(c => c[1] === "overrides.zip");
    expect(overridesCall).toBeDefined();
    expect(sf.decompressFile).toHaveBeenCalledWith("abc", "u1", "/", "overrides.zip");
  });

  test("inspects mod JARs bundled in overrides and drops client-only ones", async () => {
    inspector.inspectModJarCached.mockImplementation((_sha1, buf) =>
      buf.toString().includes("client") ? clientVerdict("explicit", "env-client") : unknownVerdict
    );
    await installFilePlan(ctx(), {
      modFiles: [],
      extraFiles: [],
      overrideEntries: [
        { path: "mods/clientmod.jar", data: Buffer.from("client jar bytes") },
        { path: "mods/servermod.jar", data: Buffer.from("server jar bytes") },
        { path: "config/foo.toml", data: Buffer.from("x=1") }
      ],
      unavailable: []
    });
    const overridesCall = http.uploadBufferToServer.mock.calls.find(c => c[1] === "overrides.zip");
    const entries = new AdmZip(overridesCall[2]).getEntries().map(e => e.entryName);
    expect(entries).toContain("mods/servermod.jar");
    expect(entries).toContain("config/foo.toml");
    expect(entries).not.toContain("mods/clientmod.jar");
  });

  test("flushes the mod-inspector cache once per download batch", async () => {
    const plan = {
      modFiles: [ modFile("a.jar", "a"), modFile("b.jar", "b") ],
      extraFiles: [], overrideEntries: [], unavailable: []
    };
    await installFilePlan(ctx(), plan);
    // Two mods, batch size 20 → a single batch → a single flush.
    expect(inspector.flushModInspectorCache).toHaveBeenCalledTimes(1);
  });

  test("passes the plan's unavailable list through to the result", async () => {
    const unavailable = [ { modId: 42, displayName: "Mystery Mod" } ];
    const res = await installFilePlan(ctx(), {
      modFiles: [], extraFiles: [], overrideEntries: [], unavailable
    });
    expect(res.unavailable).toBe(unavailable);
    expect(res.crashRiskWarnings).toEqual([]);
  });

  test("warns on crash-risk for installed Fabric mods without skipping them", async () => {
    const fakeOracle = { has: () => false, isClientApiPackage: () => false };
    crashRisk.getOracle.mockResolvedValue(fakeOracle);
    crashRisk.assessCrashRisk.mockReturnValue({
      risk: true,
      detail: "com/example/Mod --init--> net/minecraft/class_310",
      reason: "init-reaches-client-only"
    });

    const res = await installFilePlan(
      ctx({ loaderType: "fabric", mcVersion: "1.21.1" }),
      {
        modFiles: [ modFile("risky.jar", "r") ],
        extraFiles: [],
        overrideEntries: [],
        unavailable: []
      }
    );

    expect(res.installed).toBe(1);
    expect(lastBatchEntries()).toEqual([ "mods/risky.jar" ]);
    expect(res.crashRiskWarnings).toEqual([ {
      filename: "risky.jar",
      path: "mods/risky.jar",
      detail: "com/example/Mod --init--> net/minecraft/class_310",
      modId: null
    } ]);
    expect(crashRisk.getOracle).toHaveBeenCalledWith("1.21.1");
  });

  test("does not request a crash-risk oracle for Forge installs", async () => {
    await installFilePlan(
      ctx({ loaderType: "forge", mcVersion: "1.20.1" }),
      { modFiles: [ modFile("a.jar", "a") ], extraFiles: [], overrideEntries: [], unavailable: [] }
    );
    expect(crashRisk.getOracle).not.toHaveBeenCalled();
    expect(crashRisk.assessCrashRisk).not.toHaveBeenCalled();
  });

  test("skips crash-risk assessment for mods that were already filtered as client-only", async () => {
    const fakeOracle = { has: () => false, isClientApiPackage: () => false };
    crashRisk.getOracle.mockResolvedValue(fakeOracle);
    inspector.inspectModJarCached.mockReturnValue(clientVerdict("explicit", "env-client"));

    const res = await installFilePlan(
      ctx({ loaderType: "fabric", mcVersion: "1.21.1" }),
      {
        modFiles: [ modFile("client.jar", "c") ],
        extraFiles: [],
        overrideEntries: [],
        unavailable: []
      }
    );

    expect(res.installed).toBe(0);
    expect(res.crashRiskWarnings).toEqual([]);
    expect(crashRisk.assessCrashRisk).not.toHaveBeenCalled();
  });
});

describe("buildProgressBar", () => {
  test("renders the trailing unit label and rounded percentages", () => {
    const bar = buildProgressBar({ downloaded: 5, installed: 0, total: 10, unit: "10 mods" });
    expect(bar).toContain("10 mods");
    expect(bar).toContain("↓ 50%");
    expect(bar).toContain("↑ 0%");
  });
});
