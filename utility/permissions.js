const { getUserId } = require("./helper_functions.js");
const { users } = require("../users.json");
const msgLog = require("./logger.js");

// bitwise integer permissions
const PERMISSIONS = {
  READ_NESTS: 1 << 0, // 1
  READ_EGGS: 1 << 1, // 2
  CREATE_SERVER: 1 << 2, // 4
  SUSPEND_OWN_SERVER: 1 << 3, // 8
  UNSUSPEND_OWN_SERVER: 1 << 4, // 16
  DELETE_OWN_SERVER: 1 << 5, // 32
  READ_OWN_SERVERS: 1 << 6, // 64
  EDIT_OWN_SERVER_SETTINGS: 1 << 7, // 128
  EDIT_ANY_SERVER_SETTINGS: 1 << 8, // 256
  SUSPEND_ANY_SERVER: 1 << 9, // 512
  UNSUSPEND_ANY_SERVER: 1 << 10, // 1024

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
