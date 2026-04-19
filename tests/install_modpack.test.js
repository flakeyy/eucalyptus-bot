jest.mock("../utility/logger.js", () => ({
  log: jest.fn(),
  debug: jest.fn(),
  debugExtended: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

jest.mock("../utility/permissions.js", () => ({
  PERMISSIONS: { READ_SERVERS: 4 },
  authenticateUserForPermission: jest.fn()
}));

jest.mock("../utility/server_functions.js", () => ({
  getClientServers: jest.fn(),
  setServerPowerState: jest.fn(),
  getServerResourceInfoById: jest.fn(),
  changeServerEgg: jest.fn(),
  reinstallServer: jest.fn(),
  listServerFiles: jest.fn(),
  deleteServerFiles: jest.fn(),
  getFileUploadUrl: jest.fn(),
  decompressFile: jest.fn()
}));

jest.mock("../utility/helper_functions.js", () => ({
  reconstructCommand: jest.fn(() => "/install-modpack"),
  getUserId: jest.fn(() => 1),
  userHasClientApiKey: jest.fn(() => true),
  applicationApiCall: jest.fn()
}));

jest.mock("../utility/error_messages.js", () => ({
  getErrorMessage: jest.fn(code => `Error: ${code}`)
}));

jest.mock("../config.json", () => ({
  debug: false,
  minecraft_nest_id: 1,
  modpack_eggs: { forge: 3, fabric: 4, neoforge: 5, quilt: 6 },
  mc_version_variable: "MC_VERSION",
  java_images: { "8": "img:java_8", "17": "img:java_17", "21": "img:java_21" },
  minecraft_java_map: { "1.21": 21, "1.20": 21, "1.19": 17, "1.17": 17, "1.12": 8 }
}), { virtual: true });

// curseforge.js is NOT mocked globally — pure functions tested directly
const curseforge = require("../utility/curseforge.js");
const { parseProjectId, detectLoaderType, findServerPack } = curseforge;

const { execute, runInstallation } = require("../commands/ptero/install_modpack.js");
const serverFunctions = require("../utility/server_functions.js");
const helpers = require("../utility/helper_functions.js");
const perms = require("../utility/permissions.js");

// ─── Project ID Parsing ─────────────────────────────────────────────────────

describe("parseProjectId", () => {
  test("parses a bare numeric ID string", () => {
    expect(parseProjectId("905765")).toBe(905765);
  });

  test("parses a numeric ID with whitespace", () => {
    expect(parseProjectId("  905765  ")).toBe(905765);
  });

  test("extracts numeric ID from a CurseForge projects URL", () => {
    expect(parseProjectId("https://www.curseforge.com/projects/905765")).toBe(905765);
  });

  test("returns null for a slug-only URL (no numeric ID)", () => {
    expect(parseProjectId("https://www.curseforge.com/minecraft/modpacks/star-technology")).toBeNull();
  });

  test("returns null for a non-numeric string", () => {
    expect(parseProjectId("star-technology")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseProjectId("")).toBeNull();
  });

  test("returns null for null", () => {
    expect(parseProjectId(null)).toBeNull();
  });
});

// ─── Loader Type Detection ───────────────────────────────────────────────────

describe("detectLoaderType", () => {
  test("maps modLoader 1 to forge", () => {
    expect(detectLoaderType([ { modLoader: 1 } ])).toBe("forge");
  });

  test("maps modLoader 4 to fabric", () => {
    expect(detectLoaderType([ { modLoader: 4 } ])).toBe("fabric");
  });

  test("maps modLoader 5 to quilt", () => {
    expect(detectLoaderType([ { modLoader: 5 } ])).toBe("quilt");
  });

  test("maps modLoader 6 to neoforge", () => {
    expect(detectLoaderType([ { modLoader: 6 } ])).toBe("neoforge");
  });

  test("returns first recognized loader from multiple entries", () => {
    expect(detectLoaderType([ { modLoader: 0 }, { modLoader: 1 } ])).toBe("forge");
  });

  test("returns null for unrecognized modLoader", () => {
    expect(detectLoaderType([ { modLoader: 99 } ])).toBeNull();
  });

  test("returns null for empty array", () => {
    expect(detectLoaderType([])).toBeNull();
  });

  test("returns null for null input", () => {
    expect(detectLoaderType(null)).toBeNull();
  });
});

// ─── Server Pack Detection ───────────────────────────────────────────────────

describe("findServerPack", () => {
  const makeFile = (id, isServerPack, dateStr) => ({
    id,
    displayName: `file-${id}.zip`,
    downloadUrl: `https://cdn.example.com/${id}`,
    isServerPack,
    fileDate: dateStr
  });

  test("returns the most recent server pack", () => {
    const files = [
      makeFile(1, true, "2024-01-01T00:00:00Z"),
      makeFile(2, true, "2024-06-01T00:00:00Z"),
      makeFile(3, false, "2024-12-01T00:00:00Z")
    ];
    expect(findServerPack(files).id).toBe(2);
  });

  test("returns null when no server packs exist", () => {
    const files = [
      makeFile(1, false, "2024-01-01T00:00:00Z"),
      makeFile(2, false, "2024-06-01T00:00:00Z")
    ];
    expect(findServerPack(files)).toBeNull();
  });

  test("returns null for empty array", () => {
    expect(findServerPack([])).toBeNull();
  });

  test("returns null for null input", () => {
    expect(findServerPack(null)).toBeNull();
  });

  test("returns the single server pack when only one exists", () => {
    const files = [ makeFile(5, true, "2024-03-01T00:00:00Z") ];
    expect(findServerPack(files).id).toBe(5);
  });
});

// ─── CurseForge API Helpers ──────────────────────────────────────────────────

describe("CurseForge API helpers", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("getModpackById", () => {
    test("returns modpack on success", async () => {
      const mockModpack = { id: 905765, name: "Star Technology", gameId: 432, classId: 4471, latestFilesIndexes: [ { modLoader: 1 } ] };
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ data: mockModpack })
      });

      const result = await curseforge.getModpackById(905765);
      expect(result).toEqual(mockModpack);
    });

    test("returns null when classId is not 4471 (not a modpack)", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ data: { id: 123, gameId: 432, classId: 6 } })
      });

      const result = await curseforge.getModpackById(123);
      expect(result).toBeNull();
    });

    test("returns null on 404", async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 });

      const result = await curseforge.getModpackById(99999);
      expect(result).toBeNull();
    });

    test("throws on non-404 HTTP error", async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });

      await expect(curseforge.getModpackById(99999)).rejects.toThrow("CurseForge API error: HTTP 500");
    });
  });

  describe("getModpackFiles", () => {
    test("returns files array on success", async () => {
      const mockFiles = [
        { id: 1, displayName: "server.zip", isServerPack: true, downloadUrl: "https://cdn/1.zip" }
      ];
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ data: mockFiles })
      });

      const result = await curseforge.getModpackFiles(123);
      expect(result).toEqual(mockFiles);
    });

    test("throws on HTTP error", async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });

      await expect(curseforge.getModpackFiles(123)).rejects.toThrow("CurseForge API error: HTTP 500");
    });
  });
});

