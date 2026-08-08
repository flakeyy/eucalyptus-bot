"use strict";

const msgLog = require("../logger.js");
const {
  listServerFiles, getFileContents, createServerDirectory,
  renameServerFiles, deleteServerFiles
} = require("../server_functions.js");
const { promoteParkedJar } = require("../crash_attribution.js");
const {
  recordLearnedVerdict, flushVerdictStore, getLearnedVerdict, isProtectedLearnedMod
} = require("../verdict_store.js");

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function quarantineJars(ctx, jars, reasonsByJar) {
  const { serverId, userId, modIndex } = ctx;
  await createServerDirectory(serverId, userId, "/", "mods-disabled").catch(() => {});
  const moves = jars.map(jar => ({ from: `mods/${jar}`, to: `mods-disabled/${jar}` }));
  await renameServerFiles(serverId, userId, "/", moves).catch(() => {});
  for (const jar of jars) {
    const sha1 = modIndex?.sha1Of?.get(jar) ?? null;
    if (sha1) {
      recordLearnedVerdict(sha1, "crashes-server", {
        source: "boot-verify",
        modId: modIndex?.modIdOf?.get(jar) ?? null,
        filename: jar,
        detail: reasonsByJar.get(jar) ?? null
      });
    }
    msgLog.warn(`[boot-verify] quarantined ${jar}: ${reasonsByJar.get(jar) ?? "dependent of quarantined mod"}`);
  }
  flushVerdictStore();
}

async function restoreParkedJars(ctx, jars) {
  const { serverId, userId, modIndex } = ctx;
  const moves = jars.map(jar => ({ from: `mods-disabled/${jar}`, to: `mods/${jar}` }));
  await renameServerFiles(serverId, userId, "/", moves).catch(() => {});
  for (const jar of jars) {
    if (modIndex) promoteParkedJar(modIndex, jar);
    msgLog.warn(`[boot-verify] restored parked dep ${jar} from mods-disabled/`);
  }
}

function parkedJarsForMissingDeps(modIndex, missingDeps) {
  const out = [];
  for (const dep of missingDeps ?? []) {
    const id = String(dep).toLowerCase();
    const jar = modIndex?.parkedByModId?.get(id);
    if (jar) {
      out.push(jar);
      continue;
    }
    if (id.length < 5 || !modIndex?.parkedJars) continue;
    const normalized = id.replace(/_/g, "-");
    const token = new RegExp(
      `(?:^|[^a-z0-9])${escapeRegExp(normalized)}(?:[^a-z0-9]|$)`,
      "i"
    );
    for (const parked of modIndex.parkedJars) {
      if (token.test(String(parked).replace(/_/g, "-"))) out.push(parked);
    }
  }
  return [ ...new Set(out) ];
}

async function neutralizeUnboundNamespaces(ctx, namespaces) {
  const nsList = [ ...namespaces ].map(n => String(n).toLowerCase()).filter(Boolean);
  if (nsList.length === 0) return 0;
  const moves = [];
  const tryList = async dir => {
    const files = await listServerFiles(ctx.serverId, ctx.userId, dir).catch(() => null);
    return files ?? [];
  };
  const matchesNs = name => {
    const lower = String(name).toLowerCase();
    return nsList.some(ns => ns.length >= 3 && (lower === ns || lower.includes(ns)));
  };

  await createServerDirectory(ctx.serverId, ctx.userId, "/", "datapacks-disabled").catch(() => {});
  await createServerDirectory(ctx.serverId, ctx.userId, "/", "kubejs-data-disabled").catch(() => {});
  await createServerDirectory(ctx.serverId, ctx.userId, "/", "kubejs-scripts-disabled").catch(() => {});

  for (const entry of await tryList("/datapacks")) {
    const name = entry.attributes?.name;
    if (!name || entry.attributes?.is_file) continue;
    if (matchesNs(name)) {
      moves.push({ from: `datapacks/${name}`, to: `datapacks-disabled/${name}` });
    }
  }

  for (const entry of await tryList("/kubejs/data")) {
    const name = entry.attributes?.name;
    if (!name || entry.attributes?.is_file) continue;
    if (nsList.includes(name.toLowerCase()) || matchesNs(name)) {
      moves.push({ from: `kubejs/data/${name}`, to: `kubejs-data-disabled/${name}` });
      continue;
    }
    if (nsList.some(ns => ns.includes("custommachinery"))) {
      moves.push({ from: `kubejs/data/${name}`, to: `kubejs-data-disabled/${name}` });
    }
  }

  for (const entry of await tryList("/world/datapacks")) {
    const name = entry.attributes?.name;
    if (!name || entry.attributes?.is_file) continue;
    if (matchesNs(name)) {
      moves.push({ from: `world/datapacks/${name}`, to: `datapacks-disabled/world-${name}` });
    }
  }

  for (const scriptsDir of [ "startup_scripts", "server_scripts", "client_scripts" ]) {
    for (const entry of await tryList(`/kubejs/${scriptsDir}`)) {
      const name = entry.attributes?.name;
      if (!name || !entry.attributes?.is_file) continue;
      if (!/\.(js|ts)$/i.test(name)) continue;
      if (matchesNs(name)) {
        moves.push({
          from: `kubejs/${scriptsDir}/${name}`,
          to: `kubejs-scripts-disabled/${scriptsDir}-${name}`
        });
      }
    }
  }

  if (moves.length === 0) return 0;
  await renameServerFiles(ctx.serverId, ctx.userId, "/", moves).catch(() => {});
  for (const m of moves) {
    msgLog.warn(`[boot-verify] neutralized unbound-namespace path: ${m.from}`);
  }
  await deleteServerFiles(ctx.serverId, ctx.userId, [ "world" ]).catch(() => {});
  return moves.length;
}

