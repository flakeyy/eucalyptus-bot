jest.mock("../utility/logger.js", () => ({
  log: jest.fn(),
  debug: jest.fn(),
  debugExtended: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

jest.mock("../config.json", () => ({ mod_id_blocklist: [ "blockedmod" ] }), { virtual: true });

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
  extractModDeps: jest.fn(),
  flushModInspectorCache: jest.fn()
}));

const AdmZip = require("adm-zip");
const { installFilePlan, buildProgressBar } = require("../utility/modpack_install.js");
const http = require("../utility/modpack_http.js");
const sf = require("../utility/server_functions.js");
const inspector = require("../utility/mod_inspector.js");

// Each downloaded "JAR" is just Buffer.from(its download URL) so mocks can branch on content.
const ctx = () => ({
  i: {},
  serverId: "abc",
  userId: "u1",
  loaderType: "forge",
  updateProgress: jest.fn().mockResolvedValue(undefined)
});

const modFile = (name, sha1, sideFallback = null) => ({
  path: `mods/${name}`,
  filename: name,
  downloadUrl: `https://cdn.example.com/${name}`,
  sha1,
  sideFallback
});

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
  inspector.inspectModJarCached.mockReturnValue({ isClientOnly: false, source: "no-metadata", loader: null });
});

describe("installFilePlan", () => {
  test("uploads server-side mods and skips client-only ones", async () => {
    inspector.inspectModJarCached.mockImplementation(sha1 =>
      sha1 === "client"
        ? { isClientOnly: true, source: "fabric.mod.json" }
        : { isClientOnly: false, source: "no-metadata" }
    );

    const plan = {
      modFiles: [ modFile("a.jar", "a"), modFile("c.jar", "client") ],
      extraFiles: [],
      overrideEntries: [],
      unavailable: []
    };

    const res = await installFilePlan(ctx(), plan);

    expect(res).toEqual({ unavailable: [], installed: 1, total: 1 });
    expect(lastBatchEntries()).toEqual([ "mods/a.jar" ]);
  });

  test("skips mods whose required dependency was skipped (client-dep chain)", async () => {
    inspector.inspectModJarCached.mockImplementation((_sha1, buf) =>
      buf.toString().includes("lib.jar")
        ? { isClientOnly: true, source: "fabric.mod.json" }
        : { isClientOnly: false, source: "no-metadata" }
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

  test("sideFallback 'unsupported' skips a mod only when the JAR declares no side metadata", async () => {
    // JAR has no metadata → fallback applies → skipped.
    inspector.inspectModJarCached.mockReturnValue({ isClientOnly: false, source: "no-metadata" });
    let res = await installFilePlan(ctx(), {
      modFiles: [ modFile("x.jar", "x", "unsupported") ],
      extraFiles: [], overrideEntries: [], unavailable: []
    });
    expect(res.installed).toBe(0);

    // JAR declares a side (not "no-metadata") → fallback ignored → installed.
    jest.clearAllMocks();
    http.downloadFile.mockImplementation(async url => Buffer.from(url));
    http.uploadBufferToServer.mockResolvedValue({ ok: true });
    sf.getFileUploadUrl.mockResolvedValue("https://wings.example.com/upload");
    sf.decompressFile.mockResolvedValue(204);
    inspector.extractModDeps.mockReturnValue({ modId: null, requiredDeps: [] });
    inspector.inspectModJarCached.mockReturnValue({ isClientOnly: false, source: "fabric.mod.json" });
    res = await installFilePlan(ctx(), {
      modFiles: [ modFile("x.jar", "x", "unsupported") ],
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
