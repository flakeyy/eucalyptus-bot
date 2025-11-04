import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { getUserId } = require('./utility/helper_functions.js');
const { users } = require('./users.json');

// bitwise integer permisisons
export const PERMISSIONS = {
    READ_NESTS: 1 << 0, //1
    READ_EGGS: 1 << 1, //2
    CREATE_SERVER: 1 << 2, //4
    SUSPEND_OWN_SERVER: 1 << 3, //8
    UNSUSPEND_OWN_SERVER: 1 << 4, //16
    DELETE_OWN_SERVER: 1 << 5, //32
    READ_OWN_SERVERS: 1 << 6, //64
    EDIT_SERVER_SETTINGS: 1 << 7, //128

    ADMINISTRATOR: 1 << 16, //65536
}

function hasPermission(userId, permission) {
    for(const user of users) {
        if(user.panelId === userId) {
            const userPermissions = user.permissions;
            return (userPermissions & permission) === permission;
        }
    }
    return false;
}

export function authenticateUserForPermission(discordId, permission) {
    const userId = getUserId(discordId);
    if(userId < 0) {
        return userId;
    }
    if(hasPermission(userId, permission) || hasPermission(userId, PERMISSIONS.ADMINISTRATOR)) {
        return true;
    }
    return false;
}
