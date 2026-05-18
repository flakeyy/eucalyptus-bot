jest.mock("../utility/logger.js", () => ({
  log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
}));

jest.mock("../utility/permissions.js", () => ({
  PERMISSIONS: { SET_CLIENT_KEY: 2 },
  authenticateUserForPermission: jest.fn()
}));

jest.mock("../utility/helper_functions.js", () => ({
  reconstructCommand: jest.fn(() => "/set-client-key api-key:********"),
  getUserId: jest.fn(),
  clientApiCall: jest.fn()
}));

jest.mock("../utility/database.js", () => ({
  getUserByPanelId: jest.fn(),
  updateUserApiKey: jest.fn()
}));

jest.mock("../utility/error_messages.js", () => ({
  getErrorMessage: jest.fn(code => ({
    USER_NOT_FOUND: "User not found.",
    INSUFFICIENT_PERMISSIONS: "Insufficient permissions.",
    INVALID_INPUT: "Invalid input.",
    API_KEY_INVALID: "Invalid API key."
  }[code] || `Unknown error: ${code}`))
}));

jest.mock("../config.json", () => ({ debug: false }), { virtual: true });

const { execute: setClientKey } = require("../commands/ptero/set_client_key.js");
const permissions = require("../utility/permissions.js");
const helpers = require("../utility/helper_functions.js");
const database = require("../utility/database.js");
const { makeDeferredInteraction } = require("./fixtures/interaction.js");

beforeEach(() => {
  jest.clearAllMocks();
});

describe("set-client-key command", () => {
  test("validates the key against the panel, then writes it to the database", async () => {
    permissions.authenticateUserForPermission.mockReturnValue(true);
    helpers.getUserId.mockReturnValue(1);
    helpers.clientApiCall.mockResolvedValue({ statusCode: 200 });
    database.getUserByPanelId.mockReturnValue({ discordId: "discord123", panelId: 1 });

    const interaction = makeDeferredInteraction({ apiKey: "new-valid-key" });
    await setClientKey(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(database.updateUserApiKey).toHaveBeenCalledWith("discord123", "new-valid-key");
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "Successfully set client API key.",
      flags: 64
    });
  });

  test("rejects an API key that fails panel validation, without writing to the database", async () => {
    permissions.authenticateUserForPermission.mockReturnValue(true);
    helpers.getUserId.mockReturnValue(1);
    helpers.clientApiCall.mockResolvedValue({ statusCode: 401 });
    database.getUserByPanelId.mockReturnValue({ discordId: "discord123", panelId: 1 });

    const interaction = makeDeferredInteraction({ apiKey: "invalid-key" });
    await setClientKey(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith("Invalid API key.");
    expect(database.updateUserApiKey).not.toHaveBeenCalled();
  });

  test("denies access when the caller is not in the database", async () => {
    permissions.authenticateUserForPermission.mockReturnValue(-1);

    const interaction = makeDeferredInteraction();
    await setClientKey(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith("User not found.");
  });

  test("denies access when the caller lacks SET_CLIENT_KEY permission", async () => {
    permissions.authenticateUserForPermission.mockReturnValue(false);

    const interaction = makeDeferredInteraction();
    await setClientKey(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith("Insufficient permissions.");
  });

  test("rejects a null api-key option as INVALID_INPUT", async () => {
    permissions.authenticateUserForPermission.mockReturnValue(true);
    helpers.getUserId.mockReturnValue(1);

    const interaction = makeDeferredInteraction({ apiKey: null });
    await setClientKey(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith("Invalid input.");
    expect(helpers.clientApiCall).not.toHaveBeenCalled();
  });

  test("does not write when the panel_id is not in the users table", async () => {
    permissions.authenticateUserForPermission.mockReturnValue(true);
    helpers.getUserId.mockReturnValue(999);
    database.getUserByPanelId.mockReturnValue(null);

    const interaction = makeDeferredInteraction();
    await setClientKey(interaction);

    expect(helpers.clientApiCall).not.toHaveBeenCalled();
    expect(database.updateUserApiKey).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith("Invalid API key.");
  });
});
