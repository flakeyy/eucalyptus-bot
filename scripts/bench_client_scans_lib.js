// Experimental client-code scanners for cost measurement (not production).
// Approaches:
//   2 - entrypoint / ServiceLoader constant-pool string scan
//   3 - whole-JAR .class string scan for client packages
//   4 - shallow <init>/<clinit> call-graph from server entrypoints

"use strict";

const AdmZip = require("adm-zip");

const CLIENT_PATTERNS = [
  "net/minecraft/client/",
  "net/minecraftforge/client/",
  "net/neoforged/neoforge/client/",
  "com/mojang/blaze3d/"
];

function matchesClientPattern(s) {
  for (const p of CLIENT_PATTERNS) {
    if (s.includes(p)) return true;
  }
  return false;
}

// ── Minimal class-file constant-pool reader ─────────────────────────────────

function parseConstantPool(buf) {
  if (buf.length < 10 || buf.readUInt32BE(0) !== 0xCAFEBABE) return null;
  const cpCount = buf.readUInt16BE(8);
  const tags = new Array(cpCount);
  const values = new Array(cpCount); // Utf8 string, or {tag, ...refs}
  let offset = 10;

  const need = n => {
    if (offset + n > buf.length) throw new Error("truncated class");
  };

  for (let i = 1; i < cpCount; i++) {
    need(1);
    const tag = buf[offset++];
    tags[i] = tag;
    switch (tag) {
    case 1: { // Utf8
      need(2);
      const len = buf.readUInt16BE(offset); offset += 2;
      need(len);
      values[i] = buf.toString("utf8", offset, offset + len);
      offset += len;
      break;
    }
    case 3: case 4: // Integer, Float
      need(4); values[i] = null; offset += 4; break;
    case 5: case 6: // Long, Double — take two slots
      need(8); values[i] = null; offset += 8; i++; break;
    case 7: case 8: case 16: case 19: case 20: // Class, String, MethodType, Module, Package
      need(2); values[i] = buf.readUInt16BE(offset); offset += 2; break;
    case 9: case 10: case 11: case 12: case 17: case 18: // Field/Method/Interface/NameAndType/Dynamic/InvokeDynamic
      need(4);
      values[i] = { a: buf.readUInt16BE(offset), b: buf.readUInt16BE(offset + 2) };
      offset += 4;
      break;
    case 15: // MethodHandle
      need(3); values[i] = buf.readUInt16BE(offset + 1); offset += 3; break;
    default:
      return null; // unsupported / corrupt
    }
  }

  const utf8 = i => (typeof values[i] === "string" ? values[i] : null);
  const className = i => {
    if (tags[i] !== 7) return null;
    return utf8(values[i]);
  };

  // this_class is at offset+2 after access_flags (we only need CP + this_class name)
  need(6);
  const thisClass = buf.readUInt16BE(offset + 2);

  // Referenced classes from Class / Fieldref / Methodref / InterfaceMethodref.
  // Cheaper and more robust than walking Code bytecode for a cost experiment.
  const referencedClasses = [];
  for (let i = 1; i < tags.length; i++) {
    const tag = tags[i];
    const v = values[i];
    if (tag === 7) {
      const n = utf8(v);
      if (n) referencedClasses.push(n);
    } else if (tag === 9 || tag === 10 || tag === 11) {
      const n = className(v.a);
      if (n) referencedClasses.push(n);
    }
  }

  return {
    thisClassName: className(thisClass),
    referencedClasses,
    allUtf8() {
      const out = [];
      for (let i = 1; i < values.length; i++) {
        if (typeof values[i] === "string") out.push(values[i]);
      }
      return out;
    }
  };
}

function classHasClientStrings(parsed) {
  if (!parsed) return false;
  for (const s of parsed.allUtf8()) {
    if (matchesClientPattern(s)) return true;
  }
  return false;
}

// ── Entrypoint discovery ────────────────────────────────────────────────────

function lenientJsonParse(text) {
  try { return JSON.parse(text.replace(/^\uFEFF/, "")); } catch { return null; }
}

function classNameToPath(name) {
  return name.replace(/\./g, "/") + ".class";
}

