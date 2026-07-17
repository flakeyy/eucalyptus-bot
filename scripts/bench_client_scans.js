#!/usr/bin/env node
// Benchmark: current mod_inspector vs experimental client-code scanners 2/3/4.
//
// Usage:
//   node --expose-gc scripts/bench_client_scans.js <mods-folder> [--iters N] [--limit N] [--loader forge]
//
// Two tables:
//   A) Bolt-on cost: current inspectModJar + scanners (second AdmZip open) — what a
//      naive add-on would cost.
//   B) Scanner-only cost: one AdmZip open + scanners — isolates 2 vs 3 vs 4.
//
// JAR buffers are preloaded so timings exclude disk I/O.

"use strict";

const fs = require("fs");
const path = require("path");
const { inspectModJar } = require("../utility/mod_inspector.js");
const {
  openZip,
  scanEntrypointClientRefs,
  scanWholeJarClientRefs,
  scanCallGraphClientRefs
} = require("./bench_client_scans_lib.js");

function parseArgs(argv) {
  const out = { folder: null, iters: 5, limit: null, loader: null, warmup: 1 };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--iters") out.iters = Number(args[++i]);
    else if (args[i] === "--limit") out.limit = Number(args[++i]);
    else if (args[i] === "--loader") out.loader = args[++i];
    else if (args[i] === "--warmup") out.warmup = Number(args[++i]);
    else if (!args[i].startsWith("-")) out.folder = args[i];
  }
  return out;
}

