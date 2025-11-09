const ADMIN_DISCORD_ID = process.env.ADMIN_DISCORD_ID;

const ERROR_MESSAGES = {
  USER_NOT_FOUND: {
    id: -1,
    text: `Unable to find any authenticatable user based on your Discord account.\nPlease let <@${ADMIN_DISCORD_ID}> know if you believe this is in error.`
  },
  INSUFFICIENT_PERMISSIONS: {
    id: -2,
    text: `You do not have permission to perform this action.\nPlease let <@${ADMIN_DISCORD_ID}> know if you believe this is in error.`
  },
  SERVER_TIMEOUT: {
    id: -3,
    text: `Server did not respond in time, it's likely the request timed out.\n<@${ADMIN_DISCORD_ID}>`
  },
  INVALID_SERVER_NAME: {
    id: -4,
    text: "Invalid server name.\nPlease try again."
  },
  NODE_NOT_FOUND: {
    id: -5,
    text: "The specified node does not exist.\nPlease try again."
  },
  NEST_NOT_FOUND: {
    id: -6,
    text: "The specified nest does not exist.\nPlease try again."
  },
  EGG_NOT_FOUND: {
    id: -7,
    text: "The specified egg does not exist.\nPlease try again."
  },
  ALLOCATION_NOT_FOUND: {
    id: -9,
    text: `Could not find a port to assign to the server.\nPlease let <@${ADMIN_DISCORD_ID}> know.`
  },
  EGG_INFO_NOT_RETURNED: {
    id: -10,
    text: `Egg info could not be returned.\nPlease let <@${ADMIN_DISCORD_ID}> know.`
  },
  API_REQUEST_FAILED: {
    id: -11,
    format: statusCode => `The API responded but returned an error, please check your request or try again later. HTTP Code: ${statusCode}\n<@${ADMIN_DISCORD_ID}>`
  },
  SERVER_CREATION_TIMEOUT: {
    id: -12,
    text: "Server creation timed out.\nPlease check if the server was created before continuing with further requests."
  },
  SERVER_CREATION_FAILED_MEMORY: {
    id: -13,
    format: amountToFree => `Creating this server would put you over your allowed maximum memory usage.\nYou will need to create this server with less memory OR free up ${amountToFree} MB by deleting or suspending other active servers.`
  },
  SERVER_SUSPEND_FAILED: {
    id: -14,
    text: "Failed to suspend the server.\nPlease ensure the server ID is correct and try again."
  },
  SERVER_SUSPEND_FAILED_ALREADY_SUSPENDED: {
    id: -15,
    text: "The server is already suspended.\nNo action was taken."
  },
  SERVER_UNSUSPEND_FAILED: {
    id: -16,
    text: "Failed to unsuspend.\nPlease ensure the server ID is correct and try again."
  },
  SERVER_UNSUSPEND_FAILED_MEMORY: {
    id: -17,
    text: "Failed to unsuspend due to your account's memory limit.\nPlease free up some memory by suspending or deleting other active servers before trying again."
  },
  SERVER_UNSUSPEND_FAILED_ALREADY_ACTIVE: {
    id: -18,
    text: "The server is already active.\nNo action was taken."
  },
  SERVER_EDIT_FAILED: {
    id: -19,
    text: "Server edit failed.\nCheck your request and try again."
  }
};

function getErrorMessage(keyOrId, ...params) {
  let entry;
  if (typeof keyOrId === "string") {
    entry = ERROR_MESSAGES[keyOrId];
  } else if (typeof keyOrId === "number") {
    entry = Object.values(ERROR_MESSAGES).find(e => e.id === keyOrId);
  }

  if (!entry) return `Unknown error code: "${keyOrId}" <@${ADMIN_DISCORD_ID}>`;

  if (typeof entry.format === "function") return entry.format(...params);
  return entry.text;
}

module.exports = {
  ERROR_MESSAGES,
  getErrorMessage
};
