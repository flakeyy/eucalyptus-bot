const { MessageFlags } = require("discord.js");
const { PERMISSIONS } = require("../../../utility/permissions.js");
const db = require("../../../utility/database.js");
const { getServerInfoById, getServerResourceInfoById } = require("../../../utility/server_functions.js");
const { HTTP_STATUS_CODES } = require("../../../utility/constants.js");

// Shared guards/lookups used by the admin user and server handlers.

// Looks up the target user's DB row, replying with a "not found" message and
// returning null when absent. `notFoundExtra` is appended after the mention.
async function requireDbUser(interaction, targetUser, notFoundExtra = "") {
  const existing = db.getUserByDiscordId(targetUser.id);
  if (!existing) {
    await interaction.editReply({
      content: `No database entry found for <@${targetUser.id}>${notFoundExtra}`,
      flags: MessageFlags.Ephemeral
    });
    return null;
  }
  return existing;
}

// Replies and returns true when the target account is IMMUNITY-protected and the
// caller is not allowed to act on it. Self-edits are permitted when allowSelf.
async function denyIfImmune(interaction, dbUser, { callerId, targetId, allowSelf = true, action = "modified" }) {
  const isImmune = Boolean(dbUser.permissions & PERMISSIONS.IMMUNITY);
  if (isImmune && !(allowSelf && callerId === targetId)) {
    await interaction.editReply({
      content: `This user's account is protected and cannot be ${action}.`,
      flags: MessageFlags.Ephemeral
    });
    return true;
  }
  return false;
}

// Re-fetches a server's info and patches it into serverObjects in place.
// Returns the updated server object, or null if the fetch failed.
async function refreshServerInState(serverObjects, serverId, targetDiscordId) {
  const res = await getServerInfoById(serverId, targetDiscordId);
  if (res.statusCode === HTTP_STATUS_CODES.OK) {
    const updated = await res.body.json();
    const idx = serverObjects.data.findIndex(s => s.attributes.identifier === serverId);
    if (idx !== -1) serverObjects.data[idx] = updated;
    return updated;
  }
  return null;
}

// Fetches a server's live resource info, or null when unavailable (e.g. suspended).
async function fetchResourceInfo(serverId, targetDiscordId) {
  const res = await getServerResourceInfoById(serverId, targetDiscordId);
  return res.statusCode === HTTP_STATUS_CODES.OK ? await res.body.json() : null;
}

module.exports = {
  requireDbUser,
  denyIfImmune,
  refreshServerInState,
  fetchResourceInfo
};