// ─── Command: auth and early exits ──────────────────────────────────────────

describe("install-modpack command", () => {
  let interaction;

  beforeEach(() => {
    jest.clearAllMocks();
    helpers.reconstructCommand.mockReturnValue("/install-modpack");
    helpers.getUserId.mockReturnValue(1);
    helpers.userHasClientApiKey.mockReturnValue(true);

    interaction = {
      reply: jest.fn().mockResolvedValue(undefined),
      followUp: jest.fn().mockResolvedValue(undefined),
      fetchReply: jest.fn(),
      user: { id: "discord123", username: "testuser" },
      replied: false,
      deferred: false
    };
  });

  test("shows USER_NOT_FOUND when user is not in database", async () => {
    perms.authenticateUserForPermission.mockReturnValue(-1);

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith("Error: USER_NOT_FOUND");
  });

  test("shows INSUFFICIENT_PERMISSIONS when user lacks READ_SERVERS", async () => {
    perms.authenticateUserForPermission.mockReturnValue(false);

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith("Error: INSUFFICIENT_PERMISSIONS");
  });

  test("shows API_KEY_NOT_SET when no client API key is configured", async () => {
    perms.authenticateUserForPermission.mockReturnValue(true);
    helpers.userHasClientApiKey.mockReturnValue(false);

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith("Error: API_KEY_NOT_SET");
    // No API calls should be made before the key check
    expect(serverFunctions.getClientServers).not.toHaveBeenCalled();
  });

  test("shows CLIENT_API_FAILURE when getClientServers returns null", async () => {
    perms.authenticateUserForPermission.mockReturnValue(true);
    serverFunctions.getClientServers.mockResolvedValue(null);
    helpers.applicationApiCall.mockResolvedValue({
      statusCode: 200,
      body: { json: async () => ({ attributes: { relationships: { servers: { data: [] } } } }) }
    });

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith("Error: CLIENT_API_FAILURE");
  });

  test("replies with server select UI on successful load", async () => {
    perms.authenticateUserForPermission.mockReturnValue(true);
    serverFunctions.getClientServers.mockResolvedValue({
      data: [
        { attributes: { identifier: "abc123", name: "My Server", internal_id: 1 } }
      ]
    });
    helpers.applicationApiCall.mockResolvedValue({
      statusCode: 200,
      body: {
        json: async () => ({
          attributes: {
            relationships: {
              servers: {
                data: [ { attributes: { identifier: "abc123", nest: 1 } } ]
              }
            }
          }
        })
      }
    });

    const mockCollector = { on: jest.fn() };
    const mockResponse = { createMessageComponentCollector: jest.fn(() => mockCollector) };
    interaction.fetchReply = jest.fn().mockResolvedValue(mockResponse);

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: expect.any(Number) })
    );
  });
});

