// Crash-risk scanner (Layer 2): detects mods whose dedicated-server init path
// eagerly references Minecraft classes that only exist on the client.
//
// Pipeline:
//   1. Roots = fabric/quilt main|server entrypoints (incl. JiJ nested jars),
//      or Forge/NeoForge @Mod container classes (constructed on dedicated
//      servers, so their construction path must be client-clean)
//   2. Eager <init>/<clinit> reachability with virtual dispatch
//   3. ServiceLoader providers only when their interface is on that graph
//   4. Flag if a reached ref is in the client-only class oracle
//
// Usage: a hit is a rescuable SKIP signal at Layer 1 precedence slot 8 when the
// provider is silent/unsupported, and a warning only when the provider says
// required/optional.

"use strict";

const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const msgLog = require("./logger.js");
const { getCrashScan, putCrashScan } = require("./verdict_store.js");

const CACHE_DIR = path.join(__dirname, "../crash_risk_cache");
const USER_AGENT = "pterobot/discord-bot";

// @Mod annotation descriptors across Forge eras (1.7 FML → modern NeoForge).
const FORGE_MOD_ANNOTATIONS = [
  "Lcpw/mods/fml/common/Mod;",
  "Lnet/minecraftforge/fml/common/Mod;",
  "Lnet/neoforged/fml/common/Mod;"
];

// ── Classfile: CP + init/clinit code refs ───────────────────────────────────

