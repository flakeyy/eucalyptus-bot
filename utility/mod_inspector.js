const AdmZip = require("adm-zip");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CACHE_PATH = path.join(__dirname, "../mod_inspector_cache.json");
// Bump when detection heuristics change so cached verdicts are recomputed.
const CACHE_VERSION = "v2";

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

// Parses mod metadata JSON, tolerating the lenient JSON that mod loaders accept
// (GSON allows raw control characters inside string literals — e.g. multi-line
// description fields — which strict JSON.parse rejects).
function lenientJsonParse(text) {
  const stripped = text.replace(/^\uFEFF/, "");
  try { return JSON.parse(stripped); } catch { /* try repair below */ }

  // Escape raw control characters that appear inside string literals.
  let out = "", inString = false, escaped = false;
  for (const ch of stripped) {
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === "\\") { out += ch; escaped = true; continue; }
      if (ch === "\"") { inString = false; out += ch; continue; }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      out += ch;
    } else {
      if (ch === "\"") inString = true;
      out += ch;
    }
  }
  try { return JSON.parse(out); } catch { return null; }
}

// Extracts side-detection signals from a Forge/NeoForge mods.toml.
//   clientSideOnly - top-level clientSideOnly=true flag (authoritative)
//   mcDepSide      - side declared on the minecraft dependency, if any
//   loaderDepSide  - side declared on the forge/neoforge dependency, if any
//   depSides       - every side value declared across dependency blocks
function parseForgeTomlSignals(content) {
  const out = {
    clientSideOnly: /^\s*clientSideOnly\s*=\s*true/im.test(content),
    mcDepSide: null,
    loaderDepSide: null,
    depSides: []
  };
  for (const block of content.split(/\[\[dependencies\./).slice(1)) {
    const modId = (block.match(/modId\s*=\s*"([^"]+)"/) || [])[1];
    const side = (block.match(/side\s*=\s*"(\w+)"/) || [])[1] ?? null;
    if (side) out.depSides.push(side);
    if (modId === "minecraft") out.mcDepSide = side;
    if (modId === "forge" || modId === "neoforge") out.loaderDepSide = side;
  }
  return out;
}

// Inspects a mod JAR buffer and classifies its side.
// loaderType ("fabric"|"quilt"|"forge"|"neoforge"|null) selects which metadata is
// authoritative when a JAR ships support for multiple loaders (universal JAR).
//
// Returns { verdict, confidence, loader, source }:
//   verdict    - "client" (client-only) or "unknown" (no client-only evidence)
//   confidence - for "client": "explicit" (declared by the mod), "strong"
//                (high-precision heuristic), or "weak" (heuristic that should be
//                overridden by provider metadata when available); null otherwise
//   loader     - loader whose metadata produced the signal (or was present)
//   source     - human-readable signal name for logging
//
// Heuristics were tuned against a labeled corpus of real mods (see git history):
// explicit/strong signals had zero false positives; weak signals are correct on
// client mods but occasionally fire on server mods with sloppy metadata, so the
// install engine lets provider (Modrinth) side metadata rescue those.
function inspectModJar(buffer, loaderType = null) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    return { verdict: "unknown", confidence: null, loader: null, source: "error" };
  }

  const readJson = name => {
    const entry = zip.getEntry(name);
    return entry ? lenientJsonParse(entry.getData().toString("utf8")) : null;
  };
  const readToml = name => {
    const entry = zip.getEntry(name);
    return entry ? parseForgeTomlSignals(entry.getData().toString("utf8")) : null;
  };

  const fabric = readJson("fabric.mod.json");
  const quilt = readJson("quilt.mod.json");
  const forge = readToml("META-INF/mods.toml");
  const neo = readToml("META-INF/neoforge.mods.toml");

  const fabricEnv = typeof fabric?.environment === "string" ? fabric.environment : null;
  // Quilt declares environment under minecraft.environment (older mods used quilt_loader).
  const quiltEnv = quilt?.minecraft?.environment ?? quilt?.quilt_loader?.environment ?? null;

  // Pick the metadata that matches the target loader; cross-loader fallbacks
  // mirror actual loader compatibility (Quilt loads Fabric mods, NeoForge reads
  // legacy mods.toml).
  const isTomlLoader = loaderType === "forge" || loaderType === "neoforge";
  const preferredToml = loaderType === "neoforge" ? (neo ?? forge) : loaderType === "forge" ? forge : null;
  const preferredEnv = loaderType === "quilt" ? (quiltEnv ?? fabricEnv) : loaderType === "fabric" ? fabricEnv : null;
  const anyToml = preferredToml ?? neo ?? forge;
  const anyEnv = preferredEnv ?? quiltEnv ?? fabricEnv;

  const envLoader = quiltEnv !== null && (loaderType === "quilt" || fabricEnv === null) ? "quilt" : "fabric";
  const tomlLoader = neo && (loaderType === "neoforge" || !forge) ? "neoforge" : "forge";

  // 1. Explicit declarations in the target loader's own metadata.
  const ownEnv = loaderType ? preferredEnv : anyEnv;
  const ownToml = loaderType ? preferredToml : anyToml;
  if (ownEnv === "client" && (!loaderType || !isTomlLoader)) {
    return { verdict: "client", confidence: "explicit", loader: envLoader, source: "env-client" };
  }
  if (ownToml?.clientSideOnly) {
    return { verdict: "client", confidence: "explicit", loader: tomlLoader, source: "clientSideOnly" };
  }

  // Server-content evidence used to corroborate or veto heuristics below.
  const hasDataContent = zip.getEntries().some(e =>
    /^data\/[^/]+\/(recipes?|loot_tables?|worldgen|structures|advancements?)\//.test(e.entryName)
  );
  let clientMixins = 0, commonMixins = 0, serverMixins = 0;
  for (const e of zip.getEntries()) {
    if (e.isDirectory || e.entryName.includes("/")) continue; // mixin configs live at the JAR root
    if (!/mixins?.*\.json$/i.test(e.entryName) || /refmap/i.test(e.entryName)) continue;
    const mixinConfig = lenientJsonParse(e.getData().toString("utf8"));
    if (!mixinConfig?.package) continue;
    clientMixins += (mixinConfig.client ?? []).length;
    commonMixins += (mixinConfig.mixins ?? []).length;
    serverMixins += (mixinConfig.server ?? []).length;
  }

  // 2. Strong heuristics.
  // A universal JAR that declares client-only for another loader is almost
  // certainly client-only on this loader too (mods rarely differ per loader).
  if (anyEnv === "client" || anyToml?.clientSideOnly) {
    return { verdict: "client", confidence: "strong", loader: anyEnv === "client" ? envLoader : tomlLoader, source: "cross-loader-env" };
  }
  // A large mixin set that is overwhelmingly client-targeted, with no datapack
  // content, only occurs in client-only mods (UI/render overhauls). Small
  // all-client mixin sets also occur in server-needed libraries whose only
  // mixins happen to be client tweaks, so those are downgraded to weak below.
  const totalMixins = clientMixins + commonMixins + serverMixins;
  const mixinDominant = !hasDataContent && totalMixins > 0 && clientMixins / totalMixins >= 0.95;
  if (mixinDominant && clientMixins >= 20) {
    return { verdict: "client", confidence: "strong", loader: loaderType, source: "client-mixins" };
  }

  // 3. Weak heuristics — skipped entirely when the JAR shows server content.
  const contradicted = hasDataContent || commonMixins >= 5;
  if (!contradicted) {
    if (mixinDominant && clientMixins >= 2) {
      return { verdict: "client", confidence: "weak", loader: loaderType, source: "client-mixins" };
    }
    if (ownToml?.mcDepSide === "CLIENT" || ownToml?.loaderDepSide === "CLIENT") {
      return { verdict: "client", confidence: "weak", loader: tomlLoader, source: "dep-side-client" };
    }
    if (ownToml && ownToml.depSides.length > 0 && ownToml.depSides.every(s => s === "CLIENT")) {
      return { verdict: "client", confidence: "weak", loader: tomlLoader, source: "all-deps-client" };
    }
    const entrypoints = Object.keys(fabric?.entrypoints ?? {});
    if ((!loaderType || !isTomlLoader) && entrypoints.includes("client")
        && !entrypoints.includes("main") && !entrypoints.includes("server")) {
      return { verdict: "client", confidence: "weak", loader: "fabric", source: "client-entrypoints" };
    }
  }

  const presentLoader = fabric ? "fabric" : quilt ? "quilt" : neo ? "neoforge" : forge ? "forge" : null;
  return { verdict: "unknown", confidence: null, loader: presentLoader, source: presentLoader ? "no-signal" : "no-metadata" };
}

