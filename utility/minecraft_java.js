// Maps a Minecraft version string onto the Pterodactyl yolk image that should
// run that server. Thresholds live in config.minecraft_java_map (MC version →
// Java major); images live in config.java_images.
"use strict";

function parseMcVersionParts(mcVersion) {
  if (!mcVersion || typeof mcVersion !== "string") return null;
  const match = mcVersion.trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] !== undefined ? Number(match[3]) : 0
  };
}

function compareMcVersions(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

// Picks the docker image for `mcVersion` using the highest map key that is
// <= that version. Versions older than every map key (e.g. 1.7.10 when the
// floor is 1.8) fall back to Java 8.
function getJavaImageForMCVersion(mcVersion, config) {
  const javaMap = config?.minecraft_java_map;
  const images = config?.java_images;
  if (!mcVersion || !javaMap || !images) return null;

  const target = parseMcVersionParts(mcVersion);
  if (!target) return null;

  const entries = Object.entries(javaMap)
    .map(([ key, javaVer ]) => {
      const parts = parseMcVersionParts(key);
      return parts ? { parts, javaVer } : null;
    })
    .filter(Boolean)
    .sort((a, b) => compareMcVersions(b.parts, a.parts));

  for (const entry of entries) {
    if (compareMcVersions(target, entry.parts) >= 0) {
      return images[String(entry.javaVer)] || null;
    }
  }

  return images["8"] || null;
}

module.exports = {
  parseMcVersionParts,
  compareMcVersions,
  getJavaImageForMCVersion
};
