#!/usr/bin/env node
// Tier 1 verification — offline, no panel.
//
// Runs search → version select → download → unwrap → classify and prints the
// install plan the job *would* execute: strategy chosen, whether the archive has
// a nested root, mod counts, skips with slot and reason, unavailable files.
// Touches no server, so it is safe to run against anything at any time.
//
// This is the loop to live in while changing selection, resolution, or
// classification code. Tier 0 (`npm test`) cannot see provider drift; Tier 2
// (scripts/modpack_smoke.js) needs a panel and an hour.
//
// Usage:
//   node scripts/modpack_preflight.js --pack="all the mods 10"
//   node scripts/modpack_preflight.js --pack=cf:520914 --version=latest
//   node scripts/modpack_preflight.js --pack=mr:sop --json
//   node scripts/modpack_preflight.js --pack=cf:520914 --version=6543210
//   node scripts/modpack_preflight.js --corpus            # sweep the eval corpus
//   node scripts/modpack_preflight.js --corpus --limit=10 --out=docs/tier1.json
//
// Requires CURSEFORGE_API_KEY (and optionally MODRINTH_API_KEY) in .env.
"use strict";

// quiet: dotenv's banner goes to stdout, which would corrupt `--json > out.json`.
require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

const { searchModpacksDetailed, parsePackChoice } = require("../utility/modpack/search.js");
const { lookupModpack, listModpackFiles, resolveModpackInstall } = require("../utility/modpack_providers.js");
const { downloadToBuffer } = require("../utility/modpack_http.js");
const {
  detectNestedArchiveRoot, decideWithClientSignals, applyDependencyRescue,
  normalizeArchiveEntryPath, shouldSkipArchiveEntry, isArchiveModsJar
} = require("../utility/modpack_install.js");
const { isManifestZip, defaultLoaderForLegacyMc } = require("../utility/curseforge.js");
const { inspectModJarCached, extractModDeps } = require("../utility/mod_inspector.js");
const { assessClientSignals } = require("../utility/client_signals.js");
const { detectLoaderVersionFromBuffer, buildLoaderEggEnv } = require("../utility/loader_version.js");
const { getJavaImageForMCVersion } = require("../utility/minecraft_java.js");
const { isServerStarterZip, parseServerStarterConfig } = require("../utility/modpack/job.js");
const config = require("../config.json");

const SKIP_SLOT_LABELS = {
  1: "config blocklist",
  2: "config allowlist / server-side override",
  3: "learned verdict (boot-verify)",
  4: "crash-risk scan",
  5: "provider server_side flag",
  6: "curated client-only list",
  7: "static jar inspection",
  8: "client signals (bytecode)"
};

function parseArgs(argv) {
  const opts = { pack: null, version: null, json: false, out: null, corpus: false, limit: 0 };
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [ , key, value ] = m;
    if (key === "pack") opts.pack = value;
    else if (key === "version") opts.version = value;
    else if (key === "json") opts.json = true;
    else if (key === "out") opts.out = value;
    else if (key === "corpus") opts.corpus = true;
    else if (key === "limit") opts.limit = parseInt(value, 10) || 0;
  }
  return opts;
}

function fmtBytes(n) {
  if (!n) return "0 B";
  const mb = n / 1_048_576;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;
}

/**
 * Resolve `--pack` to { source, id }. Accepts an autocomplete value (`cf:123`,
 * `mr:sop`) directly, or a free-text name — in which case the top-ranked search
 * hit is used, exactly as a user picking the first autocomplete row would get.
 */
async function resolvePackRef(packArg) {
  const direct = parsePackChoice(packArg);
  if (direct) return { ...direct, via: "explicit" };

  const hits = await searchModpacksDetailed(packArg);
  if (!hits.length) return null;
  const top = parsePackChoice(hits[0].value);
  return top ? { ...top, via: `search (${hits.length} hits, top score ${hits[0].score?.toFixed(1)})` } : null;
}

/** Pick the file the wizard would preselect, or an explicitly requested one. */
function pickFile(fileOptions, versionArg) {
  if (!fileOptions?.length) return null;
  if (!versionArg || versionArg === "latest") return fileOptions[0];
  return fileOptions.find(f => f.id === String(versionArg))
    ?? fileOptions.find(f => f.label.toLowerCase().includes(String(versionArg).toLowerCase()))
    ?? null;
}

