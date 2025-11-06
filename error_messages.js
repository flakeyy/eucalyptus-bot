import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ADMIN_DISCORD_ID = process.env.ADMIN_DISCORD_ID;

export const ERROR_MESSAGES = {
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
        text: `Invalid server name.\nPlease try again.`
    },
    NODE_NOT_FOUND: {
        id: -5,
        text: `The specified node does not exist.\nPlease try again.`
    },
    NEST_NOT_FOUND: {
        id: -6,
        text: `The specified nest does not exist.\nPlease try again.`
    },
    EGG_NOT_FOUND: {
        id: -7,
        text: `The specified egg does not exist.\nPlease try again.`
    },
    MEMORY_EXCEEDS_LIMIT: {
        id: -8,
        format: (exceedingAmount) => `Creating this server would put you over your allowed maximum memory usage.\nPlease free up at least ${exceedingAmount} MB of memory by suspending or deleting other active servers before creating a new one.`
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
        format: (statusCode) => `The API responded but returned an error, please check your request or try again later. HTTP Code: ${statusCode}\n<@${ADMIN_DISCORD_ID}>`
    },
    SERVER_CREATION_TIMEOUT: {
        id: -12,
        text: `Server creation timed out.\nPlease check if the server was created before continuing with further requests.`
    },
    SERVER_SUSPEND_FAILED: {
        id: -13,
        text: `Failed to suspend the server.\nPlease ensure the server ID is correct and try again.`
    },
    SERVER_SUSPEND_FAILED_ALREADY_SUSPENDED: {
        id: -14,
        text: `The server is already suspended.\nNo action was taken.`
    },
};

/**
 * Retrieve an error message string by key (e.g. 'NODE_NOT_FOUND') or numeric id (e.g. -5).
 * For parameterized messages pass params after the keyOrId.
 * Returns a string.
 */
export function getErrorMessage(keyOrId, ...params) {
    let entry;
    if (typeof keyOrId === 'string') {
        entry = ERROR_MESSAGES[keyOrId];
    } else if (typeof keyOrId === 'number') {
        entry = Object.values(ERROR_MESSAGES).find(e => e.id === keyOrId);
    }

    if (!entry) return `Unknown error (${keyOrId})`;

    if (typeof entry.format === 'function') return entry.format(...params);
    return entry.text;
}