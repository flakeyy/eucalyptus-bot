// Mock I/O dependencies before requiring anything
jest.mock("dotenv", () => ({ config: jest.fn() }));
jest.mock("undici", () => ({
  Client: jest.fn().mockImplementation(() => ({ request: jest.fn() }))
}));
jest.mock("../config.json", () => ({ debug: false }), { virtual: true });

const TEST_USERS = [
  // ADMINISTRATOR — all permissions via bit 16
  { panelId: 1, panelAPIKey: "key-alice", discordId: "111", panelUsername: "alice", permissions: 65536, maximumAllowedMemory: 4096 },
  // GET_SERVICE_INFORMATION only (bit 0 = 1)
  { panelId: 2, panelAPIKey: "key-bob", discordId: "222", panelUsername: "bob", permissions: 1, maximumAllowedMemory: 2048 },
  // No permissions, no API key
  { panelId: 3, panelAPIKey: "", discordId: "333", panelUsername: "charlie", permissions: 0, maximumAllowedMemory: -1 }
];

jest.mock("../utility/database.js", () => ({
  getUserByDiscordId: jest.fn(id => TEST_USERS.find(u => u.discordId === id) || null),
  getUserByPanelId: jest.fn(id => TEST_USERS.find(u => u.panelId === id) || null),
  getUserByPanelUsername: jest.fn(name => TEST_USERS.find(u => u.panelUsername === name) || null),
  getAllUsers: jest.fn(() => TEST_USERS),
  updateUserApiKey: jest.fn(),
  getBlacklistedNode: jest.fn(() => null),
  getAllBlacklistedNodes: jest.fn(() => [])
}));
jest.mock("../utility/logger.js", () => ({
  log: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

// Set env vars before modules are required (error_messages.js reads ADMIN_DISCORD_ID at load time)
process.env.ADMIN_DISCORD_ID = "admin999";

const {
  getUserId,
  getPanelUsername,
  getDiscordId,
  validateString,
  userHasClientApiKey,
  extractEnvVariables,
  resolveEnvVariables,
  formatNames,
  reconstructCommand,
  getCommands
} = require("../utility/helper_functions.js");

const { getErrorMessage } = require("../utility/error_messages.js");
const { PERMISSIONS, authenticateUserForPermission } = require("../utility/permissions.js");

// ---------------------------------------------------------------------------
// helper_functions — user lookups
// ---------------------------------------------------------------------------
// Each lookup accepts a discordId (string), a panelUsername (string), or a
// panelId (number). The unknown cases verify the -1 sentinel.

describe("getUserId", () => {
  test.each([
    [ "discordId string", "111", 1 ],
    [ "panelUsername string", "alice", 1 ],
    [ "discordId number (coerced to string)", 111, 1 ],
    [ "unknown string", "nobody", -1 ],
    [ "unknown number", 999, -1 ]
  ])("%s → %s", (_label, input, expected) => {
    expect(getUserId(input)).toBe(expected);
  });
});

describe("getPanelUsername", () => {
  test.each([
    [ "discordId string", "222", "bob" ],
    [ "panelUsername string", "bob", "bob" ],
    [ "discordId number", 111, "alice" ],
    [ "unknown string", "nobody", -1 ],
    [ "unknown number", 9999, -1 ]
  ])("%s → %s", (_label, input, expected) => {
    expect(getPanelUsername(input)).toBe(expected);
  });
});

describe("getDiscordId", () => {
  test.each([
    [ "discordId string", "111", "111" ],
    [ "panelUsername string", "alice", "111" ],
    [ "panelId number", 1, "111" ],
    [ "unknown string", "nobody", -1 ],
    [ "unknown number", 9999, -1 ]
  ])("%s → %s", (_label, input, expected) => {
    expect(getDiscordId(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// helper_functions — validateString
// ---------------------------------------------------------------------------

describe("validateString", () => {
  test("returns the trimmed string for valid input", () => {
    expect(validateString("hello")).toBe("hello");
    expect(validateString("  hello  ")).toBe("hello");
  });

  test("returns false for an empty string", () => {
    expect(validateString("")).toBe(false);
    expect(validateString("   ")).toBe(false);
  });

  test("returns false when string exceeds maxLength", () => {
    const tooLong = "a".repeat(33); // default maxLength is 32
    expect(validateString(tooLong)).toBe(false);
  });

  test("returns false for non-string input", () => {
    expect(validateString(42)).toBe(false);
    expect(validateString(null)).toBe(false);
    expect(validateString(undefined)).toBe(false);
  });

  test("accepts string exactly at boundary lengths", () => {
    expect(validateString("a")).toBe("a");           // minLength 1
    expect(validateString("a".repeat(32))).toBe("a".repeat(32)); // maxLength 32
  });

  test("respects custom minLength and maxLength", () => {
    expect(validateString("hi", 3, 10)).toBe(false);      // too short
    expect(validateString("hello", 3, 10)).toBe("hello"); // within range
    expect(validateString("a".repeat(11), 1, 10)).toBe(false); // too long
  });
});

// ---------------------------------------------------------------------------
// helper_functions — userHasClientApiKey
// ---------------------------------------------------------------------------

describe("userHasClientApiKey", () => {
  test("returns true when the user has a non-empty API key", () => {
    expect(userHasClientApiKey("111")).toBeTruthy();
    expect(userHasClientApiKey("222")).toBeTruthy();
  });

  test("returns falsy when the user has an empty API key", () => {
    expect(userHasClientApiKey("333")).toBeFalsy();
  });

  test("returns false for an unknown discordId", () => {
    expect(userHasClientApiKey("unknown")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// helper_functions — extractEnvVariables
// ---------------------------------------------------------------------------

describe("extractEnvVariables", () => {
  test("extracts env_variable keys with their default values", () => {
    const input = {
      data: [
        { attributes: { env_variable: "SERVER_JAR_URL", default_value: "https://example.com/server.jar" } },
        { attributes: { env_variable: "STARTUP_COMMAND", default_value: "java -Xms128M -jar server.jar" } }
      ]
    };
    expect(extractEnvVariables(input)).toEqual({
      SERVER_JAR_URL: "https://example.com/server.jar",
      STARTUP_COMMAND: "java -Xms128M -jar server.jar"
    });
  });

  test("returns empty object for empty data array", () => {
    expect(extractEnvVariables({ data: [] })).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// helper_functions — resolveEnvVariables
// ---------------------------------------------------------------------------

describe("resolveEnvVariables", () => {
  test("passes through defaults and reports nothing missing when all are usable", () => {
    const input = {
      data: [
        { attributes: { env_variable: "BETA_BRANCH", default_value: "none", rules: "nullable|string", name: "Beta Branch" } },
        { attributes: { env_variable: "MAXPLAYERS", default_value: "8", rules: "required|numeric", name: "Max Players" } }
      ]
    };
    expect(resolveEnvVariables(input, { port: 7777 })).toEqual({
      environment: { BETA_BRANCH: "none", MAXPLAYERS: "8" },
      missing: []
    });
  });

  test("fills a blank required port variable from the allocation port", () => {
    const input = {
      data: [
        { attributes: { env_variable: "RELIABLE_PORT", default_value: "", rules: "required|numeric|between:1024,65535", name: "Reliable Messaging Port" } }
      ]
    };
    expect(resolveEnvVariables(input, { port: 27015 })).toEqual({
      environment: { RELIABLE_PORT: "27015" },
      missing: []
    });
  });

  test("does not fill a blank required port when the allocation port is out of range", () => {
    const input = {
      data: [
        { attributes: { env_variable: "RELIABLE_PORT", default_value: "", rules: "required|numeric|between:1024,65535", name: "Reliable Messaging Port" } }
      ]
    };
    const result = resolveEnvVariables(input, { port: 80 });
    expect(result.environment.RELIABLE_PORT).toBe("");
    expect(result.missing).toEqual([ { envVariable: "RELIABLE_PORT", name: "Reliable Messaging Port" } ]);
  });

  test("reports a blank required non-derivable variable as missing", () => {
    const input = {
      data: [
        { attributes: { env_variable: "SERVER_NAME", default_value: "", rules: "required|string", name: "Server Name" } }
      ]
    };
    const result = resolveEnvVariables(input, { port: 7777 });
    expect(result.environment.SERVER_NAME).toBe("");
    expect(result.missing).toEqual([ { envVariable: "SERVER_NAME", name: "Server Name" } ]);
  });

  test("leaves blank optional (nullable) variables untouched", () => {
    const input = {
      data: [
        { attributes: { env_variable: "EXTRA_ARGS", default_value: "", rules: "nullable|string", name: "Extra Args" } }
      ]
    };
    expect(resolveEnvVariables(input, {})).toEqual({
      environment: { EXTRA_ARGS: "" },
      missing: []
    });
  });
});

// ---------------------------------------------------------------------------
// helper_functions — formatNames
// ---------------------------------------------------------------------------

describe("formatNames", () => {
  test("returns a formatted list of names", () => {
    const input = {
      data: [
        { attributes: { name: "Vanilla" } },
        { attributes: { name: "Paper" } }
      ]
    };
    expect(formatNames(input)).toBe("- Vanilla\n- Paper");
  });

  test("returns empty string for empty data array", () => {
    expect(formatNames({ data: [] })).toBe("");
  });

  test("throws for null input", () => {
    expect(() => formatNames(null)).toThrow();
  });

  test("throws when data property is missing", () => {
    expect(() => formatNames({})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// helper_functions — reconstructCommand
// ---------------------------------------------------------------------------

describe("reconstructCommand", () => {
  test("renders a bare command with no options", () => {
    const interaction = { commandName: "info", options: { data: [] } };
    // Trailing space is a quirk of the current implementation; not asserting on it.
    expect(reconstructCommand(interaction).trim()).toBe("/info");
  });

  test("renders a command with a scalar option", () => {
    const interaction = {
      commandName: "ping",
      options: { data: [ { name: "target", value: "node-1" } ] }
    };
    expect(reconstructCommand(interaction)).toBe("/ping target:node-1");
  });

  test("redacts the api-key option value", () => {
    const interaction = {
      commandName: "set-client-key",
      options: { data: [ { name: "api-key", value: "super-secret-real-key" } ] }
    };
    const out = reconstructCommand(interaction);
    expect(out).toBe("/set-client-key api-key:********");
    expect(out).not.toContain("super-secret-real-key");
  });

  test("flattens a subcommand group with options", () => {
    const interaction = {
      commandName: "admin",
      options: {
        data: [ {
          name: "user",
          options: [ {
            name: "view",
            options: [ { name: "target", value: "alice" } ]
          } ]
        } ]
      }
    };
    expect(reconstructCommand(interaction)).toBe("/admin user view target:alice");
  });
});

// ---------------------------------------------------------------------------
// helper_functions — getCommands (integration against real commands/ tree)
// ---------------------------------------------------------------------------

describe("getCommands", () => {
  test("returns an array containing the known slash commands", async () => {
    const commands = await getCommands();
    expect(Array.isArray(commands)).toBe(true);
    const names = commands.map(c => c.name);
    // These are stable, user-facing commands the bot exposes today.
    for (const expected of [ "info", "help", "admin", "set-client-key" ]) {
      expect(names).toContain(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// error_messages — getErrorMessage
// ---------------------------------------------------------------------------

describe("getErrorMessage", () => {
  test("returns text for a known string key", () => {
    expect(getErrorMessage("INVALID_INPUT")).toContain("Invalid input");
  });

  test("formats messages that use a format function", () => {
    expect(getErrorMessage("API_REQUEST_FAILED", 422)).toContain("422");
    expect(getErrorMessage("SERVER_CREATION_FAILED_MEMORY", 512)).toContain("512");
  });

  test("looks up by numeric id", () => {
    // INVALID_INPUT has id -4
    expect(getErrorMessage(-4)).toContain("Invalid input");
  });

  test("returns a fallback string for an unknown key or id", () => {
    expect(getErrorMessage("NONEXISTENT_CODE")).toContain("NONEXISTENT_CODE");
    expect(typeof getErrorMessage(-999)).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// permissions — authenticateUserForPermission
// ---------------------------------------------------------------------------

describe("authenticateUserForPermission", () => {
  test("returns true for a user who has the requested permission", () => {
    // user "222" has permissions=1 (GET_SERVICE_INFORMATION bit)
    expect(authenticateUserForPermission("222", PERMISSIONS.GET_SERVICE_INFORMATION)).toBe(true);
  });

  test("returns true for an ADMINISTRATOR regardless of the requested permission", () => {
    // user "111" has ADMINISTRATOR (65536); doesn't have READ_SERVERS directly
    expect(authenticateUserForPermission("111", PERMISSIONS.READ_SERVERS)).toBe(true);
    expect(authenticateUserForPermission("111", PERMISSIONS.CREATE_SERVER)).toBe(true);
  });

  test("returns false for a user who lacks the requested permission", () => {
    // user "222" has permissions=1, which does not include CREATE_SERVER (16)
    expect(authenticateUserForPermission("222", PERMISSIONS.CREATE_SERVER)).toBe(false);
  });

  test("returns false for a user with no permissions", () => {
    // user "333" has permissions=0
    expect(authenticateUserForPermission("333", PERMISSIONS.GET_SERVICE_INFORMATION)).toBe(false);
  });

  test("returns -1 for an unknown discordId", () => {
    expect(authenticateUserForPermission("unknown-id", PERMISSIONS.GET_SERVICE_INFORMATION)).toBe(-1);
  });
});
