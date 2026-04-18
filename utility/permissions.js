const { getUserId } = require("./helper_functions.js");
const db = require("./database.js");
const msgLog = require("./logger.js");

// bitwise integer permissions
const PERMISSIONS = {
  GET_SERVICE_INFORMATION: 1 << 0, // 1
  SET_CLIENT_KEY: 1 << 1, // 2
  READ_SERVERS: 1 << 2, // 4
  EDIT_SERVER_PROPERTIES: 1 << 3, // 8
  CREATE_SERVER: 1 << 4, // 16

  ADMINISTRATOR: 1 << 16, // 65536
  IMMUNITY: 1 << 17 // 131072 — assigned only via /init; hidden and non-modifiable through any UI
};

function hasPermission(userId, permission) {
  const user = db.getUserByPanelId(userId);
  if (!user) return false;
  return (user.permissions & permission) === permission;
}

function authenticateUserForPermission(discordId, permission) {
  const userId = getUserId(discordId);
  const permName = permissionName(permission);

  if (userId < 0) {
    msgLog.warn(`User: ${discordId} attempted to use ${permName} but was not found in the user database.`);
    return userId;
  }
  if (hasPermission(userId, permission) || hasPermission(userId, PERMISSIONS.ADMINISTRATOR)) {
    return true;
  }
  msgLog.warn(`User: ${discordId} attempted to use ${permName} but lacks the necessary permissions.`);
  return false;
}

function permissionName(permission) {
  if (typeof permission === "string") return permission;
  const key = Object.keys(PERMISSIONS).find(k => PERMISSIONS[k] === permission);
  return key || String(permission);
}

module.exports = {
  PERMISSIONS,
  authenticateUserForPermission
};
