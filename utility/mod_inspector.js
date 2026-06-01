const AdmZip = require("adm-zip");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CACHE_PATH = path.join(__dirname, "../mod_inspector_cache.json");

let cache = null;
let cacheDirty = false;

function loadCache() {
  if (cache !== null) return;
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    cache = {};
  }
}

// Persists the cache to disk only when there are unwritten entries. Callers
// (e.g. the install engine) invoke this once per batch instead of paying a
// synchronous full-file write for every inspected JAR.
function flushModInspectorCache() {
  if (!cacheDirty || cache === null) return;
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  cacheDirty = false;
}

// Checks if a Forge/NeoForge mods.toml declares the mod as client-only.
// Looks for a minecraft dependency block that explicitly sets side="CLIENT".
function isForgeClientOnly(content) {
  const depBlocks = content.split(/\[\[dependencies\./);
  for (const block of depBlocks.slice(1)) {
    if (/modId\s*=\s*"minecraft"/.test(block) && /side\s*=\s*"CLIENT"/.test(block)) return true;
  }
  return false;
}

// Inspects a mod JAR buffer and returns client-side status.
// loaderType ("fabric"|"quilt"|"forge"|"neoforge"|null) controls which metadata file is
// preferred when a JAR ships support for multiple loaders (universal/multi-loader mod).
// Returns { isClientOnly: boolean, loader: string|null, source: string }
// If the mod declares no environment/side metadata, isClientOnly is false (safe default).
function inspectModJar(buffer, loaderType = null) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    return { isClientOnly: false, loader: null, source: "error" };
  }

  // Read all present metadata entries up front so we can pick the right one for multi-loader JARs.
  const parseFabric = () => {
    const entry = zip.getEntry("fabric.mod.json");
    if (!entry) return null;
    try {
      const meta = JSON.parse(entry.getData().toString("utf8"));
      return { isClientOnly: meta.environment === "client", loader: "fabric", source: "fabric.mod.json" };
    } catch { return null; }
  };

  const parseQuilt = () => {
    const entry = zip.getEntry("quilt.mod.json");
    if (!entry) return null;
    try {
      const meta = JSON.parse(entry.getData().toString("utf8"));
      const env = meta?.quilt_loader?.environment;
      return { isClientOnly: env === "client", loader: "quilt", source: "quilt.mod.json" };
    } catch { return null; }
  };

  const parseNeoforge = () => {
    const entry = zip.getEntry("META-INF/neoforge.mods.toml");
    if (!entry) return null;
    const content = entry.getData().toString("utf8");
    return { isClientOnly: isForgeClientOnly(content), loader: "neoforge", source: "META-INF/neoforge.mods.toml" };
  };

  const parseForge = () => {
    const entry = zip.getEntry("META-INF/mods.toml");
    if (!entry) return null;
    const content = entry.getData().toString("utf8");
    return { isClientOnly: isForgeClientOnly(content), loader: "forge", source: "META-INF/mods.toml" };
  };

  // When the loader is known, check the matching metadata file first so a universal JAR
  // (one that bundles metadata for multiple loaders) is evaluated for the correct side.
  // Quilt falls back to Fabric metadata since Quilt can load Fabric mods.
  // NeoForge falls back to Forge metadata for the same reason.
  if (loaderType) {
    let result = null;
    if (loaderType === "fabric")   result = parseFabric();
    if (loaderType === "quilt")    result = parseQuilt() ?? parseFabric();
    if (loaderType === "neoforge") result = parseNeoforge() ?? parseForge();
    if (loaderType === "forge")    result = parseForge();
    if (result) return result;
  }

  // Unknown loader or no matching metadata found: fall through in priority order.
  return parseFabric() ?? parseQuilt() ?? parseNeoforge() ?? parseForge()
    ?? { isClientOnly: false, loader: null, source: "no-metadata" };
}

// Like inspectModJar but checks an on-disk cache keyed by SHA1+loaderType first.
// If sha1 is null, computes it from the buffer.
// Writes new results to cache before returning.
function inspectModJarCached(sha1, buffer, loaderType = null) {
  loadCache();

  const hash = sha1 ?? crypto.createHash("sha1").update(buffer).digest("hex");
  const key = loaderType ? `${hash}:${loaderType}` : hash;
  if (cache[key]) return cache[key];

  const result = inspectModJar(buffer, loaderType);
  cache[key] = result;
  cacheDirty = true;

  return result;
}

// IDs that are always present on a server and should not trigger dependency propagation.
const SYSTEM_MOD_IDS = new Set([ "minecraft", "forge", "neoforge", "java", "neoforge_version" ]);

// Extracts a mod's own ID and its mandatory (required) dependencies from a JAR buffer.
// Returns { modId: string|null, requiredDeps: string[] }
function extractModDeps(buffer, loaderType = null) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    return { modId: null, requiredDeps: [] };
  }

  const fromFabric = () => {
    const entry = zip.getEntry("fabric.mod.json");
    if (!entry) return null;
    try {
      const meta = JSON.parse(entry.getData().toString("utf8"));
      const modId = meta.id ?? null;
      const requiredDeps = Object.keys(meta.depends ?? {}).filter(d => !SYSTEM_MOD_IDS.has(d));
      return { modId, requiredDeps };
    } catch { return null; }
  };

  const fromQuilt = () => {
    const entry = zip.getEntry("quilt.mod.json");
    if (!entry) return null;
    try {
      const meta = JSON.parse(entry.getData().toString("utf8"));
      const modId = meta?.quilt_loader?.id ?? null;
      const depList = meta?.quilt_loader?.depends ?? [];
      const requiredDeps = (Array.isArray(depList) ? depList : [])
        .map(d => typeof d === "string" ? d : d?.id)
        .filter(id => id && !SYSTEM_MOD_IDS.has(id));
      return { modId, requiredDeps };
    } catch { return null; }
  };

  const fromForgeToml = filename => {
    const entry = zip.getEntry(filename);
    if (!entry) return null;
    const content = entry.getData().toString("utf8");

    // First modId in the file belongs to the [[mods]] declaration (appears before [[dependencies.*]])
    const modIdMatch = content.match(/modId\s*=\s*"([^"]+)"/);
    const modId = modIdMatch ? modIdMatch[1] : null;

    const requiredDeps = [];
    const depBlocks = content.split(/\[\[dependencies\./);
    for (const block of depBlocks.slice(1)) {
      if (/mandatory\s*=\s*false/.test(block)) continue;
      if (/type\s*=\s*"optional"/.test(block)) continue;
      if (/side\s*=\s*"CLIENT"/.test(block)) continue;
      const depMatch = block.match(/modId\s*=\s*"([^"]+)"/);
      if (depMatch && !SYSTEM_MOD_IDS.has(depMatch[1])) requiredDeps.push(depMatch[1]);
    }

    return { modId, requiredDeps };
  };

  if (loaderType) {
    let result = null;
    if (loaderType === "fabric")   result = fromFabric();
    if (loaderType === "quilt")    result = fromQuilt() ?? fromFabric();
    if (loaderType === "neoforge") result = fromForgeToml("META-INF/neoforge.mods.toml") ?? fromForgeToml("META-INF/mods.toml");
    if (loaderType === "forge")    result = fromForgeToml("META-INF/mods.toml");
    if (result) return result;
  }

  return fromFabric() ?? fromQuilt()
    ?? fromForgeToml("META-INF/neoforge.mods.toml")
    ?? fromForgeToml("META-INF/mods.toml")
    ?? { modId: null, requiredDeps: [] };
}

module.exports = { inspectModJar, inspectModJarCached, extractModDeps, flushModInspectorCache };
