#!/usr/bin/env node
// Download + inspect a fixed corpus of popular modpacks against the production
// install decision (inspectModJar + decideModInstall precedence table + Layer 2
// crash scan + dependency rescue/propagation).
//
// Ground truth: Modrinth project server_side / mrpack env.server
//   unsupported → should skip (client-only)
//   required | optional → should install
//   null → unlabeled (reported separately, not in accuracy math)
// corrected by data/server_side_overrides.json (known mislabels) and frozen
// golden labels in scripts/eval_overrides.json.
//
// Usage:
//   node scripts/eval_pack_corpus.js
//   node scripts/eval_pack_corpus.js --only atm9,rlcraft
//   node scripts/eval_pack_corpus.js --skip-download   # re-score cached jars

"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const AdmZip = require("adm-zip");

const {
  getModpackById,
  getModpackFiles,
  detectLoaderType,
  detectMCVersion,
  parseManifestLoaderType,
  resolveCurseforgeInstall
} = require("../utility/curseforge.js");
const {
  getModrinthModpack,
  getModrinthVersions,
  resolveModrinthInstall,
  analyzeModrinthFiles,
  getServerSideBySlugs
} = require("../utility/modrinth.js");
const { downloadFile } = require("../utility/modpack_http.js");
const {
  inspectModJar,
  decideModInstall,
  extractModDeps,
  isKnownServerSideMod
} = require("../utility/mod_inspector.js");
const { assessClientSignals } = require("../utility/client_signals.js");

// Frozen ground-truth overrides (hand-triaged FP/FN rows — see Phase 0 of the
// mod-detection overhaul plan). sha1 → { label: "client"|"server", note }.
const EVAL_OVERRIDES = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "eval_overrides.json"), "utf8")).overrides ?? {};
  } catch {
    return {};
  }
})();

const ROOT = "/tmp/modpack-corpus";
const PACK_DIR = path.join(ROOT, "packs");
const JAR_DIR = path.join(ROOT, "jars");
const OUT_DIR = path.join(ROOT, "results");
const CONCURRENCY = 8;

const PACKS = [
  { key: "atm9", name: "All the Mods 9 (ATM9)", source: "cf", cfId: 715572 },
  { key: "create-aab", name: "Create: Above and Beyond", source: "cf", cfId: 542763 },
  { key: "rlcraft", name: "RLCraft", source: "cf", cfId: 285109 },
  { key: "better-mc-fabric", name: "Better Minecraft [Fabric]", source: "mr", mrSlug: "better-mc-fabric-bmc2" },
  { key: "ftb-skies", name: "FTB Skies", source: "cf", cfId: 1091252 },
  { key: "gtnh", name: "GregTech: New Horizons (GTNH)", source: "cf", cfId: 252507 },
  { key: "prominence-ii", name: "Prominence II RPG", source: "cf", cfId: 466901 },
  { key: "enigmatica-9", name: "Enigmatica 9", source: "cf", cfId: 632239 },
  { key: "valhelsia-6", name: "Valhelsia 6", source: "cf", cfId: 878495 },
  { key: "sevtech", name: "SevTech: Ages", source: "cf", cfId: 268208 },
  { key: "cobblemon", name: "Cobblemon Official", source: "mr", mrSlug: "cobblemon-fabric" },
  { key: "vault-hunters-3", name: "Vault Hunters 3rd Edition", source: "cf", cfId: 711537 },
  { key: "pixelmon", name: "Pixelmon Reforged", source: "cf", cfId: 389615 },
  { key: "divine-journey-2", name: "Divine Journey 2", source: "cf", cfId: 370666 },
  { key: "simply-optimized", name: "Simply Optimized", source: "mr", mrSlug: "sop" },
  { key: "stoneblock-3", name: "Stoneblock 3", source: "cf", cfId: 1091305 },
  { key: "medieval-mc", name: "Medieval Minecraft", source: "cf", cfId: 876851 }, // Medieval MC [FORGE] MMC4
  { key: "nomi-ceu", name: "Nomifactory CEu", source: "cf", cfId: 594351 },
  { key: "ftb-academy", name: "FTB Academy", source: "cf", cfId: 336409 },
  { key: "mc-eternal", name: "MC Eternal", source: "cf", cfId: 349129 },
  { key: "create-astral", name: "Create: Astral", source: "cf", cfId: 681792 },
  { key: "craft-to-exile-2", name: "Craft to Exile 2", source: "cf", cfId: 936875 },
  { key: "ftb-infinity", name: "Feed The Beast Infinity Evolved", source: "cf", cfId: 227724 },
  { key: "integrated-mc", name: "Integrated Minecraft", source: "cf", cfId: 663737 },
  { key: "dawncraft", name: "DawnCraft", source: "cf", cfId: 829758 }
];

