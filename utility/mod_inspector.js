const AdmZip = require("adm-zip");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const config = require("../config.json");
const { FORGE_MOD_ANNOTATIONS } = require("./crash_risk.js");
const {
  getInspection, putInspection, getLearnedVerdict, flushVerdictStore
} = require("./verdict_store.js");

// Bump when detection logic changes so cached verdicts are recomputed.
const CACHE_VERSION = "v8";

// ── Curated lists (Layer 1 slots 2 and 6) ───────────────────────────────────

function loadCuratedList(filename) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, "../data", filename), "utf8"));
    return {
      modIds: new Set((data.modIds ?? []).map(s => s.toLowerCase())),
      filenamePrefixes: (data.filenamePrefixes ?? []).map(s => s.toLowerCase()),
      sha1s: new Set(data.sha1s ?? [])
    };
  } catch {
    return { modIds: new Set(), filenamePrefixes: [], sha1s: new Set() };
  }
}

const CLIENT_SIDE_MODS = loadCuratedList("client_side_mods.json");
const SERVER_SIDE_OVERRIDES = loadCuratedList("server_side_overrides.json");

function matchesCuratedList(list, { modId = null, filename = null, sha1 = null } = {}) {
  if (sha1 && list.sha1s.has(sha1)) return true;
  if (modId && list.modIds.has(modId.toLowerCase())) return true;
  if (filename) {
    const base = filename.split("/").pop().toLowerCase();
    if (list.filenamePrefixes.some(p => base.startsWith(p))) return true;
  }
  return false;
}

// ── Metadata parsing ────────────────────────────────────────────────────────

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

// Reads the explicit clientSideOnly flag from a Forge/NeoForge mods.toml.
function tomlClientSideOnly(content) {
  return /^\s*clientSideOnly\s*=\s*true/im.test(content);
}

