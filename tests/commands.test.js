// Mock dependencies BEFORE requiring commands
jest.mock("../utility/logger.js", () => ({
  log: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

jest.mock("../utility/permissions.js", () => ({
  PERMISSIONS: {
    GET_SERVICE_INFORMATION: 1,
    SET_CLIENT_KEY: 2,
    READ_SERVERS: 4,
    EDIT_SERVER_PROPERTIES: 8,
    CREATE_SERVER: 16,
    ADMINISTRATOR: 65536
  },
  authenticateUserForPermission: jest.fn()
}));

jest.mock("../utility/server_functions.js", () => ({
  getEggs: jest.fn(),
  getNests: jest.fn(),
  getNodes: jest.fn()
}));

jest.mock("../utility/helper_functions.js", () => ({
  reconstructCommand: jest.fn(),
  getUserId: jest.fn(),
  getCommands: jest.fn(),
  getMonitorUptime: jest.fn(),
  clientApiCall: jest.fn(),
  saveUsersFile: jest.fn(),
  userHasClientApiKey: jest.fn()
}));

jest.mock("../utility/error_messages.js", () => ({
  getErrorMessage: jest.fn((code) => {
    const messages = {
      USER_NOT_FOUND: "User not found.",
      INSUFFICIENT_PERMISSIONS: "Insufficient permissions.",
      SERVER_TIMEOUT: "Server timeout.",
      API_KEY_INVALID: "Invalid API key.",
      API_KEY_NOT_SET: "API key not set."
    };
    return messages[code] || "Unknown error.";
  })
}));

jest.mock("../config.json", () => ({
  debug: false
}), { virtual: true });

jest.mock("../users.json", () => ({
  users: [
    { panelId: 1, panelAPIKey: "test-key-1", discordId: "discord123", panelUsername: "testuser", permissions: 65536 },
    { panelId: 2, panelAPIKey: "test-key-2", discordId: "discord456", panelUsername: "user2", permissions: 1 }
  ]
}), { virtual: true });

const { execute: info } = require("../commands/ptero/info.js");
const { execute: setClientKey } = require("../commands/ptero/set_client_key.js");

describe("Pterobot Command Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Set up global variables used by commands
    global.version = "1.0.0";
    global.commitHash = "abc123";
    global.isDev = false;
    global.serverCount = 10;
    global.userCount = 5;
  });

  describe("info command", () => {
    test("should display service information", async () => {
      const helpers = require("../utility/helper_functions.js");

      helpers.reconstructCommand.mockReturnValue("/info");
      helpers.getMonitorUptime.mockResolvedValueOnce(99.5).mockResolvedValueOnce(98.2);

      const interaction = {
        reply: jest.fn(),
        followUp: jest.fn(),
        user: { id: "discord123", username: "testuser" },
        replied: false,
        deferred: false
      };

      await info(interaction);

      expect(interaction.reply).toHaveBeenCalled();
      expect(helpers.getMonitorUptime).toHaveBeenCalledWith('panel');
      expect(helpers.getMonitorUptime).toHaveBeenCalledWith('node');
    });

    test("should handle null uptime values", async () => {
      const helpers = require("../utility/helper_functions.js");

      helpers.reconstructCommand.mockReturnValue("/info");
      helpers.getMonitorUptime.mockResolvedValue(null);

      const interaction = {
        reply: jest.fn(),
        followUp: jest.fn(),
        user: { id: "discord123", username: "testuser" },
        replied: false,
        deferred: false
      };

      await info(interaction);

      expect(interaction.reply).toHaveBeenCalled();
    });

    test("should handle errors gracefully", async () => {
      const helpers = require("../utility/helper_functions.js");

      helpers.reconstructCommand.mockReturnValue("/info");
      helpers.getMonitorUptime.mockRejectedValue(new Error("API Error"));

      const mockCatch = jest.fn().mockResolvedValue(undefined);
      const interaction = {
        reply: jest.fn().mockReturnValue({ catch: mockCatch }),
        followUp: jest.fn().mockReturnValue({ catch: mockCatch }),
        user: { id: "discord123", username: "testuser" },
        replied: false,
        deferred: false
      };

      await info(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'An error occurred while loading the service information.',
          ephemeral: true
        })
      );
    });
  });

  describe("set-client-key command", () => {
    test("should set API key successfully with valid key", async () => {
      const permissions = require("../utility/permissions.js");
      const helpers = require("../utility/helper_functions.js");

      permissions.authenticateUserForPermission.mockReturnValue(true);
      helpers.getUserId.mockReturnValue(1);
      helpers.reconstructCommand.mockReturnValue("/set-client-key api-key:********");
      helpers.clientApiCall.mockResolvedValue({ statusCode: 200 });

      const interaction = {
        deferReply: jest.fn(),
        editReply: jest.fn(),
        user: { id: "discord123", username: "testuser" },
        options: {
          getString: jest.fn().mockReturnValue("new-valid-key")
        }
      };

      await setClientKey(interaction);

      expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
      expect(helpers.clientApiCall).toHaveBeenCalledWith(
        "client/account",
        "GET",
        null,
        "discord123",
        "new-valid-key"
      );
      expect(helpers.saveUsersFile).toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith({
        content: "Successfully set client API key.",
        flags: 64
      });
    });

    test("should reject invalid API key", async () => {
      const permissions = require("../utility/permissions.js");
      const helpers = require("../utility/helper_functions.js");

      permissions.authenticateUserForPermission.mockReturnValue(true);
      helpers.getUserId.mockReturnValue(1);
      helpers.reconstructCommand.mockReturnValue("/set-client-key api-key:********");
      helpers.clientApiCall.mockResolvedValue({ statusCode: 401 });

      const interaction = {
        deferReply: jest.fn(),
        editReply: jest.fn(),
        user: { id: "discord123", username: "testuser" },
        options: {
          getString: jest.fn().mockReturnValue("invalid-key")
        }
      };

      await setClientKey(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith("Invalid API key.");
      expect(helpers.saveUsersFile).not.toHaveBeenCalled();
    });

    test("should deny access for user not found", async () => {
      const permissions = require("../utility/permissions.js");

      permissions.authenticateUserForPermission.mockReturnValue(-1);

      const interaction = {
        deferReply: jest.fn(),
        editReply: jest.fn(),
        user: { id: "unknown-user", username: "unknown" },
        options: {
          getString: jest.fn().mockReturnValue("some-key")
        }
      };

      await setClientKey(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith("User not found.");
    });

    test("should deny access for insufficient permissions", async () => {
      const permissions = require("../utility/permissions.js");

      permissions.authenticateUserForPermission.mockReturnValue(false);

      const interaction = {
        deferReply: jest.fn(),
        editReply: jest.fn(),
        user: { id: "discord456", username: "user2" },
        options: {
          getString: jest.fn().mockReturnValue("some-key")
        }
      };

      await setClientKey(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith("Insufficient permissions.");
    });

    test("should handle missing API key input", async () => {
      const permissions = require("../utility/permissions.js");
      const helpers = require("../utility/helper_functions.js");

      permissions.authenticateUserForPermission.mockReturnValue(true);
      helpers.getUserId.mockReturnValue(1);

      const interaction = {
        deferReply: jest.fn(),
        editReply: jest.fn(),
        user: { id: "discord123", username: "testuser" },
        options: {
          getString: jest.fn().mockReturnValue(null)
        }
      };

      await setClientKey(interaction);

      // Should fail with INVALID_INPUT error
      expect(interaction.editReply).toHaveBeenCalled();
    });

    test("should not save when user panel ID not found in users array", async () => {
      const permissions = require("../utility/permissions.js");
      const helpers = require("../utility/helper_functions.js");

      permissions.authenticateUserForPermission.mockReturnValue(true);
      helpers.getUserId.mockReturnValue(999); // Non-existent panel ID
      helpers.reconstructCommand.mockReturnValue("/set-client-key api-key:********");
      helpers.clientApiCall.mockResolvedValue({ statusCode: 200 });

      const interaction = {
        deferReply: jest.fn(),
        editReply: jest.fn(),
        user: { id: "discord123", username: "testuser" },
        options: {
          getString: jest.fn().mockReturnValue("new-key")
        }
      };

      await setClientKey(interaction);

      expect(helpers.saveUsersFile).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith("Invalid API key.");
    });
  });
});