async function neutralizeKubejsScriptErrors(ctx, consoleTail = "") {
  if (!/KubeJS startup script syntax errors|There were KubeJS .* script .* ?errors|Error loading script/i.test(consoleTail)) {
    return 0;
  }
  let logText = "";
  try {
    logText = await getFileContents(ctx.serverId, ctx.userId, "/logs/kubejs/startup.log") || "";
  } catch { /* optional */ }
  if (!logText) {
    try {
      logText = await getFileContents(ctx.serverId, ctx.userId, "/logs/kubejs/server.log") || "";
    } catch { /* optional */ }
  }
  const combined = `${consoleTail}\n${logText}`;
  const files = new Set();
  for (const m of combined.matchAll(/(?:kubejs\/)?((?:startup|server|client)_scripts\/[^\s:'"()#]+\.(?:js|ts))/gi)) {
    files.add(m[1].replace(/\\/g, "/"));
  }
  for (const m of combined.matchAll(/Error loading script[:\s]+['"]?([^\s'"]+\.(?:js|ts))/gi)) {
    const rel = m[1].replace(/\\/g, "/");
    if (rel.includes("_scripts/")) files.add(rel.replace(/^.*?((?:startup|server|client)_scripts\/)/i, "$1"));
    else files.add(rel.split("/").pop());
  }
  for (const m of combined.matchAll(/\(([A-Za-z0-9_./\\-]+\.(?:js|ts))#\d+\)/g)) {
    const rel = m[1].replace(/\\/g, "/");
    files.add(rel.includes("_scripts/") ? rel.replace(/^.*?((?:startup|server|client)_scripts\/)/i, "$1") : rel.split("/").pop());
  }
  for (const m of combined.matchAll(
    /\[ERROR\][^\n]*?(?:startup_scripts\/)?([A-Za-z0-9_ .'/-]+\.(?:js|ts))/gi
  )) {
    const rel = m[1].replace(/\\/g, "/").trim();
    if (rel.includes("_scripts/")) files.add(rel.replace(/^.*?((?:startup|server|client)_scripts\/)/i, "$1"));
    else if (rel.includes("/")) files.add(`startup_scripts/${rel}`);
    else files.add(rel.split("/").pop());
  }

  const listDeepJs = async (scriptsDir, maxDepth = 2) => {
    const out = [];
    const walk = async (rel, depth) => {
      const entries = await listServerFiles(ctx.serverId, ctx.userId, `/kubejs/${rel}`).catch(() => null);
      for (const e of entries ?? []) {
        const name = e.attributes?.name;
        if (!name) continue;
        const child = `${rel}/${name}`;
        if (e.attributes?.is_file) {
          if (/\.(js|ts)$/i.test(name)) out.push(child);
          continue;
        }
        if (depth < maxDepth) await walk(child, depth + 1);
      }
    };
    await walk(scriptsDir, 0);
    return out;
  };

  const allStartupJs = await listDeepJs("startup_scripts");
  const allServerJs = await listDeepJs("server_scripts");
  const allJs = [ ...allStartupJs, ...allServerJs ];

  const resolved = new Set();
  for (const rel of files) {
    const norm = rel.replace(/\\/g, "/");
    const base = norm.includes("/") ? norm.split("/").pop() : norm;
    let found = false;
    for (const path of allJs) {
      if (path === norm || path.endsWith(`/${base}`)) {
        resolved.add(path);
        found = true;
      }
    }
    if (!found) {
      resolved.add(norm.includes("_scripts/") ? norm : `startup_scripts/${base}`);
    }
  }

  if (resolved.size === 0) {
    for (const path of allStartupJs) {
      if (path.split("/").length === 2) resolved.add(path);
    }
  }
  if (resolved.size === 0 && /KubeJS startup script syntax errors|There were KubeJS/i.test(combined)) {
    for (const path of allStartupJs) {
      if (path.split("/").length < 3) continue;
      if (/Modern-Industrialization|modern_industrialization/i.test(path)) continue;
      resolved.add(path);
    }
  }
  if (resolved.size === 0) return 0;

  const existingSet = new Set(allJs);
  const fileTargets = [ ...resolved ].filter(rel =>
    /\.(js|ts)$/i.test(rel) && existingSet.has(rel)
  );
  if (fileTargets.length === 0) return 0;

  await createServerDirectory(ctx.serverId, ctx.userId, "/", "kubejs-scripts-disabled").catch(() => {});
  const moves = fileTargets
    .filter(rel => {
      if (/Modern-Industrialization|modern_industrialization/i.test(rel)) {
        msgLog.warn(`[boot-verify] skip neutralizing protected kubejs script: kubejs/${rel}`);
        return false;
      }
      return true;
    })
    .map(rel => ({
      from: `kubejs/${rel}`,
      to: `kubejs-scripts-disabled/${encodeURIComponent(rel)}`
    }));
  if (moves.length === 0) return 0;
  await renameServerFiles(ctx.serverId, ctx.userId, "/", moves).catch(() => {});
  for (const m of moves) {
    msgLog.warn(`[boot-verify] neutralized kubejs script: ${m.from}`);
  }
  return moves.length;
}

function filterRestorableParked(modIndex, jars, quarantinedJars, hardFailedJars) {
  return jars
    .filter(j => modIndex.parkedJars?.has(j) && !quarantinedJars?.has(j) && !hardFailedJars?.has(j))
    .filter(j => {
      const id = modIndex.modIdOf?.get(j);
      if (isProtectedLearnedMod({ modId: id, filename: j })) return true;
      const sha1 = modIndex.sha1Of?.get(j);
      return !sha1 || getLearnedVerdict(sha1) !== "crashes-server";
    });
}

const DISK_MATCH_PROTECT_IDS = new Set([
  "minecraft", "forge", "neoforge", "fabricloader", "fabric-api", "java",
  "gregtech", "gregtechceu", "gtceu", "railcraft", "thermalexpansion",
  "thermalfoundation", "codechickenlib", "cofhcore", "mantle", "tconstruct",
  "ic2", "industrialcraft", "mekanism", "ae2", "appliedenergistics2",
  "create", "kubejs", "rhino", "architectury", "groovyscript", "llibrary",
  "frostedheart", "caupona", "guideme", "modern_industrialization", "powah",
  "byg", "biomesyougo", "ftblibrary"
]);

// Server-pack installs leave an empty modIndex — match crash modIds to unique
// jar basenames still in mods/ (token-boundary, len≥5).

async function jarsFromDiskForSignals(ctx, signals, alreadyKnown = new Set()) {
  let files = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    files = await listServerFiles(ctx.serverId, ctx.userId, "/mods").catch(() => null);
    if (files !== null) break;
    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
  }
  if (!files?.length) return [];
  const names = files
    .map(f => f.attributes?.name)
    .filter(n => typeof n === "string" && /\.jar$/i.test(n) && !alreadyKnown.has(n));
  if (names.length === 0) return [];

  if (signals?.clientClassMissing) {
    try {
      const curated = require("../../data/client_side_mods.json");
      const prefixes = (curated.filenamePrefixes ?? []).map(p => String(p).toLowerCase());
      const modIds = new Set((curated.modIds ?? []).map(id => String(id).toLowerCase()));
      const clientHits = [];
      for (const name of names) {
        if (isProtectedLearnedMod({ filename: name })) continue;
        const lower = name.toLowerCase();
        if (prefixes.some(p => p.length >= 5 && lower.startsWith(p))) {
          clientHits.push(name);
          continue;
        }
        for (const id of modIds) {
          if (id.length < 5) continue;
          const token = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(id)}(?:[^a-z0-9]|$)`, "i");
          if (token.test(lower)) {
            clientHits.push(name);
            break;
          }
        }
        if (clientHits.length >= 20) break;
      }
      return [ ...new Set(clientHits) ];
    } catch {
      return [];
    }
  }

  const needles = new Set();
  const addNeedle = id => {
    const n = String(id).toLowerCase();
    if (n.length < 5 || DISK_MATCH_PROTECT_IDS.has(n)) return;
    needles.add(n);
  };
  for (const id of signals?.dependentModIds ?? []) addNeedle(id);
  if (needles.size === 0) {
    for (const id of signals?.modIds ?? []) addNeedle(id);
  }

  const hits = [];
  for (const needle of needles) {
    const token = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(needle)}(?:[^a-z0-9]|$)`, "i");
    const matched = names.filter(n => token.test(n));
    if (matched.length === 1) hits.push(matched[0]);
  }
  return [ ...new Set(hits) ];
}

module.exports = {
  escapeRegExp,
  quarantineJars,
  restoreParkedJars,
  parkedJarsForMissingDeps,
  neutralizeUnboundNamespaces,
  neutralizeKubejsScriptErrors,
  filterRestorableParked,
  jarsFromDiskForSignals
};