// Reads @Mod(clientSideOnly=true) from a classfile's RuntimeVisibleAnnotations.
// Returns true/false when the element is present, or null when the class is not
// a Forge @Mod container (or the attribute is absent/unreadable).
function readModClientSideOnly(buf) {
  if (!buf || buf.length < 10 || buf.readUInt32BE(0) !== 0xCAFEBABE) return null;
  const cpCount = buf.readUInt16BE(8);
  const tags = new Array(cpCount);
  const values = new Array(cpCount);
  let offset = 10;
  try {
    for (let i = 1; i < cpCount; i++) {
      const tag = buf[offset++];
      tags[i] = tag;
      if (tag === 1) {
        const len = buf.readUInt16BE(offset); offset += 2;
        values[i] = buf.toString("utf8", offset, offset + len); offset += len;
      } else if (tag === 7 || tag === 8 || tag === 16 || tag === 19 || tag === 20) {
        values[i] = buf.readUInt16BE(offset); offset += 2;
      } else if (tag === 3 || tag === 4) {
        values[i] = buf.readInt32BE(offset); offset += 4;
      } else if (tag === 5 || tag === 6) {
        offset += 8; i++;
      } else if (tag === 9 || tag === 10 || tag === 11 || tag === 12 || tag === 17 || tag === 18) {
        offset += 4;
      } else if (tag === 15) {
        offset += 3;
      } else {
        return null;
      }
    }
  } catch {
    return null;
  }

  const utf8 = i => (typeof values[i] === "string" ? values[i] : null);

  const skipFieldsMethods = () => {
    offset += 6; // access, this, super
    const ifaceCount = buf.readUInt16BE(offset); offset += 2 + ifaceCount * 2;
    const skipMembers = count => {
      for (let m = 0; m < count; m++) {
        offset += 6; // access, name, desc
        const attrCount = buf.readUInt16BE(offset); offset += 2;
        for (let a = 0; a < attrCount; a++) {
          const len = buf.readUInt32BE(offset + 2);
          offset += 6 + len;
        }
      }
    };
    const fieldCount = buf.readUInt16BE(offset); offset += 2;
    skipMembers(fieldCount);
    const methodCount = buf.readUInt16BE(offset); offset += 2;
    skipMembers(methodCount);
  };

  try {
    skipFieldsMethods();
  } catch {
    return null;
  }

  if (offset + 2 > buf.length) return null;
  const attrCount = buf.readUInt16BE(offset); offset += 2;
  for (let a = 0; a < attrCount; a++) {
    if (offset + 6 > buf.length) return null;
    const nameIdx = buf.readUInt16BE(offset);
    const len = buf.readUInt32BE(offset + 2);
    offset += 6;
    const attrEnd = offset + len;
    if (attrEnd > buf.length) return null;
    if (utf8(nameIdx) === "RuntimeVisibleAnnotations" && len >= 2) {
      let p = offset;
      const numAnnotations = buf.readUInt16BE(p); p += 2;
      for (let n = 0; n < numAnnotations; n++) {
        if (p + 4 > attrEnd) break;
        const type = utf8(buf.readUInt16BE(p)); p += 2;
        const numPairs = buf.readUInt16BE(p); p += 2;
        const isMod = FORGE_MOD_ANNOTATIONS.includes(type);
        for (let e = 0; e < numPairs; e++) {
          if (p + 3 > attrEnd) break;
          const elemName = utf8(buf.readUInt16BE(p)); p += 2;
          const tag = buf[p++];
          if (tag === 90 /* Z boolean */ && p + 2 <= attrEnd) {
            const constIdx = buf.readUInt16BE(p); p += 2;
            if (isMod && elemName === "clientSideOnly") {
              return values[constIdx] === 1;
            }
          } else if (tag === 115 /* s string */ && p + 2 <= attrEnd) {
            p += 2;
          } else if (tag === 101 /* e enum */ && p + 4 <= attrEnd) {
            p += 4;
          } else if (tag === 99 /* c class */ && p + 2 <= attrEnd) {
            p += 2;
          } else if (tag === 64 /* @ nested */) {
            // Skip nested annotation roughly: abandon this attribute
            return isMod ? false : null;
          } else if (tag === 91 /* [ array */ && p + 2 <= attrEnd) {
            // Skip arrays — clientSideOnly is never an array
            return isMod ? false : null;
          } else if ((tag === 66 || tag === 67 || tag === 73 || tag === 83 || tag === 70 || tag === 68
            || tag === 74 || tag === 115) && p + 2 <= attrEnd) {
            // B C I S F D J s — const pool index (J/D still 2-byte index)
            p += 2;
          } else {
            return null;
          }
        }
        if (isMod) return false; // @Mod present but clientSideOnly absent/default
      }
    }
    offset = attrEnd;
  }
  return null;
}

// Scans Forge @Mod container classes for the explicit clientSideOnly annotation.
// Only explicit when every readable @Mod annotation is clientSideOnly=true
// (mixed multi-mod JARs like CraftTweaker 1.12 with one client submodule do NOT
// count).
function scanForgeModClientSignals(zip) {
  let modAnnoCount = 0;
  let clientSideOnlyCount = 0;
  let foundModClass = false;

  for (const e of zip.getEntries()) {
    if (e.isDirectory || !e.entryName.endsWith(".class")) continue;
    const buf = e.getData();
    if (!FORGE_MOD_ANNOTATIONS.some(m => buf.indexOf(m) !== -1)) continue;
    foundModClass = true;

    const annotated = readModClientSideOnly(buf);
    if (annotated === true) {
      modAnnoCount++;
      clientSideOnlyCount++;
    } else if (annotated === false) {
      modAnnoCount++;
    }
  }

  const clientSideOnly = modAnnoCount > 0 && clientSideOnlyCount === modAnnoCount;
  return { clientSideOnly, foundModClass };
}