function parseArgs(argv) {
  const out = { only: null, skipDownload: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--only") out.only = new Set(argv[++i].split(",").map(s => s.trim()).filter(Boolean));
    if (argv[i] === "--skip-download") out.skipDownload = true;
  }
  return out;
}

function ensureDirs() {
  for (const d of [ ROOT, PACK_DIR, JAR_DIR, OUT_DIR ]) fs.mkdirSync(d, { recursive: true });
}

function sha1Of(buf) {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

function jarCachePath(sha1) {
  return path.join(JAR_DIR, `${sha1}.jar`);
}

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

function metrics(c) {
  const total = c.tp + c.tn + c.fp + c.fn;
  return {
    ...c,
    total,
    accuracy: total ? (c.tp + c.tn) / total : null,
    precision: (c.tp + c.fp) ? c.tp / (c.tp + c.fp) : null,
    recall: (c.tp + c.fn) ? c.tp / (c.tp + c.fn) : null,
    specificity: (c.tn + c.fp) ? c.tn / (c.tn + c.fp) : null,
    f1: (2 * c.tp + c.fp + c.fn) ? (2 * c.tp) / (2 * c.tp + c.fp + c.fn) : null
  };
}

const pct = x => (x === null || x === undefined) ? "n/a" : `${(100 * x).toFixed(1)}%`;

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

async function pickLatestCfFile(modId) {
  const files = await getModpackFiles(modId);
  const ranked = [ ...files ].sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate));
  // Prefer a full client pack zip with a download URL.
  const withUrl = ranked.find(f => f.downloadUrl && /\.zip$/i.test(f.fileName || ""));
  return withUrl || ranked.find(f => f.downloadUrl) || ranked[0] || null;
}

async function downloadPackCf(pack) {
  const mod = await getModpackById(pack.cfId);
  if (!mod) throw new Error(`CF modpack ${pack.cfId} not found`);
  const file = await pickLatestCfFile(pack.cfId);
  if (!file) throw new Error(`No files for CF ${pack.cfId}`);
  if (!file.downloadUrl) throw new Error(`No download URL for ${file.fileName}`);

  const zipPath = path.join(PACK_DIR, pack.key, file.fileName);
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size !== file.fileLength) {
    console.log(`  downloading pack zip ${file.fileName} (${(file.fileLength / 1e6).toFixed(1)} MB)...`);
    const buf = await downloadFile(file.downloadUrl);
    fs.writeFileSync(zipPath, buf);
  } else {
    console.log(`  cached pack zip ${file.fileName}`);
  }

  const loaderType = parseManifestLoaderType(
    JSON.parse(new AdmZip(fs.readFileSync(zipPath)).readAsText("manifest.json") || "null")
  ) || detectLoaderType(mod.latestFilesIndexes) || "forge";
  const mcVersion = detectMCVersion(mod, file);

  const buffer = fs.readFileSync(zipPath);
  console.log(`  resolving CurseForge install plan (loader=${loaderType}, mc=${mcVersion})...`);
  const resolved = await resolveCurseforgeInstall(buffer, loaderType, msg => {
    if (msg && !msg.includes("progress")) process.stdout.write(`    ${msg.split("\n")[0]}\n`);
  });
  if (!resolved?.plan) throw new Error("Failed to resolve CF install plan");

  return {
    source: "cf",
    packName: mod.name,
    fileName: file.fileName,
    fileId: file.id,
    loaderType,
    mcVersion,
    zipPath,
    plan: resolved.plan
  };
}