/**
 * Classify an archive (server pack / loose zip) exactly as installArchiveBuffer
 * does, minus the uploads. Any divergence here would make a green preflight a
 * lie, so this calls the same exported decision helpers.
 */
function classifyArchive(buffer, loaderType) {
  const zip = new AdmZip(buffer);
  const nestedRoot = detectNestedArchiveRoot(buffer);

  const skips = [];
  const crashRisks = [];
  const modInfos = [];
  let modJarTotal = 0;
  let otherFiles = 0;

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const path = normalizeArchiveEntryPath(entry.entryName, nestedRoot);
    if (shouldSkipArchiveEntry(path)) continue;

    if (!isArchiveModsJar(path)) {
      otherFiles += 1;
      continue;
    }

    modJarTotal += 1;
    let data;
    try {
      data = entry.getData();
    } catch (err) {
      skips.push({ filename: path, slot: null, source: `unreadable (${err.message})`, rescuable: false });
      continue;
    }
    const filename = path.split("/").pop();
    const inspection = inspectModJarCached(null, data, loaderType);
    const { modId, requiredDeps } = extractModDeps(data, loaderType);
    const decision = decideWithClientSignals({
      inspection, providerServerSide: null, modId, filename, sha1: null, buffer: data
    });
    modInfos.push({
      filename, buffer: data, modId, requiredDeps,
      isClientOnly: !decision.install,
      rescuable: decision.rescuable,
      source: decision.source,
      slot: decision.slot,
      providerServerSide: null
    });
  }

  // The install runs dependency rescue before committing anything, so the
  // preflight must too — otherwise it reports skips the real install rescues.
  const { rescued, propagated } = applyDependencyRescue(modInfos);

  let installed = 0;
  let parked = 0;
  for (const info of modInfos) {
    if (info.isClientOnly) {
      skips.push({
        filename: info.filename, modId: info.modId, slot: info.slot,
        source: info.source, rescuable: !!info.rescuable
      });
      if (info.rescuable) parked += 1;
      continue;
    }
    installed += 1;
    const risk = assessClientSignals(info.buffer);
    if (risk.risk || risk.advisory) crashRisks.push({ filename: info.filename, detail: risk.detail });
  }

  // The condition that killed ATM9: a mod is installed, declares a hard
  // dependency, and that dependency is not going to be on disk. Dependency
  // rescue fixes the rescuable cases; anything left here boots into a
  // missing-dependency crash, so the preflight must say so out loud rather
  // than leaving it to be discovered on a live server.
  const installedIds = new Set(
    modInfos.filter(i => !i.isClientOnly && i.modId).map(i => i.modId.toLowerCase())
  );
  const skippedById = new Map(
    modInfos.filter(i => i.isClientOnly && i.modId).map(i => [ i.modId.toLowerCase(), i.filename ])
  );
  // Provided by the loader/runtime, never shipped as a jar under mods/.
  const LOADER_PROVIDED = new Set([ "minecraft", "forge", "neoforge", "fabricloader", "fabric", "java", "mcp" ]);

  const missingDeps = [];
  for (const info of modInfos) {
    if (info.isClientOnly) continue;
    for (const dep of info.requiredDeps || []) {
      const id = String(dep).toLowerCase();
      if (!id || LOADER_PROVIDED.has(id) || installedIds.has(id)) continue;
      missingDeps.push({
        dependent: info.filename,
        missing: id,
        // A dep we skipped is our bug; a dep absent from the pack is the pack's.
        skippedJar: skippedById.get(id) ?? null
      });
    }
  }

  return {
    nestedRoot, modJarTotal, installed, parked, otherFiles, skips, crashRisks,
    rescued, propagated, missingDeps
  };
}

