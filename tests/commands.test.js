/* eslint-disable node/no-unpublished-require */
const { SlashCommandBuilder } = require("discord.js");

const mockPermissions = {
  READ_NESTS: 1,
  READ_EGGS: 2,
  CREATE_SERVER: 4,
  SUSPEND_OWN_SERVER: 8,
  UNSUSPEND_OWN_SERVER: 16,
  DELETE_OWN_SERVER: 32,
  READ_OWN_SERVERS: 64,
  EDIT_OWN_SERVER_SETTINGS: 128,
  EDIT_ANY_SERVER_SETTINGS: 256,
  SUSPEND_ANY_SERVER: 512,
  UNSUSPEND_ANY_SERVER: 1024,
  ADMINISTRATOR: 65536
};

jest.mock("../utility/permissions.js", () => ({
  PERMISSIONS: mockPermissions,
  authenticateUserForPermission: jest.fn().mockReturnValue(true)
}));

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

describe("get-nests command", () => {
  test("formats and replies with nests list", async () => {
    jest.resetModules();
    const mockGetNests = jest.fn().mockResolvedValue({
      data: [
        { attributes: { name: "nest1", description: "First nest" } },
        { attributes: { name: "nest2", description: "Second nest" } }
      ]
    });

    jest.mock("../utility/helper_functions.js", () => ({
      apiCall: jest.fn().mockResolvedValue({
        body: { json: jest.fn().mockResolvedValue({
          data: [
            { attributes: { name: "nest1", description: "First nest" } },
            { attributes: { name: "nest2", description: "Second nest" } }
          ]
        })}
      }),
      getUserId: jest.fn().mockReturnValue("panelUser1"),
      formatNames: jest.fn().mockImplementation(nests => nests.data.map(n => `- ${n.attributes.name} | ${n.attributes.description}`).join("\n"))
    }));

    jest.mock("../utility/server_functions.js", () => ({
      getNests: mockGetNests,
      getServerOwnerId: jest.fn().mockResolvedValue("panelUser1"),
      editServerDetails: jest.fn().mockResolvedValue({ statusCode: 200 }),
      editServerBuild: jest.fn().mockResolvedValue(200),
      getAvailableUserMemory: jest.fn().mockResolvedValue(2048)
    }));

    const interaction = {
      deferReply: jest.fn().mockResolvedValue(),
      editReply: jest.fn().mockResolvedValue(),
      user: { id: "discord1" }
    };

    // Import after mocking
    const { getNests } = require("../utility/server_functions.js");
    const getNestsCommand = require("../commands/ptero/get_nests.js");
    global.getNests = getNests;

    await getNestsCommand.execute(interaction);
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("List of Nests"));
  });

      jest.mock("../utility/server_functions.js", () => ({
        getNests: mockGetNests,
        getServerOwnerId: jest.fn().mockResolvedValue("panelUser1"),
        editServerDetails: jest.fn().mockResolvedValue({ statusCode: 200 }),
        editServerBuild: jest.fn().mockResolvedValue(200),
        getAvailableUserMemory: jest.fn().mockResolvedValue(2048)
      }));
    });

    test("formats and replies with nests list", async () => {      jest.mock("../utility/server_functions.js", () => ({
        getServerOwnerId: jest.fn().mockResolvedValue("panelUser1"),
        getServerInfoById: jest.fn().mockResolvedValue({
          name: "test-server",
          limits: { memory: 1024 },
          id: "abc123"
        }),
        editServerDetails: jest.fn().mockResolvedValue(true),
        isServerSuspended: jest.fn().mockResolvedValue(false)
      }));

      const interaction = {
        deferReply: jest.fn().mockResolvedValue(),
        editReply: jest.fn().mockResolvedValue(),
        user: { id: "discord1" }
      };

      // Import after mocking
      const { getNests } = require("../utility/server_functions.js");
      const getNestsCommand = require("../commands/ptero/get_nests.js");
      global.getNests = getNests;

      await getNestsCommand.execute(interaction);
      expect(interaction.deferReply).toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("List of Nests"));
    });

  describe("get-eggs command", () => {
    test("formats and replies with eggs list", async () => {
      jest.resetModules();
      const mockApiCall = jest.fn().mockResolvedValue({
        body: {
          json: jest.fn().mockResolvedValue({
            data: [
              { attributes: { name: "egg1", description: "First egg" } },
              { attributes: { name: "egg2", description: "Second egg" } }
            ]
          })
        }
      });

      jest.mock("../utility/helper_functions.js", () => ({
        apiCall: mockApiCall,
        getUserId: jest.fn().mockReturnValue("panelUser1"),
        formatNames: jest.fn().mockImplementation(names => names.join(", "))
      }));

      jest.mock("../utility/server_functions.js", () => ({
        getNestIdByName: jest.fn().mockResolvedValue(1),
        getEggs: jest.fn().mockResolvedValue([
          { name: "egg1", description: "First egg" },
          { name: "egg2", description: "Second egg" }
        ]),
        getServersByUser: jest.fn().mockResolvedValue({ data: [] }),
        editServerBuild: jest.fn().mockResolvedValue(200)
      }));

      jest.mock("../utility/permissions.js", () => ({
        PERMISSIONS: { READ_EGGS: "READ_EGGS" },
        authenticateUserForPermission: jest.fn().mockReturnValue(true)
      }));

      const getEggs = require("../commands/ptero/get_eggs.js");
      const interaction = {
        deferReply: jest.fn().mockResolvedValue(),
        editReply: jest.fn().mockResolvedValue(),
        user: { id: "discord1" },
        options: {
          getString: jest.fn().mockReturnValue("nest1")
        }
      };

      await getEggs.execute(interaction);
      expect(interaction.deferReply).toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("List of Eggs"));
    });
  });

  describe("get-owned-servers command", () => {
    test("formats and replies with servers list", async () => {
      jest.resetModules();
      const mockApiCall = jest.fn().mockResolvedValue({
        body: {
          json: jest.fn().mockResolvedValue({
            data: [
              { attributes: { name: "server1", identifier: "abc123", status: "running" } },
              { attributes: { name: "server2", identifier: "def456", status: "stopped" } }
            ]
          })
        }
      });

      jest.mock("../utility/helper_functions.js", () => ({
        apiCall: mockApiCall,
        getUserId: jest.fn().mockReturnValue("panelUser1"),
        formatNames: jest.fn().mockImplementation(names => names.join(", ")),
        getPanelUsername: jest.fn().mockReturnValue("TestUser")
      }));

      jest.mock("../utility/server_functions.js", () => ({
        getOwnedServers: jest.fn().mockResolvedValue([
          { name: "server1", identifier: "abc123", status: "running" },
          { name: "server2", identifier: "def456", status: "stopped" }
        ]),
        getServersByUser: jest.fn().mockResolvedValue({
          data: [
            { attributes: { 
              name: "server1", 
              identifier: "abc123", 
              status: "running",
              limits: { memory: 1024 },
              is_suspended: false
            }},
            { attributes: { 
              name: "server2", 
              identifier: "def456", 
              status: "stopped",
              limits: { memory: 2048 },
              is_suspended: false
            }}
          ]
        }),
        editServerBuild: jest.fn().mockResolvedValue(200)
      }));

      jest.mock("../utility/permissions.js", () => ({
        PERMISSIONS: { READ_SERVERS: "READ_SERVERS" },
        authenticateUserForPermission: jest.fn().mockReturnValue(true)
      }));

      const getOwnedServers = require("../commands/ptero/get_owned_servers.js");
      const interaction = {
        deferReply: jest.fn().mockResolvedValue(),
        editReply: jest.fn().mockResolvedValue(),
        user: { id: "discord1" }
      };

      await getOwnedServers.execute(interaction);
      expect(interaction.deferReply).toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("Servers owned by"));
    });
  });

  describe("suspend-server command", () => {
    beforeEach(() => {
      jest.resetModules();
    });

    test("suspends server successfully", async () => {
      const mockApiCall = jest.fn().mockResolvedValue({
        statusCode: 204,
        body: {
          json: jest.fn().mockResolvedValue({
            data: { attributes: { suspended: true } }
          })
        }
      });

      jest.mock("../utility/helper_functions.js", () => ({
        apiCall: mockApiCall,
        getUserId: jest.fn().mockReturnValue("panelUser1"),
        formatNames: jest.fn().mockImplementation(names => names.join(", "))
      }));

      jest.mock("../utility/server_functions.js", () => ({
        getServerOwnerId: jest.fn().mockResolvedValue("panelUser1"),
        suspendServer: jest.fn().mockResolvedValue({ suspended: true }),
        isServerSuspended: jest.fn().mockResolvedValue(false)
      }));

      jest.mock("../utility/permissions.js", () => ({
        PERMISSIONS: {
          READ_NESTS: 1,
          READ_EGGS: 2,
          CREATE_SERVER: 4,
          SUSPEND_OWN_SERVER: 8,
          UNSUSPEND_OWN_SERVER: 16,
          DELETE_OWN_SERVER: 32,
          READ_OWN_SERVERS: 64,
          EDIT_OWN_SERVER_SETTINGS: 128,
          EDIT_ANY_SERVER_SETTINGS: 256,
          SUSPEND_ANY_SERVER: 512,
          UNSUSPEND_ANY_SERVER: 1024,
          ADMINISTRATOR: 65536
        },
        authenticateUserForPermission: jest.fn().mockReturnValue(true)
      }));      const suspendServer = require("../commands/ptero/suspend_server.js");
      const interaction = {
        deferReply: jest.fn().mockResolvedValue(),
        editReply: jest.fn().mockResolvedValue(),
        options: { getString: jest.fn().mockReturnValue("abc123") },
        user: { id: "discord1" }
      };

      await suspendServer.execute(interaction);
      expect(interaction.deferReply).toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("has been suspended"));
    });
  });

  describe("unsuspend-server command", () => {
    beforeEach(() => {
      jest.resetModules();
    });

    test("unsuspends server successfully", async () => {
      const mockApiCall = jest.fn().mockResolvedValue({
        statusCode: 204,
        body: {
          json: jest.fn().mockResolvedValue({
            data: { attributes: { suspended: false } }
          })
        }
      });

      jest.mock("../utility/helper_functions.js", () => ({
        apiCall: mockApiCall,
        getUserId: jest.fn().mockReturnValue("panelUser1"),
        formatNames: jest.fn().mockImplementation(names => names.join(", "))
      }));

      jest.mock("../utility/server_functions.js", () => ({
        getServerOwnerId: jest.fn().mockResolvedValue("panelUser1"),
        isServerSuspended: jest.fn().mockResolvedValue(true),
        unsuspendServer: jest.fn().mockResolvedValue({ suspended: false }),
        getServerInfoById: jest.fn().mockResolvedValue({
          limits: { memory: 1024 },
          name: "test-server",
          id: "abc123"
        }),
        getAvailableUserMemory: jest.fn().mockResolvedValue(2048)
      }));

      jest.mock("../utility/permissions.js", () => ({
        PERMISSIONS: { UNSUSPEND_OWN_SERVER: "UNSUSPEND_OWN_SERVER" },
        authenticateUserForPermission: jest.fn().mockReturnValue(true)
      }));

      const unsuspendServer = require("../commands/ptero/unsuspend_server.js");
      const interaction = {
        deferReply: jest.fn().mockResolvedValue(),
        editReply: jest.fn().mockResolvedValue(),
        options: { getString: jest.fn().mockReturnValue("abc123") },
        user: { id: "discord1" }
      };

      await unsuspendServer.execute(interaction);
      expect(interaction.deferReply).toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("has been unsuspended"));
    });
  });

  describe("edit-server command", () => {
    beforeEach(() => {
      jest.resetModules();
      
      global.PERMISSIONS = {
        READ_NESTS: 1,
        READ_EGGS: 2,
        CREATE_SERVER: 4,
        SUSPEND_OWN_SERVER: 8,
        UNSUSPEND_OWN_SERVER: 16,
        DELETE_OWN_SERVER: 32,
        READ_OWN_SERVERS: 64,
        EDIT_OWN_SERVER_SETTINGS: 128,
        EDIT_ANY_SERVER_SETTINGS: 256,
        SUSPEND_ANY_SERVER: 512,
        UNSUSPEND_ANY_SERVER: 1024,
        ADMINISTRATOR: 65536
      };
      
      jest.mock("../utility/permissions.js", () => ({
        PERMISSIONS: global.PERMISSIONS,
        authenticateUserForPermission: jest.fn().mockReturnValue(true)
      }));
    });

    test("updates server settings successfully", async () => {
      jest.resetModules();
      jest.mock("../utility/server_functions.js", () => ({
        getServerOwnerId: jest.fn().mockResolvedValue("panelUser1"),
        getServerInfoById: jest.fn().mockResolvedValue({
          name: "test-server",
          limits: { memory: 1024 },
          id: "abc123"
        }),
        editServerDetails: jest.fn().mockResolvedValue(true),
        isServerSuspended: jest.fn().mockResolvedValue(false),
        editServerBuild: jest.fn().mockResolvedValue(200)
      }));

      const editServer = require("../commands/ptero/edit_server.js");
      const interaction = {
        deferReply: jest.fn().mockResolvedValue(),
        editReply: jest.fn().mockResolvedValue(),
        options: {
          getString: jest.fn().mockReturnValue("abc123"),
          getInteger: jest.fn().mockReturnValue(512)
        },
        user: { id: "discord1" }
      };

      await editServer.execute(interaction);
      expect(interaction.deferReply).toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("has been edited"));
    });

    test("handles API errors gracefully", async () => {
      jest.resetModules();
      jest.mock("../utility/server_functions.js", () => ({
        getServerOwnerId: jest.fn().mockResolvedValue("panelUser1"),
        getServerInfoById: jest.fn().mockResolvedValue({
          name: "test-server",
          limits: { memory: 1024 },
          id: "abc123"
        }),
        editServerDetails: jest.fn().mockResolvedValue(true),
        isServerSuspended: jest.fn().mockResolvedValue(false),
        editServerBuild: jest.fn().mockResolvedValue(500) // Simulate error
      }));

      const editServer = require("../commands/ptero/edit_server.js");
      const interaction1 = {
        deferReply: jest.fn().mockResolvedValue(),
        editReply: jest.fn().mockResolvedValue(),
        options: {
          getString: jest.fn().mockReturnValue("abc123"),
          getInteger: jest.fn().mockReturnValue(512)
        },
        user: { id: "discord1" }
      };

      await editServer.execute(interaction1);
  expect(interaction1.editReply).toHaveBeenCalledWith(expect.stringContaining("Server edit failed"));
    });
  });

  describe("gen-server command", () => {
    let mockApiCall;

    beforeEach(() => {
      jest.resetModules();

      mockApiCall = jest.fn().mockImplementation(url => ({
        body: {
          json: jest.fn().mockResolvedValue(
            url.includes("allocations")
              ? {
                  data: [{
                    attributes: {
                      id: 1,
                      assigned: false,
                      alias: null,
                      ip: "0.0.0.0"
                    }
                  }]
                }
              : {
                  data: {
                    attributes: {
                      id: "123",
                      identifier: "abc123",
                      name: "test"
                    }
                  }
                }
          )
        }
      }));

      jest.mock("../utility/server_functions.js", () => ({
        getServerOwnerId: jest.fn().mockResolvedValue("panelUser1"),
        getServerInfoById: jest.fn().mockResolvedValue({
          name: "test-server",
          limits: { memory: 1024 },
          id: "abc123"
        }),
        editServerDetails: jest.fn().mockResolvedValue(true),
        isServerSuspended: jest.fn().mockResolvedValue(false),
        editServerBuild: jest.fn().mockResolvedValue(200)
      }));

      jest.mock("../config.json", () => ({
        developer_mode: false,
        default_overhead_mb: 32,
        java_overhead_mb: 64,
        minecraft_nest_id: 999
      }), { virtual: true });
    });

    test("returns error on empty name", async () => {
      jest.mock("../utility/server_functions.js", () => ({
        getNodeIdByName: jest.fn().mockResolvedValue(1)
      }));

      const gen = require("../commands/ptero/gen_server.js");
      const result = await gen.createServer("", "node", "nest", "egg", 128, "discord1", "panelUser1");
      expect(typeof result).toBe("string");
      expect(result).toContain("Invalid server name");
    });

    test("returns error when node not found", async () => {
      jest.mock("../utility/server_functions.js", () => ({
        getNodeIdByName: jest.fn().mockResolvedValue(-1)
      }));

      const gen = require("../commands/ptero/gen_server.js");
      const result = await gen.createServer("test", "invalid-node", "nest", "egg", 128, "discord1", "panelUser1");
      expect(typeof result).toBe("string");
    });

    test("returns error when memory limit exceeded", async () => {
      jest.mock("../utility/server_functions.js", () => ({
        getNodeIdByName: jest.fn().mockResolvedValue(1),
        getNestIdByName: jest.fn().mockResolvedValue(1),
        getEggIdByName: jest.fn().mockResolvedValue(1),
        getAvailableUserMemory: jest.fn().mockResolvedValue(100)
      }));

      const gen = require("../commands/ptero/gen_server.js");
      const result = await gen.createServer("test", "node", "nest", "egg", 128, "discord1", "panelUser1");
      expect(typeof result).toBe("string");
    });

    test("returns error when no allocation available", async () => {
      mockApiCall.mockImplementation(() => ({
        body: {
          json: jest.fn().mockResolvedValue({ data: [] })
        }
      }));

      jest.mock("../utility/server_functions.js", () => ({
        getNodeIdByName: jest.fn().mockResolvedValue(1),
        getNestIdByName: jest.fn().mockResolvedValue(1),
        getEggIdByName: jest.fn().mockResolvedValue(1),
        getAvailableUserMemory: jest.fn().mockResolvedValue(1024),
        getEggData: jest.fn().mockResolvedValue({
          attributes: {
            docker_image: "img",
            startup: "run",
            relationships: { variables: [] }
          }
        })
      }));

      const gen = require("../commands/ptero/gen_server.js");
      const result = await gen.createServer("test", "node", "nest", "egg", 128, "discord1", "panelUser1");
      expect(typeof result).toBe("string");
    });

    test("uses higher overhead memory for Minecraft servers", async () => {
      jest.resetModules();
      const mockApiCall = jest.fn((url, method, body) => {
        if (url.includes("allocations")) {
          return {
            body: {
              json: jest.fn().mockResolvedValue({
                data: [{
                  attributes: {
                    id: 1,
                    assigned: false,
                    alias: null,
                    ip: "0.0.0.0"
                  }
                }]
              })
            }
          };
        }
        if (url === "application/servers" && method === "POST") {
          return {
            body: {
              json: jest.fn().mockResolvedValue({
                data: {
                  attributes: {
                    id: "123",
                    identifier: "abc123",
                    name: "test"
                  }
                }
              })
            }
          };
        }
        return {
          body: {
            json: jest.fn().mockResolvedValue({ data: [] })
          }
        };
      });

      jest.mock("../utility/helper_functions.js", () => ({
        apiCall: mockApiCall,
        extractEnvVariables: jest.fn().mockReturnValue({}),
        getUserId: jest.fn().mockReturnValue("panelUser1")
      }));

      jest.mock("../utility/server_functions.js", () => ({
        getNodeIdByName: jest.fn().mockResolvedValue(1),
        getNestIdByName: jest.fn().mockResolvedValue(999), // minecraft_nest_id
        getEggIdByName: jest.fn().mockResolvedValue(1),
        getAvailableUserMemory: jest.fn().mockResolvedValue(1024),
        getEggData: jest.fn().mockResolvedValue({
          attributes: {
            docker_image: "img",
            startup: "run",
            relationships: { variables: [] }
          }
        })
      }));

      const gen = require("../commands/ptero/gen_server.js");
      await gen.createServer("test", "node", "nest", "egg", 128, "discord1", "panelUser1");

      // Check the last call to mockApiCall
      const lastCall = mockApiCall.mock.calls[mockApiCall.mock.calls.length - 1];
      expect(lastCall[2]).toContain('"overhead_memory":64');
    });

    test("handles developer mode correctly", async () => {
      jest.resetModules();
      jest.mock("../config.json", () => ({
        developer_mode: true,
        default_overhead_mb: 32,
        java_overhead_mb: 64,
        minecraft_nest_id: 999
      }), { virtual: true });

      const mockApiCall = jest.fn((url, method, body) => {
        if (url.includes("allocations")) {
          return {
            body: {
              json: jest.fn().mockResolvedValue({
                data: [{
                  attributes: {
                    id: 1,
                    assigned: false,
                    alias: null,
                    ip: "0.0.0.0"
                  }
                }]
              })
            }
          };
        }
        if (url === "application/servers" && method === "POST") {
          return {
            body: {
              json: jest.fn().mockResolvedValue({
                data: {
                  attributes: {
                    id: "123",
                    identifier: "abc123",
                    name: "test"
                  }
                }
              })
            }
          };
        }
        return {
          body: {
            json: jest.fn().mockResolvedValue({ data: [] })
          }
        };
      });

      jest.mock("../utility/helper_functions.js", () => ({
        apiCall: mockApiCall,
        extractEnvVariables: jest.fn().mockReturnValue({}),
        getUserId: jest.fn().mockReturnValue("panelUser1")
      }));

      jest.mock("../utility/server_functions.js", () => ({
        getNodeIdByName: jest.fn().mockResolvedValue(1),
        getNestIdByName: jest.fn().mockResolvedValue(1),
        getEggIdByName: jest.fn().mockResolvedValue(1),
        getAvailableUserMemory: jest.fn().mockResolvedValue(1024),
        getEggData: jest.fn().mockResolvedValue({
          attributes: {
            docker_image: "img",
            startup: "run",
            relationships: { variables: [] }
          }
        })
      }));

      const gen = require("../commands/ptero/gen_server.js");
      const result = await gen.createServer("test", "node", "nest", "egg", 128, "discord1", "panelUser1");
      expect(result).toContain("Developer mode enabled");
    });

    test("creates server successfully", async () => {
      jest.resetModules();
      const mockApiCall = jest.fn((url, method, body) => {
        if (url.includes("allocations")) {
          return {
            body: {
              json: jest.fn().mockResolvedValue({
                data: [{
                  attributes: {
                    id: 1,
                    assigned: false,
                    alias: null,
                    ip: "0.0.0.0"
                  }
                }]
              })
            }
          };
        }
        if (url === "application/servers" && method === "POST") {
          return {
            body: {
              json: jest.fn().mockResolvedValue({
                data: {
                  attributes: {
                    id: "123",
                    identifier: "abc123",
                    name: "test"
                  }
                }
              })
            }
          };
        }
        return {
          body: {
            json: jest.fn().mockResolvedValue({ data: [] })
          }
        };
      });

      jest.mock("../utility/helper_functions.js", () => ({
        apiCall: mockApiCall,
        extractEnvVariables: jest.fn().mockReturnValue({}),
        getUserId: jest.fn().mockReturnValue("panelUser1")
      }));

      jest.mock("../utility/server_functions.js", () => ({
        getNodeIdByName: jest.fn().mockResolvedValue(1),
        getNestIdByName: jest.fn().mockResolvedValue(1),
        getEggIdByName: jest.fn().mockResolvedValue(1),
        getAvailableUserMemory: jest.fn().mockResolvedValue(1024),
        getEggData: jest.fn().mockResolvedValue({
          attributes: {
            docker_image: "img",
            startup: "run",
            relationships: { variables: [] }
          }
        })
      }));

      const gen = require("../commands/ptero/gen_server.js");
      await gen.createServer("test", "node", "nest", "egg", 128, "discord1", "panelUser1");

      // Check the last call to mockApiCall
      const lastCall = mockApiCall.mock.calls[mockApiCall.mock.calls.length - 1];
      expect(lastCall[2]).toContain('"name":"test"');
    });
  });