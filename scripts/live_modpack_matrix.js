#!/usr/bin/env node
// Live install-modpack matrix: wipe + install + boot-verify a fixed smoke set of
// packs onto one panel server, writing notes as it goes.
//
// Usage:
//   $env:LIVE_CLIENT_API_KEY="…"
//   # If PANEL_URL 301-redirects (undici Client does not follow), override to the final host:
//   $env:PANEL_URL="https://srv.example.com/"
//   node scripts/live_modpack_matrix.js --server=f20fed63
//   node scripts/live_modpack_matrix.js --server=f20fed63 --only=simply-optimized,cobblemon
//   node scripts/live_modpack_matrix.js --server=f20fed63 --skip-boot
//   node scripts/live_modpack_matrix.js --server=f20fed63 --continue
//
"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const { initDatabase, getUserByDiscordId, createUser, updateUser, updateUserApiKey } = require("../utility/database.js");
const { applicationApiCall, clientApiCall } = require("../utility/helper_functions.js");
const { getClientServers, setServerPowerState } = require("../utility/server_functions.js");
const { detectProvider, lookupModpack, listModpackFiles } = require("../utility/modpack_providers.js");
const { runInstallation } = require("../commands/ptero/install_modpack.js");
const { PERMISSIONS } = require("../utility/permissions.js");
const config = require("../config.json");
const msgLog = require("../utility/logger.js");

const NOTES_PATH = path.join(__dirname, "../docs/live-modpack-matrix-NOTES.md");
const RESULTS_PATH = path.join(__dirname, "../docs/live-modpack-matrix-results.json");
const SETTLE_MS = 10_000;

