#!/usr/bin/env node
// Tier 2 verification — live panel, one server, real installs.
//
// Drives installs through runModpackJob + CollectingReporter, which is the
// reporter seam's whole justification: no Discord types, no stub interaction,
// and every progress event is captured as structured data instead of being
// rendered into a message nobody reads.
//
// The default set is six packs, one per axis, so a full run covers every
// distinct code path rather than six variations of the same one:
//   CF server pack (Forge), CF server pack (NeoForge), CF manifest-only (Fabric),
//   Modrinth .mrpack, legacy 1.12 Forge, and ServerStarter-wrapped.
// At least one is a nested-root server pack — that layout is what the Wings
// pull fast path silently mishandled, so it stays permanently in the set.
//
// Asserts install OK *and* boot OK, and records wall-clock per stage so the
// "about 15 minutes" claim is measured rather than assumed.
//
// Usage:
//   export LIVE_CLIENT_API_KEY="…"     # or store one via /set-client-key
//   node scripts/modpack_smoke.js --server=f20fed63
//   node scripts/modpack_smoke.js --server=f20fed63 --only=atm10,sop
//   node scripts/modpack_smoke.js --server=f20fed63 --skip-boot
//   node scripts/modpack_smoke.js --server=f20fed63 --continue
//   node scripts/modpack_smoke.js --list
//
// Rotate the client API key after a run.
"use strict";

require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");

const { initDatabase, getUserByDiscordId, createUser, updateUser, updateUserApiKey } = require("../utility/database.js");
const { clientApiCall } = require("../utility/helper_functions.js");
const { getClientServers, setServerPowerState, listServerFiles } = require("../utility/server_functions.js");
const { detectProvider, lookupModpack, listModpackFiles } = require("../utility/modpack_providers.js");
const { runModpackJob } = require("../utility/modpack/job.js");
const { CollectingReporter } = require("../utility/modpack/reporters.js");
const { PERMISSIONS } = require("../utility/permissions.js");
const config = require("../config.json");
const msgLog = require("../utility/logger.js");

const NOTES_PATH = path.join(__dirname, "../docs/modpack-smoke-NOTES.md");
const RESULTS_PATH = path.join(__dirname, "../docs/modpack-smoke-results.json");
// Let the previous install's process fully release before the next wipe.
const SETTLE_MS = 10_000;

// One pack per axis. Keep this set small and orthogonal — the point is coverage
// of distinct code paths, not breadth of packs (scripts/modpack_preflight.js
// --corpus sweeps breadth offline, in seconds, without a panel).
// `expect` keys are the ones checkExpectations() actually enforces:
// serverPack | manifest | loader | mcVersion. Axis intent that cannot be
// asserted before downloading (nested root, ServerStarter wrapper) belongs in
// `axis` and is confirmed with `scripts/modpack_preflight.js`, not asserted here.
const PACKS = [
  {
    key: "atm9",
    name: "All the Mods 9 (ATM9)",
    input: "715572",
    // Tier 1 confirmed this pack's server zip wraps everything in
    // "Server-Files-1.1.1/" — 418 mod jars, none of them at /mods. Before the
    // nested-root fix it met every condition for the Wings pull fast path, so
    // it installed 0 mods and reported success. It is the regression case.
    axis: "CF server pack · Forge · NESTED ARCHIVE ROOT",
    expect: { serverPack: true, loader: "forge" }
  },
  {
    key: "atm10",
    name: "All the Mods 10 (ATM10)",
    input: "925200",
    axis: "CF server pack · NeoForge",
    expect: { serverPack: true, loader: "neoforge" }
  },
  {
    key: "ftb-academy",
    name: "FTB Academy",
    input: "336409",
    axis: "CF · legacy 1.12 Forge (Java 8 image)",
    expect: { loader: "forge", mcVersion: "1.12.2" }
  },
  {
    key: "enigmatica-9",
    name: "Enigmatica 9",
    input: "632239",
    // Tier 1: a *server pack* that still ships manifest.json, so it takes the
    // manifest branch rather than the archive branch — a combination neither of
    // the two obvious axes covers.
    axis: "CF server pack that resolves as a manifest plan",
    expect: { serverPack: true, manifest: true }
  },
  {
    key: "fabulously-optimized",
    name: "Fabulously Optimized",
    input: "https://www.curseforge.com/minecraft/modpacks/fabulously-optimized",
    axis: "CF manifest-only · Fabric",
    expect: { manifest: true, loader: "fabric" }
  },
  {
    key: "sop",
    name: "Simply Optimized",
    input: "https://modrinth.com/modpack/sop",
    axis: "Modrinth .mrpack",
    expect: { manifest: true, loader: "fabric" }
  }
];