function fmtMs(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtBytes(n) {
  const abs = Math.abs(n);
  if (abs < 1024) return `${n}B`;
  if (abs < 1024 ** 2) return `${(n / 1024).toFixed(1)}KB`;
  if (abs < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${(n / 1024 ** 3).toFixed(2)}GB`;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function forceGc() {
  if (typeof global.gc === "function") global.gc();
}

function runBaseline(buffers, loader) {
  let baselineClient = 0;
  for (const { buffer } of buffers) {
    if (inspectModJar(buffer, loader).verdict === "client") baselineClient++;
  }
  return { baselineClient, hits2: 0, hits3: 0, hits4: 0, classes3: 0 };
}

function runBolton(buffers, loader, flags) {
  let hits2 = 0, hits3 = 0, hits4 = 0, baselineClient = 0, classes3 = 0;
  for (const { buffer } of buffers) {
    if (inspectModJar(buffer, loader).verdict === "client") baselineClient++;
    if (!flags.s2 && !flags.s3 && !flags.s4) continue;
    const zip = openZip(buffer);
    if (flags.s2 && scanEntrypointClientRefs(zip).hit) hits2++;
    if (flags.s3) {
      const r = scanWholeJarClientRefs(zip, { earlyExit: !flags.full3 });
      classes3 += r.scanned;
      if (r.hit) hits3++;
    }
    if (flags.s4 && scanCallGraphClientRefs(zip).hit) hits4++;
  }
  return { baselineClient, hits2, hits3, hits4, classes3 };
}

function runScanOnly(buffers, flags) {
  let hits2 = 0, hits3 = 0, hits4 = 0, classes3 = 0;
  for (const { buffer } of buffers) {
    const zip = openZip(buffer);
    if (flags.s2 && scanEntrypointClientRefs(zip).hit) hits2++;
    if (flags.s3) {
      const r = scanWholeJarClientRefs(zip, { earlyExit: !flags.full3 });
      classes3 += r.scanned;
      if (r.hit) hits3++;
    }
    if (flags.s4 && scanCallGraphClientRefs(zip).hit) hits4++;
  }
  return { baselineClient: 0, hits2, hits3, hits4, classes3 };
}

function measure(name, fn, buffers, iters, warmup) {
  for (let i = 0; i < warmup; i++) fn(buffers);

  forceGc();
  const memBefore = process.memoryUsage();
  const ruBefore = process.resourceUsage();
  const times = [];
  let last = null;

  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    last = fn(buffers);
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }

  forceGc();
  const memAfter = process.memoryUsage();
  const ruAfter = process.resourceUsage();
  times.sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const perJar = times.map(t => t / buffers.length);
  perJar.sort((a, b) => a - b);

  return {
    name,
    jars: buffers.length,
    wallMs: {
      min: times[0],
      median: percentile(times, 50),
      p95: percentile(times, 95),
      mean
    },
    perJarMs: { median: percentile(perJar, 50), mean: mean / buffers.length },
    cpuUserMs: (ruAfter.userCPUTime - ruBefore.userCPUTime) / 1000,
    cpuSystemMs: (ruAfter.systemCPUTime - ruBefore.systemCPUTime) / 1000,
    heapDelta: memAfter.heapUsed - memBefore.heapUsed,
    hits: last
  };
}

function printTable(title, results, baseline) {
  console.log("\n" + "=".repeat(96));
  console.log(title);
  console.log("=".repeat(96));
  const col = { name: 28, wall: 12, per: 12, cpu: 14, heap: 12, vs: 8 };
  console.log([
    "Variant".padEnd(col.name),
    "Wall med".padEnd(col.wall),
    "Per-jar".padEnd(col.per),
    "CPU total".padEnd(col.cpu),
    "Heap Δ".padEnd(col.heap),
    "vs ref"
  ].join("  "));
  console.log("-".repeat(96));
  for (const r of results) {
    const cpu = r.cpuUserMs + r.cpuSystemMs;
    const vs = baseline ? r.wallMs.median / baseline.wallMs.median : 1;
    console.log([
      r.name.padEnd(col.name),
      fmtMs(r.wallMs.median).padEnd(col.wall),
      fmtMs(r.perJarMs.median).padEnd(col.per),
      fmtMs(cpu).padEnd(col.cpu),
      fmtBytes(r.heapDelta).padEnd(col.heap),
      baseline ? `${vs.toFixed(2)}x` : "—"
    ].join("  "));
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.folder) {
    console.log("Usage: node --expose-gc scripts/bench_client_scans.js <mods-folder> [--iters 5] [--limit N] [--loader forge]");
    process.exit(1);
  }

  const dir = path.resolve(opts.folder);
  let files = fs.readdirSync(dir).filter(f => f.endsWith(".jar")).sort();
  if (opts.limit) files = files.slice(0, opts.limit);

  console.log(`Loading ${files.length} JARs from ${dir}...`);
  const buffers = files.map(f => {
    const buffer = fs.readFileSync(path.join(dir, f));
    return { name: f, buffer, size: buffer.length };
  });
  const totalBytes = buffers.reduce((a, b) => a + b.size, 0);
  console.log(`Corpus: ${buffers.length} jars, ${fmtBytes(totalBytes)} in memory`);
  console.log(`Iters: ${opts.iters}, warmup: ${opts.warmup}, loader: ${opts.loader ?? "(auto)"}`);
  console.log(`GC exposed: ${typeof global.gc === "function"}`);

  const L = opts.loader;

  // ── Table A: bolt-on (inspect + second zip) ──────────────────────────────
  const bolton = [
    { name: "baseline (now)", fn: bufs => runBaseline(bufs, L) },
    { name: "now + 2 entrypoint", fn: bufs => runBolton(bufs, L, { s2: true }) },
    { name: "now + 3 whole-jar", fn: bufs => runBolton(bufs, L, { s3: true }) },
    { name: "now + 3 full (no exit)", fn: bufs => runBolton(bufs, L, { s3: true, full3: true }) },
    { name: "now + 4 call-graph", fn: bufs => runBolton(bufs, L, { s4: true }) },
    { name: "now + 2+3", fn: bufs => runBolton(bufs, L, { s2: true, s3: true }) },
    { name: "now + 2+4", fn: bufs => runBolton(bufs, L, { s2: true, s4: true }) },
    { name: "now + 3+4", fn: bufs => runBolton(bufs, L, { s3: true, s4: true }) },
    { name: "now + 2+3+4", fn: bufs => runBolton(bufs, L, { s2: true, s3: true, s4: true }) }
  ];

  const boltonResults = [];
  for (const v of bolton) {
    process.stdout.write(`A ${v.name}...`);
    const r = measure(v.name, v.fn, buffers, opts.iters, opts.warmup);
    boltonResults.push(r);
    console.log(` ${fmtMs(r.wallMs.median)}`);
  }

  // ── Table B: scanner-only (shared zip, no metadata) ──────────────────────
  const scanOnly = [
    { name: "zip open only", fn: bufs => {
      for (const { buffer } of bufs) openZip(buffer);
      return { baselineClient: 0, hits2: 0, hits3: 0, hits4: 0, classes3: 0 };
    } },
    { name: "2 entrypoint", fn: bufs => runScanOnly(bufs, { s2: true }) },
    { name: "3 whole-jar", fn: bufs => runScanOnly(bufs, { s3: true }) },
    { name: "3 full (no exit)", fn: bufs => runScanOnly(bufs, { s3: true, full3: true }) },
    { name: "4 call-graph", fn: bufs => runScanOnly(bufs, { s4: true }) },
    { name: "2+3", fn: bufs => runScanOnly(bufs, { s2: true, s3: true }) },
    { name: "2+4", fn: bufs => runScanOnly(bufs, { s2: true, s4: true }) },
    { name: "3+4", fn: bufs => runScanOnly(bufs, { s3: true, s4: true }) },
    { name: "2+3+4", fn: bufs => runScanOnly(bufs, { s2: true, s3: true, s4: true }) }
  ];

  const scanResults = [];
  for (const v of scanOnly) {
    process.stdout.write(`B ${v.name}...`);
    const r = measure(v.name, v.fn, buffers, opts.iters, opts.warmup);
    scanResults.push(r);
    console.log(` ${fmtMs(r.wallMs.median)}`);
  }

  printTable(
    "A) BOLT-ON: inspectModJar + scanners (second zip open) — vs baseline",
    boltonResults,
    boltonResults[0]
  );
  printTable(
    "B) SCANNER-ONLY: one zip open + scan — vs zip-open-only (isolates 2/3/4)",
    scanResults,
    scanResults[0]
  );

  console.log("\nHit / work counts (last iter):");
  for (const r of [ ...boltonResults, ...scanResults ]) {
    const h = r.hits;
    console.log(
      `  ${r.name.padEnd(28)}  client=${h.baselineClient}` +
      `  hit2=${h.hits2}  hit3=${h.hits3}  hit4=${h.hits4}` +
      (h.classes3 ? `  classes3=${h.classes3}` : "")
    );
  }

  console.log("\nNotes:");
  console.log("  - Disk I/O excluded (buffers preloaded).");
  console.log("  - Table A ≈ cost of adding scanners without refactoring inspectModJar.");
  console.log("  - Table B isolates scanner work; '3 full' disables early-exit (worst case).");
  console.log("  - Heap Δ is noisy; rank by wall/CPU.");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