async function downloadPackMr(pack) {
  const project = await getModrinthModpack(pack.mrSlug);
  if (!project) throw new Error(`Modrinth modpack ${pack.mrSlug} not found`);
  const versions = await getModrinthVersions(project.id);
  const ver = versions.find(v => (v.files || []).some(f => f.filename?.endsWith(".mrpack") || f.primary))
    || versions[0];
  if (!ver) throw new Error(`No versions for ${pack.mrSlug}`);
  const file = (ver.files || []).find(f => f.filename?.endsWith(".mrpack")) || ver.files?.[0];
  if (!file?.url) throw new Error(`No mrpack URL for ${pack.mrSlug}`);

  const zipPath = path.join(PACK_DIR, pack.key, file.filename);
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  if (!fs.existsSync(zipPath)) {
    console.log(`  downloading mrpack ${file.filename}...`);
    const buf = await downloadFile(file.url);
    fs.writeFileSync(zipPath, buf);
  } else {
    console.log(`  cached mrpack ${file.filename}`);
  }

  const buffer = fs.readFileSync(zipPath);
  const resolved = await resolveModrinthInstall(buffer);
  if (!resolved?.plan) throw new Error("Failed to resolve Modrinth install plan");

  return {
    source: "mr",
    packName: project.title,
    fileName: file.filename,
    fileId: ver.id,
    loaderType: resolved.plan.loaderType,
    mcVersion: resolved.plan.mcVersion,
    zipPath,
    plan: resolved.plan
  };
}

async function ensureJar(mod) {
  const dest = jarCachePath(mod.sha1 || `url-${sha1Of(Buffer.from(mod.downloadUrl)).slice(0, 16)}`);
  // Prefer sha1-named cache when available
  const cachePath = mod.sha1 ? jarCachePath(mod.sha1) : dest;
  if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) {
    return { buffer: fs.readFileSync(cachePath), sha1: mod.sha1 || sha1Of(fs.readFileSync(cachePath)), cachePath, cached: true };
  }
  const buffer = await downloadFile(mod.downloadUrl);
  const sha1 = mod.sha1 || sha1Of(buffer);
  const finalPath = jarCachePath(sha1);
  if (!fs.existsSync(finalPath)) fs.writeFileSync(finalPath, buffer);
  return { buffer, sha1, cachePath: finalPath, cached: false };
}

function classifyDecision(inspection, providerSide, decision) {
  const reasons = [];
  if (inspection.verdict === "client") {
    reasons.push(`jar:${inspection.confidence}/${inspection.source}`);
  } else {
    reasons.push(`jar:${inspection.verdict || "unknown"}`);
  }
  if (providerSide) reasons.push(`provider:${providerSide}`);
  reasons.push(`slot${decision.slot}:${decision.source}`);
  reasons.push(decision.install ? "INSTALL" : "SKIP");
  return reasons.join(" ");
}