// 50-pack live matrix:
//   1–25  = offline eval_pack_corpus set
//   26    = Arcadia [RPG] (recent quarantine regression)
//   27–50 = additional popular Forge/Fabric/NeoForge packs
// Prefer smaller / faster packs earlier when practical; heavies still mixed in.
const PACKS = [
  // ── Corpus (25) ──────────────────────────────────────────────────────────
  { key: "simply-optimized", name: "Simply Optimized", input: "https://modrinth.com/modpack/sop" },
  { key: "cobblemon", name: "Cobblemon Official", input: "https://modrinth.com/modpack/cobblemon-fabric" },
  { key: "better-mc-fabric", name: "Better Minecraft [Fabric]", input: "https://modrinth.com/modpack/better-mc-fabric-bmc2" },
  { key: "ftb-academy", name: "FTB Academy", input: "336409" },
  { key: "create-aab", name: "Create: Above and Beyond", input: "542763" },
  { key: "prominence-ii", name: "Prominence II RPG", input: "466901" },
  { key: "medieval-mc", name: "Medieval Minecraft", input: "876851" },
  { key: "create-astral", name: "Create: Astral", input: "681792" },
  { key: "valhelsia-6", name: "Valhelsia 6", input: "878495" },
  { key: "ftb-skies", name: "FTB Skies", input: "1091252" },
  { key: "enigmatica-9", name: "Enigmatica 9", input: "632239" },
  { key: "stoneblock-3", name: "Stoneblock 3", input: "1091305" },
  { key: "craft-to-exile-2", name: "Craft to Exile 2", input: "936875" },
  { key: "integrated-mc", name: "Integrated Minecraft", input: "663737" },
  { key: "nomi-ceu", name: "Nomifactory CEu", input: "594351" },
  { key: "mc-eternal", name: "MC Eternal", input: "349129" },
  { key: "vault-hunters-3", name: "Vault Hunters 3rd Edition", input: "711537" },
  { key: "divine-journey-2", name: "Divine Journey 2", input: "370666" },
  { key: "sevtech", name: "SevTech: Ages", input: "268208" },
  { key: "pixelmon", name: "Pixelmon Reforged", input: "389615" },
  { key: "dawncraft", name: "DawnCraft", input: "829758" },
  { key: "ftb-infinity", name: "Feed The Beast Infinity Evolved", input: "227724" },
  { key: "atm9", name: "All the Mods 9 (ATM9)", input: "715572" },
  { key: "rlcraft", name: "RLCraft", input: "285109" },
  { key: "atm6", name: "All the Mods 6 (ATM6)", input: "381671" },
  // GTNH (252507) removed: CF mirror is incomplete; matrix uses client packs + strip.

  // ── Arcadia + extras (25) ────────────────────────────────────────────────
  { key: "arcadia-rpg", name: "Arcadia [RPG]", input: "https://www.curseforge.com/minecraft/modpacks/arcadia-rpg" },
  { key: "fabulously-optimized", name: "Fabulously Optimized", input: "https://www.curseforge.com/minecraft/modpacks/fabulously-optimized" },
  { key: "all-of-fabric-7", name: "All of Fabric 7", input: "899572" },
  { key: "cottage-witch", name: "Cottage Witch", input: "689550" },
  { key: "better-mc-forge", name: "Better MC [FORGE] BMC4", input: "876781" },
  { key: "better-mc-neoforge", name: "Better MC [NEOFORGE] BMC5", input: "462042" },
  { key: "create-perfect-world", name: "Create: Perfect World", input: "919384" },
  { key: "avalon-reborn", name: "Avalon Reborn", input: "1186808" },
  { key: "ftb-oceanblock", name: "FTB OceanBlock", input: "1091200" },
  { key: "ftb-oceanblock-2", name: "FTB OceanBlock 2", input: "1198207" },
  { key: "minecolonies-dim", name: "MineColonies: Dimensional Adventure", input: "852146" },
  { key: "winter-rescue", name: "The Winter Rescue", input: "535790" },
  { key: "forever-stranded", name: "Forever Stranded", input: "253026" },
  { key: "hexxit-updated", name: "Hexxit Updated", input: "274563" },
  { key: "skyfactory-4", name: "SkyFactory 4", input: "296062" },
  { key: "skyfactory-5", name: "SkyFactory 5", input: "392141" },
  { key: "atm7", name: "All the Mods 7 (ATM7)", input: "426926" },
  { key: "atm8", name: "All the Mods 8 (ATM8)", input: "520914" },
  { key: "atm10", name: "All the Mods 10 (ATM10)", input: "925200" },
  { key: "enigmatica2e", name: "Enigmatica 2: Expert", input: "282744" },
  { key: "rad", name: "Roguelike Adventures and Dungeons", input: "289267" },
  { key: "rad2", name: "Roguelike Adventures and Dungeons 2", input: "572778" },
  { key: "meatballcraft", name: "MeatballCraft", input: "411966" },
  { key: "po3", name: "Project Ozone 3", input: "256289" },
  { key: "decursio", name: "The Decursio Project", input: "457186" }
];

