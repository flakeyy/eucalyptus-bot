jest.mock("../utility/logger.js", () => ({
  log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
}));

jest.mock("../utility/permissions.js", () => ({
  PERMISSIONS: {
    GET_SERVICE_INFORMATION: 1, SET_CLIENT_KEY: 2, READ_SERVERS: 4,
    EDIT_SERVER_PROPERTIES: 8, CREATE_SERVER: 16, ADMINISTRATOR: 65536,
    IMMUNITY: 131072
  },
  authenticateUserForPermission: jest.fn(() => true)
}));

jest.mock("../utility/server_functions.js", () => ({
  getEggs: jest.fn(), getNests: jest.fn(), getNodes: jest.fn(),
  getClientServers: jest.fn(), getServerInfoById: jest.fn(),
  getServerResourceInfoById: jest.fn(), isServerSuspended: jest.fn(),
  suspendServer: jest.fn(), unsuspendServer: jest.fn(), deleteServer: jest.fn(),
  editServerInfo: jest.fn(), setServerPowerState: jest.fn(),
  getAvailableUserMemory: jest.fn().mockResolvedValue(null)
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
  getErrorMessage: jest.fn(code => `Error: ${code}`)
}));

jest.mock("../config.json", () => ({ debug: false }), { virtual: true });

const { execute: admin } = require("../commands/ptero/admin.js");
const database = require("../utility/database.js");

// Build an interaction whose fetchReply returns a stub collector. The collector
// captures its "collect" listener so we can drive it from the test.
function makeCollectorInteraction({ group, sub }) {
  const collectorListeners = {};
  const collector = {
    on: jest.fn((event, fn) => { collectorListeners[event] = fn; }),
    stop: jest.fn()
  };

  return {
    interaction: {
      deferReply: jest.fn(),
      editReply: jest.fn(),
      fetchReply: jest.fn().mockResolvedValue({
        createMessageComponentCollector: jest.fn(() => collector)
      }),
      user: { id: "admin999", username: "admin" },
      options: {
        getSubcommandGroup: jest.fn(() => group),
        getSubcommand: jest.fn(() => sub),
        getUser: jest.fn(() => ({ id: "target123", username: "target" })),
        getString: jest.fn(),
        getInteger: jest.fn(() => null)
      }
    },
    collectorListeners
  };
}

function makeButtonInteraction(customId) {
  return {
    customId,
    user: { id: "admin999", username: "admin" },
    deferUpdate: jest.fn().mockResolvedValue(undefined),
    editReply: jest.fn().mockResolvedValue(undefined)
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("/admin user delete — collector", () => {
  beforeEach(() => {
    database.getUserByDiscordId.mockReturnValue({
      discordId: "target123", panelUsername: "alice", panelId: 1,
      maximumAllowedMemory: -1, permissions: 0, panelAPIKey: null
    });
  });

  test("clicking confirm deletes the user from the database", async () => {
    const { interaction, collectorListeners } = makeCollectorInteraction({ group: "user", sub: "delete" });
    await admin(interaction);

    expect(collectorListeners.collect).toBeDefined();
    await collectorListeners.collect(makeButtonInteraction("admin-confirm-delete-user"));

    expect(database.deleteUser).toHaveBeenCalledWith("target123");
  });

  test("clicking cancel leaves the database untouched", async () => {
    const { interaction, collectorListeners } = makeCollectorInteraction({ group: "user", sub: "delete" });
    await admin(interaction);

    const cancelBtn = makeButtonInteraction("admin-cancel-delete-user");
    await collectorListeners.collect(cancelBtn);

    expect(database.deleteUser).not.toHaveBeenCalled();
    // Cancel branch sends a "Cancelled" message.
    expect(cancelBtn.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: expect.any(Array) })
    );
  });

  test("surfaces the error message when deleteUser throws", async () => {
    database.deleteUser.mockImplementation(() => { throw new Error("DB locked"); });

    const { interaction, collectorListeners } = makeCollectorInteraction({ group: "user", sub: "delete" });
    await admin(interaction);

    const btn = makeButtonInteraction("admin-confirm-delete-user");
    await collectorListeners.collect(btn);

    expect(btn.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("DB locked") })
    );
  });
});
