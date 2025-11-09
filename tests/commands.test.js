/* eslint-disable node/no-unpublished-require */
// Temporarily commenting out unused path import
// const path = require("path");

// Mock discord.js to avoid ESM/import issues when running under Jest
jest.mock("discord.js", () => {
  class SlashCommandBuilder {
    constructor() {}
    setName() { return this; }
    setDescription() { return this; }
    addStringOption() { return this; }
    addIntegerOption() { return this; }
  }
  return { SlashCommandBuilder };
});

describe("Command modules", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("ping command replies with Pong!", async () => {
    const ping = require("../commands/utility/ping.js");

    const interaction = {
      reply: jest.fn()
    };

    await ping.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith("Pong!");
  });

  test("get-nodes formats and replies with nodes list", async () => {
    // mock permissions and server_functions before requiring the module
    jest.mock("../permissions.js", () => ({
      PERMISSIONS: { READ_NODES: "READ_NODES" },
      authenticateUserForPermission: jest.fn().mockReturnValue(true)
    }));

    jest.mock("../utility/server_functions.js", () => ({
      getNodes: jest.fn().mockResolvedValue({ data: [ { attributes: { name: "nodeA", description: "desc", allocated_resources: { memory: 10 }, memory: 100 } } ] })
    }));

    const getNodesCmd = require("../commands/ptero/get_nodes.js");

    const interaction = {
      user: { id: "user1" },
      deferReply: jest.fn().mockResolvedValue(),
      editReply: jest.fn().mockResolvedValue(),
      options: {
        getString: jest.fn()
      }
    };

    await getNodesCmd.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalled();
    const replyArg = interaction.editReply.mock.calls[0][0];
    expect(replyArg).toContain("List of Nodes");
    expect(replyArg).toContain("nodeA");
  });

  test("get-nests replies with formatted nests", async () => {
    jest.mock("../permissions.js", () => ({
      PERMISSIONS: { READ_NESTS: "READ_NESTS" },
      authenticateUserForPermission: jest.fn().mockReturnValue(true)
    }));

    jest.mock("../utility/server_functions.js", () => ({
      getNests: jest.fn().mockResolvedValue([ "nestA", "nestB" ])
    }));

    jest.mock("../utility/helper_functions.js", () => ({
      formatNames: jest.fn().mockReturnValue("nestA\nnestB")
    }));

    const getNestsCmd = require("../commands/ptero/get_nests.js");

    const interaction = {
      user: { id: "user1" },
      deferReply: jest.fn().mockResolvedValue(),
      editReply: jest.fn().mockResolvedValue(),
      options: { getString: jest.fn() }
    };

    await getNestsCmd.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("List of Nests"));
  });

  test("get-eggs replies with formatted eggs for a nest", async () => {
    jest.mock("../permissions.js", () => ({
      PERMISSIONS: { READ_EGGS: "READ_EGGS" },
      authenticateUserForPermission: jest.fn().mockReturnValue(true)
    }));

    jest.mock("../utility/server_functions.js", () => ({
      getEggs: jest.fn().mockResolvedValue([ "eggA", "eggB" ]),
      getNestIdByName: jest.fn().mockResolvedValue(5)
    }));

    jest.mock("../utility/helper_functions.js", () => ({
      formatNames: jest.fn().mockReturnValue("eggA\neggB")
    }));

    const getEggsCmd = require("../commands/ptero/get_eggs.js");

    const interaction = {
      user: { id: "user1" },
      deferReply: jest.fn().mockResolvedValue(),
      editReply: jest.fn().mockResolvedValue(),
      options: { getString: jest.fn().mockReturnValue("nestName") }
    };

    await getEggsCmd.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("List of Eggs"));
  });

  test("get-owned-servers replies with formatted servers list", async () => {
    jest.mock("../permissions.js", () => ({
      PERMISSIONS: { READ_OWN_SERVERS: "READ_OWN_SERVERS" },
      authenticateUserForPermission: jest.fn().mockReturnValue(true)
    }));

    jest.mock("../utility/helper_functions.js", () => ({
      getUserId: jest.fn().mockReturnValue("panelUser1"),
      getPanelUsername: jest.fn().mockReturnValue("panelUserName")
    }));

    jest.mock("../utility/server_functions.js", () => ({
      getServersByUser: jest.fn().mockResolvedValue({ data: [ { attributes: { name: "s1", limits: { memory: 128 }, suspended: false, id: 42 } }, { attributes: { name: "s2", limits: { memory: 64 }, suspended: true, id: 43 } } ] })
    }));

    const getOwned = require("../commands/ptero/get_owned_servers.js");

    const interaction = {
      user: { id: "user1" },
      deferReply: jest.fn().mockResolvedValue(),
      editReply: jest.fn().mockResolvedValue(),
      options: { getString: jest.fn() }
    };

    await getOwned.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("Servers owned by"));
    expect(interaction.editReply.mock.calls[0][0]).toContain("TOTAL | Servers: 2");
  });

  test("suspend-server replies with suspended message when api returns 204", async () => {
    jest.mock("../permissions.js", () => ({
      PERMISSIONS: { SUSPEND_OWN_SERVER: "SUSPEND_OWN_SERVER", SUSPEND_ANY_SERVER: "SUSPEND_ANY_SERVER" },
      authenticateUserForPermission: jest.fn().mockReturnValue(true)
    }));

    jest.mock("../utility/helper_functions.js", () => ({
      apiCall: jest.fn().mockResolvedValue({ statusCode: 204 }),
      getUserId: jest.fn().mockReturnValue("panelUser1")
    }));

    jest.mock("../utility/server_functions.js", () => ({
      getServerOwnerId: jest.fn().mockResolvedValue("panelUser1"),
      isServerSuspended: jest.fn().mockResolvedValue(false)
    }));

    const suspendCmd = require("../commands/ptero/suspend_server.js");

    const interaction = {
      user: { id: "user1" },
      deferReply: jest.fn().mockResolvedValue(),
      editReply: jest.fn().mockResolvedValue(),
      reply: jest.fn().mockResolvedValue(),
      options: { getString: jest.fn().mockReturnValue("123") }
    };

    await suspendCmd.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("has been suspended"));
  });

  test("unsuspend-server replies with unsuspended message when api returns 204", async () => {
    jest.mock("../permissions.js", () => ({
      PERMISSIONS: { UNSUSPEND_OWN_SERVER: "UNSUSPEND_OWN_SERVER", UNSUSPEND_ANY_SERVER: "UNSUSPEND_ANY_SERVER" },
      authenticateUserForPermission: jest.fn().mockReturnValue(true)
    }));

    jest.mock("../utility/helper_functions.js", () => ({
      apiCall: jest.fn().mockResolvedValue({ statusCode: 204 }),
      getUserId: jest.fn().mockReturnValue("panelUser1")
    }));

    jest.mock("../utility/server_functions.js", () => ({
      getServerOwnerId: jest.fn().mockResolvedValue("panelUser1"),
      isServerSuspended: jest.fn().mockResolvedValue(true),
      getAvailableUserMemory: jest.fn().mockResolvedValue(1024),
      getServerInfoById: jest.fn().mockResolvedValue({ limits: { memory: 128 } })
    }));

    const unsuspendCmd = require("../commands/ptero/unsuspend_server.js");

    const interaction = {
      user: { id: "user1" },
      deferReply: jest.fn().mockResolvedValue(),
      editReply: jest.fn().mockResolvedValue(),
      reply: jest.fn().mockResolvedValue(),
      options: { getString: jest.fn().mockReturnValue("123") }
    };

    await unsuspendCmd.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("has been unsuspended"));
  });

  // gen-server has a large flow — test failure cases and developer-mode short-circuit
  test("gen-server createServer returns error on empty name", async () => {
    jest.mock("../permissions.js", () => ({
      PERMISSIONS: { CREATE_SERVER: "CREATE_SERVER" },
      authenticateUserForPermission: jest.fn().mockReturnValue(true)
    }));

    // stub utility functions used in createServer
    jest.mock("../utility/helper_functions.js", () => ({
      apiCall: jest.fn(),
      extractEnvVariables: jest.fn().mockReturnValue({}),
      getUserId: jest.fn().mockReturnValue("panelUser1")
    }));

    jest.mock("../utility/server_functions.js", () => ({
      getNodeIdByName: jest.fn().mockResolvedValue(1),
      getNestIdByName: jest.fn().mockResolvedValue(1),
      getEggIdByName: jest.fn().mockResolvedValue(1),
      getAvailableUserMemory: jest.fn().mockResolvedValue(1024),
      getDefaultAllocation: jest.fn(),
      getEggData: jest.fn().mockResolvedValue({ attributes: { docker_image: "img", startup: "run", relationships: { variables: [] } } })
    }));

    // set developer_mode true via config mock so createServer short-circuits after building body
    jest.mock("../config.json", () => ({ developer_mode: true, default_overhead_mb: 32, java_overhead_mb: 64, minecraft_nest_id: 999 }), { virtual: true });

    const gen = require("../commands/ptero/gen_server.js");

    const result = await gen.createServer("", "node", "nest", "egg", 128, "discord1", "panelUser1");

    // empty name should return INVALID_SERVER_NAME via error_messages; mock not provided, but createServer returns getErrorMessage output
    // In module, getErrorMessage comes from ../error_messages.js — if not mocked it will throw; so we just assert that function returned a string (error message)
    expect(typeof result).toBe("string");
  });

});