function collectEntrypointClassNames(zip) {
  const names = new Set();

  const fabricEntry = zip.getEntry("fabric.mod.json");
  if (fabricEntry) {
    const meta = lenientJsonParse(fabricEntry.getData().toString("utf8"));
    const eps = meta?.entrypoints ?? {};
    for (const key of [ "main", "server" ]) {
      for (const e of eps[key] ?? []) {
        const cls = typeof e === "string" ? e : e?.value;
        if (cls) names.add(cls.split("::")[0]);
      }
    }
  }

  const quiltEntry = zip.getEntry("quilt.mod.json");
  if (quiltEntry) {
    const meta = lenientJsonParse(quiltEntry.getData().toString("utf8"));
    const eps = meta?.quilt_loader?.entrypoints ?? {};
    for (const key of [ "main", "server", "init" ]) {
      for (const e of eps[key] ?? []) {
        const cls = typeof e === "string" ? e : e?.value ?? e?.class;
        if (typeof cls === "string") names.add(cls.split("::")[0]);
      }
    }
  }

  // ServiceLoader providers (Xaero crash path)
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    if (!e.entryName.startsWith("META-INF/services/") || e.entryName.endsWith("/")) continue;
    const body = e.getData().toString("utf8");
    for (const line of body.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      names.add(t.split("#")[0].trim());
    }
  }

  return [ ...names ];
}

function readClass(zip, className) {
  const entry = zip.getEntry(classNameToPath(className));
  if (!entry) return null;
  try {
    return parseConstantPool(entry.getData());
  } catch {
    return null;
  }
}

// ── Scanners ────────────────────────────────────────────────────────────────

/** Approach 2: entrypoint + ServiceLoader classes' constant-pool strings. */
function scanEntrypointClientRefs(zip) {
  const classes = collectEntrypointClassNames(zip);
  let scanned = 0;
  for (const cls of classes) {
    const parsed = readClass(zip, cls);
    if (!parsed) continue;
    scanned++;
    if (classHasClientStrings(parsed)) {
      return { hit: true, source: "entrypoint-cp", detail: cls, scanned };
    }
  }
  return { hit: false, source: null, detail: null, scanned };
}

/** Approach 3: every .class constant-pool string. */
function scanWholeJarClientRefs(zip, { earlyExit = true } = {}) {
  let scanned = 0;
  let hit = false;
  let detail = null;
  for (const e of zip.getEntries()) {
    if (e.isDirectory || !e.entryName.endsWith(".class")) continue;
    if (e.entryName.includes("META-INF/")) continue;
    let parsed;
    try {
      parsed = parseConstantPool(e.getData());
    } catch {
      continue;
    }
    if (!parsed) continue;
    scanned++;
    if (!hit && classHasClientStrings(parsed)) {
      hit = true;
      detail = e.entryName;
      if (earlyExit) {
        return { hit: true, source: "whole-jar-cp", detail, scanned };
      }
    }
  }
  return { hit, source: hit ? "whole-jar-cp" : null, detail, scanned };
}

/**
 * Approach 4: from entrypoint/ServiceLoader classes, follow CP class refs
 * up to `depth` hops; flag if any reached class has client strings.
 * (Uses full-class CP edges rather than Code walking — over-approx of ctor graph.)
 */
function scanCallGraphClientRefs(zip, depth = 3) {
  const roots = collectEntrypointClassNames(zip);
  const visited = new Set();
  const queue = roots.map(c => ({ name: c, d: 0 }));
  let scanned = 0;

  while (queue.length > 0) {
    const { name, d } = queue.shift();
    if (visited.has(name) || d > depth) continue;
    visited.add(name);
    const parsed = readClass(zip, name);
    if (!parsed) continue;
    scanned++;
    if (classHasClientStrings(parsed)) {
      return { hit: true, source: "call-graph", detail: name, scanned, visited: visited.size };
    }
    if (d >= depth) continue;

    for (const target of parsed.referencedClasses) {
      if (!target || target.startsWith("java/") || target.startsWith("javax/")) continue;
      if (target.startsWith("[")) continue; // array types
      if (!visited.has(target)) queue.push({ name: target, d: d + 1 });
    }
  }

  return { hit: false, source: null, detail: null, scanned, visited: visited.size };
}

function openZip(buffer) {
  return new AdmZip(buffer);
}

module.exports = {
  openZip,
  scanEntrypointClientRefs,
  scanWholeJarClientRefs,
  scanCallGraphClientRefs,
  CLIENT_PATTERNS
};
