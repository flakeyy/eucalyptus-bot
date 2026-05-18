jest.mock("../utility/logger.js", () => ({
  log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
}));

jest.mock("../utility/permissions.js", () => ({
  PERMISSIONS: {
    GET_SERVICE_INFORMATION: 1, SET_CLIENT_KEY: 2, READ_SERVERS: 4,
    EDIT_SERVER_PROPERTIES: 8, CREATE_SERVER: 16, ADMINISTRATOR: 65536,
    IMMUNITY: 131072
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
  reconstructCommand: jest.fn(() => "/admin"),
  getUserId: jest.fn(),
  userHasClientApiKey: jest.fn(),
  clientApiCall: jest.fn(),
  applicationApiCall: jest.fn()
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
  getErrorMessage: jest.fn(code => ({
    USER_NOT_FOUND: "User not found.",
    INSUFFICIENT_PERMISSIONS: "Insufficient permissions."
  }[code] || `Unknown error: ${code}`))
}));

jest.mock("../config.json", () => ({ debug: false }), { virtual: true });

const { execute: admin } = require("../commands/ptero/admin.js");
const permissions = require("../utility/permissions.js");
const database = require("../utility/database.js");
const helpers = require("../utility/helper_functions.js");
const { makeAdminInteraction } = require("./fixtures/interaction.js");

beforeEach(() => {
  jest.clearAllMocks();
});

// ── auth gates ────────────────────────────────────────────────────────────

describe("admin auth", () => {
  test("returns USER_NOT_FOUND when caller is not in the database", async () => {
    permissions.authenticateUserForPermission.mockReturnValue(-1);

    const interaction = makeAdminInteraction({ group: "user", sub: "view" });
    await admin(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith("User not found.");
  });

  test("returns INSUFFICIENT_PERMISSIONS for a non-admin caller", async () => {
    permissions.authenticateUserForPermission.mockReturnValue(false);

    const interaction = makeAdminInteraction({ group: "user", sub: "view" });
    await admin(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith("Insufficient permissions.");
  });
});

// ── /admin user view ──────────────────────────────────────────────────────

describe("/admin user view", () => {
  beforeEach(() => permissions.authenticateUserForPermission.mockReturnValue(true));

  test("replies with the target's username when they exist", async () => {
    database.getUserByDiscordId.mockReturnValue({
      discordId: "target123", panelUsername: "alice", panelId: 1,
      maximumAllowedMemory: 4096, permissions: 0, panelAPIKey: "key"
    });

    const interaction = makeAdminInteraction({ group: "user", sub: "view" });
    await admin(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("alice") })
    );
  });

  test("replies with not-found message when target is absent", async () => {
    database.getUserByDiscordId.mockReturnValue(null);

    const interaction = makeAdminInteraction({ group: "user", sub: "view" });
    await admin(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("No database entry") })
    );
  });
});

// ── /admin user create ────────────────────────────────────────────────────

describe("/admin user create", () => {
  beforeEach(() => permissions.authenticateUserForPermission.mockReturnValue(true));

  test("inserts user and confirms success", async () => {
    database.getUserByDiscordId
      .mockReturnValueOnce(null)  // existence check
      .mockReturnValueOnce({      // re-fetch after insert
        discordId: "target123", panelUsername: "alice", panelId: 7,
        maximumAllowedMemory: -1, permissions: 0, panelAPIKey: null
      });
    database.getUserByPanelId.mockReturnValue(null);

    const interaction = makeAdminInteraction({
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

  test("rejects when target already has a database entry", async () => {
    database.getUserByDiscordId.mockReturnValue({ discordId: "target123" });

    const interaction = makeAdminInteraction({
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

  test("rejects when panel_id is taken by another user", async () => {
    database.getUserByDiscordId.mockReturnValue(null);
    database.getUserByPanelId.mockReturnValue({ discordId: "someone-else" });

    const interaction = makeAdminInteraction({
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
});

// ── /admin user edit / delete ─────────────────────────────────────────────
// Both subcommands share the "target must exist" gate; cover it once each
// and verify the happy-path renders an interactive component message.

describe("/admin user edit + delete", () => {
  beforeEach(() => permissions.authenticateUserForPermission.mockReturnValue(true));

  test.each([ "edit", "delete" ])("%s: rejects when target is absent", async sub => {
    database.getUserByDiscordId.mockReturnValue(null);

    const interaction = makeAdminInteraction({ group: "user", sub });
    await admin(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("No database entry") })
    );
  });

  test.each([ "edit", "delete" ])("%s: shows interactive component when target exists", async sub => {
    database.getUserByDiscordId.mockReturnValue({
      discordId: "target123", panelUsername: "alice", panelId: 1,
      maximumAllowedMemory: -1, permissions: 0, panelAPIKey: null
    });

    const interaction = makeAdminInteraction({ group: "user", sub });
    await admin(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: expect.any(Array), flags: expect.any(Number) })
    );
    expect(interaction.fetchReply).toHaveBeenCalled();
  });
});

// ── /admin servers manage ─────────────────────────────────────────────────

describe("/admin servers manage", () => {
  beforeEach(() => permissions.authenticateUserForPermission.mockReturnValue(true));

  test("rejects when target has no database entry", async () => {
    database.getUserByDiscordId.mockReturnValue(null);

    const interaction = makeAdminInteraction({ group: "servers", sub: "manage" });
    await admin(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("No database entry") })
    );
  });

  test("rejects when target has no stored client API key", async () => {
    database.getUserByDiscordId.mockReturnValue({
      discordId: "target123", panelUsername: "alice", panelId: 1,
      maximumAllowedMemory: -1, permissions: 0, panelAPIKey: null
    });
    helpers.userHasClientApiKey.mockReturnValue(false);

    const interaction = makeAdminInteraction({ group: "servers", sub: "manage" });
    await admin(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("no client API key") })
    );
  });
});
