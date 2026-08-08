"use strict";

/**
 * Mapping-free client-only signals for Layer 1 slot 8.
 *
 * Replaces the old crash_risk.js reachability scanner + Mojang/Yarn oracles.
 * Two checks only:
 *   1. Mixin configs applied on dedicated servers that target client-only MC classes
 *   2. Constant-pool references to net/minecraft/client/** (or blaze3d) from
 *      @Mod / fabric|quilt main|server entrypoint classes (SRG keeps those names)
 */

const AdmZip = require("adm-zip");

// @Mod annotation descriptors across Forge eras (1.7 FML → modern NeoForge).
const FORGE_MOD_ANNOTATIONS = [
  "Lcpw/mods/fml/common/Mod;",
  "Lnet/minecraftforge/fml/common/Mod;",
  "Lnet/neoforged/fml/common/Mod;"
];

const CLIENT_CP_PREFIXES = [
  "net/minecraft/client/",
  "com/mojang/blaze3d/"
];

function lenientJsonParse(text) {
  const stripped = String(text || "").replace(/^\uFEFF/, "");
  try { return JSON.parse(stripped); } catch { /* repair below */ }
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

function openZip(buffer) {
  try { return new AdmZip(buffer); } catch { return null; }
}

/**
 * True when a mixin JSON in the jar targets client-only Minecraft classes from
 * a config that is not clearly client-sided (common/default configs applied on
 * dedicated servers → ClassMetadataNotFoundException: ParticleManager etc.).
 */
function jarHasServerAppliedClientMixins(buffer) {
  try {
    const zip = openZip(buffer);
    if (!zip) return false;
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const name = entry.entryName.replace(/\\/g, "/");
      const base = name.split("/").pop() || "";
      if (!/mixins?[^/]*\.json$/i.test(base)) continue;
      // Explicit client mixin configs are not loaded on dedicated servers.
      if (/(^|[._-])client([._-]|$)/i.test(base)) continue;
      let text;
      try { text = entry.getData().toString("utf8"); } catch { continue; }
      if (/net\.minecraft\.client\.(particle\.ParticleManager|gui\.|renderer\.|Minecraft)\b/i.test(text) ||
          /net\/minecraft\/client\/(particle\/ParticleManager|gui\/|renderer\/|Minecraft)/i.test(text)) {
        return true;
      }
    }
  } catch { /* ignore */ }
  return false;
}

/** Collect Utf8 strings from a classfile constant pool. */
function collectCpUtf8(buf) {
  if (!buf || buf.length < 10 || buf.readUInt32BE(0) !== 0xCAFEBABE) return [];
  const cpCount = buf.readUInt16BE(8);
  const out = [];
  let offset = 10;
  try {
    for (let i = 1; i < cpCount; i++) {
      if (offset >= buf.length) break;
      const tag = buf[offset++];
      if (tag === 1) {
        const len = buf.readUInt16BE(offset); offset += 2;
        out.push(buf.toString("utf8", offset, offset + len));
        offset += len;
      } else if (tag === 7 || tag === 8 || tag === 16 || tag === 19 || tag === 20) {
        offset += 2;
      } else if (tag === 3 || tag === 4 || tag === 9 || tag === 10 || tag === 11 || tag === 12 || tag === 17 || tag === 18) {
        offset += 4;
      } else if (tag === 5 || tag === 6) {
        offset += 8; i++;
      } else if (tag === 15) {
        offset += 3;
      } else {
        break;
      }
    }
  } catch {
    return out;
  }
  return out;
}

function isClientOnlyCpRef(s) {
  if (!s || typeof s !== "string") return false;
  // Class names use /; descriptors / field types may use L...; or dotted form.
  const n = s.replace(/\./g, "/");
  return CLIENT_CP_PREFIXES.some(p => n.includes(p));
}

function findClientCpHit(buf) {
  for (const s of collectCpUtf8(buf)) {
    if (isClientOnlyCpRef(s)) return s.replace(/\./g, "/");
  }
  return null;
}

function collectFabricEntrypoints(zip) {
  const names = new Set();
  const addFrom = (meta, keys) => {
    for (const key of keys) {
      for (const e of meta?.entrypoints?.[key] ?? meta?.quilt_loader?.entrypoints?.[key] ?? []) {
        const cls = typeof e === "string" ? e : e?.value ?? e?.class;
        if (typeof cls === "string") names.add(cls.split("::")[0].replace(/\./g, "/"));
      }
    }
  };
  const fabric = zip.getEntry("fabric.mod.json");
  if (fabric) {
    const meta = lenientJsonParse(fabric.getData().toString("utf8"));
    addFrom(meta, [ "main", "server" ]);
  }
  const quilt = zip.getEntry("quilt.mod.json");
  if (quilt) {
    const meta = lenientJsonParse(quilt.getData().toString("utf8"));
    addFrom(meta, [ "main", "server", "init" ]);
  }
  return names;
}

function collectForgeModRoots(zip) {
  const names = new Set();
  for (const e of zip.getEntries()) {
    if (e.isDirectory || !e.entryName.endsWith(".class")) continue;
    // Skip nested jars for this shallow scan — @Mod roots live at the top level
    // for the crash cases we care about; JiJ libs are rarely the eager root.
    if (e.entryName.includes("META-INF/jars/") || e.entryName.includes("META-INF/jarjar/")) continue;
    const buf = e.getData();
    if (!FORGE_MOD_ANNOTATIONS.some(m => buf.indexOf(m) !== -1)) continue;
    names.add(e.entryName.replace(/\.class$/, "").replace(/\\/g, "/"));
  }
  return names;
}

function readClass(zip, className) {
  const path = `${className}.class`;
  const entry = zip.getEntry(path) || zip.getEntry(path.replace(/\//g, "\\"));
  return entry ? entry.getData() : null;
}

/**
 * Shallow CP scan of entrypoint / @Mod classes for client-only Minecraft refs.
 * @returns {{ hit: string|null, root: string|null }}
 */
function scanEntrypointClientCpRefs(buffer) {
  const zip = openZip(buffer);
  if (!zip) return { hit: null, root: null };

  const roots = new Set([
    ...collectFabricEntrypoints(zip),
    ...collectForgeModRoots(zip)
  ]);
  if (roots.size === 0) return { hit: null, root: null };

  for (const root of roots) {
    const buf = readClass(zip, root);
    if (!buf) continue;
    const hit = findClientCpHit(buf);
    if (hit) return { hit, root };
  }
  return { hit: null, root: null };
}

/**
 * Slot-8 signal. Shape matches the old assessCrashRisk return so callers and
 * decideModInstall({ crashRisk }) keep working.
 */
function assessClientSignals(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    return { risk: false, detail: null, reason: "no-buffer" };
  }
  if (jarHasServerAppliedClientMixins(buffer)) {
    return {
      risk: true,
      detail: "server-applied client mixin config",
      reason: "client-mixin-on-server"
    };
  }
  const { hit, root } = scanEntrypointClientCpRefs(buffer);
  if (hit) {
    return {
      risk: true,
      detail: `${root} → ${hit}`,
      reason: "entrypoint-client-cp"
    };
  }
  return { risk: false, detail: null, reason: "clean" };
}

module.exports = {
  FORGE_MOD_ANNOTATIONS,
  jarHasServerAppliedClientMixins,
  scanEntrypointClientCpRefs,
  assessClientSignals
};