function parseClassFile(buf) {
  if (!buf || buf.length < 10 || buf.readUInt32BE(0) !== 0xCAFEBABE) return null;
  const cpCount = buf.readUInt16BE(8);
  const tags = new Array(cpCount);
  const values = new Array(cpCount);
  let offset = 10;

  const need = n => {
    if (offset + n > buf.length) throw new Error("truncated");
  };

  for (let i = 1; i < cpCount; i++) {
    need(1);
    const tag = buf[offset++];
    tags[i] = tag;
    switch (tag) {
    case 1: {
      need(2);
      const len = buf.readUInt16BE(offset); offset += 2;
      need(len);
      values[i] = buf.toString("utf8", offset, offset + len);
      offset += len;
      break;
    }
    case 3: case 4:
      need(4); values[i] = null; offset += 4; break;
    case 5: case 6:
      need(8); values[i] = null; offset += 8; i++; break;
    case 7: case 8: case 16: case 19: case 20:
      need(2); values[i] = buf.readUInt16BE(offset); offset += 2; break;
    case 9: case 10: case 11: case 12: case 17: case 18:
      need(4);
      values[i] = { a: buf.readUInt16BE(offset), b: buf.readUInt16BE(offset + 2) };
      offset += 4;
      break;
    case 15:
      need(3); values[i] = buf.readUInt16BE(offset + 1); offset += 3; break;
    default:
      return null;
    }
  }

  const utf8 = i => (typeof values[i] === "string" ? values[i] : null);
  const className = i => (tags[i] === 7 ? utf8(values[i]) : null);

  need(6);
  const thisClass = buf.readUInt16BE(offset + 2);
  const superClass = buf.readUInt16BE(offset + 4);
  offset += 6;

  need(2);
  const ifaceCount = buf.readUInt16BE(offset); offset += 2;
  const interfaces = [];
  need(ifaceCount * 2);
  for (let i = 0; i < ifaceCount; i++) {
    interfaces.push(className(buf.readUInt16BE(offset)));
    offset += 2;
  }

  const fieldTypes = [];
  need(2);
  const fieldCount = buf.readUInt16BE(offset); offset += 2;
  for (let f = 0; f < fieldCount; f++) {
    need(8);
    offset += 2; // access
    offset += 2; // name
    const descIdx = buf.readUInt16BE(offset); offset += 2;
    const desc = utf8(descIdx);
    if (desc) {
      const m = desc.match(/L([^;]+);/);
      if (m) fieldTypes.push(m[1]);
    }
    const attrCount = buf.readUInt16BE(offset); offset += 2;
    for (let a = 0; a < attrCount; a++) {
      need(6);
      const len = buf.readUInt32BE(offset + 2);
      offset += 6 + len;
    }
  }

  const resolveRefClass = cpIndex => {
    const tag = tags[cpIndex];
    const v = values[cpIndex];
    if (tag === 7) return utf8(v);
    if (tag === 9 || tag === 10 || tag === 11) return className(v.a);
    if (tag === 15) return resolveRefClass(v);
    return null;
  };

  const resolveMethodRef = cpIndex => {
    const tag = tags[cpIndex];
    const v = values[cpIndex];
    if (tag !== 10 && tag !== 11) return null;
    const owner = className(v.a);
    const nat = values[v.b];
    if (!nat || tags[v.b] !== 12) return null;
    return { owner, name: utf8(nat.a), desc: utf8(nat.b) };
  };

  const classRefsFromCp = cpRefs => {
    const out = [];
    for (const idx of cpRefs) {
      const n = resolveRefClass(idx);
      if (n) out.push(n);
    }
    return out;
  };

  const methodRefsFromCp = cpRefs => {
    const out = [];
    for (const idx of cpRefs) {
      const m = resolveMethodRef(idx);
      if (m) out.push(m);
    }
    return out;
  };

  // methodKey -> { name, desc, classRefs[], invokes[] }
  const methods = [];
  need(2);
  const methodCount = buf.readUInt16BE(offset); offset += 2;
  for (let m = 0; m < methodCount; m++) {
    need(8);
    offset += 2;
    const nameIdx = buf.readUInt16BE(offset); offset += 2;
    const descIdx = buf.readUInt16BE(offset); offset += 2;
    const name = utf8(nameIdx);
    const desc = utf8(descIdx);
    const cpRefs = [];
    const attrCount = buf.readUInt16BE(offset); offset += 2;
    for (let a = 0; a < attrCount; a++) {
      need(6);
      const attrNameIdx = buf.readUInt16BE(offset);
      const attrLen = buf.readUInt32BE(offset + 2);
      offset += 6;
      need(attrLen);
      if (utf8(attrNameIdx) === "Code" && attrLen >= 8) {
        const codeLen = buf.readUInt32BE(offset + 4);
        const codeStart = offset + 8;
        const codeEnd = codeStart + codeLen;
        if (codeEnd <= offset + attrLen) {
          collectCodeCpRefs(buf, codeStart, codeEnd, cpRefs);
        }
      }
      offset += attrLen;
    }
    methods.push({
      name,
      desc,
      classRefs: classRefsFromCp(cpRefs),
      invokes: methodRefsFromCp(cpRefs)
    });
  }

  const thisName = className(thisClass);

  // Same-class eager frontier from <init>/<clinit> (Services.<clinit> → load()).
  const eagerMethodKeys = new Set();
  const methodQueue = [];
  for (const m of methods) {
    if (m.name === "<init>" || m.name === "<clinit>") {
      eagerMethodKeys.add(`${m.name}${m.desc}`);
      methodQueue.push(m);
    }
  }
  while (methodQueue.length > 0) {
    const m = methodQueue.shift();
    for (const inv of m.invokes) {
      if (inv.owner !== thisName) continue;
      const key = `${inv.name}${inv.desc}`;
      if (eagerMethodKeys.has(key)) continue;
      if (inv.name === "equals" || inv.name === "hashCode" || inv.name === "toString") continue;
      const target = methods.find(x => x.name === inv.name && x.desc === inv.desc);
      if (!target) continue;
      eagerMethodKeys.add(key);
      methodQueue.push(target);
    }
  }

  const initClassRefs = [];
  const eagerInvokes = [];
  for (const m of methods) {
    if (!eagerMethodKeys.has(`${m.name}${m.desc}`)) continue;
    initClassRefs.push(...m.classRefs);
    eagerInvokes.push(...m.invokes);
  }

  return {
    thisClassName: thisName,
    superClassName: className(superClass),
    interfaces: interfaces.filter(Boolean),
    fieldTypes,
    initClassRefs,
    eagerInvokes,
    methods,
    utf8Strings() {
      const out = [];
      for (let i = 1; i < values.length; i++) {
        if (typeof values[i] === "string") out.push(values[i]);
      }
      return out;
    }
  };
}