// Inspects a mod JAR buffer for EXPLICIT client-only declarations only.
// loaderType ("fabric"|"quilt"|"forge"|"neoforge"|null) selects which metadata is
// authoritative when a JAR ships support for multiple loaders (universal JAR).
//
// Returns { verdict, confidence, loader, source }:
//   verdict    - "client" (self-declared client-only) or "unknown"
//   confidence - "explicit" (declared for the target loader) or "strong"
//                (declared for another loader in a universal JAR); null otherwise
//   loader     - loader whose metadata produced the signal (or was present)
//   source     - signal name for logging
//
// The old weak-heuristic tier (mixin-count thresholds, dep sides, GUI supers,
// client CP mentions) was deleted: it was overfit to specific mods and its job
// is now done by the curated client list (slot 6), the crash-proof scan
// (slot 8), and the boot-verify loop (Layer 3).
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
  const readTomlClientOnly = name => {
    const entry = zip.getEntry(name);
    return entry ? tomlClientSideOnly(entry.getData().toString("utf8")) : null;
  };

  const fabric = readJson("fabric.mod.json");
  const quilt = readJson("quilt.mod.json");
  const forge = readTomlClientOnly("META-INF/mods.toml");
  const neo = readTomlClientOnly("META-INF/neoforge.mods.toml");

  const fabricEnv = typeof fabric?.environment === "string" ? fabric.environment : null;
  // Quilt declares environment under minecraft.environment (older mods used quilt_loader).
  const quiltEnv = quilt?.minecraft?.environment ?? quilt?.quilt_loader?.environment ?? null;

  // Pick the metadata that matches the target loader; cross-loader fallbacks
  // mirror actual loader compatibility (Quilt loads Fabric mods, NeoForge reads
  // legacy mods.toml).
  const isTomlLoader = loaderType === "forge" || loaderType === "neoforge";
  const preferredTomlClientOnly = loaderType === "neoforge" ? (neo ?? forge) : loaderType === "forge" ? forge : null;
  const preferredEnv = loaderType === "quilt" ? (quiltEnv ?? fabricEnv) : loaderType === "fabric" ? fabricEnv : null;
  const anyTomlClientOnly = preferredTomlClientOnly ?? neo ?? forge;
  const anyEnv = preferredEnv ?? quiltEnv ?? fabricEnv;

  const envLoader = quiltEnv !== null && (loaderType === "quilt" || fabricEnv === null) ? "quilt" : "fabric";
  const tomlLoader = neo && (loaderType === "neoforge" || !forge) ? "neoforge" : "forge";

  // 1. Explicit declarations in the target loader's own metadata.
  const ownEnv = loaderType ? preferredEnv : anyEnv;
  const ownTomlClientOnly = loaderType ? preferredTomlClientOnly : anyTomlClientOnly;
  if (ownEnv === "client" && (!loaderType || !isTomlLoader)) {
    return { verdict: "client", confidence: "explicit", loader: envLoader, source: "env-client" };
  }
  if (ownTomlClientOnly) {
    return { verdict: "client", confidence: "explicit", loader: tomlLoader, source: "clientSideOnly" };
  }

  // 2. Cross-loader declarations: a universal JAR that declares client-only for
  // another loader is almost certainly client-only on this loader too.
  if (anyEnv === "client" || anyTomlClientOnly) {
    return { verdict: "client", confidence: "strong", loader: anyEnv === "client" ? envLoader : tomlLoader, source: "cross-loader-env" };
  }

  // 3. Legacy Forge bytecode: @Mod(clientSideOnly=true) containers (no mods.toml
  // side field). Skipped when inspecting as Fabric/Quilt.
  if (!loaderType || isTomlLoader) {
    const forgeScan = scanForgeModClientSignals(zip);
    if (forgeScan.clientSideOnly) {
      return { verdict: "client", confidence: "explicit", loader: "forge", source: "mod-annotation-clientSideOnly" };
    }
  }

  const presentLoader = fabric ? "fabric" : quilt ? "quilt" : neo !== null ? "neoforge" : forge !== null ? "forge" : null;
  return { verdict: "unknown", confidence: null, loader: presentLoader, source: presentLoader ? "no-signal" : "no-metadata" };
}

