// Resolves the mod-loader build a pack expects and maps it onto egg env vars
// (FORGE_VERSION / NEOFORGE_VERSION / LOADER_VERSION, plus Forge BUILD_TYPE).
// Prefer an exact version from the pack; fall back to "latest" when unknown so
// we do not install a stale "recommended" Forge that mods reject.
"use strict";

const AdmZip = require("adm-zip");
const { parseManifestFromZip } = require("./curseforge.js");
const { parseMrpackIndex } = require("./modrinth.js");

// Parses CurseForge manifest.json minecraft.modLoaders into
// { loaderType, build, mcVersion } or null.
function parseCurseforgeManifestLoader(manifest) {
  if (!manifest?.minecraft) return null;
  const mcVersion = manifest.minecraft.version || null;
  const loaders = manifest.minecraft.modLoaders || [];
  const primary = loaders.find(l => l.primary) ?? loaders[0];
  if (!primary?.id || typeof primary.id !== "string") return null;
  const match = primary.id.match(/^(forge|neoforge|fabric|quilt)-(.+)$/i);
  if (!match) return null;
  return {
    loaderType: match[1].toLowerCase(),
    build: match[2],
    mcVersion
  };
}

// Parses Modrinth .mrpack dependencies into { loaderType, build, mcVersion }.
function parseMrpackLoaderSpec(deps) {
  if (!deps || typeof deps !== "object") return null;
  const mcVersion = deps.minecraft || null;
  for (const [ key, value ] of Object.entries(deps)) {
    const k = key.toLowerCase();
    if (k === "minecraft") continue;
    let loaderType = null;
    if (k === "forge") loaderType = "forge";
    else if (k === "neoforge") loaderType = "neoforge";
    else if (k === "fabric-loader" || k === "fabric") loaderType = "fabric";
    else if (k === "quilt-loader" || k === "quilt") loaderType = "quilt";
    if (!loaderType || value === null || value === undefined || value === "") continue;
    return { loaderType, build: String(value).replace(/^v/i, ""), mcVersion };
  }
  return null;
}

// Reads loader version metadata from a downloaded pack zip (CF manifest or mrpack).
function detectLoaderVersionFromBuffer(buffer) {
  const manifest = parseManifestFromZip(buffer);
  if (manifest) {
    const spec = parseCurseforgeManifestLoader(manifest);
    if (spec) return spec;
  }
  const index = parseMrpackIndex(buffer);
  if (index?.dependencies) {
    const spec = parseMrpackLoaderSpec(index.dependencies);
    if (spec) return spec;
  }
  return null;
}

// Formats a loader build into the string the panel egg installer expects.
// Forge maven coords are `${mc}-${build}`; NeoForge is bare (except 1.20.1 bridge).
// Legacy Forge (1.7.10 / 1.8.9) used a triple maven version `${mc}-${build}-${mc}`.
function formatEggLoaderVersion(loaderType, mcVersion, build) {
  if (!build) return null;
  const cleaned = String(build).trim();
  if (!cleaned) return null;

  if (loaderType === "forge") {
    let version = cleaned;
    if (mcVersion) {
      if (cleaned.startsWith(`${mcVersion}-`)) {
        version = cleaned;
      } else if (/^\d+\.\d+(\.\d+)?-\d/.test(cleaned)) {
        // Already a full maven coord for some MC version (e.g. 1.20.1-47.4.20).
        version = cleaned;
      } else {
        version = `${mcVersion}-${cleaned}`;
      }

      // Egg scripts that take FORGE_VERSION verbatim skip their 1.7.10 / 1.8.9
      // special-case URL builder — those builds live under mc-build-mc on Maven.
      if (
        (mcVersion === "1.7.10" || mcVersion === "1.8.9")
        && version.startsWith(`${mcVersion}-`)
        && !version.endsWith(`-${mcVersion}`)
      ) {
        version = `${version}-${mcVersion}`;
      }
    }
    return version;
  }

  if (loaderType === "neoforge") {
    // 1.20.1 NeoForge builds lived under the transitional forge artifact.
    if (mcVersion === "1.20.1" && /^47\./.test(cleaned) && !cleaned.startsWith("1.20.1-")) {
      return `1.20.1-${cleaned}`;
    }
    if (cleaned.startsWith("1.20.1-")) return cleaned;
    return cleaned.replace(/^neoforge-/i, "");
  }

  // Fabric / Quilt loader versions are bare (e.g. 0.16.14).
  return cleaned.replace(/^(fabric-loader-|quilt-loader-)/i, "");
}

// Builds egg environment overrides for the detected (or fallback) loader build.
// Returns { envOverrides, resolvedVersion, source } where source is
// "pack" | "latest-fallback" | null.
function buildLoaderEggEnv({ loaderType, mcVersion, loaderSpec, config }) {
  const envOverrides = {};
  const versionVarMap = config.loader_version_variables || {
    forge: "FORGE_VERSION",
    neoforge: "NEOFORGE_VERSION",
    fabric: "LOADER_VERSION",
    quilt: "LOADER_VERSION"
  };
  const buildTypeVar = config.forge_build_type_variable || "BUILD_TYPE";
  const versionVar = versionVarMap[loaderType] || null;

  const packBuild = loaderSpec?.build
    && (!loaderSpec.loaderType || loaderSpec.loaderType === loaderType)
    ? loaderSpec.build
    : null;
  const packMc = loaderSpec?.mcVersion || mcVersion || null;
  const formatted = packBuild ? formatEggLoaderVersion(loaderType, packMc, packBuild) : null;

  if (formatted && versionVar) {
    envOverrides[versionVar] = formatted;
    return { envOverrides, resolvedVersion: formatted, source: "pack" };
  }

  // No pack pin: prefer latest over recommended for Forge (BUILD_TYPE), and
  // leave Fabric/NeoForge on their egg defaults ("latest" / empty → metadata).
  if (loaderType === "forge" && buildTypeVar) {
    envOverrides[buildTypeVar] = "latest";
    if (versionVar) envOverrides[versionVar] = "";
    return { envOverrides, resolvedVersion: null, source: "latest-fallback" };
  }

  return { envOverrides, resolvedVersion: null, source: null };
}

// Lightweight zip probe used by tests without pulling full install deps.
function zipHasEntry(buffer, name) {
  try {
    return new AdmZip(buffer).getEntry(name) !== null;
  } catch {
    return false;
  }
}

module.exports = {
  parseCurseforgeManifestLoader,
  parseMrpackLoaderSpec,
  detectLoaderVersionFromBuffer,
  formatEggLoaderVersion,
  buildLoaderEggEnv,
  zipHasEntry
};
