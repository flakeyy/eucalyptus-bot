jest.mock("../utility/logger.js", () => ({
  log: jest.fn(),
  debug: jest.fn(),
  debugExtended: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

jest.mock("../utility/permissions.js", () => ({
  PERMISSIONS: { EDIT_SERVER_PROPERTIES: 8 },
  authenticateUserForPermission: jest.fn()
}));

jest.mock("../utility/server_functions.js", () => ({
  getClientServers: jest.fn(),
  setServerPowerState: jest.fn(),
  getServerResourceInfoById: jest.fn(),
  changeServerEgg: jest.fn(),
  reinstallServer: jest.fn(),
  getServerInstallStatus: jest.fn(),
  listServerFiles: jest.fn(),
  deleteServerFiles: jest.fn(),
  getFileUploadUrl: jest.fn(),
  decompressFile: jest.fn(),
  writeServerFile: jest.fn().mockResolvedValue(204),
  renameServerFiles: jest.fn().mockResolvedValue(204),
  createServerDirectory: jest.fn().mockResolvedValue(204),
  chmodServerFiles: jest.fn().mockResolvedValue(204)
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

jest.mock("../utility/url_validation.js", () => ({
  validateExternalUrl: jest.fn(async () => ({ ok: true }))
}));

jest.mock("../utility/boot_verify.js", () => ({
  verifyServerBoot: jest.fn()
}));

jest.mock("../config.json", () => ({
  debug: false,
  minecraft_nest_id: 1,
  modpack_eggs: { forge: 3, fabric: 4, neoforge: 5, quilt: 6 },
  mc_version_variable: "MC_VERSION",
  forge_build_type_variable: "BUILD_TYPE",
  loader_version_variables: {
    forge: "FORGE_VERSION",
    neoforge: "NEOFORGE_VERSION",
    fabric: "LOADER_VERSION",
    quilt: "LOADER_VERSION"
  },
  java_images: { "8": "img:java_8", "17": "img:java_17", "21": "img:java_21", "25": "img:java_25" },
  minecraft_java_map: {
    "26.1": 25, "1.20.5": 21, "1.20": 17, "1.19": 17, "1.17": 17, "1.12": 8, "1.8": 8
  }
}), { virtual: true });

// curseforge.js is NOT mocked globally — pure functions tested directly
const curseforge = require("../utility/curseforge.js");
const { parseProjectId, parseModpackSlug, detectLoaderType, findServerPack } = curseforge;

const { execute, runInstallation } = require("../commands/ptero/install_modpack.js");
const serverFunctions = require("../utility/server_functions.js");
const helpers = require("../utility/helper_functions.js");
const perms = require("../utility/permissions.js");
const bootVerify = require("../utility/boot_verify.js");
const testConfig = require("../config.json");
const { makeState, mockHappyPath, mockUpToTransfer } = require("./fixtures/modpack.js");

// ─── Project ID Parsing ─────────────────────────────────────────────────────

describe("parseProjectId", () => {
  test.each([
    [ "bare numeric ID string", "905765", 905765 ],
    [ "numeric ID with whitespace", "  905765  ", 905765 ],
    [ "CurseForge /projects/ URL", "https://www.curseforge.com/projects/905765", 905765 ]
  ])("parses %s", (_label, input, expected) => {
    expect(parseProjectId(input)).toBe(expected);
  });

  test.each([
    [ "slug-only URL", "https://www.curseforge.com/minecraft/modpacks/star-technology" ],
    [ "non-numeric string", "star-technology" ],
    [ "empty string", "" ],
    [ "null", null ]
  ])("returns null for %s", (_label, input) => {
    expect(parseProjectId(input)).toBeNull();
  });
});

// ─── Modpack Slug Parsing ───────────────────────────────────────────────────

describe("parseModpackSlug", () => {
  test.each([
    [ "https URL", "https://www.curseforge.com/minecraft/modpacks/star-technology", "star-technology" ],
    [ "no scheme",  "www.curseforge.com/minecraft/modpacks/star-technology", "star-technology" ],
    [ "no www",     "https://curseforge.com/minecraft/modpacks/all-the-mods-10", "all-the-mods-10" ],
    [ "URL with trailing path", "https://www.curseforge.com/minecraft/modpacks/star-technology/files/12345", "star-technology" ],
    [ "URL with whitespace", "  https://www.curseforge.com/minecraft/modpacks/star-technology  ", "star-technology" ],
    [ "uppercase slug normalized", "https://www.curseforge.com/minecraft/modpacks/Star-Technology", "star-technology" ]
  ])("parses %s", (_label, input, expected) => {
    expect(parseModpackSlug(input)).toBe(expected);
  });

  test.each([
    [ "bare numeric ID", "905765" ],
    [ "non-modpacks URL", "https://www.curseforge.com/minecraft/mc-mods/jei" ],
    [ "/projects/ URL", "https://www.curseforge.com/projects/905765" ],
    [ "empty string", "" ],
    [ "null", null ]
  ])("returns null for %s", (_label, input) => {
    expect(parseModpackSlug(input)).toBeNull();
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

describe("resolveLoaderType", () => {
  const {
    inferLoaderFromGameVersions,
    defaultLoaderForLegacyMc,
    resolveLoaderType
  } = require("../utility/curseforge.js");

  test("infers Forge from gameVersion labels", () => {
    expect(inferLoaderFromGameVersions([ "1.12.2", "Forge" ])).toBe("forge");
  });

  test("defaults pre-1.14 Minecraft to forge", () => {
    expect(defaultLoaderForLegacyMc("1.12.2")).toBe("forge");
    expect(defaultLoaderForLegacyMc("1.7.10")).toBe("forge");
    expect(defaultLoaderForLegacyMc("1.20.1")).toBeNull();
  });

  test("falls back to legacy MC when indexes omit modLoader", () => {
    expect(resolveLoaderType({
      indexes: [ { modLoader: 0, gameVersion: "1.12.2" } ],
      mcVersion: "1.12.2"
    })).toBe("forge");
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

  describe("getModpackBySlug", () => {
    test("returns the matching modpack when slug matches case-insensitively", async () => {
      const mockModpack = { id: 905765, slug: "star-technology", name: "Star Technology", gameId: 432, classId: 4471 };
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ data: [
          { id: 1, slug: "star-tech-fork" },
          mockModpack
        ] })
      });

      const result = await curseforge.getModpackBySlug("star-technology");
      expect(result).toEqual(mockModpack);
    });

    test("returns null when no slug matches exactly", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ data: [ { id: 1, slug: "star-tech-fork" } ] })
      });

      const result = await curseforge.getModpackBySlug("star-technology");
      expect(result).toBeNull();
    });

    test("returns null when search yields no results", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ data: [] })
      });

      const result = await curseforge.getModpackBySlug("does-not-exist");
      expect(result).toBeNull();
    });

    test("throws on HTTP error", async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });

      await expect(curseforge.getModpackBySlug("star-technology")).rejects.toThrow("CurseForge API error: HTTP 500");
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

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Error: USER_NOT_FOUND" })
    );
  });

  test("shows INSUFFICIENT_PERMISSIONS when user lacks EDIT_SERVER_PROPERTIES", async () => {
    perms.authenticateUserForPermission.mockReturnValue(false);

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Error: INSUFFICIENT_PERMISSIONS" })
    );
  });

  test("shows API_KEY_NOT_SET when no client API key is configured", async () => {
    perms.authenticateUserForPermission.mockReturnValue(true);
    helpers.userHasClientApiKey.mockReturnValue(false);

    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Error: API_KEY_NOT_SET" })
    );
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

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Error: CLIENT_API_FAILURE" })
    );
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
  const USER = { user: { id: "discord1", username: "testuser" } };
  let mockInteraction;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    serverFunctions.reinstallServer.mockResolvedValue(204);
    mockInteraction = { editReply: jest.fn().mockResolvedValue(undefined) };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function runAndSettle(state) {
    const p = runInstallation(mockInteraction, state, USER);
    await jest.runAllTimersAsync();
    await p;
  }

  test("server file wipe: deleteServerFiles is called with names from listServerFiles result", async () => {
    mockHappyPath(serverFunctions, { firstListResult: [
      { attributes: { name: "server.jar" } },
      { attributes: { name: "mods" } },
      { attributes: { name: "config" } }
    ] });

    await runAndSettle(makeState());

    expect(serverFunctions.deleteServerFiles).toHaveBeenCalledWith(
      "abc123",
      "discord1",
      [ "server.jar", "mods", "config" ]
    );
  });

  // config mock has modpack_eggs.forge = 3, modpack_eggs.fabric = 4, minecraft_nest_id = 1
  test.each([
    [ "forge", 3, { BUILD_TYPE: "latest", FORGE_VERSION: "" } ],
    [ "fabric", 4, {} ]
  ])("egg change: %s loader → changeServerEgg with eggId %i", async (loaderType, eggId, loaderEnv) => {
    mockHappyPath(serverFunctions);
    await runAndSettle(makeState({ loaderType }));
    expect(serverFunctions.changeServerEgg).toHaveBeenCalledWith(42, eggId, 1, loaderEnv, null);
  });

  test("egg change pins FORGE_VERSION from a curseforge manifest zip", async () => {
    const AdmZip = require("adm-zip");
    const zip = new AdmZip();
    zip.addFile("manifest.json", Buffer.from(JSON.stringify({
      minecraft: {
        version: "1.20.1",
        modLoaders: [ { id: "forge-47.4.20", primary: true } ]
      },
      files: []
    })));
    // Manifest with no files → resolveCurseforgeInstall still returns a plan;
    // stub the provider so we don't hit the network during egg-change focus.
    jest.spyOn(require("../utility/modpack_providers.js"), "resolveModpackInstall")
      .mockResolvedValue({
        kind: "plan",
        plan: { modFiles: [], extraFiles: [], overrideEntries: [], unavailable: [], mcVersion: "1.20.1" }
      });

    mockHappyPath(serverFunctions);
    const packBytes = zip.toBuffer();
    const { makeStreamResponse } = require("./fixtures/modpack.js");
    global.fetch = jest.fn()
      .mockResolvedValueOnce(makeStreamResponse(new Uint8Array(packBytes)))
      .mockResolvedValue({ ok: true });

    await runAndSettle(makeState({
      loaderType: "forge",
      usingClientPack: true,
      mcVersion: "1.20.1"
    }));

    expect(serverFunctions.changeServerEgg).toHaveBeenCalledWith(
      42, 3, 1,
      { MC_VERSION: "1.20.1", FORGE_VERSION: "1.20.1-47.4.20" },
      "img:java_17"
    );
  });

  test("skips archive upload when CurseForge download fails", async () => {
    mockUpToTransfer(serverFunctions);
    serverFunctions.getFileUploadUrl.mockResolvedValue("https://wings.example.com/upload?token=x");
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403 });

    await runAndSettle(makeState());

    expect(serverFunctions.decompressFile).not.toHaveBeenCalled();
  });

  test("fails archive install when getFileUploadUrl returns null", async () => {
    mockUpToTransfer(serverFunctions);
    serverFunctions.getFileUploadUrl.mockResolvedValue(null);
    const { makeArchivePackBytes, makeStreamResponse } = require("./fixtures/modpack.js");
    global.fetch = jest.fn().mockResolvedValue(makeStreamResponse(makeArchivePackBytes()));

    await runAndSettle(makeState());

    // Download succeeds; chunked upload cannot get a Wings URL.
    expect(serverFunctions.getFileUploadUrl).toHaveBeenCalled();
  });

  test("aborts before upload when reinstall reports install_failed", async () => {
    mockHappyPath(serverFunctions);
    serverFunctions.getServerInstallStatus.mockResolvedValue("install_failed");

    await runAndSettle(makeState());

    expect(serverFunctions.getFileUploadUrl).not.toHaveBeenCalled();
    expect(serverFunctions.decompressFile).not.toHaveBeenCalled();
    const lastCall = mockInteraction.editReply.mock.calls.at(-1)[0];
    expect(JSON.stringify(lastCall.components[0])).toContain("MODPACK_REINSTALL_FAILED");
  });

  test("aborts before upload when reinstall never finishes (stays installing)", async () => {
    mockHappyPath(serverFunctions);
    serverFunctions.getServerInstallStatus.mockResolvedValue("installing");

    await runAndSettle(makeState());

    expect(serverFunctions.getFileUploadUrl).not.toHaveBeenCalled();
    expect(serverFunctions.decompressFile).not.toHaveBeenCalled();
    const lastCall = mockInteraction.editReply.mock.calls.at(-1)[0];
    expect(JSON.stringify(lastCall.components[0])).toContain("MODPACK_REINSTALL_TIMEOUT");
  });

  test("uploads chunked archive batches after the install status clears", async () => {
    mockHappyPath(serverFunctions);
    // Two polls still installing, then idle — upload must wait for the clear.
    serverFunctions.getServerInstallStatus
      .mockResolvedValueOnce("installing")
      .mockResolvedValueOnce("installing")
      .mockResolvedValue(null);

    await runAndSettle(makeState());

    expect(serverFunctions.getServerInstallStatus).toHaveBeenCalledTimes(3);
    expect(serverFunctions.getFileUploadUrl).toHaveBeenCalled();
    expect(serverFunctions.decompressFile).toHaveBeenCalled();
  });

  test("includes client pack reminder when usingClientPack is true", async () => {
    mockHappyPath(serverFunctions);

    await runAndSettle(makeState({ usingClientPack: true }));

    const lastCall = mockInteraction.editReply.mock.calls.at(-1)[0];
    expect(JSON.stringify(lastCall.components[0])).toContain("client modpack");
  });

  test("does not run boot verification when config.boot_verify is absent", async () => {
    mockHappyPath(serverFunctions);
    await runAndSettle(makeState());
    expect(bootVerify.verifyServerBoot).not.toHaveBeenCalled();
  });

  describe("with boot_verify enabled", () => {
    beforeEach(() => {
      testConfig.boot_verify = { enabled: true, max_attempts: 3 };
    });

    afterEach(() => {
      delete testConfig.boot_verify;
    });

    test("reports a verified boot and drops the crash reminder", async () => {
      mockHappyPath(serverFunctions);
      bootVerify.verifyServerBoot.mockResolvedValue({
        success: true, attempts: 1, quarantined: [], reason: null, consoleTail: ""
      });

      await runAndSettle(makeState({ usingClientPack: true }));

      expect(bootVerify.verifyServerBoot).toHaveBeenCalledWith(expect.objectContaining({
        serverId: "abc123",
        userId: "discord1",
        settings: testConfig.boot_verify
      }));
      const lastCall = JSON.stringify(mockInteraction.editReply.mock.calls.at(-1)[0].components[0]);
      expect(lastCall).toContain("Boot verified");
      expect(lastCall).not.toContain("client modpack");
    });

    test("lists quarantined mods in the completion message", async () => {
      mockHappyPath(serverFunctions);
      bootVerify.verifyServerBoot.mockResolvedValue({
        success: true,
        attempts: 2,
        quarantined: [ { jar: "badmod.jar", reason: "loader error names mod 'badmod'" } ],
        reason: null,
        consoleTail: ""
      });

      await runAndSettle(makeState());

      const lastCall = JSON.stringify(mockInteraction.editReply.mock.calls.at(-1)[0].components[0]);
      expect(lastCall).toContain("badmod.jar");
      expect(lastCall).toContain("mods-disabled");
    });

    test("warns when verification fails", async () => {
      mockHappyPath(serverFunctions);
      bootVerify.verifyServerBoot.mockResolvedValue({
        success: false, attempts: 3, quarantined: [], reason: "unattributed", consoleTail: "boom"
      });

      await runAndSettle(makeState());

      const lastCall = JSON.stringify(mockInteraction.editReply.mock.calls.at(-1)[0].components[0]);
      expect(lastCall).toContain("did not boot successfully");
      expect(lastCall).toContain("unattributed");
    });

    test("a boot-verify crash does not fail the install completion", async () => {
      mockHappyPath(serverFunctions);
      bootVerify.verifyServerBoot.mockRejectedValue(new Error("ws exploded"));

      await runAndSettle(makeState());

      const lastCall = JSON.stringify(mockInteraction.editReply.mock.calls.at(-1)[0].components[0]);
      expect(lastCall).toContain("Installation Complete");
    });
  });
});