async function evaluatePack(pack, meta) {
  const { plan, loaderType, mcVersion, packName, fileName } = meta;
  const mods = plan.modFiles || [];
  const overrideMods = (plan.overrideEntries || []).filter(e => /^mods\/[^/]+\.jar$/i.test(e.path));

  console.log(`  mods in plan: ${mods.length}, override jars: ${overrideMods.length}`);

  let done = 0;
  let dlFailed = 0;
  const rows = [];

  // Full Layer 1 decision (+ lazy client_signals for slot-9 rows), matching the
  // production install engine. Learned verdicts are not injected — the eval
  // measures the static pipeline.
  const decideRow = ({ inspection, provider, modId, filename, sha1, buffer }) => {
    let decision = decideModInstall({ inspection, providerServerSide: provider, modId, filename, sha1 });
    if (decision.install && decision.slot === 9 && buffer) {
      const risk = assessClientSignals(buffer);
      if (risk.risk) {
        decision = decideModInstall({ inspection, providerServerSide: provider, modId, filename, sha1, crashRisk: risk });
      }
    }
    return decision;
  };

  await mapPool(mods, CONCURRENCY, async mod => {
    try {
      const { buffer, sha1 } = await ensureJar(mod);
      const inspection = inspectModJar(buffer, loaderType);
      const deps = extractModDeps(buffer, loaderType);
      const filename = mod.filename || path.basename(mod.path);
      // Production provider: pack env (mrpack) or CF→Modrinth project side.
      const provider = mod.providerServerSide ?? null;
      const decision = decideRow({ inspection, provider, modId: deps.modId, filename, sha1, buffer });
      const jarOnly = decideRow({ inspection, provider: null, modId: deps.modId, filename, sha1, buffer });
      rows.push({
        origin: "manifest",
        filename,
        sha1,
        providerServerSide: provider,
        jarVerdict: inspection.verdict,
        jarConfidence: inspection.confidence,
        jarSource: inspection.source,
        jarSkip: !jarOnly.install,
        combinedSkip: !decision.install,
        slot: decision.slot,
        slotSource: decision.source,
        rescuable: decision.rescuable,
        modId: deps.modId,
        requiredDeps: deps.requiredDeps,
        decision: classifyDecision(inspection, provider, decision)
      });
    } catch (e) {
      dlFailed++;
      rows.push({
        origin: "manifest",
        filename: mod.filename || path.basename(mod.path || "?"),
        error: e.message,
        combinedSkip: null
      });
    } finally {
      done++;
      if (done % 25 === 0 || done === mods.length) {
        process.stdout.write(`\r  downloaded/inspected ${done}/${mods.length} (fail ${dlFailed})   `);
      }
    }
  });
  process.stdout.write("\n");

  // Override jars: no provider metadata
  for (const entry of overrideMods) {
    const buffer = entry.data;
    const sha1 = sha1Of(buffer);
    const inspection = inspectModJar(buffer, loaderType);
    const deps = extractModDeps(buffer, loaderType);
    const filename = path.basename(entry.path);
    const decision = decideRow({ inspection, provider: null, modId: deps.modId, filename, sha1, buffer });
    rows.push({
      origin: "override",
      filename,
      sha1,
      providerServerSide: null,
      jarVerdict: inspection.verdict,
      jarConfidence: inspection.confidence,
      jarSource: inspection.source,
      jarSkip: !decision.install,
      combinedSkip: !decision.install,
      slot: decision.slot,
      slotSource: decision.source,
      rescuable: decision.rescuable,
      modId: deps.modId,
      requiredDeps: deps.requiredDeps,
      decision: classifyDecision(inspection, null, decision)
    });
  }

  // Dependency rescue fixpoint + client-chain propagation — same passes as the
  // production install engine, so the scored decision is what actually ships.
  let rescued = true;
  while (rescued) {
    rescued = false;
    const requiredByInstalled = new Set(
      rows.filter(r => !r.error && r.combinedSkip === false).flatMap(r => r.requiredDeps ?? [])
    );
    for (const r of rows) {
      if (r.error || r.combinedSkip !== true || !r.rescuable || !r.modId) continue;
      if (requiredByInstalled.has(r.modId)) {
        r.combinedSkip = false;
        r.slotSource = "dep-rescue";
        r.decision += " → dep-rescue INSTALL";
        rescued = true;
      }
    }
  }
  const providerVouched = r => r.providerServerSide === "required" || r.providerServerSide === "optional";
  const skippedIds = new Set(rows.filter(r => r.combinedSkip === true && r.modId).map(r => r.modId));
  let propagated = true;
  while (propagated) {
    propagated = false;
    for (const r of rows) {
      if (r.error || r.combinedSkip !== false || providerVouched(r)) continue;
      if ((r.requiredDeps ?? []).some(dep => skippedIds.has(dep))) {
        r.combinedSkip = true;
        r.slotSource = "client-dep-chain";
        r.decision += " → dep-chain SKIP";
        if (r.modId) { skippedIds.add(r.modId); propagated = true; }
      }
    }
  }

  // Ground truth = Modrinth *project* server_side by JAR hash (not pack env.server,
  // which pack authors often leave as "required" for client mods).
  const sha1s = [ ...new Set(rows.map(r => r.sha1).filter(Boolean)) ];
  console.log(`  looking up Modrinth project sides for ${sha1s.length} jars...`);
  const { serverSideByHash } = await analyzeModrinthFiles(sha1s);
  // Slug fallback for CF builds that don't match Modrinth hashes.
  const missingSlugs = [ ...new Set(
    rows.filter(r => r.sha1 && !serverSideByHash.has(r.sha1) && r.modId).map(r => r.modId)
  ) ];
  const sideBySlug = await getServerSideBySlugs(missingSlugs);

  for (const r of rows) {
    if (r.error) continue;
    const projectSide = (r.sha1 && serverSideByHash.get(r.sha1))
      || (r.modId && sideBySlug.get(r.modId))
      || null;
    r.projectServerSide = projectSide ?? null;
    r.truthClient = truthClient(projectSide);
    // Known Modrinth mislabels (data/server_side_overrides.json) are truth
    // corrections by definition — these mods are server-side.
    if (r.truthClient === true && isKnownServerSideMod({ modId: r.modId, filename: r.filename, sha1: r.sha1 })) {
      r.truthClient = false;
      r.truthOverridden = true;
    }
    // Frozen golden labels win over live Modrinth labels.
    const override = r.sha1 && EVAL_OVERRIDES[r.sha1];
    if (override) {
      r.truthClient = override.label === "client";
      r.truthOverridden = true;
    }
  }

  const labeled = rows.filter(r => r.truthClient !== null && r.truthClient !== undefined && !r.error);
  const jarCounts = emptyCounts();
  const combinedCounts = emptyCounts();
  const fps = [];
  const fns = [];
  const rescues = []; // rescuable skips reversed by the dependency fixpoint
  const strongOverrides = []; // explicit/strong jar skip despite pack provider required/optional
  const packEnvDisagreements = []; // pack env vs project side

  for (const r of labeled) {
    const jb = bucket(!!r.jarSkip, r.truthClient);
    const cb = bucket(!!r.combinedSkip, r.truthClient);
    jarCounts[jb]++;
    combinedCounts[cb]++;
    if (cb === "fp") fps.push(r);
    if (cb === "fn") fns.push(r);
    if (r.slotSource === "dep-rescue") rescues.push(r);
    if ((r.providerServerSide === "required" || r.providerServerSide === "optional")
      && r.combinedSkip
      && r.jarVerdict === "client"
      && (r.jarConfidence === "explicit" || r.jarConfidence === "strong")) {
      strongOverrides.push(r);
    }
    if (r.providerServerSide && r.projectServerSide && r.providerServerSide !== r.projectServerSide) {
      packEnvDisagreements.push(r);
    }
  }

  const unlabeled = rows.filter(r => !r.error && r.truthClient === null);
  const skipped = rows.filter(r => r.combinedSkip === true);
  const installed = rows.filter(r => r.combinedSkip === false);

  // Per-slot breakdown for skips (the plan's "per-slot skip sources")
  const skipSources = {};
  for (const r of skipped) {
    const src = r.slotSource === "client-dep-chain" ? "dep-chain" : `slot${r.slot}:${r.slotSource}`;
    skipSources[src] = (skipSources[src] || 0) + 1;
  }

  return {
    key: pack.key,
    name: pack.name,
    resolvedName: packName,
    fileName,
    loaderType,
    mcVersion,
    totals: {
      manifest: mods.length,
      overrides: overrideMods.length,
      rows: rows.length,
      downloadFailed: dlFailed,
      labeled: labeled.length,
      unlabeled: unlabeled.length,
      skipped: skipped.length,
      installed: installed.length
    },
    jar: metrics(jarCounts),
    combined: metrics(combinedCounts),
    skipSources,
    fps: fps.map(summarizeRow),
    fns: fns.map(summarizeRow),
    rescues: rescues.map(summarizeRow),
    strongOverrides: strongOverrides.map(summarizeRow),
    packEnvDisagreements: packEnvDisagreements.length,
    unlabeledSkipped: unlabeled.filter(r => r.combinedSkip).map(summarizeRow),
    unlabeledInstalledSample: unlabeled.filter(r => !r.combinedSkip).slice(0, 30).map(summarizeRow),
    rows // full detail for JSON dump
  };
}

