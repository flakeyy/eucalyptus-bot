#!/usr/bin/env node
// Re-run modpack accuracy corpus comparing:
//   A) current client-only inspector (jar alone + jar+Modrinth)
//   B) old naive scanners 2/3/4 (as client-only predictors)
//   C) new crash-risk scanner (separate signal; FP rate on server-compat mods)
//
// Corpus: /tmp/modpack-inspector/<pack>/{modrinth.index.json,mods/*.jar}
//
// Usage:
//   node scripts/eval_modpack_accuracy.js
//   node scripts/eval_modpack_accuracy.js --packs cobbleverse,prominence-2-fabric

"use strict";

const fs = require("fs");
const path = require("path");
const { inspectModJar, isClientOnlyMod } = require("../utility/mod_inspector.js");
const {
  scanEntrypointClientRefs,
  scanWholeJarClientRefs,
  scanCallGraphClientRefs,
  openZip
} = require("./bench_client_scans_lib.js");
const {
  buildAndCacheOracle,
  loadOracleFromCache,
  scanCrashRisk
} = require("./crash_risk_scan_lib.js");

const ROOT = "/tmp/modpack-inspector";
const ORACLE_DIR = "/tmp/mc-oracle";
const UA = "pterobot-mod-inspector/1.0 (modpack accuracy + crash-risk)";

const DEFAULT_PACKS = [
  "cobbleverse",
  "fabulously-optimized",
  "better-mc-fabric-bmc2",
  "prominence-2-fabric",
  "cobblemon-official",
  "sodium-plus"
];

function parseArgs(argv) {
  const out = { packs: DEFAULT_PACKS };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--packs") out.packs = argv[++i].split(",").map(s => s.trim()).filter(Boolean);
  }
  return out;
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { "User-Agent": UA, ...(opts.headers || {}) }
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function lookupServerSides(sha1s) {
  const out = {};
  for (let i = 0; i < sha1s.length; i += 1000) {
    const hashes = sha1s.slice(i, i + 1000);
    const versions = await fetchJson("https://api.modrinth.com/v2/version_files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hashes, algorithm: "sha1" })
    });
    const projectIds = [ ...new Set(Object.values(versions).map(v => v.project_id).filter(Boolean)) ];
    const projects = {};
    for (let j = 0; j < projectIds.length; j += 100) {
      const ids = projectIds.slice(j, j + 100);
      const batch = await fetchJson(
        `https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`
      );
      for (const p of batch) projects[p.id] = p;
    }
    for (const [ sha, ver ] of Object.entries(versions)) {
      const p = projects[ver.project_id];
      if (!p) continue;
      out[sha] = {
        slug: p.slug,
        title: p.title,
        server_side: p.server_side,
        client_side: p.client_side
      };
    }
  }
  return out;
}

function metrics(tp, tn, fp, fn) {
  const total = tp + tn + fp + fn;
  return {
    total, tp, tn, fp, fn,
    accuracy: total ? (tp + tn) / total : null,
    precision: (tp + fp) ? tp / (tp + fp) : null,
    recall: (tp + fn) ? tp / (tp + fn) : null,
    specificity: (tn + fp) ? tn / (tn + fp) : null,
    f1: (2 * tp + fp + fn) ? (2 * tp) / (2 * tp + fp + fn) : null
  };
}

const pct = x => x === null || x === undefined ? "n/a" : `${(100 * x).toFixed(1)}%`;

function truthClient(side) {
  if (side === "unsupported") return true;
  if (side === "required" || side === "optional") return false;
  return null;
}

function bucket(pred, truth) {
  if (pred && truth) return "tp";
  if (!pred && !truth) return "tn";
  if (pred && !truth) return "fp";
  return "fn";
}

function emptyCounts() {
  return { tp: 0, tn: 0, fp: 0, fn: 0 };
}

