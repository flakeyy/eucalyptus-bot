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
  deleteServerFiles: jest.fn(),
  createServerDirectory: jest.fn()
}));

jest.mock("../utility/verdict_store.js", () => ({
  getInspection: jest.fn(() => null),
  putInspection: jest.fn(),
  getCrashScan: jest.fn(() => null),
  putCrashScan: jest.fn(),
  getLearnedVerdict: jest.fn(() => null),
  recordLearnedVerdict: jest.fn(),
  flushVerdictStore: jest.fn(),
  isMixinInfrastructureJar: jest.requireActual("../utility/verdict_store.js").isMixinInfrastructureJar,
  isProtectedLearnedMod: jest.requireActual("../utility/verdict_store.js").isProtectedLearnedMod
}));

jest.mock("../utility/mod_inspector.js", () => ({
  inspectModJarCached: jest.fn(),
  // Real decision logic: the engine tests should exercise how inspections,
  // provider metadata, and curated lists combine, not a stub of it.
  decideModInstall: jest.requireActual("../utility/mod_inspector.js").decideModInstall,
  extractModDeps: jest.fn(),
  flushModInspectorCache: jest.fn(),
  jarHasServerAppliedClientMixins: jest.fn(() => false)
}));

jest.mock("../utility/client_signals.js", () => ({
  assessClientSignals: jest.fn().mockReturnValue({ risk: false, detail: null, reason: "clean" }),
  jarHasServerAppliedClientMixins: jest.fn(() => false),
  FORGE_MOD_ANNOTATIONS: jest.requireActual("../utility/client_signals.js").FORGE_MOD_ANNOTATIONS
}));

const AdmZip = require("adm-zip");
const { installFilePlan, buildProgressBar, installArchiveBuffer, detectNestedArchiveRoot } = require("../utility/modpack_install.js");
const http = require("../utility/modpack_http.js");
const sf = require("../utility/server_functions.js");
const inspector = require("../utility/mod_inspector.js");
const clientSignals = require("../utility/client_signals.js");
const verdictStore = require("../utility/verdict_store.js");

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

const clientVerdict = (confidence, source = "env-client") => ({ verdict: "client", confidence, loader: "forge", source });
const unknownVerdict = { verdict: "unknown", confidence: null, loader: null, source: "no-metadata" };

// Returns the entry names inside the most recent uploaded mod-batch zip.
function lastBatchEntries() {
  const call = [ ...http.uploadBufferToServer.mock.calls ].reverse().find(c =>
    String(c[1]).startsWith("_mods_batch_") && !String(c[1]).includes("park")
  );
  if (!call) return null;
  return new AdmZip(call[2]).getEntries().map(e => e.entryName);
}

// Entries from the most recent park batch (mods-disabled/...).
function lastParkBatchEntries() {
  const call = [ ...http.uploadBufferToServer.mock.calls ]
    .reverse()
    .find(c => String(c[1]).startsWith("_mods_batch_park_"));
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
  sf.createServerDirectory.mockResolvedValue(204);
  inspector.extractModDeps.mockReturnValue({ modId: null, requiredDeps: [] });
  inspector.inspectModJarCached.mockReturnValue(unknownVerdict);
  clientSignals.assessClientSignals.mockReturnValue({ risk: false, detail: null, reason: "clean" });
  verdictStore.getLearnedVerdict.mockReturnValue(null);
});