function summarizeRow(r) {
  return {
    filename: r.filename,
    modId: r.modId,
    origin: r.origin,
    provider: r.providerServerSide,
    project: r.projectServerSide,
    truthOverridden: r.truthOverridden ?? false,
    jar: `${r.jarVerdict}/${r.jarConfidence}/${r.jarSource}`,
    slot: r.slot,
    slotSource: r.slotSource,
    jarSkip: r.jarSkip,
    combinedSkip: r.combinedSkip,
    decision: r.decision
  };
}

function printPackSummary(r) {
  console.log(`\n=== ${r.name} (${r.key}) ===`);
  console.log(`  ${r.resolvedName} | ${r.fileName}`);
  console.log(`  loader=${r.loaderType} mc=${r.mcVersion}`);
  console.log(`  jars: ${r.totals.rows} (manifest ${r.totals.manifest}, overrides ${r.totals.overrides}, dl-fail ${r.totals.downloadFailed})`);
  console.log(`  labeled=${r.totals.labeled} unlabeled=${r.totals.unlabeled} → skip ${r.totals.skipped} / install ${r.totals.installed}`);
  console.log(`  JAR-only : acc=${pct(r.jar.accuracy)} prec=${pct(r.jar.precision)} rec=${pct(r.jar.recall)} FP=${r.jar.fp} FN=${r.jar.fn} (n=${r.jar.total})`);
  console.log(`  Combined : acc=${pct(r.combined.accuracy)} prec=${pct(r.combined.precision)} rec=${pct(r.combined.recall)} FP=${r.combined.fp} FN=${r.combined.fn} (n=${r.combined.total})`);
  if (r.rescues.length) console.log(`  Dependency rescues (rescuable skip→install): ${r.rescues.length}`);
  if (r.strongOverrides.length) console.log(`  Strong JAR overrides of required/optional: ${r.strongOverrides.length}`);
  if (r.fps.length) {
    console.log("  False positives (skipped but truth says server-ok) top:");
    for (const f of r.fps.slice(0, 8)) console.log(`    - ${f.filename}  ${f.jar}  project=${f.project} provider=${f.provider}`);
  }
  if (r.fns.length) {
    console.log("  False negatives (installed but truth says client-only) top:");
    for (const f of r.fns.slice(0, 8)) console.log(`    - ${f.filename}  ${f.jar}  project=${f.project} provider=${f.provider}`);
  }
}