// Walk Code attribute bytecode; collect CP indices from field/method/type insns.
function collectCodeCpRefs(buf, codeStart, codeEnd, out) {
  let pc = codeStart;
  while (pc < codeEnd) {
    const op = buf[pc++];
    // opcodes with u2 CP index
    if (op === 18) { // ldc
      if (pc < codeEnd) out.push(buf[pc++]);
    } else if (op === 19 || op === 20) { // ldc_w, ldc2_w
      if (pc + 1 < codeEnd) { out.push(buf.readUInt16BE(pc)); pc += 2; }
    } else if (
      op === 178 || op === 179 || op === 180 || op === 181 // get/put static/field
      || op === 182 || op === 183 || op === 184 // invokevirtual/special/static
      || op === 187 || op === 189 || op === 192 || op === 193 // new/anewarray/checkcast/instanceof
    ) {
      if (pc + 1 < codeEnd) { out.push(buf.readUInt16BE(pc)); pc += 2; }
    } else if (op === 185) { // invokeinterface
      if (pc + 3 < codeEnd) { out.push(buf.readUInt16BE(pc)); pc += 4; }
    } else if (op === 186) { // invokedynamic
      if (pc + 3 < codeEnd) { out.push(buf.readUInt16BE(pc)); pc += 4; }
    } else if (op === 197) { // multianewarray
      if (pc + 2 < codeEnd) { out.push(buf.readUInt16BE(pc)); pc += 3; }
    } else if (op === 16) { // bipush
      pc += 1;
    } else if (op === 17) { // sipush
      pc += 2;
    } else if (op === 188) { // newarray
      pc += 1;
    } else if (op === 196) { // wide
      if (pc >= codeEnd) break;
      const wop = buf[pc++];
      pc += (wop === 132) ? 4 : 2;
    } else if (op === 170) { // tableswitch
      while ((pc - codeStart) % 4 !== 0) pc++;
      if (pc + 12 > codeEnd) break;
      pc += 4;
      const low = buf.readInt32BE(pc); pc += 4;
      const high = buf.readInt32BE(pc); pc += 4;
      pc += (high - low + 1) * 4;
    } else if (op === 171) { // lookupswitch
      while ((pc - codeStart) % 4 !== 0) pc++;
      if (pc + 8 > codeEnd) break;
      pc += 4;
      const npairs = buf.readInt32BE(pc); pc += 4;
      pc += npairs * 8;
    } else if (op === 200 || op === 201) { // goto_w, jsr_w
      pc += 4;
    } else if (
      op === 153 || op === 154 || op === 155 || op === 156 || op === 157 || op === 158
      || op === 159 || op === 160 || op === 161 || op === 162 || op === 163 || op === 164
      || op === 165 || op === 166 || op === 167 || op === 168 || op === 198 || op === 199
    ) {
      pc += 2; // branches / if*
    } else if (op === 132) { // iinc
      pc += 2;
    } else if (op >= 21 && op <= 25) { // xload
      pc += 1;
    } else if (op >= 54 && op <= 58) { // xstore
      pc += 1;
    } else if (op >= 169 && op <= 169) { // ret
      pc += 1;
    }
    // else: 1-byte opcode
  }
}

// ── Oracle: client-only class names ─────────────────────────────────────────

function parseMojangMappingClasses(text) {
  const classes = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#") || line.startsWith(" ") || line.startsWith("\t")) continue;
    // com.foo.Bar -> a:
    const m = line.match(/^([a-zA-Z0-9_$.]+) -> [a-zA-Z0-9_$]+:/);
    if (m) classes.add(m[1].replace(/\./g, "/"));
  }
  return classes;
}

