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
  getNodes: jest.fn(),
  getClientServers: jest.fn(),
  getServerInfoById: jest.fn(),
  getServerResourceInfoById: jest.fn(),
  isServerSuspended: jest.fn(),
  suspendServer: jest.fn(),
  unsuspendServer: jest.fn(),
  deleteServer: jest.fn(),
  editServerInfo: jest.fn(),
  setServerPowerState: jest.fn(),
  getAvailableUserMemory: jest.fn().mockResolvedValue(null)
}));

jest.mock("../commands/ptero/server_menu.js", () => ({
  buildServerSelectMenu: jest.fn(() => ({
    setCustomId: jest.fn().mockReturnThis(),
    setPlaceholder: jest.fn().mockReturnThis(),
    setDisabled: jest.fn().mockReturnThis(),
    addOptions: jest.fn().mockReturnThis()
  })),
  buildMainServerView: jest.fn(),
  data: { name: "servers", toJSON: jest.fn(() => ({})) },
  execute: jest.fn()
}));

jest.mock("../utility/helper_functions.js", () => ({
  reconstructCommand: jest.fn(),
  getUserId: jest.fn(),
  getCommands: jest.fn(),
  getMonitorUptime: jest.fn(),
  clientApiCall: jest.fn(),
  userHasClientApiKey: jest.fn()
}));

jest.mock("../utility/database.js", () => ({
  getUserByPanelId: jest.fn(),
  getUserByDiscordId: jest.fn(),
  updateUserApiKey: jest.fn(),
  createUser: jest.fn(),
  updateUser: jest.fn(),
  deleteUser: jest.fn()
}));

jest.mock("../utility/error_messages.js", () => ({
  getErrorMessage: jest.fn(code => {
    const messages = {
      USER_NOT_FOUND: "User not found.",
      INSUFFICIENT_PERMISSIONS: "Insufficient permissions.",
      INVALID_INPUT: "Invalid input.",
      API_KEY_INVALID: "Invalid API key.",
      API_KEY_NOT_SET: "API key not set."
    };
    return messages[code] || `Unknown error: ${code}`;
  })
}));

jest.mock("../config.json", () => ({
  debug: false
}), { virtual: true });

const { execute: info } = require("../commands/ptero/info.js");
const { execute: help } = require("../commands/ptero/help.js");
const { execute: setClientKey } = require("../commands/ptero/set_client_key.js");
const { execute: admin } = require("../commands/ptero/admin.js");

