// Mock I/O dependencies before requiring anything
jest.mock("dotenv", () => ({ config: jest.fn() }));
jest.mock("undici", () => ({
  Client: jest.fn().mockImplementation(() => ({ request: jest.fn() }))
}));
jest.mock("../config.json", () => ({ debug: false }), { virtual: true });
jest.mock("../users.json", () => ({
  users: [
    // ADMINISTRATOR — all permissions via bit 16
    { panelId: 1, panelAPIKey: "key-alice", discordId: "111", panelUsername: "alice", permissions: 65536, maximumAllowedMemory: 4096 },
    // GET_SERVICE_INFORMATION only (bit 0 = 1)
    { panelId: 2, panelAPIKey: "key-bob", discordId: "222", panelUsername: "bob", permissions: 1, maximumAllowedMemory: 2048 },
    // No permissions, no API key
    { panelId: 3, panelAPIKey: "", discordId: "333", panelUsername: "charlie", permissions: 0, maximumAllowedMemory: -1 }
  ]
}), { virtual: true });
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
  formatNames
} = require("../utility/helper_functions.js");

const { getErrorMessage } = require("../utility/error_messages.js");
const { PERMISSIONS, authenticateUserForPermission } = require("../utility/permissions.js");

// ---------------------------------------------------------------------------
// helper_functions — user lookups
// ---------------------------------------------------------------------------

describe("getUserId", () => {
  test("returns panelId for a known discordId string", () => {
    expect(getUserId("111")).toBe(1);
    expect(getUserId("222")).toBe(2);
  });

  test("returns panelId for a known panelUsername string", () => {
    expect(getUserId("alice")).toBe(1);
    expect(getUserId("bob")).toBe(2);
  });

  test("returns panelId when discordId is passed as a number", () => {
    // discordIds stored as strings; numeric lookup coerces via String(val)
    expect(getUserId(111)).toBe(1);
    expect(getUserId(222)).toBe(2);
  });

  test("returns -1 for an unknown string", () => {
    expect(getUserId("nobody")).toBe(-1);
  });

  test("returns -1 for an unknown number", () => {
    expect(getUserId(999)).toBe(-1);
  });
});

describe("getPanelUsername", () => {
  test("returns username for a known discordId string", () => {
    expect(getPanelUsername("111")).toBe("alice");
    expect(getPanelUsername("222")).toBe("bob");
  });

  test("returns username for a known panelUsername string", () => {
    expect(getPanelUsername("alice")).toBe("alice");
    expect(getPanelUsername("bob")).toBe("bob");
  });

  test("returns username when discordId is passed as a number", () => {
    expect(getPanelUsername(111)).toBe("alice");
  });

  test("returns -1 for an unknown value", () => {
    expect(getPanelUsername("nobody")).toBe(-1);
    expect(getPanelUsername(9999)).toBe(-1);
  });
});

describe("getDiscordId", () => {
  test("returns discordId for a known discordId string", () => {
    expect(getDiscordId("111")).toBe("111");
  });

  test("returns discordId for a known panelUsername string", () => {
    expect(getDiscordId("alice")).toBe("111");
  });

  test("returns discordId when looked up by panelId number", () => {
    expect(getDiscordId(1)).toBe("111");
    expect(getDiscordId(2)).toBe("222");
  });

  test("returns -1 for an unknown value", () => {
    expect(getDiscordId("nobody")).toBe(-1);
    expect(getDiscordId(9999)).toBe(-1);
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
// error_messages — getErrorMessage
// ---------------------------------------------------------------------------

describe("getErrorMessage", () => {
  test("returns the text for a known string key", () => {
    const msg = getErrorMessage("INVALID_INPUT");
    expect(typeof msg).toBe("string");
    expect(msg).toContain("Invalid input");
  });

  test("returns the text for another known string key", () => {
    const msg = getErrorMessage("USER_TIMEOUT");
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(0);
  });

  test("calls the format function when the entry uses format", () => {
    // API_REQUEST_FAILED uses a format function: statusCode => `...HTTP Code: ${statusCode}...`
    const msg = getErrorMessage("API_REQUEST_FAILED", 422);
    expect(msg).toContain("422");
  });

  test("calls the format function with memory amount for SERVER_CREATION_FAILED_MEMORY", () => {
    const msg = getErrorMessage("SERVER_CREATION_FAILED_MEMORY", 512);
    expect(msg).toContain("512");
  });

  test("returns the entry text when looked up by numeric id", () => {
    // INVALID_INPUT has id -4
    const msg = getErrorMessage(-4);
    expect(typeof msg).toBe("string");
    expect(msg).toContain("Invalid input");
  });

  test("returns an error string for an unknown string key", () => {
    const msg = getErrorMessage("NONEXISTENT_CODE");
    expect(msg).toContain("NONEXISTENT_CODE");
  });

  test("returns an error string for an unknown numeric id", () => {
    const msg = getErrorMessage(-999);
    expect(typeof msg).toBe("string");
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
