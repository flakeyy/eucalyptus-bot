const { getUserId } = require("./helper_functions.js");
const { users } = require("../users.json");
const msgLog = require("./logger.js");

// bitwise integer permissions
const PERMISSIONS = {
  GET_SERVICE_INFORMATION: 1 << 0, // 1
  CREATE_SERVER: 1 << 1, // 2
  SUSPEND_SERVER: 1 << 2, // 4
  UNSUSPEND_SERVER: 1 << 3, // 8
  DELETE_SERVER: 1 << 4, // 16
  READ_SERVERS: 1 << 5, // 32
  EDIT_SERVER_SETTINGS: 1 << 6, // 64
  SET_CLIENT_KEY: 1 << 7, // 128

  ADMINISTRATOR: 1 << 16 // 65536
};

function hasPermission(userId, permission) {
  for (const user of users) {
    if (user.panelId === userId) {
      const userPermissions = user.permissions;
      return (userPermissions & permission) === permission;
    }
  }
  return false;
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