describe("Pterobot Command Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
        reply: jest.fn().mockResolvedValue(undefined),
        followUp: jest.fn().mockResolvedValue(undefined),
        user: { id: "discord123", username: "testuser" },
        replied: false,
        deferred: false
      };

      await info(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ flags: expect.any(Number) })
      );
      expect(helpers.getMonitorUptime).toHaveBeenCalledWith("panel");
      expect(helpers.getMonitorUptime).toHaveBeenCalledWith("node");
    });

    test("should handle null uptime values", async () => {
      const helpers = require("../utility/helper_functions.js");

      helpers.reconstructCommand.mockReturnValue("/info");
      helpers.getMonitorUptime.mockResolvedValue(null);

      const interaction = {
        reply: jest.fn().mockResolvedValue(undefined),
        followUp: jest.fn().mockResolvedValue(undefined),
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

      const interaction = {
        reply: jest.fn().mockResolvedValue(undefined),
        followUp: jest.fn().mockResolvedValue(undefined),
        user: { id: "discord123", username: "testuser" },
        replied: false,
        deferred: false
      };

      await info(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "An error occurred while loading the service information.",
          ephemeral: true
        })
      );
    });

    test("should use followUp when already replied", async () => {
      const helpers = require("../utility/helper_functions.js");

      helpers.reconstructCommand.mockReturnValue("/info");
      helpers.getMonitorUptime.mockRejectedValue(new Error("API Error"));

      const interaction = {
        reply: jest.fn().mockResolvedValue(undefined),
        followUp: jest.fn().mockResolvedValue(undefined),
        user: { id: "discord123", username: "testuser" },
        replied: true,
        deferred: false
      };

      await info(interaction);

      expect(interaction.followUp).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "An error occurred while loading the service information.",
          ephemeral: true
        })
      );
      expect(interaction.reply).not.toHaveBeenCalled();
    });
  });

  describe("help command", () => {
    test("should display available commands", async () => {
      const helpers = require("../utility/helper_functions.js");

      helpers.reconstructCommand.mockReturnValue("/help");
      helpers.getCommands.mockResolvedValue([
        { name: "info", description: "Retrieves current service information." },
        { name: "help", description: "Displays available commands." },
        { name: "set-client-key", description: "Sets your client API key." }
      ]);

      const interaction = {
        reply: jest.fn().mockResolvedValue(undefined),
        followUp: jest.fn().mockResolvedValue(undefined),
        user: { id: "discord123", username: "testuser" },
        replied: false,
        deferred: false
      };

      await help(interaction);

      expect(helpers.getCommands).toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ flags: expect.any(Number) })
      );
    });

    test("should handle getCommands returning null", async () => {
      const helpers = require("../utility/helper_functions.js");

      helpers.reconstructCommand.mockReturnValue("/help");
      helpers.getCommands.mockResolvedValue(null);

      const interaction = {
        reply: jest.fn().mockResolvedValue(undefined),
        followUp: jest.fn().mockResolvedValue(undefined),
        user: { id: "discord123", username: "testuser" },
        replied: false,
        deferred: false
      };

      await help(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "An error occurred while loading commands.",
          ephemeral: true
        })
      );
    });

    test("should handle getCommands throwing an error", async () => {
      const helpers = require("../utility/helper_functions.js");

      helpers.reconstructCommand.mockReturnValue("/help");
      helpers.getCommands.mockRejectedValue(new Error("Filesystem error"));

      const interaction = {
        reply: jest.fn().mockResolvedValue(undefined),
        followUp: jest.fn().mockResolvedValue(undefined),
        user: { id: "discord123", username: "testuser" },
        replied: false,
        deferred: false
      };

      await help(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "An error occurred while loading commands.",
          ephemeral: true
        })
      );
    });
  });

  describe("set-client-key command", () => {
    test("should set API key successfully with valid key", async () => {
      const permissions = require("../utility/permissions.js");
      const helpers = require("../utility/helper_functions.js");
      const database = require("../utility/database.js");

      permissions.authenticateUserForPermission.mockReturnValue(true);
      helpers.getUserId.mockReturnValue(1);
      helpers.reconstructCommand.mockReturnValue("/set-client-key api-key:********");
      helpers.clientApiCall.mockResolvedValue({ statusCode: 200 });
      database.getUserByPanelId.mockReturnValue({ discordId: "discord123", panelId: 1 });

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
      expect(database.updateUserApiKey).toHaveBeenCalledWith("discord123", "new-valid-key");
      expect(interaction.editReply).toHaveBeenCalledWith({
        content: "Successfully set client API key.",
        flags: 64
      });
    });

    test("should reject invalid API key", async () => {
      const permissions = require("../utility/permissions.js");
      const helpers = require("../utility/helper_functions.js");
      const database = require("../utility/database.js");

      permissions.authenticateUserForPermission.mockReturnValue(true);
      helpers.getUserId.mockReturnValue(1);
      helpers.reconstructCommand.mockReturnValue("/set-client-key api-key:********");
      helpers.clientApiCall.mockResolvedValue({ statusCode: 401 });
      database.getUserByPanelId.mockReturnValue({ discordId: "discord123", panelId: 1 });

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
      expect(database.updateUserApiKey).not.toHaveBeenCalled();
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
      helpers.reconstructCommand.mockReturnValue("/set-client-key api-key:********");

      const interaction = {
        deferReply: jest.fn(),
        editReply: jest.fn(),
        user: { id: "discord123", username: "testuser" },
        options: {
          getString: jest.fn().mockReturnValue(null)
        }
      };

      await setClientKey(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith("Invalid input.");
      expect(helpers.clientApiCall).not.toHaveBeenCalled();
    });

    test("should not save when user panel ID not found in users array", async () => {
      const permissions = require("../utility/permissions.js");
      const helpers = require("../utility/helper_functions.js");
      const database = require("../utility/database.js");

      permissions.authenticateUserForPermission.mockReturnValue(true);
      helpers.getUserId.mockReturnValue(999); // panel ID not in users array
      helpers.reconstructCommand.mockReturnValue("/set-client-key api-key:********");
      database.getUserByPanelId.mockReturnValue(null);

      const interaction = {
        deferReply: jest.fn(),
        editReply: jest.fn(),
        user: { id: "discord123", username: "testuser" },
        options: {
          getString: jest.fn().mockReturnValue("some-key")
        }
      };

      await setClientKey(interaction);

      expect(helpers.clientApiCall).not.toHaveBeenCalled();
      expect(database.updateUserApiKey).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith("Invalid API key.");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // admin command
  // ─────────────────────────────────────────────────────────────────────────

  describe("admin command", () => {
    function makeInteraction({ group = null, sub, discordUser = { id: "target123", username: "target" }, extraOptions = {} } = {}) {
      return {
        deferReply: jest.fn(),
        editReply: jest.fn(),
        fetchReply: jest.fn().mockResolvedValue({
          createMessageComponentCollector: jest.fn().mockReturnValue({
            on: jest.fn(),
            stop: jest.fn()
          })
        }),
        user: { id: "admin999", username: "admin" },
        options: {
          getSubcommandGroup: jest.fn(() => group),
          getSubcommand: jest.fn(() => sub),
          getUser: jest.fn(() => discordUser),
          getString: jest.fn(),
          getInteger: jest.fn(() => null),
          ...extraOptions
        }
      };
    }

    beforeEach(() => {
      const helpers = require("../utility/helper_functions.js");
      helpers.reconstructCommand.mockReturnValue("/admin");
    });

    // ── auth gates ──────────────────────────────────────────────────────────

    test("returns USER_NOT_FOUND when admin is not in the database", async () => {
      const permissions = require("../utility/permissions.js");
      permissions.authenticateUserForPermission.mockReturnValue(-1);

      const interaction = makeInteraction({ group: "user", sub: "view" });
      await admin(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith("User not found.");
    });

    test("returns INSUFFICIENT_PERMISSIONS for a non-admin caller", async () => {
      const permissions = require("../utility/permissions.js");
      permissions.authenticateUserForPermission.mockReturnValue(false);

      const interaction = makeInteraction({ group: "user", sub: "view" });
      await admin(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith("Insufficient permissions.");
    });

    // ── /admin user view ────────────────────────────────────────────────────

    test("user view: replies with user info when target exists", async () => {
      const permissions = require("../utility/permissions.js");
      const database = require("../utility/database.js");
      permissions.authenticateUserForPermission.mockReturnValue(true);
      database.getUserByDiscordId.mockReturnValue({
        discordId: "target123", panelUsername: "alice", panelId: 1,
        maximumAllowedMemory: 4096, permissions: 0, panelAPIKey: "key"
      });

      const interaction = makeInteraction({ group: "user", sub: "view" });
      await admin(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("alice") })
      );
    });

    test("user view: replies with not-found message when target is absent", async () => {
      const permissions = require("../utility/permissions.js");
      const database = require("../utility/database.js");
      permissions.authenticateUserForPermission.mockReturnValue(true);
      database.getUserByDiscordId.mockReturnValue(null);

      const interaction = makeInteraction({ group: "user", sub: "view" });
      await admin(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("No database entry") })
      );
    });

    // ── /admin user create ──────────────────────────────────────────────────

    test("user create: inserts user and confirms success", async () => {
      const permissions = require("../utility/permissions.js");
      const database = require("../utility/database.js");
      permissions.authenticateUserForPermission.mockReturnValue(true);
      database.getUserByDiscordId
        .mockReturnValueOnce(null)  // existence check → not found
        .mockReturnValueOnce({     // re-fetch after insert
          discordId: "target123", panelUsername: "alice", panelId: 7,
          maximumAllowedMemory: -1, permissions: 0, panelAPIKey: null
        });
      database.getUserByPanelId.mockReturnValue(null);

      const interaction = makeInteraction({
        group: "user", sub: "create",
        extraOptions: {
          getString: jest.fn(() => "alice"),
          getInteger: jest.fn(name => name === "panel_id" ? 7 : null)
        }
      });
      await admin(interaction);

      expect(database.createUser).toHaveBeenCalledWith("target123", "alice", 7, -1, 0, null);
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("created successfully") })
      );
    });

    test("user create: rejects when target already has a database entry", async () => {
      const permissions = require("../utility/permissions.js");
      const database = require("../utility/database.js");
      permissions.authenticateUserForPermission.mockReturnValue(true);
      database.getUserByDiscordId.mockReturnValue({ discordId: "target123" });

      const interaction = makeInteraction({
        group: "user", sub: "create",
        extraOptions: {
          getString: jest.fn(() => "alice"),
          getInteger: jest.fn(() => 7)
        }
      });
      await admin(interaction);

      expect(database.createUser).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("already has a database entry") })
      );
    });

    test("user create: rejects when panel_id is taken by another user", async () => {
      const permissions = require("../utility/permissions.js");
      const database = require("../utility/database.js");
      permissions.authenticateUserForPermission.mockReturnValue(true);
      database.getUserByDiscordId.mockReturnValue(null);
      database.getUserByPanelId.mockReturnValue({ discordId: "someone-else" });

      const interaction = makeInteraction({
        group: "user", sub: "create",
        extraOptions: {
          getString: jest.fn(() => "alice"),
          getInteger: jest.fn(() => 7)
        }
      });
      await admin(interaction);

      expect(database.createUser).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("already assigned") })
      );
    });

    // ── /admin user edit ────────────────────────────────────────────────────

    test("user edit: replies with not-found message when target is absent", async () => {
      const permissions = require("../utility/permissions.js");
      const database = require("../utility/database.js");
      permissions.authenticateUserForPermission.mockReturnValue(true);
      database.getUserByDiscordId.mockReturnValue(null);

      const interaction = makeInteraction({ group: "user", sub: "edit" });
      await admin(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("No database entry") })
      );
    });

    test("user edit: shows interactive menu when target exists", async () => {
      const permissions = require("../utility/permissions.js");
      const database = require("../utility/database.js");
      permissions.authenticateUserForPermission.mockReturnValue(true);
      database.getUserByDiscordId.mockReturnValue({
        discordId: "target123", panelUsername: "alice", panelId: 1,
        maximumAllowedMemory: -1, permissions: 0, panelAPIKey: null
      });

      const interaction = makeInteraction({ group: "user", sub: "edit" });
      await admin(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ components: expect.any(Array), flags: expect.any(Number) })
      );
      expect(interaction.fetchReply).toHaveBeenCalled();
    });

    // ── /admin user delete ──────────────────────────────────────────────────

    test("user delete: replies with not-found message when target is absent", async () => {
      const permissions = require("../utility/permissions.js");
      const database = require("../utility/database.js");
      permissions.authenticateUserForPermission.mockReturnValue(true);
      database.getUserByDiscordId.mockReturnValue(null);

      const interaction = makeInteraction({ group: "user", sub: "delete" });
      await admin(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("No database entry") })
      );
    });

    test("user delete: shows confirmation prompt when target exists", async () => {
      const permissions = require("../utility/permissions.js");
      const database = require("../utility/database.js");
      permissions.authenticateUserForPermission.mockReturnValue(true);
      database.getUserByDiscordId.mockReturnValue({
        discordId: "target123", panelUsername: "alice", panelId: 1,
        maximumAllowedMemory: -1, permissions: 0, panelAPIKey: null
      });

      const interaction = makeInteraction({ group: "user", sub: "delete" });
      await admin(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ components: expect.any(Array), flags: expect.any(Number) })
      );
      expect(interaction.fetchReply).toHaveBeenCalled();
    });

    // ── /admin servers ──────────────────────────────────────────────────────

    test("servers: replies with not-found message when target has no database entry", async () => {
      const permissions = require("../utility/permissions.js");
      const database = require("../utility/database.js");
      permissions.authenticateUserForPermission.mockReturnValue(true);
      database.getUserByDiscordId.mockReturnValue(null);

      const interaction = makeInteraction({ group: null, sub: "servers" });
      await admin(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("No database entry") })
      );
    });

    test("servers: replies with no-API-key message when target has no stored key", async () => {
      const permissions = require("../utility/permissions.js");
      const database = require("../utility/database.js");
      const helpers = require("../utility/helper_functions.js");
      permissions.authenticateUserForPermission.mockReturnValue(true);
      database.getUserByDiscordId.mockReturnValue({
        discordId: "target123", panelUsername: "alice", panelId: 1,
        maximumAllowedMemory: -1, permissions: 0, panelAPIKey: null
      });
      helpers.userHasClientApiKey.mockReturnValue(false);

      const interaction = makeInteraction({ group: null, sub: "servers" });
      await admin(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("no client API key") })
      );
    });
  });
});
