// Sha1-keyed store for everything the bot learns about individual mod JARs:
//   - cached static inspections (mod_inspector verdicts, per loader+version)
//   - cached crash-proof scan results (crash_risk Layer 2, per MC version)
//   - learned verdicts from the boot-verify loop ("crashes-server"), which the
//     Layer 1 precedence table consults at slot 3
//
// Replaces the old raw mod_inspector_cache.json (discarded on first load — its
// entries were keyed to deleted heuristics and are stale by construction).

"use strict";

const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join(__dirname, "../verdict_store.json");
const LEGACY_CACHE_PATH = path.join(__dirname, "../mod_inspector_cache.json");
const STORE_VERSION = 1;

let storePath = STORE_PATH;
let store = null;
let dirty = false;

function load() {
  if (store !== null) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
    store = parsed.version === STORE_VERSION && parsed.entries ? parsed : { version: STORE_VERSION, entries: {} };
  } catch {
    store = { version: STORE_VERSION, entries: {} };
  }
  // One-time migration: the legacy cache is keyed to deleted heuristics — discard it.
  try {
    if (fs.existsSync(LEGACY_CACHE_PATH)) fs.unlinkSync(LEGACY_CACHE_PATH);
  } catch { /* non-fatal */ }
}

function entry(sha1, create = false) {
  load();
  if (!store.entries[sha1] && create) {
    store.entries[sha1] = { timestamp: new Date().toISOString() };
  }
  return store.entries[sha1] ?? null;
}

// Persists only when there are unwritten changes. Callers (the install engine)
// invoke this once per batch instead of paying a full-file write per JAR.
function flushVerdictStore() {
  if (!dirty || store === null) return;
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
  dirty = false;
}

// ── Static inspections (mod_inspector) ──────────────────────────────────────

function getInspection(sha1, cacheKey) {
  const e = entry(sha1);
  return e?.inspections?.[cacheKey] ?? null;
}

function putInspection(sha1, cacheKey, inspection) {
  const e = entry(sha1, true);
  e.inspections = e.inspections ?? {};
  e.inspections[cacheKey] = inspection;
  dirty = true;
}

// ── Crash-proof scans (crash_risk Layer 2) ──────────────────────────────────

function getCrashScan(sha1, cacheKey) {
  const e = entry(sha1);
  return e?.crashScans?.[cacheKey] ?? null;
}

function putCrashScan(sha1, cacheKey, result) {
  const e = entry(sha1, true);
  e.crashScans = e.crashScans ?? {};
  e.crashScans[cacheKey] = result;
  dirty = true;
}

// ── Learned verdicts (boot-verify Layer 3) ──────────────────────────────────

// Returns "crashes-server" (or a future verdict string), or null.
function getLearnedVerdict(sha1) {
  if (!sha1) return null;
  return entry(sha1)?.learnedVerdict ?? null;
}

function recordLearnedVerdict(sha1, verdict, { source = null, modId = null, filename = null, detail = null } = {}) {
  if (!sha1) return;
  const e = entry(sha1, true);
  e.learnedVerdict = verdict;
  e.source = source;
  e.modId = modId ?? e.modId ?? null;
  e.filename = filename ?? e.filename ?? null;
  e.detail = detail ?? null;
  e.timestamp = new Date().toISOString();
  dirty = true;
}

function clearLearnedVerdict(sha1) {
  const e = entry(sha1);
  if (!e || !e.learnedVerdict) return;
  delete e.learnedVerdict;
  delete e.source;
  delete e.detail;
  dirty = true;
}

// Test helper: reset in-memory state, optionally pointing at a different file.
function _resetForTests(newPath = null) {
  store = null;
  dirty = false;
  storePath = newPath ?? STORE_PATH;
}

module.exports = {
  flushVerdictStore,
  getInspection,
  putInspection,
  getCrashScan,
  putCrashScan,
  getLearnedVerdict,
  recordLearnedVerdict,
  clearLearnedVerdict,
  _resetForTests,
  _STORE_PATH: STORE_PATH
};