async function ensureOracle(mc) {
  const cachePath = path.join(ORACLE_DIR, `client-only-${mc}.json`);
  if (fs.existsSync(cachePath)) return loadOracleFromCache(cachePath);

  fs.mkdirSync(ORACLE_DIR, { recursive: true });
  console.log(`Building oracle for ${mc}...`);

  const manifest = await fetchJson("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
  const ver = manifest.versions.find(v => v.id === mc);
  if (!ver) throw new Error(`No Mojang version ${mc}`);
  const meta = await fetchJson(ver.url);

  const clientMap = path.join(ORACLE_DIR, `client-${mc}.txt`);
  const serverMap = path.join(ORACLE_DIR, `server-${mc}.txt`);
  if (!fs.existsSync(clientMap)) {
    const r = await fetch(meta.downloads.client_mappings.url);
    fs.writeFileSync(clientMap, Buffer.from(await r.arrayBuffer()));
  }
  if (!fs.existsSync(serverMap)) {
    const r = await fetch(meta.downloads.server_mappings.url);
    fs.writeFileSync(serverMap, Buffer.from(await r.arrayBuffer()));
  }

  let yarnJar = path.join(ORACLE_DIR, `yarn-${mc}.jar`);
  if (!fs.existsSync(yarnJar)) {
    try {
      const yarns = await fetchJson(`https://meta.fabricmc.net/v2/versions/yarn/${mc}`);
      if (yarns[0]?.version) {
        const verName = yarns[0].version;
        const url = `https://maven.fabricmc.net/net/fabricmc/yarn/${encodeURIComponent(verName)}/yarn-${verName}-v2.jar`;
        const r = await fetch(url);
        if (r.ok) fs.writeFileSync(yarnJar, Buffer.from(await r.arrayBuffer()));
        else yarnJar = null;
      } else yarnJar = null;
    } catch {
      yarnJar = null;
    }
  }

  return buildAndCacheOracle({
    mojangClientPath: clientMap,
    mojangServerPath: serverMap,
    yarnJarPath: yarnJar && fs.existsSync(yarnJar) ? yarnJar : null
  }, cachePath);
}

function printMetricTable(title, rows) {
  console.log(`\n=== ${title} ===\n`);
  console.log(
    "Variant".padEnd(28), "N".padStart(5), "Acc".padStart(8), "Prec".padStart(8),
    "Recall".padStart(8), "Spec".padStart(8), "F1".padStart(8),
    "TP".padStart(4), "TN".padStart(5), "FP".padStart(4), "FN".padStart(4)
  );
  console.log("-".repeat(100));
  for (const [ name, m ] of rows) {
    console.log(
      name.padEnd(28),
      String(m.total).padStart(5),
      pct(m.accuracy).padStart(8),
      pct(m.precision).padStart(8),
      pct(m.recall).padStart(8),
      pct(m.specificity).padStart(8),
      pct(m.f1).padStart(8),
      String(m.tp).padStart(4),
      String(m.tn).padStart(5),
      String(m.fp).padStart(4),
      String(m.fn).padStart(4)
    );
  }
}

async function main() {
  const opts = parseArgs(process.argv);

  const packFiles = {};
  const allSha1 = new Set();
  const mcByPack = {};

  for (const pack of opts.packs) {
    const indexPath = path.join(ROOT, pack, "modrinth.index.json");
    if (!fs.existsSync(indexPath)) {
      console.warn(`Skipping missing pack: ${pack}`);
      continue;
    }
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    mcByPack[pack] = index.dependencies?.minecraft ?? null;
    const files = [];
    for (const file of index.files || []) {
      if (!file.path?.endsWith(".jar")) continue;
      if (!file.path.replace(/\\/g, "/").startsWith("mods/")) continue;
      const sha1 = file.hashes?.sha1;
      if (!sha1) continue;
      const jarPath = path.join(ROOT, pack, "mods", path.basename(file.path));
      if (!fs.existsSync(jarPath)) continue;
      files.push({ sha1, jarPath, name: path.basename(file.path) });
      allSha1.add(sha1);
    }
    packFiles[pack] = files;
    console.log(`${pack}: ${files.length} jars (mc ${mcByPack[pack]})`);
  }

  console.log(`\nLooking up Modrinth metadata for ${allSha1.size} unique jars...`);
  const metaBySha = await lookupServerSides([ ...allSha1 ]);
  console.log(`Resolved ${Object.keys(metaBySha).length}`);

  const oracles = {};
  for (const mc of new Set(Object.values(mcByPack).filter(Boolean))) {
    try {
      oracles[mc] = await ensureOracle(mc);
      console.log(`Oracle ${mc}: ${oracles[mc].size} names`);
    } catch (e) {
      console.warn(`Oracle ${mc} failed: ${e.message}`);
    }
  }

  // Aggregate counters
  const agg = {
    jar: emptyCounts(),
    combined: emptyCounts(),
    old2: emptyCounts(),
    old3: emptyCounts(),
    old4: emptyCounts(),
    crash: emptyCounts(),
    jarOrCrash: emptyCounts(),
    // crash-risk as crash detector on server-compat only (truth=false means should NOT flag)
    crashOnServer: emptyCounts()
  };
  const packSummaries = [];
  const crashFps = [];
  const crashHits = [];

  for (const pack of Object.keys(packFiles)) {
    const local = {
      jar: emptyCounts(), combined: emptyCounts(),
      old2: emptyCounts(), old3: emptyCounts(), old4: emptyCounts(),
      crash: emptyCounts(), jarOrCrash: emptyCounts(), crashOnServer: emptyCounts()
    };
    const oracle = oracles[mcByPack[pack]] ?? null;
    let crashSkipped = 0;

    for (const f of packFiles[pack]) {
      const meta = metaBySha[f.sha1];
      if (!meta) continue;
      const truth = truthClient(meta.server_side);
      if (truth === null) continue;

      const buffer = fs.readFileSync(f.jarPath);
      const inspection = inspectModJar(buffer, "fabric");
      const jarClient = inspection.verdict === "client";
      const combinedClient = isClientOnlyMod(inspection, meta.server_side);

      const zip = openZip(buffer);
      const s2 = scanEntrypointClientRefs(zip).hit;
      const s3 = scanWholeJarClientRefs(zip).hit;
      const s4 = scanCallGraphClientRefs(zip).hit;

      let crash = false;
      let crashDetail = null;
      if (oracle) {
        const r = scanCrashRisk(buffer, oracle);
        crash = r.risk;
        crashDetail = r.detail;
      } else {
        crashSkipped++;
      }

      const preds = {
        jar: jarClient,
        combined: combinedClient,
        old2: s2,
        old3: s3,
        old4: s4,
        crash,
        jarOrCrash: jarClient || crash
      };

      for (const [ key, pred ] of Object.entries(preds)) {
        const b = bucket(pred, truth);
        local[key][b]++;
        agg[key][b]++;
      }

      // Crash-risk FP rate among mods Modrinth says are server-ok
      if (oracle && truth === false) {
        const b = crash ? "fp" : "tn";
        local.crashOnServer[b]++;
        agg.crashOnServer[b]++;
        if (crash) {
          crashFps.push({ pack, name: f.name, slug: meta.slug, server_side: meta.server_side, detail: crashDetail });
        }
      }
      if (oracle && crash) {
        crashHits.push({
          pack, name: f.name, slug: meta.slug, server_side: meta.server_side,
          jarClient, detail: crashDetail
        });
      }
    }

    packSummaries.push({
      pack,
      mc: mcByPack[pack],
      jars: packFiles[pack].length,
      crashSkipped,
      jar: metrics(local.jar.tp, local.jar.tn, local.jar.fp, local.jar.fn),
      combined: metrics(local.combined.tp, local.combined.tn, local.combined.fp, local.combined.fn),
      old2: metrics(local.old2.tp, local.old2.tn, local.old2.fp, local.old2.fn),
      old3: metrics(local.old3.tp, local.old3.tn, local.old3.fp, local.old3.fn),
      old4: metrics(local.old4.tp, local.old4.tn, local.old4.fp, local.old4.fn),
      crash: metrics(local.crash.tp, local.crash.tn, local.crash.fp, local.crash.fn),
      jarOrCrash: metrics(local.jarOrCrash.tp, local.jarOrCrash.tn, local.jarOrCrash.fp, local.jarOrCrash.fn),
      crashOnServer: metrics(
        local.crashOnServer.tp, local.crashOnServer.tn,
        local.crashOnServer.fp, local.crashOnServer.fn
      )
    });
  }

  const toM = c => metrics(c.tp, c.tn, c.fp, c.fn);

  console.log("\nGround truth: Modrinth server_side (unsupported=client, required/optional=server)");
  console.log("Note: crash-risk is NOT a client-only detector — its client-only F1 will be low by design.");

  printMetricTable("CLIENT-ONLY detection (ALL PACKS)", [
    [ "jar (current)", toM(agg.jar) ],
    [ "jar + Modrinth", toM(agg.combined) ],
    [ "old-2 entrypoint CP", toM(agg.old2) ],
    [ "old-3 whole-jar", toM(agg.old3) ],
    [ "old-4 call-graph CP", toM(agg.old4) ],
    [ "crash-risk (misused)", toM(agg.crash) ],
    [ "jar OR crash-risk", toM(agg.jarOrCrash) ]
  ]);

  // Per-pack jar + crash FP on server-ok
  console.log("\n=== Per-pack: current jar client-only vs crash-risk FPs on server-ok mods ===\n");
  console.log(
    "Pack".padEnd(28), "MC".padEnd(8),
    "JarAcc".padStart(8), "JarFP".padStart(6), "JarFN".padStart(6),
    "CrashFP".padStart(8), "CrashHits".padStart(10), "SrvOK".padStart(6)
  );
  console.log("-".repeat(100));
  for (const r of packSummaries) {
    const srvOk = r.crashOnServer.tn + r.crashOnServer.fp;
    console.log(
      r.pack.padEnd(28),
      String(r.mc || "?").padEnd(8),
      pct(r.jar.accuracy).padStart(8),
      String(r.jar.fp).padStart(6),
      String(r.jar.fn).padStart(6),
      String(r.crashOnServer.fp).padStart(8),
      String(crashHits.filter(h => h.pack === r.pack).length).padStart(10),
      String(srvOk).padStart(6)
    );
  }

  const crashSrv = toM(agg.crashOnServer);
  console.log("\n=== Crash-risk as CRASH detector on Modrinth server-ok jars ===");
  console.log(`Server-ok jars scored: ${crashSrv.total}`);
  console.log(`False positives (flagged crash-risk but Modrinth says server-ok): ${crashSrv.fp}`);
  console.log(`True negatives (correctly not flagged): ${crashSrv.tn}`);
  console.log(`Specificity: ${pct(crashSrv.specificity)}`);

  if (crashFps.length) {
    console.log(`\nCrash-risk FPs on server-ok (${crashFps.length}):`);
    for (const f of crashFps.slice(0, 25)) {
      console.log(`  [${f.pack}] ${f.name}`);
      console.log(`    mr=${f.server_side}  ${f.detail}`);
    }
    if (crashFps.length > 25) console.log(`  ... +${crashFps.length - 25} more`);
  } else {
    console.log("\nNo crash-risk false positives on Modrinth server-ok jars.");
  }

  const novel = crashHits.filter(h => !h.jarClient);
  console.log(`\nCrash-risk hits total: ${crashHits.length} (of which ${novel.length} NOT already jar-client)`);
  if (novel.length) {
    console.log("Novel crash-risk hits (jar said unknown):");
    for (const h of novel.slice(0, 20)) {
      console.log(`  [${h.pack}] ${h.name}  mr=${h.server_side}`);
      console.log(`    ${h.detail}`);
    }
  }

  const outPath = path.join(ROOT, "accuracy-crash-risk-compare.json");
  fs.writeFileSync(outPath, JSON.stringify({
    agg: Object.fromEntries(Object.entries(agg).map(([ k, v ]) => [ k, toM(v) ])),
    packs: packSummaries,
    crashFps,
    crashHits
  }, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