function parseYarnTinyClasses(tinyText) {
  // yarn v2 tiny header: "tiny\t2\t0\tintermediary\tnamed" (no official column)
  const lines = tinyText.split(/\r?\n/);
  const intermediary = new Set();
  const named = new Set();
  const namedToInt = new Map();
  const intToNamed = new Map();
  for (const line of lines) {
    if (!line.startsWith("c\t")) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const inter = parts[1];
    const nam = parts[2];
    if (inter) intermediary.add(inter);
    if (nam) named.add(nam);
    if (inter && nam) {
      namedToInt.set(nam, inter);
      intToNamed.set(inter, nam);
    }
  }
  return { intermediary, named, namedToInt, intToNamed };
}

function buildAndCacheOracle(opts, cachePath) {
  const clientOff = parseMojangMappingClasses(fs.readFileSync(opts.mojangClientPath, "utf8"));
  const serverOff = parseMojangMappingClasses(fs.readFileSync(opts.mojangServerPath, "utf8"));
  const clientOnlyOfficial = [];
  for (const c of clientOff) {
    if (!serverOff.has(c)) clientOnlyOfficial.push(c);
  }
  const names = new Set(clientOnlyOfficial);
  for (const c of clientOff) {
    if (c.startsWith("net/minecraft/client/") || c.startsWith("com/mojang/blaze3d/")) names.add(c);
  }

  if (opts.yarnJarPath && fs.existsSync(opts.yarnJarPath)) {
    const zip = new AdmZip(opts.yarnJarPath);
    const entry = zip.getEntry("mappings/mappings.tiny");
    if (entry) {
      const yarn = parseYarnTinyClasses(entry.getData().toString("utf8"));
      // Any yarn-named class under client/blaze3d is client-only; store named + intermediary.
      for (const nam of yarn.named) {
        if (nam.startsWith("net/minecraft/client/") || nam.startsWith("com/mojang/blaze3d/")) {
          names.add(nam);
          const inter = yarn.namedToInt.get(nam);
          if (inter) names.add(inter);
        }
      }
    }
  }

  const payload = {
    officialClientOnly: clientOnlyOfficial.length,
    names: [ ...names ]
  };
  fs.writeFileSync(cachePath, JSON.stringify(payload));
  return loadOracleFromCache(cachePath);
}