function parseArgs(argv) {
  const out = { server: null, only: null, skipBoot: false, continueRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--server=")) out.server = a.slice("--server=".length);
    else if (a === "--server") out.server = argv[++i];
    else if (a.startsWith("--only=")) out.only = new Set(a.slice("--only=".length).split(",").map(s => s.trim()).filter(Boolean));
    else if (a === "--only") out.only = new Set(argv[++i].split(",").map(s => s.trim()).filter(Boolean));
    else if (a === "--skip-boot") out.skipBoot = true;
    else if (a === "--continue") out.continueRun = true;
  }
  return out;
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
  return !!(row?.install?.ok && (row.boot?.success || row.boot === "skipped" || row.boot === null));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function makeStubInteraction(userId, username) {
  const user = { id: String(userId), username: username || "live-matrix" };
  const noop = async () => {};
  return {
    user,
    editReply: noop,
    deferUpdate: noop,
    update: noop,
    replied: true,
    deferred: true
  };
}

async function ensureDbUser(discordId, clientApiKey) {
  initDatabase();

  // Resolve panel account via the client key.
  const accountRes = await clientApiCall("client/account", "GET", null, discordId, clientApiKey);
  if (accountRes.statusCode !== 200) {
    throw new Error(`client/account failed: HTTP ${accountRes.statusCode}`);
  }
  const account = await accountRes.body.json();
  const panelId = account.attributes?.id;
  const panelUsername = account.attributes?.username;
  if (!panelId || !panelUsername) {
    throw new Error("client/account missing id/username");
  }

  const perms = PERMISSIONS.ADMINISTRATOR | PERMISSIONS.EDIT_SERVER_PROPERTIES | PERMISSIONS.READ_SERVERS;
  const existing = getUserByDiscordId(discordId);
  if (!existing) {
    createUser(discordId, panelUsername, panelId, -1, perms, clientApiKey);
    msgLog.log(`[live-matrix] created DB user ${discordId} → panel ${panelUsername} (#${panelId})`);
  } else {
    updateUser(discordId, "panel_username", panelUsername);
    updateUser(discordId, "panel_id", panelId);
    updateUser(discordId, "permissions", perms);
    updateUserApiKey(discordId, clientApiKey);
    msgLog.log(`[live-matrix] updated DB user ${discordId} → panel ${panelUsername} (#${panelId})`);
  }

  // Confirm the admin application API can see this user (optional soft check).
  try {
    const userApi = await applicationApiCall(`application/users/${panelId}`, "GET");
    if (userApi.statusCode !== 200) {
      msgLog.warn(`[live-matrix] application/users/${panelId} → HTTP ${userApi.statusCode}`);
    }
  } catch (e) {
    msgLog.warn(`[live-matrix] application user check failed: ${e.message}`);
  }

  return { panelId, panelUsername };
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

function pickFile(fileOptions) {
  // Providers list server packs ahead of linked client packs when available.
  return fileOptions?.[0] || null;
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function unavailableSummary(mods) {
  return (mods || []).slice(0, 10).map(f => f.displayName ?? f.fileName ?? `Mod ${f.modId}`);
}

function quarantineSummary(bootResult) {
  return (bootResult?.quarantined || []).map(q => ({ jar: q.jar, reason: q.reason }));
}

function consoleTailSnippet(bootResult, lines = 30) {
  if (!bootResult?.consoleTail) return null;
  return bootResult.consoleTail.split("\n").slice(-lines).join("\n");
}

function writeNotes(results, meta) {
  const lines = [];
  lines.push("# Live install-modpack matrix notes");
  lines.push("");
  lines.push(`- **Started:** ${meta.startedAt}`);
  lines.push(`- **Finished:** ${meta.finishedAt || "(in progress)"}`);
  lines.push(`- **Server:** \`${meta.serverId}\` (${meta.serverName})`);
  lines.push(`- **Boot verify:** ${meta.bootVerify ? "enabled" : "skipped"}`);
  lines.push("");

  const okInstall = results.filter(r => r.install?.ok);
  const okBoot = results.filter(r => r.boot?.success);
  const failInstall = results.filter(r => r.install && !r.install.ok);
  const failBoot = results.filter(r => r.install?.ok && r.boot && !r.boot.success);
  const pending = results.filter(r => !r.install);

  lines.push("## Summary");
  lines.push("");
  lines.push("| Pack | Install | Boot | Duration |");
  lines.push("|------|---------|------|----------|");
  for (const r of results) {
    const install = !r.install ? "—" : (r.install.ok ? "ok" : `FAIL (${r.install.stage})`);
    let boot = "—";
    if (r.boot === "skipped") boot = "skipped";
    else if (r.boot) boot = r.boot.success ? "ok" : `FAIL (${r.boot.reason})`;
    else if (r.install?.ok) boot = "n/a";
    lines.push(`| ${r.key} | ${install} | ${boot} | ${r.duration || "—"} |`);
  }
  lines.push("");
  lines.push(
    `Totals: ${okInstall.length} install ok / ${failInstall.length} install fail / ` +
    `${okBoot.length} boot ok / ${failBoot.length} boot fail` +
    (pending.length ? ` / ${pending.length} pending` : "") + "."
  );
  lines.push("");
  lines.push("> **Security:** rotate the client API key used for this run — it was pasted into chat.");
  lines.push("");

  for (const r of results) {
    lines.push(`## ${r.name} (\`${r.key}\`)`);
    lines.push("");
    lines.push(`- **Source:** ${r.source || "?"}`);
    lines.push(`- **File:** ${r.fileName || "?"} (\`${r.fileId || "?"}\`)`);
    lines.push(`- **Loader / MC:** ${r.loaderType || "?"} / ${r.mcVersion || "?"}`);
    lines.push(`- **Server pack:** ${r.isServerPack ? "yes" : "no"}`);
    lines.push(`- **Duration:** ${r.duration || "—"}`);
    if (!r.install) {
      lines.push("- **Install:** pending / not run");
      lines.push("");
      continue;
    }
    if (!r.install.ok) {
      lines.push(`- **Install:** FAILED at \`${r.install.stage}\` — ${r.install.error || "?"}`);
      if (r.error) lines.push(`- **Exception:** ${r.error}`);
      lines.push("");
      continue;
    }
    lines.push("- **Install:** ok");
    if (r.usedManifest) {
      lines.push(`- **Mods placed (manifest):** ${r.manifestInstalled}/${r.manifestTotal}`);
    } else {
      lines.push("- **Install path:** server-pack / archive extract (not a per-mod manifest plan)");
      if (typeof r.modsOnDisk === "number") lines.push(`- **\`.jar\` files in \`mods/\` after install:** ${r.modsOnDisk}`);
    }
    if (r.unavailable?.length) {
      lines.push(`- **Unavailable mods (${r.unavailable.length}):**`);
      for (const n of r.unavailable) lines.push(`  - ${n}`);
    }
    if (r.crashRiskWarnings?.length) {
      lines.push(`- **Crash-risk warnings:** ${r.crashRiskWarnings.length}`);
      for (const w of r.crashRiskWarnings.slice(0, 10)) lines.push(`  - \`${w}\``);
    }
    if (r.boot === "skipped") {
      lines.push("- **Boot-verify:** skipped");
    } else if (r.boot) {
      lines.push(
        `- **Boot-verify:** ${r.boot.success ? "success" : `failed (${r.boot.reason})`} ` +
        `after ${r.boot.attempts} attempt(s)`
      );
      if (r.quarantined?.length) {
        lines.push(`- **Quarantined (${r.quarantined.length}):**`);
        for (const q of r.quarantined) lines.push(`  - \`${q.jar}\` — ${q.reason}`);
      }
      if (r.consoleTail) {
        lines.push("");
        lines.push("```");
        lines.push(r.consoleTail);
        lines.push("```");
      }
    } else {
      lines.push("- **Boot-verify:** not run / no result");
    }
    lines.push("");
  }

  fs.mkdirSync(path.dirname(NOTES_PATH), { recursive: true });
  fs.writeFileSync(NOTES_PATH, lines.join("\n"), "utf8");
  fs.writeFileSync(RESULTS_PATH, JSON.stringify({ meta, results }, null, 2), "utf8");
}

async function runPack(pack, ctx) {
  const started = Date.now();
  const row = {
    key: pack.key,
    name: pack.name,
    input: pack.input
  };

  msgLog.log(`[live-matrix] ========== ${pack.key} ==========`);
  console.log(`\n>>> Starting ${pack.key} (${pack.name})\n`);

  try {
    const source = detectProvider(pack.input);
    if (!source) throw new Error(`Unrecognized URL/id: ${pack.input}`);
    row.source = source;

    const modpack = await lookupModpack(source, pack.input);
    if (!modpack) throw new Error("Modpack not found");
    row.name = modpack.name || pack.name;

    const fileOptions = await listModpackFiles(source, modpack);
    const chosen = pickFile(fileOptions);
    if (!chosen?.downloadUrl) throw new Error("No downloadable file options");

    row.fileId = chosen.id;
    row.fileName = chosen.label;
    row.isServerPack = !!chosen.isServerPack;
    row.mcVersion = chosen.mcVersion;
    row.loaderType = chosen.loaderType ?? modpack.loaderType;

    if (!config.modpack_eggs?.[row.loaderType]) {
      throw new Error(`No egg configured for loader ${row.loaderType}`);
    }

    // Refresh server metadata each pack in case of drift.
    const server = await resolveServer(ctx.discordId, ctx.serverId);
    ctx.serverName = server.serverName;
    ctx.serverInternalId = server.serverInternalId;

    const stub = makeStubInteraction(ctx.discordId, "live-matrix");
    const state = {
      source,
      serverId: ctx.serverId,
      serverInternalId: ctx.serverInternalId,
      serverName: ctx.serverName,
      modpackName: row.name,
      modpackId: modpack.id,
      targetFile: {
        id: chosen.id,
        displayName: chosen.label,
        downloadUrl: chosen.downloadUrl
      },
      loaderType: row.loaderType,
      usingClientPack: !chosen.isServerPack,
      mcVersion: chosen.mcVersion
    };

    const result = await runInstallation(stub, state, stub);
    row.duration = formatDuration(Date.now() - started);

    if (!result || !result.ok) {
      row.install = {
        ok: false,
        stage: result?.stage || "unknown",
        error: result?.error || "no result"
      };
      return row;
    }

    row.install = { ok: true };
    row.manifestInstalled = result.manifestInstalled;
    row.manifestTotal = result.manifestTotal;
    row.unavailable = unavailableSummary(result.unavailableMods);
    row.unavailableCount = result.unavailableMods?.length || 0;
    row.crashRiskWarnings = (result.crashRiskWarnings || []).map(w => w.filename || w);
    row.usedManifest = result.usedManifest;

    // Zip/server-pack installs don't go through installFilePlan, so
    // manifestInstalled/total stay 0 — count jars on disk instead.
    if (!result.usedManifest) {
      try {
        const { listServerFiles } = require("../utility/server_functions.js");
        const mods = await listServerFiles(ctx.serverId, ctx.discordId, "/mods");
        row.modsOnDisk = (mods || []).filter(f =>
          f.attributes?.is_file && /\.jar$/i.test(f.attributes.name || "")
        ).length;
      } catch {
        row.modsOnDisk = null;
      }
    }

    if (ctx.skipBoot || !config.boot_verify?.enabled) {
      row.boot = "skipped";
    } else if (result.bootResult) {
      row.boot = {
        success: !!result.bootResult.success,
        reason: result.bootResult.reason || null,
        attempts: result.bootResult.attempts
      };
      row.quarantined = quarantineSummary(result.bootResult);
      if (!result.bootResult.success) {
        row.consoleTail = consoleTailSnippet(result.bootResult);
      }
    } else {
      row.boot = null;
    }

    return row;
  } catch (err) {
    row.duration = formatDuration(Date.now() - started);
    row.install = { ok: false, stage: "exception", error: err.message };
    row.error = err.stack || err.message;
    msgLog.error(`[live-matrix] ${pack.key} failed: ${err.message}`);
    return row;
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  let clientApiKey = process.env.LIVE_CLIENT_API_KEY;
  const discordId = process.env.ADMIN_DISCORD_ID;

  if (!opts.server) {
    console.error("Usage: node scripts/live_modpack_matrix.js --server=<id> [--only=a,b] [--skip-boot] [--continue]");
    process.exit(1);
  }
  if (!discordId) {
    console.error("ADMIN_DISCORD_ID missing from .env");
    process.exit(1);
  }
  if (!process.env.ENCRYPTION_KEY) {
    console.error("ENCRYPTION_KEY missing from .env");
    process.exit(1);
  }
  if (!clientApiKey) {
    initDatabase();
    const existing = getUserByDiscordId(discordId);
    if (existing?.panelAPIKey) {
      clientApiKey = existing.panelAPIKey;
      msgLog.log("[live-matrix] using client API key from local DB (LIVE_CLIENT_API_KEY unset)");
    } else {
      console.error("Set LIVE_CLIENT_API_KEY in the environment (or store a client key via /set-client-key).");
      process.exit(1);
    }
  }

  if (opts.skipBoot) {
    if (!config.boot_verify) config.boot_verify = {};
    config.boot_verify.enabled = false;
    msgLog.log("[live-matrix] --skip-boot: boot_verify disabled for this run");
  } else if (!config.boot_verify?.enabled) {
    console.error("boot_verify is not enabled in config.json (or pass --skip-boot)");
    process.exit(1);
  }

  await ensureDbUser(discordId, clientApiKey);
  const server = await resolveServer(discordId, opts.server);

  const selected = PACKS.filter(p => !opts.only || opts.only.has(p.key));
  if (selected.length === 0) {
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
    packCount: selected.length,
    continueRun: !!opts.continueRun,
    onlyKeys: opts.only ? [ ...opts.only ] : null
  };

  // --only rechecks should refresh those keys but keep the rest of a prior
  // full-matrix results file intact.
  const selectedKeys = new Set(selected.map(p => p.key));
  const results = [];
  if (opts.only) {
    for (const p of PACKS) {
      if (selectedKeys.has(p.key)) {
        results.push(
          opts.continueRun && isPackDone(priorByKey.get(p.key))
            ? priorByKey.get(p.key)
            : { key: p.key, name: p.name, input: p.input }
        );
      } else if (priorByKey.has(p.key)) {
        results.push(priorByKey.get(p.key));
      }
    }
  } else {
    for (const p of selected) {
      results.push(
        opts.continueRun && isPackDone(priorByKey.get(p.key))
          ? priorByKey.get(p.key)
          : { key: p.key, name: p.name, input: p.input }
      );
    }
  }
  writeNotes(results, meta);

  const ctx = {
    discordId,
    serverId: server.serverId,
    serverInternalId: server.serverInternalId,
    serverName: server.serverName,
    skipBoot: opts.skipBoot
  };

  const runIndexes = results
    .map((r, idx) => ({ r, idx, pack: PACKS.find(p => p.key === r.key) }))
    .filter(({ r, pack }) => pack && selectedKeys.has(pack.key) && !isPackDone(r));

  console.log(`Live matrix: ${selected.length} pack(s) → ${server.serverName} (${server.serverId})`);
  if (opts.only) console.log(`--only recheck: ${selected.length} keyed, ${results.length} total rows kept`);
  if (opts.continueRun) console.log(`Resume: ${selected.length - runIndexes.length} already done, ${runIndexes.length} remaining`);
  console.log(`Notes: ${NOTES_PATH}`);

  for (let n = 0; n < runIndexes.length; n++) {
    const { idx, pack } = runIndexes[n];
    const row = await runPack(pack, ctx);
    results[idx] = row;
    writeNotes(results, meta);

    // Stop leftover process between packs so the next wipe starts clean.
    try {
      await setServerPowerState(ctx.serverId, ctx.discordId, "kill").catch(() =>
        setServerPowerState(ctx.serverId, ctx.discordId, "stop")
      );
    } catch {
      // ignore
    }
    if (n < runIndexes.length - 1) {
      console.log(`Settling ${SETTLE_MS / 1000}s before next pack...`);
      await sleep(SETTLE_MS);
    }
  }

  meta.finishedAt = new Date().toISOString();
  meta.packCount = results.length;
  writeNotes(results, meta);
  console.log(`\nDone. Notes written to ${NOTES_PATH}`);
  console.log("Remember to rotate the client API key used for this run.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
