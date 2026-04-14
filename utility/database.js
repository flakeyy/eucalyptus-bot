const Database = require("better-sqlite3");
const path = require("node:path");
const fs = require("node:fs");
const msgLog = require("./logger.js");
const { encrypt, decrypt, isEncrypted } = require("./crypto.js");

const DB_PATH = path.join(__dirname, "../pterobot.db");

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
  }
  return db;
}

function initDatabase() {
  const database = getDb();

  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      discord_id TEXT PRIMARY KEY,
      panel_username TEXT NOT NULL,
      panel_id INTEGER NOT NULL UNIQUE,
      maximum_allowed_memory INTEGER NOT NULL DEFAULT -1,
      permissions INTEGER NOT NULL DEFAULT 0,
      panel_api_key TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS blacklist_nodes (
      node_name TEXT PRIMARY KEY,
      reason TEXT DEFAULT NULL
    );
  `);

  migrateFromJson(database);
  encryptExistingKeys(database);

  msgLog.log("Database initialized.");
  return database;
}

function migrateFromJson(database) {
  const userCount = database.prepare("SELECT COUNT(*) as count FROM users").get();

  if (userCount.count === 0) {
    const usersPath = path.join(__dirname, "../users.json");
    if (fs.existsSync(usersPath)) {
      try {
        const { users } = JSON.parse(fs.readFileSync(usersPath, "utf-8"));
        const insert = database.prepare(
          "INSERT OR IGNORE INTO users (discord_id, panel_username, panel_id, maximum_allowed_memory, permissions, panel_api_key) VALUES (?, ?, ?, ?, ?, ?)"
        );
        const insertAll = database.transaction(rows => {
          for (const u of rows) {
            insert.run(
              u.discordId,
              u.panelUsername,
              u.panelId,
              u.maximumAllowedMemory ?? -1,
              u.permissions ?? 0,
              u.panelAPIKey ?? null
            );
          }
        });
        insertAll(users);
        msgLog.log(`Migrated ${users.length} user(s) from users.json.`);
      } catch (err) {
        msgLog.error(`Failed to migrate users.json: ${err.message}`);
      }
    }
  }

  const nodeCount = database.prepare("SELECT COUNT(*) as count FROM blacklist_nodes").get();

  if (nodeCount.count === 0) {
    const blacklistPath = path.join(__dirname, "../blacklist.json");
    if (fs.existsSync(blacklistPath)) {
      try {
        const { nodes } = JSON.parse(fs.readFileSync(blacklistPath, "utf-8"));
        const entries = Object.entries(nodes);
        if (entries.length > 0) {
          const insert = database.prepare("INSERT OR IGNORE INTO blacklist_nodes (node_name, reason) VALUES (?, ?)");
          const insertAll = database.transaction(rows => {
            for (const [ name, reason ] of rows) {
              insert.run(name, reason || null);
            }
          });
          insertAll(entries);
          msgLog.log(`Migrated ${entries.length} blacklisted node(s) from blacklist.json.`);
        }
      } catch (err) {
        msgLog.error(`Failed to migrate blacklist.json: ${err.message}`);
      }
    }
  }
}

function encryptExistingKeys(database) {
  const rows = database.prepare("SELECT discord_id, panel_api_key FROM users WHERE panel_api_key IS NOT NULL").all();
  const update = database.prepare("UPDATE users SET panel_api_key = ? WHERE discord_id = ?");
  const encryptAll = database.transaction(rows => {
    for (const row of rows) {
      if (!isEncrypted(row.panel_api_key)) {
        update.run(encrypt(row.panel_api_key), row.discord_id);
      }
    }
  });
  encryptAll(rows);
  if (rows.length > 0) {
    msgLog.log(`Encrypted ${rows.filter(r => !isEncrypted(r.panel_api_key)).length} existing API key(s).`);
  }
}

function rowToUser(row) {
  return {
    discordId: row.discord_id,
    panelUsername: row.panel_username,
    panelId: row.panel_id,
    maximumAllowedMemory: row.maximum_allowed_memory,
    permissions: row.permissions,
    panelAPIKey: decrypt(row.panel_api_key)
  };
}

function getUserByDiscordId(discordId) {
  const row = getDb().prepare("SELECT * FROM users WHERE discord_id = ?").get(discordId);
  return row ? rowToUser(row) : null;
}

function getUserByPanelId(panelId) {
  const row = getDb().prepare("SELECT * FROM users WHERE panel_id = ?").get(panelId);
  return row ? rowToUser(row) : null;
}

function getUserByPanelUsername(username) {
  const row = getDb().prepare("SELECT * FROM users WHERE panel_username = ?").get(username);
  return row ? rowToUser(row) : null;
}

function getAllUsers() {
  return getDb().prepare("SELECT * FROM users").all().map(rowToUser);
}

function updateUserApiKey(discordId, apiKey) {
  getDb().prepare("UPDATE users SET panel_api_key = ? WHERE discord_id = ?").run(encrypt(apiKey), discordId);
}

function createUser(discordId, panelUsername, panelId, maxMemory = -1, permissions = 0, panelApiKey = null) {
  getDb().prepare(
    "INSERT INTO users (discord_id, panel_username, panel_id, maximum_allowed_memory, permissions, panel_api_key) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(discordId, panelUsername, panelId, maxMemory, permissions, encrypt(panelApiKey));
}

function updateUser(discordId, field, value) {
  const allowed = [ "panel_username", "panel_id", "maximum_allowed_memory", "permissions", "panel_api_key" ];
  if (!allowed.includes(field)) throw new Error(`Invalid field: ${field}`);
  const stored = field === "panel_api_key" ? encrypt(value) : value;
  getDb().prepare(`UPDATE users SET ${field} = ? WHERE discord_id = ?`).run(stored, discordId);
}

function deleteUser(discordId) {
  getDb().prepare("DELETE FROM users WHERE discord_id = ?").run(discordId);
}

function getBlacklistedNode(nodeName) {
  return getDb().prepare("SELECT * FROM blacklist_nodes WHERE node_name = ?").get(nodeName) || null;
}

function getAllBlacklistedNodes() {
  return getDb().prepare("SELECT * FROM blacklist_nodes").all();
}

module.exports = {
  initDatabase,
  getUserByDiscordId,
  getUserByPanelId,
  getUserByPanelUsername,
  getAllUsers,
  updateUserApiKey,
  createUser,
  updateUser,
  deleteUser,
  getBlacklistedNode,
  getAllBlacklistedNodes
};