function parseArgs(argv) {
  const out = { server: null, only: null, skipBoot: false, continueRun: false, list: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--server=")) out.server = a.slice("--server=".length);
    else if (a === "--server") out.server = argv[++i];
    else if (a.startsWith("--only=")) out.only = new Set(a.slice("--only=".length).split(",").map(s => s.trim()).filter(Boolean));
    else if (a === "--only") out.only = new Set(argv[++i].split(",").map(s => s.trim()).filter(Boolean));
    else if (a === "--skip-boot") out.skipBoot = true;
    else if (a === "--continue") out.continueRun = true;
    else if (a === "--list") out.list = true;
  }
  return out;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function loadPriorResults() {
  try {
    const parsed = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf8"));
    return Array.isArray(parsed.results) ? parsed.results : [];
  } catch {
    return [];
  }
}

function isPackDone(row) {
  return !!(row?.install?.ok && (row.boot?.success || row.boot === "skipped"));
}

/**
 * Collapse a CollectingReporter's event log into per-stage wall clock. This is
 * the measurement the plan's "about 15 minutes" claim needs — it comes free
 * from the reporter seam, which the old stub-interaction harness threw away.
 */
function stageTimings(reporter, startedAt) {
  const stages = [];
  let prev = { stage: null, at: startedAt };
  for (const ev of reporter.events) {
    if (!ev.stage || ev.stage === prev.stage) continue;
    if (prev.stage) stages.push({ stage: prev.stage, ms: ev.at - prev.at });
    prev = { stage: ev.stage, at: ev.at };
  }
  if (prev.stage) stages.push({ stage: prev.stage, ms: Date.now() - prev.at });
  // A stage can be re-entered (progress → boot-verify → progress); fold them.
  const folded = new Map();
  for (const s of stages) folded.set(s.stage, (folded.get(s.stage) || 0) + s.ms);
  return [ ...folded ].map(([ stage, ms ]) => ({ stage, ms, human: formatDuration(ms) }));
}

async function ensureDbUser(discordId, clientApiKey) {
  initDatabase();

  const accountRes = await clientApiCall("client/account", "GET", null, discordId, clientApiKey);
  if (accountRes.statusCode !== 200) {
    throw new Error(`client/account failed: HTTP ${accountRes.statusCode}`);
  }
  const account = await accountRes.body.json();
  const panelId = account.attributes?.id;
  const panelUsername = account.attributes?.username;
  if (!panelId || !panelUsername) throw new Error("client/account missing id/username");

  const perms = PERMISSIONS.ADMINISTRATOR | PERMISSIONS.EDIT_SERVER_PROPERTIES | PERMISSIONS.READ_SERVERS;
  if (!getUserByDiscordId(discordId)) {
    createUser(discordId, panelUsername, panelId, -1, perms, clientApiKey);
    msgLog.log(`[smoke] created DB user ${discordId} → panel ${panelUsername} (#${panelId})`);
  } else {
    updateUser(discordId, "panel_username", panelUsername);
    updateUser(discordId, "panel_id", panelId);
    updateUser(discordId, "permissions", perms);
    updateUserApiKey(discordId, clientApiKey);
    msgLog.log(`[smoke] updated DB user ${discordId} → panel ${panelUsername} (#${panelId})`);
  }
}

async function resolveServer(discordId, serverId) {
  const servers = await getClientServers(discordId);
  const list = servers?.data || [];
  const server = list.find(s => s.attributes.identifier === serverId);
  if (!server) {
    const ids = list.map(s => s.attributes.identifier).join(", ") || "(none)";
    throw new Error(`Server ${serverId} not found for this client key. Visible: ${ids}`);
  }
  return {
    serverId,
    serverInternalId: server.attributes.internal_id,
    serverName: server.attributes.name
  };
}

/** Post-install assertions beyond "the job returned ok". */
function checkExpectations(pack, row) {
  const failures = [];
  const e = pack.expect || {};
  if (e.serverPack && !row.isServerPack) failures.push("expected a server pack, got a client pack");
  if (e.manifest && !row.usedManifest) failures.push("expected a manifest install, got an archive install");
  if (e.loader && row.loaderType !== e.loader) failures.push(`expected loader ${e.loader}, got ${row.loaderType}`);
  if (e.mcVersion && row.mcVersion !== e.mcVersion) failures.push(`expected MC ${e.mcVersion}, got ${row.mcVersion}`);
  // A successful install that placed no mods is the failure mode Phase 1.1
  // fixed — it used to report success with an empty /mods.
  if (row.install?.ok && row.modsOnDisk === 0) failures.push("install reported ok but /mods is empty");
  return failures;
}

async function runPack(pack, ctx) {
  const started = Date.now();
  const row = { key: pack.key, name: pack.name, input: pack.input, axis: pack.axis };
  msgLog.log(`[smoke] ========== ${pack.key} ==========`);
  console.log(`\n>>> ${pack.key} — ${pack.axis}\n`);

  try {
    const source = detectProvider(pack.input);
    if (!source) throw new Error(`Unrecognized URL/id: ${pack.input}`);
    row.source = source;

    const modpack = await lookupModpack(source, pack.input);
    if (!modpack) throw new Error("Modpack not found");
    row.name = modpack.name || pack.name;

    const fileOptions = await listModpackFiles(source, modpack);
    const chosen = fileOptions?.[0];
    if (!chosen?.downloadUrl) throw new Error("No downloadable file options");

    row.fileId = chosen.id;
    row.fileName = chosen.label;
    row.isServerPack = !!chosen.isServerPack;
    row.mcVersion = chosen.mcVersion;
    row.loaderType = chosen.loaderType ?? modpack.loaderType;
    if (!config.modpack_eggs?.[row.loaderType]) {
      throw new Error(`No egg configured for loader ${row.loaderType}`);
    }

    // Refresh server metadata each pack in case of panel-side drift.
    const server = await resolveServer(ctx.discordId, ctx.serverId);
    ctx.serverName = server.serverName;
    ctx.serverInternalId = server.serverInternalId;

    const reporter = new CollectingReporter();
    const result = await runModpackJob({
      source,
      serverId: ctx.serverId,
      serverInternalId: ctx.serverInternalId,
      serverName: ctx.serverName,
      modpackName: row.name,
      modpackId: modpack.id,
      targetFile: { id: chosen.id, displayName: chosen.label, downloadUrl: chosen.downloadUrl },
      loaderType: row.loaderType,
      usingClientPack: !chosen.isServerPack,
      mcVersion: chosen.mcVersion,
      userId: ctx.discordId,
      username: "modpack-smoke"
    }, reporter);

    row.duration = formatDuration(Date.now() - started);
    row.durationMs = Date.now() - started;
    row.stages = stageTimings(reporter, started);
    row.progressEvents = reporter.events.length;

    if (!result?.ok) {
      row.install = { ok: false, stage: result?.stage || "unknown", error: result?.error || "no result" };
      row.expectationFailures = checkExpectations(pack, row);
      return row;
    }

    row.install = { ok: true };
    row.usedManifest = result.usedManifest;
    row.manifestInstalled = result.manifestInstalled;
    row.manifestTotal = result.manifestTotal;
    row.unavailableCount = result.unavailableMods?.length || 0;
    row.unavailable = (result.unavailableMods || []).slice(0, 10)
      .map(f => f.displayName ?? f.fileName ?? `Mod ${f.modId}`);
    row.crashRiskWarnings = (result.crashRiskWarnings || []).map(w => w.filename || w);

    // Count jars on disk regardless of strategy — this is the assertion that
    // catches a "successful" install that placed nothing.
    try {
      const mods = await listServerFiles(ctx.serverId, ctx.discordId, "/mods");
      row.modsOnDisk = (mods || []).filter(f =>
        f.attributes?.is_file && /\.jar$/i.test(f.attributes.name || "")
      ).length;
    } catch {
      row.modsOnDisk = null;
    }

    if (ctx.skipBoot || !config.boot_verify?.enabled) {
      row.boot = "skipped";
    } else if (result.bootResult) {
      row.boot = {
        success: !!result.bootResult.success,
        reason: result.bootResult.reason || null,
        attempts: result.bootResult.attempts,
        diagnosis: result.bootResult.diagnosis || null
      };
      row.quarantined = (result.bootResult.quarantined || []).map(q => ({ jar: q.jar, reason: q.reason }));
      if (!result.bootResult.success && result.bootResult.consoleTail) {
        row.consoleTail = result.bootResult.consoleTail.split("\n").slice(-30).join("\n");
      }
    } else {
      row.boot = { success: false, reason: "boot-verify produced no result" };
    }

    row.expectationFailures = checkExpectations(pack, row);
    return row;
  } catch (err) {
    row.duration = formatDuration(Date.now() - started);
    row.install = { ok: false, stage: "exception", error: err.message };
    row.error = err.stack || err.message;
    msgLog.error(`[smoke] ${pack.key} failed: ${err.message}`);
    return row;
  }
}

function rowStatus(row) {
  if (!row.install) return "· pending";
  if (!row.install.ok) return `✗ install failed (${row.install.stage}: ${row.install.error})`;
  if (row.expectationFailures?.length) return `✗ ${row.expectationFailures.join("; ")}`;
  if (row.boot === "skipped") return "· installed (boot skipped)";
  if (row.boot?.success) return `✓ install + boot (${row.boot.attempts} attempt(s))`;
  return `✗ boot failed (${row.boot?.reason ?? "unknown"})`;
}

function writeNotes(results, meta) {
  const lines = [
    "# Modpack smoke (Tier 2) — live panel results",
    "",
    "Generated by `scripts/modpack_smoke.js`. Each pack covers one axis of the",
    "install matrix; a green run means every distinct code path installs and boots.",
    "",
    `- Started: ${meta.startedAt}`,
    `- Finished: ${meta.finishedAt ?? "(in progress)"}`,
    `- Server: ${meta.serverName} (\`${meta.serverId}\`)`,
    `- Boot verification: ${meta.bootVerify ? "enabled" : "disabled"}`,
    ""
  ];

  const done = results.filter(r => r.install);
  const passed = done.filter(r => r.install.ok && !r.expectationFailures?.length
    && (r.boot === "skipped" || r.boot?.success));
  lines.push(`**${passed.length}/${results.length} passing** (${done.length} attempted)`, "");

  lines.push("| Pack | Axis | Result | Mods | Duration |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const r of results) {
    const mods = typeof r.modsOnDisk === "number" ? `${r.modsOnDisk} on disk` : "—";
    lines.push(`| ${r.name} | ${r.axis ?? ""} | ${rowStatus(r)} | ${mods} | ${r.duration ?? "—"} |`);
  }
  lines.push("");

  // Per-stage wall clock, so the runtime claim is measured rather than assumed.
  const timed = results.filter(r => r.stages?.length);
  if (timed.length) {
    lines.push("## Stage wall clock", "");
    lines.push("| Pack | " + "Total | " + "Slowest stages |");
    lines.push("| --- | --- | --- |");
    for (const r of timed) {
      const top = [ ...r.stages ].sort((a, b) => b.ms - a.ms).slice(0, 4)
        .map(s => `${s.stage} ${s.human}`).join(", ");
      lines.push(`| ${r.name} | ${r.duration} | ${top} |`);
    }
    lines.push("");
    const totals = timed.map(r => r.durationMs).sort((a, b) => a - b);
    const median = totals[Math.floor(totals.length / 2)];
    lines.push(`Median end-to-end: **${formatDuration(median)}** · slowest: **${formatDuration(totals.at(-1))}**`, "");
  }

  for (const r of results) {
    if (!r.install) continue;
    lines.push(`## ${r.name}`, "");
    lines.push(`- Axis: ${r.axis ?? "—"}`);
    lines.push(`- Source: ${r.source ?? "—"} · file: ${r.fileName ?? "—"} (\`${r.fileId ?? "—"}\`)`);
    lines.push(`- Server pack: ${r.isServerPack ? "yes" : "no"} · manifest install: ${r.usedManifest ? "yes" : "no"}`);
    lines.push(`- Loader: ${r.loaderType ?? "—"} · MC: ${r.mcVersion ?? "—"}`);
    lines.push(`- Result: ${rowStatus(r)}`);
    if (typeof r.modsOnDisk === "number") lines.push(`- Mods on disk: ${r.modsOnDisk}`);
    if (r.unavailableCount) lines.push(`- Unavailable: ${r.unavailableCount} (${r.unavailable.join(", ")})`);
    if (r.crashRiskWarnings?.length) lines.push(`- Crash-risk warnings: ${r.crashRiskWarnings.join(", ")}`);
    if (r.quarantined?.length) {
      lines.push(`- Quarantined (${r.quarantined.length}):`);
      for (const q of r.quarantined) lines.push(`  - \`${q.jar}\` — ${q.reason}`);
    }
    if (r.expectationFailures?.length) {
      lines.push("- **Expectation failures:**");
      for (const f of r.expectationFailures) lines.push(`  - ${f}`);
    }
    if (r.consoleTail) lines.push("", "```", r.consoleTail, "```");
    if (r.error) lines.push("", "```", r.error, "```");
    lines.push("");
  }

  fs.mkdirSync(path.dirname(NOTES_PATH), { recursive: true });
  fs.writeFileSync(NOTES_PATH, lines.join("\n"), "utf8");
  fs.writeFileSync(RESULTS_PATH, JSON.stringify({ meta, results }, null, 2), "utf8");
}

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.list) {
    for (const p of PACKS) console.log(`${p.key.padEnd(22)} ${p.axis}`);
    return;
  }

  const discordId = process.env.ADMIN_DISCORD_ID;
  let clientApiKey = process.env.LIVE_CLIENT_API_KEY;

  if (!opts.server) {
    console.error("Usage: node scripts/modpack_smoke.js --server=<id> [--only=a,b] [--skip-boot] [--continue] [--list]");
    process.exit(1);
  }
  for (const [ label, value ] of [ [ "ADMIN_DISCORD_ID", discordId ], [ "ENCRYPTION_KEY", process.env.ENCRYPTION_KEY ] ]) {
    if (!value) {
      console.error(`${label} missing from .env`);
      process.exit(1);
    }
  }
  if (!clientApiKey) {
    initDatabase();
    const existing = getUserByDiscordId(discordId);
    if (existing?.panelAPIKey) {
      clientApiKey = existing.panelAPIKey;
      msgLog.log("[smoke] using client API key from local DB (LIVE_CLIENT_API_KEY unset)");
    } else {
      console.error("Set LIVE_CLIENT_API_KEY (or store a client key via /set-client-key).");
      process.exit(1);
    }
  }

  if (opts.skipBoot) {
    if (!config.boot_verify) config.boot_verify = {};
    config.boot_verify.enabled = false;
    msgLog.log("[smoke] --skip-boot: boot_verify disabled for this run");
  } else if (!config.boot_verify?.enabled) {
    console.error("boot_verify is not enabled in config.json (or pass --skip-boot)");
    process.exit(1);
  }

  await ensureDbUser(discordId, clientApiKey);
  const server = await resolveServer(discordId, opts.server);

  const selected = PACKS.filter(p => !opts.only || opts.only.has(p.key));
  if (!selected.length) {
    console.error("No packs selected. Known keys:", PACKS.map(p => p.key).join(", "));
    process.exit(1);
  }

  const priorByKey = new Map(loadPriorResults().map(r => [ r.key, r ]));
  const meta = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    serverId: server.serverId,
    serverName: server.serverName,
    bootVerify: !!config.boot_verify?.enabled,
    onlyKeys: opts.only ? [ ...opts.only ] : null
  };

  const results = selected.map(p =>
    opts.continueRun && isPackDone(priorByKey.get(p.key))
      ? priorByKey.get(p.key)
      : { key: p.key, name: p.name, input: p.input, axis: p.axis }
  );
  writeNotes(results, meta);

  const ctx = {
    discordId,
    serverId: server.serverId,
    serverInternalId: server.serverInternalId,
    serverName: server.serverName,
    skipBoot: opts.skipBoot
  };

  const todo = results
    .map((r, idx) => ({ idx, pack: selected.find(p => p.key === r.key) }))
    .filter(({ idx, pack }) => pack && !isPackDone(results[idx]));

  console.log(`Tier 2 smoke: ${todo.length} of ${selected.length} pack(s) → ${server.serverName} (${server.serverId})`);
  console.log(`Notes: ${NOTES_PATH}`);

  for (let n = 0; n < todo.length; n++) {
    const { idx, pack } = todo[n];
    results[idx] = await runPack(pack, ctx);
    writeNotes(results, meta);
    console.log(`    ${rowStatus(results[idx])}`);

    // Kill any leftover process so the next wipe starts from a stopped server.
    try {
      await setServerPowerState(ctx.serverId, ctx.discordId, "kill")
        .catch(() => setServerPowerState(ctx.serverId, ctx.discordId, "stop"));
    } catch { /* best effort */ }
    if (n < todo.length - 1) {
      console.log(`Settling ${SETTLE_MS / 1000}s before next pack...`);
      await sleep(SETTLE_MS);
    }
  }

  meta.finishedAt = new Date().toISOString();
  writeNotes(results, meta);

  const failed = results.filter(r =>
    !r.install?.ok || r.expectationFailures?.length || (r.boot !== "skipped" && !r.boot?.success));
  console.log(`\n${results.length - failed.length}/${results.length} passing. Notes: ${NOTES_PATH}`);
  for (const r of failed) console.log(`  ✗ ${r.name}: ${rowStatus(r)}`);
  console.log("Remember to rotate the client API key used for this run.");

  process.exit(failed.length === 0 ? 0 : 1);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.stack || err);
    process.exit(1);
  });
}

module.exports = { PACKS, stageTimings, checkExpectations, rowStatus };
