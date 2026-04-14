// Set before any module is required so crypto.js can read it.
process.env.ENCRYPTION_KEY = "a".repeat(64); // 32-byte test key (valid hex)

jest.mock("../utility/logger.js", () => ({
  log: jest.fn(),
  error: jest.fn()
}));

// Pure JS in-memory mock for better-sqlite3.
// Avoids loading the native addon entirely, which cannot survive jest's module
// sandbox when its own dependencies (path, bindings) are partially mocked.
jest.mock("better-sqlite3", () => {
  // Data lives at module scope so the singleton in database.js shares it.
  const users = [];
  const blacklistNodes = [];

  function prepare(sql) {
    const s = sql.trim();

    // ── SELECT COUNT ────────────────────────────────────────────────────────
    if (/SELECT COUNT\(\*\) as count FROM users/i.test(s)) {
      return { get: () => ({ count: users.length }) };
    }
    if (/SELECT COUNT\(\*\) as count FROM blacklist_nodes/i.test(s)) {
      return { get: () => ({ count: blacklistNodes.length }) };
    }

    // ── SELECT discord_id, panel_api_key … (used by encryptExistingKeys) ───
    if (/SELECT discord_id, panel_api_key FROM users WHERE panel_api_key IS NOT NULL/i.test(s)) {
      return {
        all: () => users
          .filter(u => u.panel_api_key !== null && u.panel_api_key !== undefined)
          .map(u => ({ discord_id: u.discord_id, panel_api_key: u.panel_api_key }))
      };
    }

    // ── SELECT * FROM users ─────────────────────────────────────────────────
    if (/SELECT \* FROM users WHERE discord_id = \?/i.test(s)) {
      return { get: id => users.find(u => u.discord_id === id) || undefined };
    }
    if (/SELECT \* FROM users WHERE panel_id = \?/i.test(s)) {
      return { get: id => users.find(u => u.panel_id === id) || undefined };
    }
    if (/SELECT \* FROM users WHERE panel_username = \?/i.test(s)) {
      return { get: name => users.find(u => u.panel_username === name) || undefined };
    }
    if (/^SELECT \* FROM users$/i.test(s)) {
      return { all: () => users.slice() };
    }

    // ── INSERT INTO users ───────────────────────────────────────────────────
    if (/INSERT OR IGNORE INTO users/i.test(s)) {
      return {
        run: (discordId, panelUsername, panelId, maxMem, perms, apiKey) => {
          const exists = users.some(u => u.discord_id === discordId || u.panel_id === panelId);
          if (!exists) {
            users.push({
              discord_id: discordId, panel_username: panelUsername, panel_id: panelId,
              maximum_allowed_memory: maxMem, permissions: perms, panel_api_key: apiKey
            });
          }
        }
      };
    }
    if (/^INSERT INTO users/i.test(s)) {
      return {
        run: (discordId, panelUsername, panelId, maxMem, perms, apiKey) => {
          if (users.some(u => u.discord_id === discordId)) throw new Error("UNIQUE constraint failed: users.discord_id");
          if (users.some(u => u.panel_id === panelId)) throw new Error("UNIQUE constraint failed: users.panel_id");
          users.push({
            discord_id: discordId, panel_username: panelUsername, panel_id: panelId,
            maximum_allowed_memory: maxMem, permissions: perms, panel_api_key: apiKey
          });
        }
      };
    }

    // ── UPDATE users ────────────────────────────────────────────────────────
    if (/UPDATE users SET panel_api_key = \? WHERE discord_id = \?/i.test(s)) {
      return {
        run: (key, id) => {
          const u = users.find(u => u.discord_id === id);
          if (u) u.panel_api_key = key;
        }
      };
    }
    // Dynamic: UPDATE users SET <field> = ? WHERE discord_id = ?
    const dynUpdate = s.match(/UPDATE users SET (\w+) = \? WHERE discord_id = \?/i);
    if (dynUpdate) {
      const field = dynUpdate[1];
      return {
        run: (value, id) => {
          const u = users.find(u => u.discord_id === id);
          if (u) u[field] = value;
        }
      };
    }

    // ── DELETE FROM users ───────────────────────────────────────────────────
    if (/DELETE FROM users WHERE discord_id = \?/i.test(s)) {
      return {
        run: id => {
          const idx = users.findIndex(u => u.discord_id === id);
          if (idx !== -1) users.splice(idx, 1);
        }
      };
    }

    // ── blacklist_nodes ─────────────────────────────────────────────────────
    if (/SELECT \* FROM blacklist_nodes WHERE node_name = \?/i.test(s)) {
      return { get: name => blacklistNodes.find(n => n.node_name === name) || null };
    }
    if (/SELECT \* FROM blacklist_nodes/i.test(s)) {
      return { all: () => blacklistNodes.slice() };
    }
    if (/INSERT OR IGNORE INTO blacklist_nodes/i.test(s)) {
      return {
        run: (name, reason) => {
          if (!blacklistNodes.some(n => n.node_name === name)) {
            blacklistNodes.push({ node_name: name, reason: reason || null });
          }
        }
      };
    }

    // Fallback no-op
    return { run: jest.fn(), get: jest.fn(() => undefined), all: jest.fn(() => []) };
  }

  const mockDb = {
    pragma: jest.fn(),
    exec: jest.fn(),
    prepare: jest.fn(sql => prepare(sql)),
    transaction: jest.fn(fn => fn)
  };

  const MockConstructor = jest.fn(() => mockDb);
  // Expose raw store so tests can inspect encrypted values at rest
  MockConstructor._store = { users, blacklistNodes };
  return MockConstructor;
});

const database = require("../utility/database.js");
const MockDatabase = require("better-sqlite3");
const { _store } = MockDatabase;

