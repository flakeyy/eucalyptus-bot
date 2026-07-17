#!/usr/bin/env node
// Evaluate crash-risk scanner vs Modrinth labels + known-positive Xaero jars.
//
// Usage:
//   node scripts/eval_crash_risk.js <mods-folder> [--loader forge] [--mc 1.20.1]
//
// Expects oracle inputs under /tmp/mc-oracle/ (created by the experiment setup)
// or passes --oracle-cache <path>.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { inspectModJar } = require("../utility/mod_inspector.js");
const { analyzeModrinthFiles } = require("../utility/modrinth.js");
const {
  buildAndCacheOracle,
  loadOracleFromCache,
  scanCrashRisk,
  openZip,
  collectServerEntrypoints
} = require("./crash_risk_scan_lib.js");
const {
  scanEntrypointClientRefs,
  scanWholeJarClientRefs,
  scanCallGraphClientRefs
} = require("./bench_client_scans_lib.js");

function parseArgs(argv) {
  const out = {
    folder: null,
    loader: null,
    mc: "1.20.1",
    positives: [],
    oracleDir: "/tmp/mc-oracle"
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--loader") out.loader = args[++i];
    else if (args[i] === "--mc") out.mc = args[++i];
    else if (args[i] === "--positive") out.positives.push(args[++i]);
    else if (args[i] === "--oracle-dir") out.oracleDir = args[++i];
    else if (!args[i].startsWith("-")) out.folder = args[i];
  }
  return out;
}

function getOracle(mc, oracleDir) {
  const cachePath = path.join(oracleDir, `client-only-${mc}.json`);
  if (fs.existsSync(cachePath)) return loadOracleFromCache(cachePath);

  const yarn = path.join(oracleDir, `yarn-${mc}.jar`);
  const clientMap = mc === "1.20.1"
    ? path.join(oracleDir, "client.txt")
    : path.join(oracleDir, `client-${mc}.txt`);
  const serverMap = mc === "1.20.1"
    ? path.join(oracleDir, "server.txt")
    : path.join(oracleDir, `server-${mc}.txt`);

  console.log(`Building client-only oracle for ${mc}...`);
  const oracle = buildAndCacheOracle({
    mojangClientPath: clientMap,
    mojangServerPath: serverMap,
    yarnJarPath: fs.existsSync(yarn) ? yarn : null
  }, cachePath);
  console.log(`  oracle size: ${oracle.size} names (official client-only: ${oracle.officialClientOnly})`);
  return oracle;
}

function metrics(rows, pred, truthKey = "truth") {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  const fps = [], fns = [];
  for (const r of rows) {
    if (!r[truthKey]) continue;
    const p = pred(r);
    if (r[truthKey] === "client" && p) tp++;
    else if (r[truthKey] === "client" && !p) { fn++; fns.push(r); }
    else if (r[truthKey] === "server" && p) { fp++; fps.push(r); }
    else if (r[truthKey] === "server" && !p) tn++;
  }
  const prec = tp + fp ? tp / (tp + fp) : 0;
  const rec = tp + fn ? tp / (tp + fn) : 0;
  const f1 = prec + rec ? 2 * prec * rec / (prec + rec) : 0;
  const spec = tn + fp ? tn / (tn + fp) : 0;
  return { tp, fp, tn, fn, prec, rec, f1, spec, fps, fns, labeled: tp + fp + tn + fn };
}

