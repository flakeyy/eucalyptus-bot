jest.mock("../utility/logger.js", () => ({
  log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
}));

jest.mock("../utility/bootstrap.js", () => ({
  isBootstrapActive: jest.fn(),
  validateAndConsumeToken: jest.fn()
}));

jest.mock("../utility/database.js", () => ({
  getUserByDiscordId: jest.fn(),
  getUserByPanelId: jest.fn(),
  createUser: jest.fn()
}));

// init.js uses PERMISSIONS.ADMINISTRATOR | PERMISSIONS.IMMUNITY directly,
// so the values here must match utility/permissions.js.
jest.mock("../utility/permissions.js", () => ({
  PERMISSIONS: { ADMINISTRATOR: 1 << 16, IMMUNITY: 1 << 17 }
}));

const { execute: init } = require("../commands/ptero/init.js");
const bootstrap = require("../utility/bootstrap.js");
const database = require("../utility/database.js");

function makeInitInteraction({ token = "tok", panelUsername = "alice", panelId = 7 } = {}) {
  return {
    deferReply: jest.fn(),
    editReply: jest.fn(),
    user: { id: "discord123", username: "alice" },
    options: {
      getString: jest.fn(name => name === "token" ? token : panelUsername),
      getInteger: jest.fn(() => panelId)
    }
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Most tests want bootstrap active and the token valid; individual tests
  // override these.
  bootstrap.isBootstrapActive.mockReturnValue(true);
  bootstrap.validateAndConsumeToken.mockReturnValue(true);
  database.getUserByDiscordId.mockReturnValue(null);
  database.getUserByPanelId.mockReturnValue(null);
});

describe("/init", () => {
  test("creates the first admin account with ADMINISTRATOR | IMMUNITY", async () => {
    const ADMIN_AND_IMMUNITY = (1 << 16) | (1 << 17); // 196608
    const interaction = makeInitInteraction({ panelUsername: "alice", panelId: 7 });

    await init(interaction);

    expect(database.createUser).toHaveBeenCalledWith(
      "discord123", "alice", 7, -1, ADMIN_AND_IMMUNITY, null
    );
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Setup complete") })
    );
  });

  test("rejects when bootstrap is no longer active", async () => {
    bootstrap.isBootstrapActive.mockReturnValue(false);
    const interaction = makeInitInteraction();

    await init(interaction);

    expect(database.createUser).not.toHaveBeenCalled();
    expect(bootstrap.validateAndConsumeToken).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Setup is already complete") })
    );
  });

  test("rejects an invalid token without consuming it for the create call", async () => {
    bootstrap.validateAndConsumeToken.mockReturnValue(false);
    const interaction = makeInitInteraction({ token: "wrong" });

    await init(interaction);

    expect(database.createUser).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Invalid token") })
    );
  });

  test("rejects when the discord user is already in the database", async () => {
    database.getUserByDiscordId.mockReturnValue({ discordId: "discord123" });
    const interaction = makeInitInteraction();

    await init(interaction);

    expect(database.createUser).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("already exists") })
    );
  });

  test("rejects when the panel_id is already taken", async () => {
    database.getUserByPanelId.mockReturnValue({ discordId: "someone-else" });
    const interaction = makeInitInteraction({ panelId: 7 });

    await init(interaction);

    expect(database.createUser).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("already assigned") })
    );
  });

  test("surfaces the error message when createUser throws", async () => {
    database.createUser.mockImplementation(() => { throw new Error("UNIQUE constraint failed"); });
    const interaction = makeInitInteraction();

    await init(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("UNIQUE constraint failed") })
    );
  });
});