async function preflightPack(packArg, versionArg) {
  const report = { pack: packArg, ok: false };
  const started = Date.now();

  const ref = await resolvePackRef(packArg);
  if (!ref) {
    report.error = "no search hit / unparseable pack reference";
    return report;
  }
  report.source = ref.source;
  report.packId = ref.id;
  report.resolvedVia = ref.via;

  const modpack = await lookupModpack(ref.source, ref.id);
  if (!modpack) {
    report.error = "lookupModpack returned null";
    return report;
  }
  report.name = modpack.name;

  const fileOptions = await listModpackFiles(ref.source, modpack);
  report.versionsListed = fileOptions?.length ?? 0;
  report.serverPacksListed = (fileOptions || []).filter(f => f.isServerPack).length;

  const chosen = pickFile(fileOptions, versionArg);
  if (!chosen?.downloadUrl) {
    report.error = fileOptions?.length ? "requested version not found / no download URL" : "no downloadable versions";
    return report;
  }
  report.file = {
    id: chosen.id,
    label: chosen.label,
    isServerPack: !!chosen.isServerPack,
    mcVersion: chosen.mcVersion,
    loaderType: chosen.loaderType ?? modpack.loaderType
  };

  let buffer;
  try {
    const { chunks } = await downloadToBuffer(chosen.downloadUrl, () => {});
    buffer = Buffer.concat(chunks);
  } catch (err) {
    report.error = `download failed: ${err.message}`;
    return report;
  }
  report.downloadBytes = buffer.length;

  // ServerStarter wrapper: the real pack lives behind modpackUrl.
  if (ref.source !== "modrinth" && isServerStarterZip(buffer)) {
    const ss = parseServerStarterConfig(buffer);
    report.serverStarter = { modpackUrl: ss?.modpackUrl ?? null, ignoreProjects: ss?.ignoreProject?.length ?? 0 };
    if (!ss?.modpackUrl) {
      report.error = "ServerStarter zip with no modpackUrl";
      return report;
    }
    try {
      const { chunks } = await downloadToBuffer(ss.modpackUrl, () => {});
      buffer = Buffer.concat(chunks);
      report.unwrappedBytes = buffer.length;
    } catch (err) {
      report.error = `ServerStarter unwrap download failed: ${err.message}`;
      return report;
    }
  }

  // Loader resolution, mirroring job.js step (c).
  let loaderType = report.file.loaderType;
  if (!loaderType) loaderType = detectLoaderVersionFromBuffer(buffer)?.loaderType ?? null;
  if (!loaderType) loaderType = defaultLoaderForLegacyMc(report.file.mcVersion);
  report.effectiveLoaderType = loaderType;
  report.eggConfigured = !!(loaderType && config.modpack_eggs?.[loaderType]);

  const loaderSpec = detectLoaderVersionFromBuffer(buffer);
  const loaderEnv = buildLoaderEggEnv({ loaderType, mcVersion: report.file.mcVersion, loaderSpec, config });
  report.loaderPin = { source: loaderEnv.source, version: loaderEnv.resolvedVersion ?? null };
  report.javaImage = report.file.mcVersion ? getJavaImageForMCVersion(report.file.mcVersion, config) : null;

  // Strategy: the same branch job.js takes at step (c)/(h).
  const usesManifest = ref.source === "modrinth" || isManifestZip(buffer);
  if (usesManifest) {
    report.strategy = "manifest-plan";
    const resolution = await resolveModpackInstall(
      ref.source === "modrinth" ? "modrinth" : "curseforge", buffer, loaderType, () => {}
    );
    if (!resolution || resolution.kind !== "plan") {
      report.error = "manifest resolution failed";
      return report;
    }
    const plan = resolution.plan;
    report.plan = {
      mcVersion: plan.mcVersion ?? null,
      modFiles: plan.modFiles.length,
      extraFiles: plan.extraFiles.length,
      overrideEntries: plan.overrideEntries.length,
      unavailable: plan.unavailable.map(u => u.displayName ?? u.fileName ?? `mod ${u.modId}`)
    };
    // Per-jar classification needs every jar downloaded — out of scope for a
    // 30-second offline loop. Tier 2 covers it against a real server.
    report.note = "manifest plans classify per jar at install time; counts above are pre-classification";
  } else {
    report.strategy = "archive";
    const nestedRoot = detectNestedArchiveRoot(buffer);
    // The 1.1 regression: a nested root means Wings' in-place decompress would
    // leave /PackName/mods and the server would boot with no mods at all.
    report.nestedArchiveRoot = nestedRoot;
    report.wingsPullEligible = !nestedRoot && !!chosen.isServerPack;

    const classified = classifyArchive(buffer, loaderType);
    report.archive = {
      modJarTotal: classified.modJarTotal,
      installed: classified.installed,
      skipped: classified.skips.length,
      parkedRescuable: classified.parked,
      otherFiles: classified.otherFiles,
      depRescued: classified.rescued,
      depPropagated: classified.propagated
    };
    report.missingDeps = classified.missingDeps;
    // A skipped hard dependency is a predicted boot failure — fail the run so
    // `--corpus` surfaces it instead of burying it in a per-pack report.
    const selfInflicted = classified.missingDeps.filter(d => d.skippedJar);
    if (selfInflicted.length) {
      report.error = `${selfInflicted.length} installed mod(s) hard-require a jar this install would skip`
        + ` (e.g. ${selfInflicted[0].dependent} → ${selfInflicted[0].missing})`;
    }
    report.skips = classified.skips;
    report.crashRisks = classified.crashRisks;
    if (classified.modJarTotal === 0) {
      report.warning = "archive contains no mods/*.jar — layout may not be a server pack";
    }
  }

  report.durationMs = Date.now() - started;
  report.ok = !report.error;
  return report;
}