function printMetrics(name, m) {
  console.log(`\n== ${name} ==`);
  console.log(`labeled=${m.labeled}  TP=${m.tp} FP=${m.fp} TN=${m.tn} FN=${m.fn}`);
  console.log(`precision=${m.prec.toFixed(3)} recall=${m.rec.toFixed(3)} f1=${m.f1.toFixed(3)} specificity=${m.spec.toFixed(3)}`);
  if (m.fps.length) {
    console.log("FP:", m.fps.slice(0, 10).map(r => `${r.name} (${r.detail || r.ss || ""})`).join(" | "));
  }
  if (m.fns.length) {
    console.log("FN:", m.fns.slice(0, 10).map(r => r.name).join(" | "));
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.folder) {
    console.log("Usage: node scripts/eval_crash_risk.js <mods-folder> [--loader forge] [--mc 1.20.1] [--positive jar]");
    process.exit(1);
  }

  const oracle = getOracle(opts.mc, opts.oracleDir);

  const files = fs.readdirSync(opts.folder).filter(f => f.endsWith(".jar")).sort();
  console.log(`Scanning ${files.length} jars in ${opts.folder} (loader=${opts.loader}, mc=${opts.mc})`);

  const rows = [];
  let riskCount = 0;
  const t0 = process.hrtime.bigint();

  for (const f of files) {
    const buffer = fs.readFileSync(path.join(opts.folder, f));
    const sha1 = crypto.createHash("sha1").update(buffer).digest("hex");
    const base = inspectModJar(buffer, opts.loader);
    const crash = scanCrashRisk(buffer, oracle);
    const zip = openZip(buffer);
    const old2 = scanEntrypointClientRefs(zip);
    const old3 = scanWholeJarClientRefs(zip);
    const old4 = scanCallGraphClientRefs(zip);
    if (crash.risk) riskCount++;
    rows.push({
      name: f,
      sha1,
      baseClient: base.verdict === "client",
      baseSrc: base.source,
      risk: crash.risk,
      detail: crash.detail,
      reason: crash.reason,
      scanned: crash.scanned,
      entrypoints: collectServerEntrypoints(zip),
      old2: old2.hit,
      old3: old3.hit,
      old4: old4.hit
    });
  }
  const t1 = process.hrtime.bigint();
  console.log(`Crash-risk flagged: ${riskCount}/${files.length}  (${(Number(t1 - t0) / 1e6).toFixed(0)}ms wall)`);

  // Modrinth labels — for "client-only skip" comparison (NOT the crash-risk truth)
  console.log("Looking up Modrinth server_side...");
  const { serverSideByHash } = await analyzeModrinthFiles(rows.map(r => r.sha1));
  for (const r of rows) {
    r.ss = serverSideByHash.get(r.sha1) ?? null;
    // client-only truth (for comparing client-only detectors — crash-risk should NOT optimize for this)
    if (r.ss === "unsupported") r.truth = "client";
    else if (r.ss === "required" || r.ss === "optional") r.truth = "server";
    else r.truth = null;

    // Crash-risk weak truth on a known-good server pack: everything should be "safe"
    // (no crash). Any risk flag = FP under this weak labeling.
    r.crashTruth = "safe";
  }

  console.log("\n########## Crash-risk on server pack (weak truth: all should be SAFE)");
  console.log(`flagged ${riskCount} / ${rows.length} (${(100 * riskCount / rows.length).toFixed(1)}%)`);
  if (riskCount) {
    console.log("Flagged jars:");
    for (const r of rows.filter(r => r.risk)) {
      console.log(`  ${r.name}`);
      console.log(`    ${r.detail}`);
      console.log(`    ss=${r.ss} baselineClient=${r.baseClient} entrypoints=${r.entrypoints.join(",") || "(none)"}`);
    }
  }

  console.log("\n########## vs Modrinth client-only labels (sanity — crash-risk is NOT a client-only detector)");
  printMetrics("baseline client-only", metrics(rows, r => r.baseClient));
  printMetrics("old-2 entrypoint CP", metrics(rows, r => r.old2));
  printMetrics("old-3 whole-jar", metrics(rows, r => r.old3));
  printMetrics("old-4 call-graph CP", metrics(rows, r => r.old4));
  printMetrics("NEW crash-risk", metrics(rows, r => r.risk));

  // Positives (known crashers)
  const positives = opts.positives.length
    ? opts.positives
    : [
      "/tmp/xaero-test/xaerolib-fabric-1.21.1-1.6.0.jar",
      "/tmp/xaero-test/xaerominimap-fabric-1.21.1-26.3.0.jar",
      "/tmp/xaero-test/xaeroworldmap.jar"
    ].filter(fs.existsSync);

  if (positives.length) {
    console.log("\n########## Known-positive crash jars");
    // Xaero is 1.21.1 — use that oracle
    const oracle1211 = getOracle("1.21.1", opts.oracleDir);
    for (const p of positives) {
      const buffer = fs.readFileSync(p);
      const zip = openZip(buffer);
      const crash20 = scanCrashRisk(buffer, oracle);
      const crash21 = scanCrashRisk(buffer, oracle1211);
      const eps = collectServerEntrypoints(zip);
      console.log(`\n${path.basename(p)}`);
      console.log(`  entrypoints: ${eps.join(", ") || "(none)"}`);
      console.log(`  crash-risk @${opts.mc}: ${crash20.risk} ${crash20.detail || crash20.reason || ""}`);
      console.log(`  crash-risk @1.21.1: ${crash21.risk} ${crash21.detail || crash21.reason || ""}`);
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