// ── Layer 1 decision: the precedence table ──────────────────────────────────
//
// Every input is either deterministic (config lists, provider metadata,
// explicit self-declarations) or self-correcting (learned verdicts from the
// boot-verify loop). Slots, first match wins:
//   1. config blocklist                          → skip,    never rescued
//   2. config allowlist / server_side_overrides  → install
//   3. learned crash verdict (VerdictStore sha1) → skip,    never rescued
//   4. provider required/optional                → install
//   5. explicit self-declared client metadata    → skip,    never rescued
//   6. curated client-side list                  → skip,    rescuable
//   7. provider unsupported                      → skip,    rescuable
//   8. Layer 2 crash-proof scan hit              → skip,    rescuable
//   9. default                                   → install
//
// "rescuable" skips may be reversed by the dependency-rescue fixpoint in
// modpack_install.js when an installed mod hard-requires the skipped one.
function decideModInstall({
  inspection,
  providerServerSide = null,
  modId = null,
  filename = null,
  sha1 = null,
  learnedVerdict = null,
  crashRisk = null
} = {}) {
  const skip = (slot, source, rescuable) => ({ install: false, slot, source, rescuable });
  const install = (slot, source) => ({ install: true, slot, source, rescuable: false });

  // 1. Config blocklist.
  if (modId !== null && (config.mod_id_blocklist ?? []).includes(modId)) {
    return skip(1, "blocklist", false);
  }

  // 2. Config allowlist + known Modrinth mislabels.
  if (modId !== null && (config.mod_id_allowlist ?? []).includes(modId)) {
    return install(2, "allowlist");
  }
  if (matchesCuratedList(SERVER_SIDE_OVERRIDES, { modId, filename, sha1 })) {
    return install(2, "server-side-override");
  }

  // 3. Learned verdict from the boot-verify loop.
  const learned = learnedVerdict ?? getLearnedVerdict(sha1);
  if (learned === "crashes-server") {
    return skip(3, "learned-crashes-server", false);
  }

  // 4. Provider says the mod belongs on the server — never drop it.
  if (providerServerSide === "required" || providerServerSide === "optional") {
    return install(4, "provider-server-side");
  }

  // 5. Explicit self-declared client-only metadata.
  if (inspection?.verdict === "client") {
    return skip(5, inspection.source, false);
  }

  // 6. Curated client-only list.
  if (matchesCuratedList(CLIENT_SIDE_MODS, { modId, filename, sha1 })) {
    return skip(6, "curated-client-list", true);
  }

  // 7. Provider says client-only.
  if (providerServerSide === "unsupported") {
    return skip(7, "provider-unsupported", true);
  }

  // 8. Layer 2 crash-proof scan (computed lazily by the caller — only reaches
  // here when the provider is silent and no static signal fired).
  if (crashRisk?.risk) {
    return skip(8, "crash-risk", true);
  }

  // 9. Default: install. A kept harmless client mod costs RAM, not correctness;
  // the boot-verify loop mops up anything that actually crashes the server.
  return install(9, "default");
}

// Boolean view of decideModInstall for callers that only need skip/install
// (eval harness, tests). opts may carry modId/filename/sha1/learnedVerdict/crashRisk.
function isClientOnlyMod(inspection, providerServerSide = null, opts = {}) {
  return !decideModInstall({ inspection, providerServerSide, ...opts }).install;
}

// True when a mod is on the known-Modrinth-mislabel list (server-side despite
// an upstream 'unsupported' label). The eval harness uses this as a truth
// correction; the install path uses it at precedence slot 2.
function isKnownServerSideMod(ref) {
  return matchesCuratedList(SERVER_SIDE_OVERRIDES, ref);
}

// Like inspectModJar but checks the verdict store (keyed by SHA1+loaderType+
// CACHE_VERSION) first. If sha1 is null, computes it from the buffer.
function inspectModJarCached(sha1, buffer, loaderType = null) {
  const hash = sha1 ?? crypto.createHash("sha1").update(buffer).digest("hex");
  const cacheKey = `${loaderType ?? "any"}:${CACHE_VERSION}`;
  const cached = getInspection(hash, cacheKey);
  if (cached?.verdict) return cached;

  const result = inspectModJar(buffer, loaderType);
  putInspection(hash, cacheKey, result);
  return result;
}

// Kept as the historical name used by the install engine; flushes the verdict
// store (which replaced mod_inspector_cache.json).
function flushModInspectorCache() {
  flushVerdictStore();
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

module.exports = {
  inspectModJar,
  inspectModJarCached,
  decideModInstall,
  isClientOnlyMod,
  extractModDeps,
  flushModInspectorCache,
  scanForgeModClientSignals,
  matchesCuratedList,
  isKnownServerSideMod,
  CACHE_VERSION
};