// ─── Installation behavior (via runInstallation) ────────────────────────────

describe("runInstallation behavior", () => {
  let mockInteraction;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    serverFunctions.reinstallServer.mockResolvedValue(204);
    mockInteraction = {
      editReply: jest.fn().mockResolvedValue(undefined)
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function makeState(overrides = {}) {
    return {
      serverId: "abc123",
      serverInternalId: 42,
      serverName: "Test Server",
      modpackName: "Star Technology",
      targetFile: {
        id: 1,
        displayName: "startech-server.zip",
        downloadUrl: "https://cdn.example.com/pack.zip"
      },
      loaderType: "forge",
      usingClientPack: false,
      ...overrides
    };
  }

  /* global ReadableStream */
  function makeStreamResponse(bytes = new Uint8Array([ 1, 2, 3, 4 ])) {
    const body = new ReadableStream({
      start(controller) { controller.enqueue(bytes); controller.close(); }
    });
    return {
      ok: true,
      status: 200,
      headers: { get: name => name === "content-length" ? String(bytes.length) : null },
      body
    };
  }

  function mockHappyPath({ firstListResult = [] } = {}) {
    serverFunctions.setServerPowerState.mockResolvedValue({ statusCode: 204 });
    serverFunctions.getServerResourceInfoById.mockResolvedValue({
      statusCode: 200,
      body: { json: async () => ({ attributes: { current_state: "offline" } }) }
    });
    serverFunctions.listServerFiles.mockResolvedValue(firstListResult);
    serverFunctions.deleteServerFiles.mockResolvedValue(204);
    serverFunctions.changeServerEgg.mockResolvedValue(200);
    serverFunctions.getFileUploadUrl.mockResolvedValue("https://wings.example.com/upload?token=x");
    serverFunctions.decompressFile.mockResolvedValue(204);
    global.fetch = jest.fn()
      .mockResolvedValueOnce(makeStreamResponse())  // download
      .mockResolvedValueOnce({ ok: true });         // upload
  }

  test("server file wipe: deleteServerFiles called with names from listServerFiles result", async () => {
    mockHappyPath({ firstListResult: [
      { attributes: { name: "server.jar" } },
      { attributes: { name: "mods" } },
      { attributes: { name: "config" } }
    ] });

    const p1 = runInstallation(mockInteraction, makeState(), { user: { id: "discord1", username: "testuser" } });
    await jest.runAllTimersAsync();
    await p1;

    expect(serverFunctions.deleteServerFiles).toHaveBeenCalledWith(
      "abc123",
      "discord1",
      [ "server.jar", "mods", "config" ]
    );
  });

  test("egg change: changeServerEgg called with egg ID from config.modpack_eggs[loaderType]", async () => {
    mockHappyPath();

    // config mock has modpack_eggs.forge = 3 and minecraft_nest_id = 1
    const p2 = runInstallation(mockInteraction, makeState({ loaderType: "forge" }), { user: { id: "discord1", username: "testuser" } });
    await jest.runAllTimersAsync();
    await p2;

    expect(serverFunctions.changeServerEgg).toHaveBeenCalledWith(42, 3, 1, {}, null);
  });

  test("egg change uses fabric egg ID for fabric loader", async () => {
    mockHappyPath();

    // config mock has modpack_eggs.fabric = 4
    const p3 = runInstallation(mockInteraction, makeState({ loaderType: "fabric" }), { user: { id: "discord1", username: "testuser" } });
    await jest.runAllTimersAsync();
    await p3;

    expect(serverFunctions.changeServerEgg).toHaveBeenCalledWith(42, 4, 1, {}, null);
  });

  test("shows download error when CurseForge fetch fails", async () => {
    serverFunctions.setServerPowerState.mockResolvedValue({ statusCode: 204 });
    serverFunctions.getServerResourceInfoById.mockResolvedValue({
      statusCode: 200,
      body: { json: async () => ({ attributes: { current_state: "offline" } }) }
    });
    serverFunctions.listServerFiles.mockResolvedValue([]);
    serverFunctions.deleteServerFiles.mockResolvedValue(204);
    serverFunctions.changeServerEgg.mockResolvedValue(200);
    serverFunctions.getFileUploadUrl.mockResolvedValue("https://wings.example.com/upload?token=x");
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403 });

    const p4 = runInstallation(mockInteraction, makeState(), { user: { id: "discord1", username: "testuser" } });
    await jest.runAllTimersAsync();
    await p4;

    expect(serverFunctions.decompressFile).not.toHaveBeenCalled();
  });

  test("shows upload error when getFileUploadUrl returns null", async () => {
    serverFunctions.setServerPowerState.mockResolvedValue({ statusCode: 204 });
    serverFunctions.getServerResourceInfoById.mockResolvedValue({
      statusCode: 200,
      body: { json: async () => ({ attributes: { current_state: "offline" } }) }
    });
    serverFunctions.listServerFiles.mockResolvedValue([]);
    serverFunctions.deleteServerFiles.mockResolvedValue(204);
    serverFunctions.changeServerEgg.mockResolvedValue(200);
    serverFunctions.getFileUploadUrl.mockResolvedValue(null);

    const p5 = runInstallation(mockInteraction, makeState(), { user: { id: "discord1", username: "testuser" } });
    await jest.runAllTimersAsync();
    await p5;

    expect(serverFunctions.decompressFile).not.toHaveBeenCalled();
  });

  test("shows client pack reminder in done message when usingClientPack is true", async () => {
    mockHappyPath();

    const p6 = runInstallation(mockInteraction, makeState({ usingClientPack: true }), { user: { id: "discord1", username: "testuser" } });
    await jest.runAllTimersAsync();
    await p6;

    const lastCall = mockInteraction.editReply.mock.calls.at(-1)[0];
    const container = lastCall.components[0];
    expect(JSON.stringify(container)).toContain("client modpack");
  });
});