beforeAll(() => {
  database.initDatabase();
});

beforeEach(() => {
  // Wipe the in-memory users array between tests
  for (const user of database.getAllUsers()) {
    database.deleteUser(user.discordId);
  }
});

// ---------------------------------------------------------------------------
// createUser
// ---------------------------------------------------------------------------

describe("createUser", () => {
  test("inserts a user and returns correct plaintext values via public API", () => {
    database.createUser("111", "alice", 1, 4096, 3, "key-alice");
    const user = database.getUserByDiscordId("111");
    expect(user).not.toBeNull();
    expect(user.discordId).toBe("111");
    expect(user.panelUsername).toBe("alice");
    expect(user.panelId).toBe(1);
    expect(user.maximumAllowedMemory).toBe(4096);
    expect(user.permissions).toBe(3);
    expect(user.panelAPIKey).toBe("key-alice");
  });

  test("stores the API key encrypted at rest (enc: prefix, not plaintext)", () => {
    database.createUser("111", "alice", 1, 4096, 3, "key-alice");
    const raw = _store.users.find(u => u.discord_id === "111");
    expect(raw.panel_api_key).toMatch(/^enc:/);
    expect(raw.panel_api_key).not.toContain("key-alice");
  });

  test("stores null API keys as null (no encryption wrapper)", () => {
    database.createUser("222", "bob", 2, -1, 0, null);
    const raw = _store.users.find(u => u.discord_id === "222");
    expect(raw.panel_api_key).toBeNull();
  });

  test("applies default values when optional params are omitted", () => {
    database.createUser("222", "bob", 2);
    const user = database.getUserByDiscordId("222");
    expect(user.maximumAllowedMemory).toBe(-1);
    expect(user.permissions).toBe(0);
    expect(user.panelAPIKey).toBeNull();
  });

  test("throws on duplicate discord_id", () => {
    database.createUser("111", "alice", 1);
    expect(() => database.createUser("111", "alice2", 2)).toThrow();
  });

  test("throws on duplicate panel_id", () => {
    database.createUser("111", "alice", 1);
    expect(() => database.createUser("222", "bob", 1)).toThrow();
  });

  test("is retrievable by panel_id after creation", () => {
    database.createUser("333", "charlie", 5, 2048, 65536, null);
    const user = database.getUserByPanelId(5);
    expect(user).not.toBeNull();
    expect(user.discordId).toBe("333");
  });

  test("is retrievable by panel username after creation", () => {
    database.createUser("444", "diana", 6);
    const user = database.getUserByPanelUsername("diana");
    expect(user).not.toBeNull();
    expect(user.discordId).toBe("444");
  });
});

// ---------------------------------------------------------------------------
// updateUser
// ---------------------------------------------------------------------------

describe("updateUser", () => {
  beforeEach(() => {
    database.createUser("111", "alice", 1, 4096, 0, "key-alice");
  });

  test("updates panel_username", () => {
    database.updateUser("111", "panel_username", "alice_renamed");
    expect(database.getUserByDiscordId("111").panelUsername).toBe("alice_renamed");
  });

  test("updates panel_id", () => {
    database.updateUser("111", "panel_id", 99);
    expect(database.getUserByDiscordId("111").panelId).toBe(99);
  });

  test("updates maximum_allowed_memory", () => {
    database.updateUser("111", "maximum_allowed_memory", 8192);
    expect(database.getUserByDiscordId("111").maximumAllowedMemory).toBe(8192);
  });

  test("sets maximum_allowed_memory to -1 (unlimited)", () => {
    database.updateUser("111", "maximum_allowed_memory", -1);
    expect(database.getUserByDiscordId("111").maximumAllowedMemory).toBe(-1);
  });

  test("updates permissions bitmask", () => {
    database.updateUser("111", "permissions", 65536);
    expect(database.getUserByDiscordId("111").permissions).toBe(65536);
  });

  test("updates panel_api_key and returns decrypted value", () => {
    database.updateUser("111", "panel_api_key", "new-secret-key");
    expect(database.getUserByDiscordId("111").panelAPIKey).toBe("new-secret-key");
  });

  test("stores updated panel_api_key encrypted at rest", () => {
    database.updateUser("111", "panel_api_key", "new-secret-key");
    const raw = _store.users.find(u => u.discord_id === "111");
    expect(raw.panel_api_key).toMatch(/^enc:/);
    expect(raw.panel_api_key).not.toContain("new-secret-key");
  });

  test("clears panel_api_key to null", () => {
    database.updateUser("111", "panel_api_key", null);
    expect(database.getUserByDiscordId("111").panelAPIKey).toBeNull();
  });

  test("throws for an invalid field name", () => {
    expect(() => database.updateUser("111", "invalid_field", "x")).toThrow("Invalid field: invalid_field");
  });

  test("throws for a SQL injection attempt in the field name", () => {
    expect(() =>
      database.updateUser("111", "panel_username; DROP TABLE users--", "x")
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// deleteUser
// ---------------------------------------------------------------------------

describe("deleteUser", () => {
  test("removes an existing user", () => {
    database.createUser("111", "alice", 1);
    database.deleteUser("111");
    expect(database.getUserByDiscordId("111")).toBeNull();
  });

  test("is a no-op for a non-existent discord_id", () => {
    expect(() => database.deleteUser("nonexistent-id")).not.toThrow();
  });

  test("does not affect other users", () => {
    database.createUser("111", "alice", 1);
    database.createUser("222", "bob", 2);
    database.deleteUser("111");
    expect(database.getUserByDiscordId("222")).not.toBeNull();
    expect(database.getUserByPanelUsername("bob")).not.toBeNull();
  });
});
