#!/usr/bin/env node
// Move jars back from mods-disabled/ into mods/.
//
// The install path parks "rescuable" skips under mods-disabled/ rather than
// deleting them, so a wrong client-only verdict is recoverable without
// reinstalling the pack. This is the tool for that recovery.
//
// Usage:
//   node scripts/restore_parked_mods.js --server=9cf843d1 --list
//   node scripts/restore_parked_mods.js --server=9cf843d1 --jar=cofh_core-1.20.1-11.0.2.56.jar
//   node scripts/restore_parked_mods.js --server=9cf843d1 --jar=a.jar --jar=b.jar --start
//   node scripts/restore_parked_mods.js --server=9cf843d1 --all --start
//
// --list   show what is parked (default when no --jar/--all given)
// --all    restore every parked jar (blunt; prefer naming jars)
// --start  start the server after restoring
"use strict";

require("dotenv").config({ quiet: true });

const { initDatabase } = require("../utility/database.js");
const {
  listServerFiles, renameServerFiles, setServerPowerState
} = require("../utility/server_functions.js");
const { isProtectedLearnedMod } = require("../utility/verdict_store.js");

const PARKED_DIR = "mods-disabled";

function parseArgs(argv) {
  const out = { server: null, jars: [], all: false, list: false, start: false };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--server=")) out.server = a.slice(9);
    else if (a.startsWith("--jar=")) out.jars.push(a.slice(6));
    else if (a === "--all") out.all = true;
    else if (a === "--list") out.list = true;
    else if (a === "--start") out.start = true;
  }
  return out;
}

async function parkedJars(serverId, userId) {
  const files = await listServerFiles(serverId, userId, `/${PARKED_DIR}`);
  return (files || [])
    .map(f => f.attributes?.name)
    .filter(n => n && /\.jar$/i.test(n))
    .sort();
}

async function main() {
  const opts = parseArgs(process.argv);
  const userId = process.env.ADMIN_DISCORD_ID;

  if (!opts.server || !userId) {
    console.error("Usage: node scripts/restore_parked_mods.js --server=<id> [--list] [--jar=<name>]... [--all] [--start]");
    console.error(opts.server ? "ADMIN_DISCORD_ID missing from .env" : "");
    process.exit(1);
  }

  initDatabase();
  const parked = await parkedJars(opts.server, userId);
  if (!parked.length) {
    console.log(`Nothing parked under /${PARKED_DIR} on ${opts.server}.`);
    return;
  }

  if (opts.list || (!opts.all && !opts.jars.length)) {
    console.log(`${parked.length} jar(s) parked under /${PARKED_DIR} on ${opts.server}:\n`);
    for (const [ i, n ] of parked.entries()) {
      // Flag anything the protected list says should never have been parked —
      // that combination means a classification bug, not a normal client skip.
      const flag = isProtectedLearnedMod({ filename: n }) ? "  ⚠ PROTECTED — should not have been parked" : "";
      console.log(`${String(i + 1).padStart(3)}. ${n}${flag}`);
    }
    console.log("\nRestore with --jar=<name> (repeatable), or --all.");
    return;
  }

  const wanted = opts.all ? parked : opts.jars;
  const missing = wanted.filter(j => !parked.includes(j));
  if (missing.length) {
    console.error(`Not parked on this server: ${missing.join(", ")}`);
    process.exit(1);
  }

  const status = await renameServerFiles(opts.server, userId, "/", wanted.map(n => ({
    from: `${PARKED_DIR}/${n}`,
    to: `mods/${n}`
  })));
  if (status < 200 || status >= 300) {
    console.error(`Restore failed: HTTP ${status}`);
    process.exit(1);
  }
  console.log(`Restored ${wanted.length} jar(s) to mods/:`);
  for (const n of wanted) console.log(`  + ${n}`);

  const after = await listServerFiles(opts.server, userId, "/mods");
  console.log(`mods/ now holds ${(after || []).filter(f => /\.jar$/i.test(f.attributes?.name || "")).length} jars.`);

  if (opts.start) {
    console.log("Starting server...");
    await setServerPowerState(opts.server, userId, "start");
    console.log("Start signal sent — watch the console for the boot result.");
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { parkedJars };
