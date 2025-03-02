import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { users } = require('./users.json');

// bitwise integer permisisons
export const PERMISSIONS = {
    READ_NESTS: 1 << 0, //1
    READ_EGGS: 1 << 1, //2
    CREATE_SERVER: 1 << 2, //4
    ADMINISTRATOR: 1 << 3, //8
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