describe("installFilePlan", () => {
  test("uploads server-side mods and skips explicitly client-only ones", async () => {
    inspector.inspectModJarCached.mockImplementation(sha1 =>
      sha1 === "client" ? clientVerdict("explicit") : unknownVerdict
    );

    const plan = {
      modFiles: [ modFile("a.jar", "a"), modFile("c.jar", "client") ],
      extraFiles: [],
      overrideEntries: [],
      unavailable: []
    };

    const res = await installFilePlan(ctx(), plan);

    expect(res).toMatchObject({ unavailable: [], installed: 1, total: 1, crashRiskWarnings: [] });
    expect(lastBatchEntries()).toEqual([ "mods/a.jar" ]);
  });

  test("skips mods whose required dependency was skipped (client-dep chain)", async () => {
    inspector.inspectModJarCached.mockImplementation((_sha1, buf) =>
      buf.toString().includes("lib.jar") ? clientVerdict("explicit") : unknownVerdict
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

  test("rescues a curated-list skip that an installed mod requires (rescuable slot 6)", async () => {
    // Blur-*.jar hits the curated client list, but content.jar (installed)
    // requires it: both must install instead of both being dropped.
    inspector.extractModDeps.mockImplementation(buf => {
      const s = buf.toString();
      if (s.includes("Blur-1.0.4.jar")) return { modId: "blur", requiredDeps: [] };
      if (s.includes("content.jar")) return { modId: "contentmod", requiredDeps: [ "blur" ] };
      return { modId: null, requiredDeps: [] };
    });

    const res = await installFilePlan(ctx(), {
      modFiles: [ modFile("Blur-1.0.4.jar", "1"), modFile("content.jar", "2") ],
      extraFiles: [], overrideEntries: [], unavailable: []
    });

    expect(res.installed).toBe(2);
    expect(lastBatchEntries().sort()).toEqual([ "mods/Blur-1.0.4.jar", "mods/content.jar" ]);
  });

  test("rescues a provider-unsupported library required by installed content (fusion/rechiseled pattern)", async () => {
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

  test("does not rescue explicit-client skips: their dependents are chained out instead", async () => {
    inspector.inspectModJarCached.mockImplementation((_sha1, buf) =>
      buf.toString().includes("clientlib.jar") ? clientVerdict("explicit") : unknownVerdict
    );
    inspector.extractModDeps.mockImplementation(buf => {
      const s = buf.toString();
      if (s.includes("clientlib.jar")) return { modId: "clientlib", requiredDeps: [] };
      if (s.includes("addon.jar")) return { modId: "addon", requiredDeps: [ "clientlib" ] };
      return { modId: null, requiredDeps: [] };
    });

    const res = await installFilePlan(ctx(), {
      modFiles: [ modFile("clientlib.jar", "1"), modFile("addon.jar", "2") ],
      extraFiles: [], overrideEntries: [], unavailable: []
    });

    expect(res.installed).toBe(0);
    expect(lastParkBatchEntries()).toBeNull();
    expect(res.modIndex.parkedJars.size).toBe(0);
  });

  test("provider 'unsupported' parks a rescuable skip under mods-disabled/", async () => {
    inspector.inspectModJarCached.mockReturnValue(unknownVerdict);
    inspector.extractModDeps.mockReturnValue({ modId: "fusion", requiredDeps: [] });
    const res = await installFilePlan(ctx(), {
      modFiles: [ modFile("fusion.jar", "x", "unsupported") ],
      extraFiles: [], overrideEntries: [], unavailable: []
    });
    expect(res.installed).toBe(0);
    expect(lastParkBatchEntries()).toEqual([ "mods-disabled/fusion.jar" ]);
    expect(res.modIndex.parkedByModId.get("fusion")).toBe("fusion.jar");
    expect(res.modIndex.byModId.has("fusion")).toBe(false);
    expect(sf.createServerDirectory).toHaveBeenCalledWith("abc", "u1", "/", "mods-disabled");
  });

  test("provider 'optional'/'required' overrides explicit client metadata (slot 4 beats slot 5)", async () => {
    inspector.inspectModJarCached.mockReturnValue(clientVerdict("explicit"));
    const res = await installFilePlan(ctx(), {
      modFiles: [ modFile("enchdesc.jar", "e", "optional") ],
      extraFiles: [], overrideEntries: [], unavailable: []
    });
    expect(res.installed).toBe(1);
  });

  test("learned crash verdict from the verdict store skips even provider-required mods", async () => {
    verdictStore.getLearnedVerdict.mockImplementation(sha1 => sha1 === "crasher" ? "crashes-server" : null);
    const res = await installFilePlan(ctx(), {
      modFiles: [ modFile("crasher.jar", "crasher", "required"), modFile("ok.jar", "ok", "required") ],
      extraFiles: [], overrideEntries: [], unavailable: []
    });
    expect(res.installed).toBe(1);
    // Learned skips are parked (not dep-rescued); boot-verify can restore them.
    const installCall = http.uploadBufferToServer.mock.calls.find(c =>
      String(c[1]).startsWith("_mods_batch_") && !String(c[1]).includes("park")
    );
    expect(new AdmZip(installCall[2]).getEntries().map(e => e.entryName)).toEqual([ "mods/ok.jar" ]);
    expect(lastParkBatchEntries()).toEqual([ "mods-disabled/crasher.jar" ]);
  });

  test("does not dep-rescue sodium even when an installed mod requires it", async () => {
    inspector.inspectModJarCached.mockReturnValue(unknownVerdict);
    inspector.extractModDeps.mockImplementation(buf => {
      const s = buf.toString();
      if (s.includes("sodium-neoforge")) return { modId: "sodium", requiredDeps: [] };
      if (s.includes("addon.jar")) return { modId: "sodiumaddon", requiredDeps: [ "sodium" ] };
      return { modId: null, requiredDeps: [] };
    });

    const res = await installFilePlan(ctx(), {
      modFiles: [
        modFile("sodium-neoforge-0.8.jar", "1", "unsupported"),
        modFile("addon.jar", "2", "required")
      ],
      extraFiles: [], overrideEntries: [], unavailable: []
    });

    // Provider-vouched addon stays; sodium must not be force-installed.
    expect(res.installed).toBe(1);
    const installedNames = lastBatchEntries();
    expect(installedNames.some(n => /sodium/i.test(n))).toBe(false);
    expect(installedNames).toContain("mods/addon.jar");
  });

  test("curated client list skips with no provider metadata (Blur pattern)", async () => {
    const res = await installFilePlan(ctx(), {
      modFiles: [ modFile("Blur-1.0.4-14.jar", "b") ],
      extraFiles: [], overrideEntries: [], unavailable: []
    });
    expect(res.installed).toBe(0);
  });

  test("server_side_overrides installs known Modrinth mislabels despite provider unsupported (Pam's pattern)", async () => {
    const res = await installFilePlan(ctx(), {
      modFiles: [ modFile("Pam's HarvestCraft 1.12.2zg.jar", "p", "unsupported") ],
      extraFiles: [], overrideEntries: [], unavailable: []
    });
    expect(res.installed).toBe(1);
  });

  test("allowlisted mods install even when detection says client-only", async () => {
    inspector.inspectModJarCached.mockReturnValue(clientVerdict("explicit"));
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
      buf.toString().includes("client") ? clientVerdict("explicit") : unknownVerdict
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
    const entries = new AdmZip(overridesCall[2]).getEntries().map(e => e.entryName).sort();
    expect(entries).toEqual([ "config/foo.toml", "mods/servermod.jar" ]);
  });

  test("skips curated override jars with backslash or nested mods paths", async () => {
    inspector.inspectModJarCached.mockReturnValue(unknownVerdict);
    inspector.extractModDeps.mockImplementation(buf => {
      if (buf.toString() === "cmm") return { modId: "custommainmenu", requiredDeps: [] };
      return { modId: null, requiredDeps: [] };
    });
    await installFilePlan(ctx(), {
      modFiles: [],
      extraFiles: [],
      overrideEntries: [
        { path: "mods\\custommainmenu-1.12.2.jar", data: Buffer.from("cmm") },
        { path: "mods/1.7.10/Blur-1.0.4.jar", data: Buffer.from("blur") },
        { path: "mods/okmod.jar", data: Buffer.from("ok") },
        { path: "config/foo.toml", data: Buffer.from("x=1") }
      ],
      unavailable: []
    });
    const overridesCall = http.uploadBufferToServer.mock.calls.find(c => c[1] === "overrides.zip");
    const entries = new AdmZip(overridesCall[2]).getEntries().map(e => e.entryName).sort();
    expect(entries).toEqual([ "config/foo.toml", "mods/okmod.jar" ]);
  });

  test("flushes the inspection cache at least once per download batch", async () => {
    const plan = {
      modFiles: [ modFile("a.jar", "a"), modFile("b.jar", "b") ],
      extraFiles: [], overrideEntries: [], unavailable: []
    };
    await installFilePlan(ctx(), plan);
    expect(inspector.flushModInspectorCache).toHaveBeenCalled();
  });

  test("passes the plan's unavailable list through to the result", async () => {
    const unavailable = [ { modId: 42, displayName: "Mystery Mod" } ];
    const res = await installFilePlan(ctx(), {
      modFiles: [], extraFiles: [], overrideEntries: [], unavailable
    });
    expect(res.unavailable).toBe(unavailable);
    expect(res.crashRiskWarnings).toEqual([]);
  });

  test("returns a mod index of installed jars for crash attribution", async () => {
    inspector.extractModDeps.mockImplementation(buf =>
      buf.toString().includes("a.jar")
        ? { modId: "moda", requiredDeps: [ "libx" ] }
        : { modId: null, requiredDeps: [] }
    );
    const res = await installFilePlan(ctx(), {
      modFiles: [ modFile("a.jar", "a") ],
      extraFiles: [], overrideEntries: [], unavailable: []
    });
    expect(res.modIndex.byModId.get("moda")).toBe("a.jar");
    expect(res.modIndex.depsOf.get("a.jar")).toEqual([ "libx" ]);
    expect(res.modIndex.sha1Of.get("a.jar")).toBe("a");
  });

  test("client_signals skips a provider-null mod with a client-only signal", async () => {
    clientSignals.assessClientSignals.mockReturnValue({
      risk: true,
      detail: "com/example/ModMain → net/minecraft/client/Minecraft",
      reason: "entrypoint-client-cp"
    });

    const res = await installFilePlan(
      ctx({ loaderType: "fabric", mcVersion: "1.21.1" }),
      { modFiles: [ modFile("risky.jar", "r") ], extraFiles: [], overrideEntries: [], unavailable: [] }
    );

    expect(res.installed).toBe(0);
    expect(clientSignals.assessClientSignals).toHaveBeenCalled();
  });

  test("client_signals only warns when the provider vouches for the mod (required/optional)", async () => {
    clientSignals.assessClientSignals.mockReturnValue({
      risk: true,
      detail: "com/example/ModMain → net/minecraft/client/Minecraft",
      reason: "entrypoint-client-cp"
    });

    const res = await installFilePlan(
      ctx({ loaderType: "fabric", mcVersion: "1.21.1" }),
      {
        modFiles: [ modFile("risky.jar", "r", "optional") ],
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
      detail: "com/example/ModMain → net/minecraft/client/Minecraft",
      modId: null
    } ]);
  });

  test("skips client_signals assessment for mods that were already filtered as client-only", async () => {
    inspector.inspectModJarCached.mockReturnValue(clientVerdict("explicit"));

    const res = await installFilePlan(
      ctx({ loaderType: "fabric", mcVersion: "1.21.1" }),
      { modFiles: [ modFile("client.jar", "c") ], extraFiles: [], overrideEntries: [], unavailable: [] }
    );

    expect(res.installed).toBe(0);
    expect(res.crashRiskWarnings).toEqual([]);
    // decideWithClientSignals short-circuits before assess when slot ≠ 9;
    // the warning loop also skips client-only mods.
    expect(clientSignals.assessClientSignals).not.toHaveBeenCalled();
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

describe("detectNestedArchiveRoot", () => {
  test("detects a single nested folder that owns mods/", () => {
    const zip = new AdmZip();
    zip.addFile("Server-Files/mods/a.jar", Buffer.from("a"));
    zip.addFile("Server-Files/config/x.cfg", Buffer.from("x"));
    expect(detectNestedArchiveRoot(zip.toBuffer())).toBe("Server-Files");
  });

  test("returns null when mods/ is already at the zip root", () => {
    const zip = new AdmZip();
    zip.addFile("mods/a.jar", Buffer.from("a"));
    expect(detectNestedArchiveRoot(zip.toBuffer())).toBeNull();
  });
});

describe("installArchiveBuffer", () => {
  test("flattens nested roots, skips client-only mods, and chunk-uploads survivors", async () => {
    inspector.inspectModJarCached.mockImplementation((_sha, buf) => {
      const text = buf.toString();
      if (text === "client") return clientVerdict("high");
      return unknownVerdict;
    });
    inspector.extractModDeps.mockReturnValue({ modId: null, requiredDeps: [] });

    const zip = new AdmZip();
    zip.addFile("PackRoot/mods/server.jar", Buffer.from("server"));
    zip.addFile("PackRoot/mods/client.jar", Buffer.from("client"));
    zip.addFile("PackRoot/config/foo.toml", Buffer.from("x=1"));

    const res = await installArchiveBuffer(ctx(), zip.toBuffer());
    expect(res.error).toBeUndefined();
    expect(res.skippedClient).toBe(1);
    expect(res.installed).toBe(1);
    expect(res.total).toBe(2);
    expect(sf.getFileUploadUrl).toHaveBeenCalled();
    expect(sf.decompressFile).toHaveBeenCalled();

    const entries = lastBatchEntries();
    expect(entries).toEqual(expect.arrayContaining([ "mods/server.jar", "config/foo.toml" ]));
    expect(entries).not.toContain("mods/client.jar");
    expect(entries.some(e => e.startsWith("PackRoot/"))).toBe(false);
  });
});