function printReport(r) {
  const line = (k, v) => console.log(`  ${k.padEnd(22)} ${v}`);
  console.log(`\n${"═".repeat(72)}`);
  console.log(`${r.name ?? r.pack}  [${r.source ?? "?"}:${r.packId ?? "?"}]`);
  console.log("═".repeat(72));

  if (r.error) {
    console.log(`  ✗ FAILED: ${r.error}`);
    if (r.resolvedVia) line("resolved via", r.resolvedVia);
    return;
  }

  line("resolved via", r.resolvedVia);
  line("versions listed", `${r.versionsListed} (${r.serverPacksListed} server packs)`);
  line("chosen file", `${r.file.label}  [id ${r.file.id}]`);
  line("pack type", r.file.isServerPack ? "server pack" : "client pack");
  line("mc version", r.file.mcVersion ?? "unknown");
  line("loader", `${r.effectiveLoaderType ?? "unknown"}${r.eggConfigured ? "" : "  ⚠ NO EGG CONFIGURED"}`);
  line("loader pin", `${r.loaderPin.version ?? "none"} (${r.loaderPin.source})`);
  line("java image", r.javaImage ?? "default");
  line("download", fmtBytes(r.downloadBytes));
  if (r.serverStarter) {
    line("serverstarter", `unwrapped → ${fmtBytes(r.unwrappedBytes)} (${r.serverStarter.ignoreProjects} ignored projects)`);
  }
  line("strategy", r.strategy);

  if (r.strategy === "archive") {
    const rootLabel = r.nestedArchiveRoot
      ? `"${r.nestedArchiveRoot}/"  ⚠ flatten required — Wings pull skipped`
      : "none (mods/ at zip root)";
    line("nested root", rootLabel);
    line("wings pull path", r.wingsPullEligible ? "eligible (fast path)" : "not eligible — local extract");
    line("mods", `${r.archive.installed} install / ${r.archive.skipped} skip of ${r.archive.modJarTotal}`);
    line("parked (rescuable)", String(r.archive.parkedRescuable));
    if (r.archive.depRescued?.length) {
      line("dep-rescued", `${r.archive.depRescued.length} — ${r.archive.depRescued.join(", ")}`);
    }
    if (r.archive.depPropagated?.length) {
      line("dep-propagated skip", `${r.archive.depPropagated.length} — ${r.archive.depPropagated.join(", ")}`);
    }
    line("other files", String(r.archive.otherFiles));

    if (r.skips.length) {
      console.log(`\n  Skipped mods (${r.skips.length}):`);
      for (const s of r.skips) {
        const slot = s.slot ? `slot ${s.slot}` : "—";
        const label = SKIP_SLOT_LABELS[s.slot] ?? s.source;
        console.log(`    - ${s.filename.padEnd(46)} ${slot.padEnd(8)} ${label}${s.rescuable ? " (rescuable)" : ""}`);
      }
    }
    if (r.crashRisks.length) {
      console.log(`\n  Crash-risk warnings (${r.crashRisks.length}, still installed):`);
      for (const w of r.crashRisks) console.log(`    - ${w.filename}: ${w.detail}`);
    }
    if (r.missingDeps?.length) {
      const mine = r.missingDeps.filter(d => d.skippedJar);
      const theirs = r.missingDeps.filter(d => !d.skippedJar);
      if (mine.length) {
        console.log(`\n  ⚠ ${mine.length} hard dependency/ies WE skip but an installed mod requires:`);
        for (const d of mine) console.log(`    - ${d.dependent} requires "${d.missing}" → we skip ${d.skippedJar}`);
      }
      if (theirs.length) {
        const uniq = [ ...new Set(theirs.map(d => d.missing)) ];
        console.log(`\n  note: ${uniq.length} dep(s) not present in the pack at all (pack's own metadata): ${uniq.slice(0, 8).join(", ")}`);
      }
    }
  } else {
    line("plan mc version", r.plan.mcVersion ?? "unknown");
    line("mod files", String(r.plan.modFiles));
    line("extra files", String(r.plan.extraFiles));
    line("override entries", String(r.plan.overrideEntries));
    line("unavailable", String(r.plan.unavailable.length));
    if (r.plan.unavailable.length) {
      console.log("\n  Unavailable (API download disabled — manual install required):");
      for (const u of r.plan.unavailable.slice(0, 20)) console.log(`    - ${u}`);
      if (r.plan.unavailable.length > 20) console.log(`    ...and ${r.plan.unavailable.length - 20} more`);
    }
    if (r.note) console.log(`\n  note: ${r.note}`);
  }

  if (r.warning) console.log(`\n  ⚠ ${r.warning}`);
  line("elapsed", `${(r.durationMs / 1000).toFixed(1)}s`);
}

