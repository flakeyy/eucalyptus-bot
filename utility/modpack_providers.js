// Source dispatch for modpack installs. Determines which provider a user-supplied
// URL belongs to and routes manifest/archive resolution to the matching resolver.
// Commit 1 wires CurseForge only; Modrinth is added in a follow-up.
const { resolveCurseforgeInstall } = require("./curseforge.js");

// Determines the modpack source from user input. Returns "curseforge",
// "modrinth", or null when the host isn't recognized. Bare numeric input is
// treated as a CurseForge project ID for backward compatibility.
function detectProvider(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return "curseforge";

  let host;
  try {
    host = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === "curseforge.com" || host.endsWith(".curseforge.com")) return "curseforge";
  if (host === "modrinth.com" || host.endsWith(".modrinth.com")) return "modrinth";
  return null;
}

// Resolves a downloaded modpack archive into an install result for the given
// source. Returns { kind: "archive", ... } or { kind: "plan", plan } (or null
// when the buffer can't be resolved). onProgress(message) surfaces status.
async function resolveModpackInstall(source, buffer, loaderType, onProgress = () => {}) {
  if (source === "curseforge") return resolveCurseforgeInstall(buffer, loaderType, onProgress);
  return null;
}

module.exports = { detectProvider, resolveModpackInstall };
