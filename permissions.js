import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { users } = require('./users.json');

// bitwise integer permisisons
export const PERMISSIONS = {
    READ_NESTS: 1 << 0, //1
    READ_EGGS: 1 << 1, //2
    CREATE_SERVER: 1 << 2, //4
    SUSPEND_OWN_SERVER: 1 << 3, //8
    UNSUSPEND_OWN_SERVER: 1 << 4, //16
    DELETE_OWN_SERVER: 1 << 5, //32
    LIST_OWN_SERVERS: 1 << 6, //64
    EDIT_SERVER_SETTINGS: 1 << 7, //128

    ADMINISTRATOR: 1 << 16, //65536
}

function hasPermission(user, permission) {
    const userPermissions = user.permissions;
    return (userPermissions & permission) === permission;
}

export function authenticateUserForPermission(discordId, permission) {
    for (const user of users) {
        if (user.discordId === discordId) {
            if(hasPermission(user, permission) || hasPermission(user, PERMISSIONS.ADMINISTRATOR)) {
                return user.panelId;
            }
            else {
                return -2;
            }
        }
    }
    return -1;
}