function writeMarkdownReport(all) {
  const lines = [];
  lines.push("# Modpack client-only detection accuracy report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Method");
  lines.push("");
  lines.push("- **Decision under test:** production Layer 1 precedence table (`decideModInstall`: blocklist → allowlist/server-overrides → learned verdicts → provider → explicit metadata → curated client list → provider-unsupported → client_signals → install) plus the dependency-rescue/propagation fixpoints — same pipeline as `/install-modpack`.");
  lines.push("- **Ground truth:** Modrinth **project** `server_side` looked up by JAR hash (slug fallback), with hand-triaged golden overrides from `scripts/eval_overrides.json` applied on top.");
  lines.push("- **Provider input** (what the installer sees): mrpack `env.server` or CurseForge→Modrinth project side — may disagree with project labels on lazy packs.");
  lines.push("- **Unlabeled mods** (no Modrinth project side and no override) are excluded from accuracy math but listed for coverage.");
  lines.push("");

  const aggJar = emptyCounts();
  const aggComb = emptyCounts();
  for (const r of all) {
    for (const k of [ "tp", "tn", "fp", "fn" ]) {
      aggJar[k] += r.jar[k];
      aggComb[k] += r.combined[k];
    }
  }
  const mj = metrics(aggJar);
  const mc = metrics(aggComb);

  lines.push("## Overall (all labeled mods across packs)");
  lines.push("");
  lines.push("| Variant | N | Accuracy | Precision | Recall | Spec | F1 | TP | TN | FP | FN |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  lines.push(`| JAR-only | ${mj.total} | ${pct(mj.accuracy)} | ${pct(mj.precision)} | ${pct(mj.recall)} | ${pct(mj.specificity)} | ${pct(mj.f1)} | ${mj.tp} | ${mj.tn} | ${mj.fp} | ${mj.fn} |`);
  lines.push(`| JAR + provider | ${mc.total} | ${pct(mc.accuracy)} | ${pct(mc.precision)} | ${pct(mc.recall)} | ${pct(mc.specificity)} | ${pct(mc.f1)} | ${mc.tp} | ${mc.tn} | ${mc.fp} | ${mc.fn} |`);
  lines.push("");

  lines.push("## Per-pack summary");
  lines.push("");
  lines.push("| Pack | Loader | MC | Jars | Labeled | Skip | Install | Comb Acc | Comb FP | Comb FN | Rescues | Strong overrides |");
  lines.push("|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of all) {
    lines.push(`| ${r.name} | ${r.loaderType} | ${r.mcVersion || "?"} | ${r.totals.rows} | ${r.totals.labeled} | ${r.totals.skipped} | ${r.totals.installed} | ${pct(r.combined.accuracy)} | ${r.combined.fp} | ${r.combined.fn} | ${r.rescues.length} | ${r.strongOverrides.length} |`);
  }
  lines.push("");

  // Aggregate disagreement themes
  const allFp = all.flatMap(r => r.fps.map(f => ({ ...f, pack: r.key })));
  const allFn = all.flatMap(r => r.fns.map(f => ({ ...f, pack: r.key })));
  const allRescue = all.flatMap(r => r.rescues.map(f => ({ ...f, pack: r.key })));

  lines.push("## What needs work");
  lines.push("");
  lines.push(`### False positives (skipped despite Modrinth server-ok): ${allFp.length}`);
  lines.push("These are the riskiest: we drop a mod the provider says belongs on the server.");
  lines.push("");
  if (allFp.length === 0) {
    lines.push("_None._");
  } else {
    const byJar = {};
    for (const f of allFp) {
      const k = f.jar;
      byJar[k] = (byJar[k] || 0) + 1;
    }
    lines.push("By JAR signal:");
    for (const [ k, n ] of Object.entries(byJar).sort((a, b) => b[1] - a[1])) {
      lines.push(`- \`${k}\`: ${n}`);
    }
    lines.push("");
    lines.push("Examples:");
    for (const f of allFp.slice(0, 40)) {
      lines.push(`- **[${f.pack}]** ${f.filename} (\`${f.modId || "?"}\`) — ${f.jar}, provider=${f.provider}`);
    }
    if (allFp.length > 40) lines.push(`- _… +${allFp.length - 40} more_`);
  }
  lines.push("");

  lines.push(`### False negatives (installed despite Modrinth unsupported): ${allFn.length}`);
  lines.push("Client-only mods that may still land on the server (crash risk).");
  lines.push("");
  if (allFn.length === 0) {
    lines.push("_None._");
  } else {
    const byJar = {};
    for (const f of allFn) {
      const k = f.jar;
      byJar[k] = (byJar[k] || 0) + 1;
    }
    lines.push("By JAR signal:");
    for (const [ k, n ] of Object.entries(byJar).sort((a, b) => b[1] - a[1])) {
      lines.push(`- \`${k}\`: ${n}`);
    }
    lines.push("");
    lines.push("Examples:");
    for (const f of allFn.slice(0, 40)) {
      lines.push(`- **[${f.pack}]** ${f.filename} (\`${f.modId || "?"}\`) — ${f.jar}, provider=${f.provider}`);
    }
    if (allFn.length > 40) lines.push(`- _… +${allFn.length - 40} more_`);
  }
  lines.push("");

  lines.push(`### Dependency rescues (rescuable skip → install, required by installed mods): ${allRescue.length}`);
  lines.push("");
  for (const f of allRescue.slice(0, 25)) {
    lines.push(`- **[${f.pack}]** ${f.filename}`);
  }
  if (allRescue.length > 25) lines.push(`- _… +${allRescue.length - 25} more_`);
  lines.push("");

  lines.push("## Per-slot skip sources (all packs)");
  lines.push("");
  const mix = {};
  for (const r of all) {
    for (const [ k, n ] of Object.entries(r.skipSources || {})) mix[k] = (mix[k] || 0) + n;
  }
  for (const [ k, n ] of Object.entries(mix).sort((a, b) => b[1] - a[1])) {
    lines.push(`- \`${k}\`: ${n}`);
  }
  lines.push("");

  lines.push("## Recommended follow-ups");
  lines.push("");
  lines.push("1. Triage new combined FPs — confirm whether the golden label or a curated-list/Layer-2 hit is wrong; fix the list, not a heuristic.");
  lines.push("2. Triage new combined FNs — remaining installs of true client mods are mopped up by the boot-verify loop; only chase ones that crash servers.");
  lines.push("3. Keep `scripts/eval_overrides.json` in sync when Modrinth labels are confirmed wrong; seed `data/server_side_overrides.json` for server-needed mislabels.");
  lines.push("");

  return lines.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv);
  ensureDirs();

  const selected = PACKS.filter(p => !opts.only || opts.only.has(p.key));
  console.log(`Evaluating ${selected.length} packs → ${OUT_DIR}`);

  const summaries = [];
  for (const pack of selected) {
    console.log(`\n######## ${pack.name} [${pack.key}] ########`);
    const metaPath = path.join(PACK_DIR, pack.key, "meta.json");
    let meta;
    try {
      if (opts.skipDownload && fs.existsSync(metaPath)) {
        meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        // plan.overrideEntries buffers aren't in meta — re-resolve if needed
        if (!meta.plan) throw new Error("meta missing plan");
        console.log("  using cached meta (plan URLs only; jars from cache)");
      } else {
        meta = pack.source === "cf" ? await downloadPackCf(pack) : await downloadPackMr(pack);
        // Persist override jars to disk; keep meta JSON small.
        const overrideDir = path.join(PACK_DIR, pack.key, "overrides-mods");
        fs.mkdirSync(overrideDir, { recursive: true });
        const overrideMeta = [];
        for (const e of (meta.plan.overrideEntries || [])) {
          if (!/^mods\/[^/]+\.jar$/i.test(e.path)) continue;
          const fname = path.basename(e.path);
          const dest = path.join(overrideDir, fname);
          fs.writeFileSync(dest, e.data);
          overrideMeta.push({ path: e.path, file: dest, sha1: sha1Of(e.data) });
        }
        fs.writeFileSync(metaPath, JSON.stringify({
          source: meta.source,
          packName: meta.packName,
          fileName: meta.fileName,
          fileId: meta.fileId,
          loaderType: meta.loaderType,
          mcVersion: meta.mcVersion,
          zipPath: meta.zipPath,
          plan: {
            loaderType: meta.plan.loaderType,
            mcVersion: meta.plan.mcVersion,
            modFiles: meta.plan.modFiles,
            overrideEntries: overrideMeta,
            unavailable: meta.plan.unavailable || []
          }
        }));
      }

      // Inflate override jars from disk paths stored in meta.
      if (meta.plan.overrideEntries?.length && !Buffer.isBuffer(meta.plan.overrideEntries[0]?.data)) {
        meta.plan.overrideEntries = meta.plan.overrideEntries.map(e => ({
          path: e.path,
          data: fs.readFileSync(e.file)
        }));
      }

      const result = await evaluatePack(pack, meta);
      printPackSummary(result);

      const outPath = path.join(OUT_DIR, `${pack.key}.json`);
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
      console.log(`  wrote ${outPath}`);

      // Keep summary without full rows for aggregate
      const summary = { ...result };
      delete summary.rows;
      summaries.push(summary);
    } catch (e) {
      console.error(`  FAILED: ${e.message}`);
      summaries.push({
        key: pack.key,
        name: pack.name,
        error: e.message,
        jar: metrics(emptyCounts()),
        combined: metrics(emptyCounts()),
        totals: { rows: 0, labeled: 0, skipped: 0, installed: 0, manifest: 0, overrides: 0, downloadFailed: 0, unlabeled: 0 },
        fps: [], fns: [], rescues: [], strongOverrides: [], skipSources: {}
      });
    }
  }

  const reportMd = writeMarkdownReport(summaries.filter(s => !s.error));
  const reportPath = path.join(OUT_DIR, "REPORT.md");
  fs.writeFileSync(reportPath, reportMd);
  fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify(summaries, null, 2));
  console.log(`\n\nWrote report: ${reportPath}`);
  console.log(reportMd.split("\n").slice(0, 80).join("\n"));
}

// Only run the (long, network-heavy) sweep when invoked directly — requiring
// this module just to read PACKS must not kick off a full corpus download.
if (require.main === module) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { PACKS };