// Combines a JAR inspection with provider-side metadata (Modrinth server_side /
// mrpack env.server: "required" | "optional" | "unsupported" | null) into the
// final skip decision. Returns true when the mod should not be installed.
//   - explicit/strong client verdicts are always trusted
//   - weak verdicts yield to a provider that says the mod runs on servers
//   - with no JAR signal, the provider's "unsupported" is followed
function isClientOnlyMod(inspection, providerServerSide = null) {
  if (inspection.verdict === "client") {
    if (inspection.confidence === "weak") {
      return providerServerSide !== "optional" && providerServerSide !== "required";
    }
    return true;
  }
  return providerServerSide === "unsupported";
}

// Like inspectModJar but checks an on-disk cache keyed by SHA1+loaderType first.
// If sha1 is null, computes it from the buffer.
// Writes new results to cache before returning.
function inspectModJarCached(sha1, buffer, loaderType = null) {
  loadCache();

  const hash = sha1 ?? crypto.createHash("sha1").update(buffer).digest("hex");
  const key = `${hash}:${loaderType ?? "any"}:${CACHE_VERSION}`;
  if (cache[key]?.verdict) return cache[key];

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
    const meta = lenientJsonParse(entry.getData().toString("utf8"));
    if (!meta) return null;
    const modId = meta.id ?? null;
    const requiredDeps = Object.keys(meta.depends ?? {}).filter(d => !SYSTEM_MOD_IDS.has(d));
    return { modId, requiredDeps };
  };

  const fromQuilt = () => {
    const entry = zip.getEntry("quilt.mod.json");
    if (!entry) return null;
    const meta = lenientJsonParse(entry.getData().toString("utf8"));
    if (!meta) return null;
    const modId = meta?.quilt_loader?.id ?? null;
    const depList = meta?.quilt_loader?.depends ?? [];
    const requiredDeps = (Array.isArray(depList) ? depList : [])
      .map(d => typeof d === "string" ? d : d?.id)
      .filter(id => id && !SYSTEM_MOD_IDS.has(id));
    return { modId, requiredDeps };
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

module.exports = { inspectModJar, inspectModJarCached, isClientOnlyMod, extractModDeps, flushModInspectorCache };