function loadOracleFromCache(cachePath) {
  const data = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  const names = new Set(data.names);
  return {
    size: names.size,
    officialClientOnly: data.officialClientOnly,
    has(className) {
      if (!className) return false;
      let n = className;
      if (n.startsWith("L") && n.endsWith(";")) n = n.slice(1, -1);
      if (n.startsWith("[")) return this.has(n.replace(/^\[+/, "").replace(/^L/, "").replace(/;$/, ""));
      return names.has(n);
    },
    isClientApiPackage(className) {
      if (!className) return false;
      return className.startsWith("net/minecraftforge/client/")
        || className.startsWith("net/neoforged/neoforge/client/")
        || className.startsWith("net/fabricmc/fabric/api/client/")
        || className.startsWith("net/minecraft/client/")
        || className.startsWith("com/mojang/blaze3d/");
    }
  };
}

// ── Zip / entrypoint helpers ────────────────────────────────────────────────

function lenientJsonParse(text) {
  try { return JSON.parse(text.replace(/^\uFEFF/, "")); } catch { return null; }
}

function classToPath(name) {
  return name.replace(/\./g, "/") + ".class";
}

function openZip(buffer) {
  return new AdmZip(buffer);
}

/** Nested jar support (JiJ): also search META-INF/jars/*.jar */
function readClassFromZip(zip, className) {
  const p = classToPath(className);
  const entry = zip.getEntry(p);
  if (entry) {
    try { return parseClassFile(entry.getData()); } catch { return null; }
  }
  for (const e of zip.getEntries()) {
    if (!e.entryName.startsWith("META-INF/jars/") || !e.entryName.endsWith(".jar")) continue;
    try {
      const nested = new AdmZip(e.getData());
      const ne = nested.getEntry(p);
      if (ne) return parseClassFile(ne.getData());
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Eager class refs when constructing `className`, including superclass <init>
 * with virtual calls resolved to the most-specific override in the hierarchy.
 */
function constructionEagerRefs(zip, className) {
  const hierarchy = []; // concrete → Object
  let cur = className;
  const seen = new Set();
  while (cur && !isSkippedJre(cur) && !seen.has(cur)) {
    seen.add(cur);
    const p = readClassFromZip(zip, cur);
    if (!p) break;
    hierarchy.push(p);
    cur = p.superClassName;
  }
  if (hierarchy.length === 0) return { classRefs: [], touchesServiceLoader: false };

  const hierarchyNames = new Set(hierarchy.map(p => p.thisClassName));

  const findMethod = (name, desc, preferredOwner = null) => {
    if (name === "<init>" && preferredOwner) {
      const p = hierarchy.find(x => x.thisClassName === preferredOwner);
      if (p) {
        const m = p.methods.find(x => x.name === name && x.desc === desc);
        if (m) return m;
      }
    }
    for (const p of hierarchy) {
      const m = p.methods.find(x => x.name === name && x.desc === desc);
      if (!m) continue;
      // Prefer first concrete body (hierarchy is subclass → super)
      if (m.classRefs.length === 0 && m.invokes.length === 0 && name !== "<clinit>") continue;
      return m;
    }
    for (const p of hierarchy) {
      const m = p.methods.find(x => x.name === name && x.desc === desc);
      if (m) return m;
    }
    return null;
  };

  const classRefs = new Set();
  const analyzed = new Set();
  const queue = [];

  const enqueueMethod = (name, desc, preferredOwner = null) => {
    const key = preferredOwner && name === "<init>"
      ? `${preferredOwner}.${name}${desc}`
      : `${name}${desc}`;
    if (analyzed.has(key)) return;
    analyzed.add(key);
    const m = findMethod(name, desc, preferredOwner);
    if (!m) return;
    queue.push(m);
  };

  // Start from concrete class constructors + clinit
  for (const m of hierarchy[0].methods) {
    if (m.name === "<init>") enqueueMethod(m.name, m.desc, hierarchy[0].thisClassName);
  }
  enqueueMethod("<clinit>", "()V");

  let touchesServiceLoader = false;
  while (queue.length > 0) {
    const m = queue.shift();
    for (const c of m.classRefs) {
      classRefs.add(c);
      if (c === "java/util/ServiceLoader" || /\/Services$/.test(c)) touchesServiceLoader = true;
    }
    for (const inv of m.invokes) {
      classRefs.add(inv.owner);
      if (inv.owner === "java/util/ServiceLoader" || /\/Services$/.test(inv.owner)) {
        touchesServiceLoader = true;
      }
      if (inv.name === "equals" || inv.name === "hashCode" || inv.name === "toString") continue;
      if (inv.name === "<init>") {
        if (hierarchyNames.has(inv.owner)) enqueueMethod(inv.name, inv.desc, inv.owner);
        continue;
      }
      // Virtual call within hierarchy → most-specific override
      if (hierarchyNames.has(inv.owner)) {
        enqueueMethod(inv.name, inv.desc);
      }
    }
  }

  // Always include declared interfaces / superclass as structural edges
  for (const p of hierarchy) {
    if (p.superClassName) classRefs.add(p.superClassName);
    for (const i of p.interfaces) classRefs.add(i);
  }

  return { classRefs: [ ...classRefs ], touchesServiceLoader };
}

function collectServerEntrypoints(zip) {
  const names = new Set();
  const fabricEntry = zip.getEntry("fabric.mod.json");
  if (fabricEntry) {
    const meta = lenientJsonParse(fabricEntry.getData().toString("utf8"));
    for (const key of [ "main", "server" ]) {
      for (const e of meta?.entrypoints?.[key] ?? []) {
        const cls = typeof e === "string" ? e : e?.value;
        if (cls) names.add(cls.split("::")[0].replace(/\./g, "/"));
      }
    }
  }
  const quiltEntry = zip.getEntry("quilt.mod.json");
  if (quiltEntry) {
    const meta = lenientJsonParse(quiltEntry.getData().toString("utf8"));
    for (const key of [ "main", "server", "init" ]) {
      for (const e of meta?.quilt_loader?.entrypoints?.[key] ?? []) {
        const cls = typeof e === "string" ? e : e?.value ?? e?.class;
        if (typeof cls === "string") names.add(cls.split("::")[0].replace(/\./g, "/"));
      }
    }
  }
  // Nested jars (XaeroLib inside minimap)
  for (const e of zip.getEntries()) {
    if (!e.entryName.startsWith("META-INF/jars/") || !e.entryName.endsWith(".jar")) continue;
    try {
      const nested = new AdmZip(e.getData());
      for (const n of collectServerEntrypoints(nested)) names.add(n);
    } catch { /* ignore */ }
  }
  return [ ...names ];
}

// Forge/NeoForge roots: every @Mod-annotated class is constructed on dedicated
// servers, so its construction path is the eager init surface. Includes JiJ
// nested jars (META-INF/jarjar).
function collectForgeModRoots(zip) {
  const names = new Set();
  const scan = z => {
    for (const e of z.getEntries()) {
      if (e.isDirectory) continue;
      if (/^META-INF\/(jars|jarjar)\/.+\.jar$/.test(e.entryName)) {
        try { scan(new AdmZip(e.getData())); } catch { /* ignore */ }
        continue;
      }
      if (!e.entryName.endsWith(".class")) continue;
      const buf = e.getData();
      if (!FORGE_MOD_ANNOTATIONS.some(m => buf.indexOf(m) !== -1)) continue;
      names.add(e.entryName.replace(/\.class$/, "").replace(/\\/g, "/"));
    }
  };
  scan(zip);
  return [ ...names ];
}

function listServiceProviders(zip) {
  const map = new Map();
  const scan = z => {
    for (const e of z.getEntries()) {
      if (e.isDirectory) continue;
      if (e.entryName.startsWith("META-INF/jars/") && e.entryName.endsWith(".jar")) {
        try { scan(new AdmZip(e.getData())); } catch { /* ignore */ }
        continue;
      }
      if (!e.entryName.startsWith("META-INF/services/") || e.entryName.endsWith("/")) continue;
      const iface = e.entryName.slice("META-INF/services/".length).replace(/\./g, "/");
      const providers = [];
      for (const line of e.getData().toString("utf8").split(/\r?\n/)) {
        const t = line.split("#")[0].trim();
        if (t) providers.push(t.replace(/\./g, "/"));
      }
      if (providers.length) map.set(iface, [ ...(map.get(iface) ?? []), ...providers ]);
    }
  };
  scan(zip);
  return map;
}

function isSkippedJre(name) {
  return !name
    || name.startsWith("java/")
    || name.startsWith("javax/")
    || name.startsWith("jdk/")
    || name.startsWith("sun/")
    || name.startsWith("com/sun/")
    || name.startsWith("[");
}

/**
 * Crash-risk scan.
 * @returns {{ risk: boolean, reason: string|null, detail: string|null, scanned: number, depth: number }}
 */
function scanCrashRisk(buffer, oracle, { maxDepth = 8, maxNodes = 500 } = {}) {
  let zip;
  try { zip = openZip(buffer); } catch {
    return { risk: false, reason: "bad-zip", detail: null, scanned: 0, depth: 0 };
  }

  // Fabric/Quilt roots (declared server-side entrypoints), falling back to
  // Forge/NeoForge @Mod containers (always constructed on dedicated servers).
  let rootVia = "entrypoint";
  let roots = collectServerEntrypoints(zip);
  if (roots.length === 0) {
    roots = collectForgeModRoots(zip);
    rootVia = "mod-construct";
  }
  if (roots.length === 0) {
    return { risk: false, reason: "no-server-entrypoint", detail: null, scanned: 0, depth: 0 };
  }

  const services = listServiceProviders(zip);
  const visited = new Set();
  const queue = roots.map(n => ({ name: n, d: 0, via: rootVia }));
  let scanned = 0;

  const considerHit = (className, via, host) => {
    if (oracle.has(className) || oracle.isClientApiPackage(className)) {
      return {
        risk: true,
        reason: "init-reaches-client-only",
        detail: `${host} --${via}--> ${className}`,
        scanned,
        depth: 0
      };
    }
    return null;
  };

  while (queue.length > 0 && visited.size < maxNodes) {
    const { name, d, via } = queue.shift();
    if (visited.has(name) || d > maxDepth) continue;
    visited.add(name);

    {
      const hit = considerHit(name, via, name);
      if (hit) { hit.depth = d; return hit; }
    }

    if (!readClassFromZip(zip, name)) continue;
    scanned++;

    const eager = constructionEagerRefs(zip, name);
    const edges = new Set(eager.classRefs);

    for (const target of edges) {
      if (isSkippedJre(target)) continue;
      const hit = considerHit(target, "init", name);
      if (hit) { hit.depth = d; return hit; }

      if (!visited.has(target) && d + 1 <= maxDepth) {
        queue.push({ name: target, d: d + 1, via: "init" });
      }

      // Conditional ServiceLoader: interface referenced from eager init → instantiate providers
      if (services.has(target)) {
        for (const prov of services.get(target)) {
          if (!visited.has(prov) && d + 1 <= maxDepth) {
            queue.push({ name: prov, d: d + 1, via: `service:${target}` });
          }
        }
      }
    }
  }

  return { risk: false, reason: null, detail: null, scanned, depth: 0, visited: visited.size };
}

// ── Oracle download / cache ─────────────────────────────────────────────────

async function fetchBuffer(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function downloadAndBuildOracle(mcVersion, cachePath) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const manifest = await fetchJson("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
  const ver = manifest.versions.find(v => v.id === mcVersion);
  if (!ver) throw new Error(`unknown Minecraft version ${mcVersion}`);
  const meta = await fetchJson(ver.url);
  if (!meta.downloads?.client_mappings?.url || !meta.downloads?.server_mappings?.url) {
    throw new Error(`no official mappings for ${mcVersion}`);
  }

  const clientMap = path.join(CACHE_DIR, `client-${mcVersion}.txt`);
  const serverMap = path.join(CACHE_DIR, `server-${mcVersion}.txt`);
  if (!fs.existsSync(clientMap)) {
    fs.writeFileSync(clientMap, await fetchBuffer(meta.downloads.client_mappings.url));
  }
  if (!fs.existsSync(serverMap)) {
    fs.writeFileSync(serverMap, await fetchBuffer(meta.downloads.server_mappings.url));
  }

  let yarnJarPath = path.join(CACHE_DIR, `yarn-${mcVersion}.jar`);
  if (!fs.existsSync(yarnJarPath)) {
    try {
      const yarns = await fetchJson(`https://meta.fabricmc.net/v2/versions/yarn/${encodeURIComponent(mcVersion)}`);
      const yarnVer = yarns?.[0]?.version;
      if (!yarnVer) throw new Error("no yarn build");
      const yarnUrl = `https://maven.fabricmc.net/net/fabricmc/yarn/${encodeURIComponent(yarnVer)}/yarn-${yarnVer}-v2.jar`;
      fs.writeFileSync(yarnJarPath, await fetchBuffer(yarnUrl));
    } catch (e) {
      msgLog.debugExtended(`[crash-risk] yarn mappings skipped for ${mcVersion}: ${e.message}`);
      yarnJarPath = null;
    }
  }

  return buildAndCacheOracle({
    mojangClientPath: clientMap,
    mojangServerPath: serverMap,
    yarnJarPath: yarnJarPath && fs.existsSync(yarnJarPath) ? yarnJarPath : null
  }, cachePath);
}

// Prefix-only fallback oracle for versions without official Mojang mappings
// (pre-1.14.4, i.e. the legacy 1.7-1.12 Forge era). SRG preserves class names,
// so net/minecraft/client/* prefixes still identify client-only classes there.
function buildPrefixOracle() {
  return {
    size: 0,
    officialClientOnly: 0,
    prefixOnly: true,
    has() { return false; },
    isClientApiPackage(className) {
      if (!className) return false;
      return className.startsWith("net/minecraftforge/client/")
        || className.startsWith("net/neoforged/neoforge/client/")
        || className.startsWith("net/fabricmc/fabric/api/client/")
        || className.startsWith("net/minecraft/client/")
        || className.startsWith("com/mojang/blaze3d/");
    }
  };
}

// In-memory oracle cache for the process lifetime (one per MC version).
const oracleMemo = new Map();

/**
 * Loads or builds the client-only class oracle for a Minecraft version.
 * Falls back to a prefix-only oracle when official mappings are unavailable
 * (legacy versions); returns null only when no version is known at all.
 */
async function getOracle(mcVersion) {
  if (!mcVersion || typeof mcVersion !== "string") return null;
  if (oracleMemo.has(mcVersion)) return oracleMemo.get(mcVersion);

  const cachePath = path.join(CACHE_DIR, `client-only-${mcVersion}.json`);
  let oracle;
  try {
    if (fs.existsSync(cachePath)) {
      oracle = loadOracleFromCache(cachePath);
    } else {
      msgLog.log(`[crash-risk] building client-only oracle for ${mcVersion} (first use)`);
      oracle = await downloadAndBuildOracle(mcVersion, cachePath);
    }
  } catch (e) {
    msgLog.warn(`[crash-risk] mapping oracle unavailable for ${mcVersion} (${e.message}); using prefix-only oracle`);
    oracle = buildPrefixOracle();
  }
  oracleMemo.set(mcVersion, oracle);
  return oracle;
}

/**
 * Scans a mod JAR buffer for dedicated-server crash risk.
 * Returns { risk, detail, reason } — risk is false when clean or unscannable.
 */
function assessCrashRisk(buffer, oracle) {
  if (!oracle || !buffer) return { risk: false, detail: null, reason: "no-oracle" };
  const result = scanCrashRisk(buffer, oracle);
  return {
    risk: !!result.risk,
    detail: result.detail ?? null,
    reason: result.reason ?? null
  };
}

// Like assessCrashRisk but consults the verdict store first, keyed by
// sha1 + MC version (the oracle differs per version).
function assessCrashRiskCached(sha1, buffer, oracle, mcVersion) {
  if (!oracle || !buffer) return { risk: false, detail: null, reason: "no-oracle" };
  const cacheKey = `${mcVersion ?? "any"}:v1`;
  if (sha1) {
    const cached = getCrashScan(sha1, cacheKey);
    if (cached) return cached;
  }
  const result = assessCrashRisk(buffer, oracle);
  if (sha1) putCrashScan(sha1, cacheKey, result);
  return result;
}

module.exports = {
  FORGE_MOD_ANNOTATIONS,
  parseClassFile,
  buildAndCacheOracle,
  loadOracleFromCache,
  buildPrefixOracle,
  scanCrashRisk,
  collectServerEntrypoints,
  collectForgeModRoots,
  getOracle,
  assessCrashRisk,
  assessCrashRiskCached,
  openZip: buffer => new AdmZip(buffer),
  // test helpers
  _oracleMemo: oracleMemo,
  _CACHE_DIR: CACHE_DIR
};
