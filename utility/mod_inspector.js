const AdmZip = require("adm-zip");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { parseClassFile } = require("./crash_risk.js");

const CACHE_PATH = path.join(__dirname, "../mod_inspector_cache.json");
// Bump when detection heuristics change so cached verdicts are recomputed.
const CACHE_VERSION = "v4";

let cache = null;
let cacheDirty = false;

// @Mod annotation descriptors across Forge eras (1.7 FML → modern NeoForge).
const FORGE_MOD_ANNOTATIONS = [
  "Lcpw/mods/fml/common/Mod;",
  "Lnet/minecraftforge/fml/common/Mod;",
  "Lnet/neoforged/fml/common/Mod;"
];

function isMcClientClass(name) {
  return typeof name === "string" && name.startsWith("net/minecraft/client/");
}

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

// Scans Forge @Mod container classes for dedicated-server crash signals.
// Catches 1.7-era client mods (Blur, Sound Filters, BetterPlacement) that ship
// only mcmod.info and no mods.toml side metadata:
//   - @Mod(clientSideOnly=true) → explicit
//   - eager <init>/<clinit> or field types referencing net/minecraft/client/*
//   - in-JAR field types that extend/implement a client class (Blur→ShaderResourcePack)
// Deliberately ignores raw constant-pool client names: @SideOnly methods leave
// those behind on universal mods (BiblioCraft) without breaking the server.
function scanForgeModClientSignals(zip) {
  const classBuffers = new Map();
  for (const e of zip.getEntries()) {
    if (e.isDirectory || !e.entryName.endsWith(".class")) continue;
    const name = e.entryName.replace(/\.class$/, "").replace(/\\/g, "/");
    classBuffers.set(name, e.getData());
  }

  let clientSideOnly = false;
  let refsClient = false;

  for (const buf of classBuffers.values()) {
    if (!FORGE_MOD_ANNOTATIONS.some(m => buf.indexOf(m) !== -1)) continue;

    const annotated = readModClientSideOnly(buf);
    if (annotated === true) clientSideOnly = true;

    const cf = parseClassFile(buf);
    if (!cf) continue;

    if (isMcClientClass(cf.superClassName) || cf.interfaces.some(isMcClientClass)) refsClient = true;
    if (cf.initClassRefs.some(isMcClientClass)) refsClient = true;
    if ((cf.fieldTypes ?? []).some(isMcClientClass)) refsClient = true;

    for (const ft of cf.fieldTypes ?? []) {
      const nestedBuf = classBuffers.get(ft);
      if (!nestedBuf) continue;
      const nested = parseClassFile(nestedBuf);
      if (!nested) continue;
      if (isMcClientClass(nested.superClassName) || nested.interfaces.some(isMcClientClass)) {
        refsClient = true;
      }
    }
  }

  return { clientSideOnly, refsClient };
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
  // A main/server entrypoint means the JAR loads on a dedicated server. Libraries
  // like Fusion ship large client-only mixin sets but still declare main — treating
  // those as client-only drops server content mods that hard-depend on them.
  // UI overhauls (FancyMenu) also declare stub main/server entrypoints, so an
  // overwhelming mixin set still wins as strong client despite the entrypoint.
  const fabricEntrypoints = Object.keys(fabric?.entrypoints ?? {});
  const quiltEntrypoints = Object.keys(quilt?.quilt_loader?.entrypoints ?? {});
  const hasServerEntrypoint = [ ...fabricEntrypoints, ...quiltEntrypoints ]
    .some(e => e === "main" || e === "server");

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
  // Mid-size sets with a main entrypoint (Fusion ~29) are left unknown so
  // dep-rescue can keep them when content mods require them; huge sets
  // (FancyMenu ~65+) stay strong client even with stub main/server entrypoints.
  const totalMixins = clientMixins + commonMixins + serverMixins;
  const mixinDominant = !hasDataContent
    && totalMixins > 0 && clientMixins / totalMixins >= 0.95;
  const strongMixinClient = mixinDominant && clientMixins >= 20
    && (!hasServerEntrypoint || clientMixins >= 50);
  if (strongMixinClient) {
    return { verdict: "client", confidence: "strong", loader: loaderType, source: "client-mixins" };
  }

  // 3. Weak heuristics — skipped entirely when the JAR shows server content.
  // Mid-size client-mixin libs with a main entrypoint are not weakly flagged
  // either (same Fusion rationale as above).
  const contradicted = hasDataContent || commonMixins >= 5
    || (hasServerEntrypoint && clientMixins < 50);
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
    if ((!loaderType || !isTomlLoader) && fabricEntrypoints.includes("client")
        && !fabricEntrypoints.includes("main") && !fabricEntrypoints.includes("server")) {
      return { verdict: "client", confidence: "weak", loader: "fabric", source: "client-entrypoints" };
    }
  }

  // 4. Legacy Forge bytecode: @Mod containers that crash dedicated servers at
  // construct (no mods.toml side field). Skip when inspecting as Fabric/Quilt.
  if (!loaderType || isTomlLoader) {
    const forgeScan = scanForgeModClientSignals(zip);
    if (forgeScan.clientSideOnly) {
      return { verdict: "client", confidence: "explicit", loader: "forge", source: "mod-annotation-clientSideOnly" };
    }
    if (forgeScan.refsClient) {
      return { verdict: "client", confidence: "strong", loader: "forge", source: "mod-class-client-ref" };
    }
  }

  const presentLoader = fabric ? "fabric" : quilt ? "quilt" : neo ? "neoforge" : forge ? "forge" : null;
  return { verdict: "unknown", confidence: null, loader: presentLoader, source: presentLoader ? "no-signal" : "no-metadata" };
}

// Combines a JAR inspection with provider-side metadata (mrpack env.server, or
// CurseForge→Modrinth required/optional hints: "required" | "optional" |
// "unsupported" | null) into the final skip decision. Returns true when the
// mod should not be installed.
//   - explicit/strong client verdicts are always trusted
//   - weak verdicts yield to a provider that says the mod runs on servers
//   - with no JAR signal, pack-authored "unsupported" (mrpack) is followed;
//     CurseForge installs never pass Modrinth project "unsupported" here
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

module.exports = {
  inspectModJar,
  inspectModJarCached,
  isClientOnlyMod,
  extractModDeps,
  flushModInspectorCache,
  scanForgeModClientSignals
};