/** The offline eval corpus, reused so Tier 1 sweeps the same packs Tier 0 ranks. */
function loadCorpus() {
  try {
    const { PACKS } = require("./eval_pack_corpus.js");
    if (!Array.isArray(PACKS)) return [];
    // Corpus rows are { key, name, source: "cf"|"mr", cfId?, mrSlug? } — map them
    // onto the autocomplete value form so no name-search round trip is needed.
    return PACKS
      .map(p => (p.source === "mr" ? (p.mrSlug && `mr:${p.mrSlug}`) : (p.cfId && `cf:${p.cfId}`)))
      .filter(Boolean);
  } catch (err) {
    console.error(`--corpus: ${err.message}`);
    return [];
  }
}

async function main() {
  const opts = parseArgs(process.argv);

  let packs;
  if (opts.corpus) {
    packs = loadCorpus();
    if (!packs.length) {
      console.error("--corpus: could not load a pack list from scripts/eval_pack_corpus.js");
      process.exit(1);
    }
    if (opts.limit > 0) packs = packs.slice(0, opts.limit);
  } else if (opts.pack) {
    packs = [ opts.pack ];
  } else {
    console.error("Usage: node scripts/modpack_preflight.js --pack=\"<name|cf:id|mr:slug>\" [--version=latest|<id>] [--json]");
    console.error("       node scripts/modpack_preflight.js --corpus [--limit=N] [--json]");
    process.exit(1);
  }

  const reports = [];
  for (const pack of packs) {
    let report;
    try {
      report = await preflightPack(pack, opts.version);
    } catch (err) {
      report = { pack, ok: false, error: `${err.message}`, stack: err.stack };
    }
    reports.push(report);
    if (!opts.json) printReport(report);
  }

  const payload = { generatedAt: new Date().toISOString(), reports };
  if (opts.out) {
    // Prefer --out over `--json > file`: panel/provider logging and other
    // modules' dotenv banners also write to stdout, so a redirect is not
    // guaranteed to yield parseable JSON.
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    fs.writeFileSync(opts.out, JSON.stringify(payload, null, 2), "utf8");
    console.log(`\nWrote ${reports.length} report(s) to ${opts.out}`);
  }
  if (opts.json && !opts.out) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (!opts.json && reports.length > 1) {
    const ok = reports.filter(r => r.ok).length;
    const nested = reports.filter(r => r.nestedArchiveRoot).length;
    console.log(`\n${"═".repeat(72)}`);
    console.log(`${ok}/${reports.length} packs preflighted clean · ${nested} with a nested archive root`);
    for (const r of reports.filter(x => !x.ok)) console.log(`  ✗ ${r.name ?? r.pack}: ${r.error}`);
  }

  process.exit(reports.every(r => r.ok) ? 0 : 1);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { preflightPack, classifyArchive, pickFile, resolvePackRef };
