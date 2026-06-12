jest.mock("../utility/logger.js", () => ({
  log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
}));

jest.mock("../utility/helper_functions.js", () => ({
  reconstructCommand: jest.fn(() => "/help"),
  getCommands: jest.fn()
}));

jest.mock("../config.json", () => ({ debug: false }), { virtual: true });

const { MessageFlags } = require("discord.js");
const { execute: help } = require("../commands/ptero/help.js");
const helpers = require("../utility/helper_functions.js");
const { makeReplyInteraction } = require("./fixtures/interaction.js");

beforeEach(() => {
  jest.clearAllMocks();
});

describe("help command", () => {
  test("replies with a help container grouping commands by category", async () => {
    helpers.getCommands.mockResolvedValue([
      { name: "info", description: "Retrieves current service information.", category: "Getting Started", requiresApiKey: false },
      { name: "servers", description: "Opens the interactive server management menu.", category: "Servers", requiresApiKey: true },
      { name: "mystery", description: "Uncategorized command." }
    ]);
    const interaction = makeReplyInteraction();

    await help(interaction);

    expect(helpers.getCommands).toHaveBeenCalledWith({ includeMeta: true });
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: expect.any(Number), components: expect.any(Array) })
    );

    const container = interaction.reply.mock.calls[0][0].components[0];
    const content = JSON.stringify(container.toJSON());
    expect(content).toContain("Getting Started");
    expect(content).toContain("Servers");
    expect(content).toContain("Other");
    expect(content).toContain("🔑");
  });

  // getCommands returning null and throwing collapse to the same catch branch;
  // one case is enough.
  test("on error, sends an ephemeral error message via reply", async () => {
    helpers.getCommands.mockRejectedValue(new Error("Filesystem error"));
    const interaction = makeReplyInteraction();

    await help(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "An error occurred while loading commands.",
        flags: MessageFlags.Ephemeral
      })
    );
  });
});
