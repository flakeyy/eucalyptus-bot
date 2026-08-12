"use strict";

jest.mock("../../utility/logger.js", () => ({
  log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), debugExtended: jest.fn()
}));

jest.mock("../../utility/server_functions.js", () => ({
  setServerPowerState: jest.fn(),
  getServerResourceInfoById: jest.fn(),
  changeServerEgg: jest.fn(),
  reinstallServer: jest.fn(),
  getServerInstallStatus: jest.fn(),
  listServerFiles: jest.fn(),
  deleteServerFiles: jest.fn(),
  getFileUploadUrl: jest.fn(),
  decompressFile: jest.fn(),
  pullServerFile: jest.fn().mockResolvedValue(500),
  writeServerFile: jest.fn().mockResolvedValue(204),
  renameServerFiles: jest.fn().mockResolvedValue(204),
  createServerDirectory: jest.fn().mockResolvedValue(204),
  chmodServerFiles: jest.fn().mockResolvedValue(204)
}));

jest.mock("../../utility/boot_verify.js", () => ({
  verifyServerBoot: jest.fn()
}));

jest.mock("../../utility/error_messages.js", () => ({
  getErrorMessage: jest.fn(code => `Error: ${code}`)
}));

jest.mock("../../utility/url_validation.js", () => ({
  validateExternalUrl: jest.fn(async () => ({ ok: true }))
}));

jest.mock("../../config.json", () => ({
  debug: false,
  minecraft_nest_id: 1,
  modpack_eggs: { forge: 3, fabric: 4, neoforge: 5, quilt: 6 },
  mc_version_variable: "MC_VERSION",
  forge_build_type_variable: "BUILD_TYPE",
  loader_version_variables: {
    forge: "FORGE_VERSION", neoforge: "NEOFORGE_VERSION",
    fabric: "LOADER_VERSION", quilt: "LOADER_VERSION"
  },
  java_images: { "8": "img:java_8", "17": "img:java_17", "21": "img:java_21" },
  minecraft_java_map: { "1.20": 17, "1.12": 8 }
}), { virtual: true });

const { runModpackJob } = require("../../utility/modpack/job.js");
const { CollectingReporter } = require("../../utility/modpack/reporters.js");
const serverFunctions = require("../../utility/server_functions.js");
const { makeState, mockHappyPath, makeStreamResponse } = require("../fixtures/modpack.js");

describe("modpack job stage ordering", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    serverFunctions.reinstallServer.mockResolvedValue(204);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("failed download never touches the server (nothing destructive before stop)", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403 });
    const reporter = new CollectingReporter();
    const state = {
      ...makeState(),
      userId: "discord1",
      username: "testuser"
    };

    const result = await runModpackJob(state, reporter);

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("download");
    expect(serverFunctions.setServerPowerState).not.toHaveBeenCalled();
    expect(serverFunctions.deleteServerFiles).not.toHaveBeenCalled();
    expect(serverFunctions.changeServerEgg).not.toHaveBeenCalled();
    expect(serverFunctions.reinstallServer).not.toHaveBeenCalled();
    expect(reporter.events.some(e => e.stage === "download")).toBe(true);
  });

  test("happy path reaches wipe only after stop", async () => {
    mockHappyPath(serverFunctions);
    const reporter = new CollectingReporter();
    const state = { ...makeState(), userId: "discord1", username: "testuser" };

    const p = runModpackJob(state, reporter);
    await jest.runAllTimersAsync();
    const result = await p;

    expect(result.ok).toBe(true);
    const stages = reporter.events.map(e => e.stage).filter(Boolean);
    const stopIdx = stages.indexOf("stop");
    const wipeIdx = stages.indexOf("wipe");
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(wipeIdx).toBeGreaterThan(stopIdx);
  });

  test("nested-root server pack skips the Wings pull and extracts locally", async () => {
    const { makeNestedArchivePackBytes } = require("../fixtures/modpack.js");
    mockHappyPath(serverFunctions, { packBytes: makeNestedArchivePackBytes() });
    // Pull would succeed if we let it — the point is that we never try.
    serverFunctions.pullServerFile.mockResolvedValue(204);

    const reporter = new CollectingReporter();
    const p = runModpackJob({ ...makeState(), userId: "u", username: "u" }, reporter);
    await jest.runAllTimersAsync();
    const result = await p;

    expect(result.ok).toBe(true);
    expect(serverFunctions.pullServerFile).not.toHaveBeenCalled();
    // Local extract path uploads via the chunked Wings upload.
    expect(serverFunctions.getFileUploadUrl).toHaveBeenCalled();
  });

  test("pull that leaves mods/ empty falls back to the local extract", async () => {
    mockHappyPath(serverFunctions);
    serverFunctions.pullServerFile.mockResolvedValue(204);
    serverFunctions.decompressFile.mockResolvedValue(204);
    // Root listing has files, but /mods comes back empty — the layout defeated
    // Wings' in-place decompress even though every call returned 2xx.
    serverFunctions.listServerFiles.mockImplementation(async (_id, _user, dir) =>
      dir === "/mods" ? [] : []
    );

    const reporter = new CollectingReporter();
    const p = runModpackJob({ ...makeState(), userId: "u", username: "u" }, reporter);
    await jest.runAllTimersAsync();
    const result = await p;

    expect(result.ok).toBe(true);
    expect(serverFunctions.pullServerFile).toHaveBeenCalled();
    expect(serverFunctions.getFileUploadUrl).toHaveBeenCalled();
    expect(result.manifestInstalled).toBeGreaterThan(0);
  });

  test("CollectingReporter records pct on download callbacks", async () => {
    const { makeArchivePackBytes } = require("../fixtures/modpack.js");
    const bytes = makeArchivePackBytes();
    // Stream that reports content-length so downloadToBuffer fires progress.
    global.fetch = jest.fn()
      .mockResolvedValueOnce(makeStreamResponse(new Uint8Array(bytes)))
      .mockResolvedValue({ ok: true, status: 200 });
    mockHappyPath(serverFunctions, { packBytes: bytes });

    const reporter = new CollectingReporter();
    const p = runModpackJob({ ...makeState(), userId: "u", username: "u" }, reporter);
    await jest.runAllTimersAsync();
    await p;

    expect(reporter.events.length).toBeGreaterThan(3);
  });
});
