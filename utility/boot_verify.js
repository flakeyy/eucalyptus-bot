// Boot-verify loop (Layer 3): the empirical correctness oracle for modpack
// installs. Starts the server, watches the console over the panel websocket,
// and on a crash attributes the failure to specific mod JAR(s), quarantines
// them into mods-disabled/, records a learned verdict (consulted by Layer 1 at
// precedence slot 3 on future installs), and retries — until the server boots,
// the attempt/time budget runs out, or a crash cannot be attributed.

"use strict";

const msgLog = require("./logger.js");
const { PterodactylWebSocket } = require("./pterodactyl_websocket.js");
const {
  setServerPowerState, listServerFiles, getFileContents,
  createServerDirectory, renameServerFiles
} = require("./server_functions.js");
const { attributeCrash, expandWithDependents, createModIndex } = require("./crash_attribution.js");
const { recordLearnedVerdict, flushVerdictStore } = require("./verdict_store.js");

const DEFAULTS = {
  max_attempts: 5,
  // First boot of a big pack can take minutes (worldgen); loader failures die
  // in 30-90s, so a generous ceiling costs nothing on the crash path.
  success_timeout_ms: 600_000,
  total_budget_ms: 1_800_000
};

const CONSOLE_TAIL_LINES = 400;

const SUCCESS_RE = /\bDone \([\d.,]+\s*m?s?\)!/i;
const CRASH_MARKERS = [
  /Minecraft has crashed/i,
  /Crash report saved to/i,
  /Fatal errors were detected during/i,
  /Failed to start the minecraft server/i,
  /Exception in server tick loop/i,
  /Incompatible mods found/i,
  /Loading errors encountered/i,
  /LoadingFailedException/,
  /ModResolutionException/,
  /Mixin apply failed/i
];

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

// Starts the server and watches one boot attempt.
// Resolves { outcome: "success" | "crash" | "timeout" | "ws-error", consoleTail }.
function watchBootAttempt(serverId, userId, timeoutMs) {
  return new Promise(resolve => {
    const tail = [];
    let sawStarting = false;
    let lastState = null;
    let settled = false;
    let crashSuspected = false;
    const ws = new PterodactylWebSocket(serverId, userId);

    const finish = outcome => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve({ outcome, consoleTail: tail.join("\n") });
    };

    const timer = setTimeout(() => {
      // Generous timeout reached: a server that is up and running just never
      // printed a recognizable Done line — treat steady running as success.
      finish(lastState === "running" && !crashSuspected ? "success" : "timeout");
    }, timeoutMs);

    ws.on("consoleLine", raw => {
      const line = stripAnsi(String(raw));
      tail.push(line);
      if (tail.length > CONSOLE_TAIL_LINES) tail.shift();
      if (SUCCESS_RE.test(line)) finish("success");
      else if (CRASH_MARKERS.some(re => re.test(line))) crashSuspected = true;
    });

    ws.on("powerStateChange", state => {
      lastState = state;
      if (state === "starting" || state === "running") sawStarting = true;
      // Offline after the boot began = the process died.
      if (state === "offline" && sawStarting) finish("crash");
    });

    ws.on("error", () => { /* reconnect is handled internally; timer bounds us */ });

    ws.connect()
      .then(() => setServerPowerState(serverId, userId, "start"))
      .catch(err => {
        msgLog.error(`[boot-verify] websocket/start failed for ${serverId}: ${err.message}`);
        finish("ws-error");
      });
  });
}

// Fetches the newest crash report text, or null.
async function fetchLatestCrashReport(serverId, userId) {
  const files = await listServerFiles(serverId, userId, "/crash-reports").catch(() => null);
  if (!files || files.length === 0) return null;
  const newest = files
    .filter(f => f.attributes?.is_file && /\.txt$/i.test(f.attributes?.name ?? ""))
    .sort((a, b) => new Date(b.attributes.modified_at ?? 0) - new Date(a.attributes.modified_at ?? 0))[0];
  if (!newest) return null;
  return getFileContents(serverId, userId, `/crash-reports/${newest.attributes.name}`);
}

// Moves jars from mods/ to mods-disabled/ and records learned verdicts.
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

/**
 * Runs the boot-verify loop.
 * ctx = { serverId, userId, modIndex?, onProgress?, settings? }
 * Returns {
 *   success, attempts,
 *   quarantined: [{ jar, reason }],
 *   reason: null | "unattributed" | "budget-exhausted" | "ws-error",
 *   consoleTail
 * }
 */
async function verifyServerBoot(ctx) {
  const settings = { ...DEFAULTS, ...(ctx.settings ?? {}) };
  const modIndex = ctx.modIndex ?? createModIndex();
  const onProgress = ctx.onProgress ?? (() => {});
  const started = Date.now();
  const quarantined = [];
  const quarantinedModIds = [];
  let consoleTail = "";

  for (let attempt = 1; attempt <= settings.max_attempts; attempt++) {
    const budgetLeft = settings.total_budget_ms - (Date.now() - started);
    if (budgetLeft <= 0) {
      return { success: false, attempts: attempt - 1, quarantined, reason: "budget-exhausted", consoleTail };
    }

    await onProgress(
      attempt === 1
        ? "Verifying server boot (this can take several minutes)..."
        : `Boot attempt ${attempt}/${settings.max_attempts} after quarantining ${quarantined.length} mod(s)...`
    );
    msgLog.log(`[boot-verify] ${ctx.serverId}: boot attempt ${attempt}/${settings.max_attempts}`);

    const result = await watchBootAttempt(
      ctx.serverId, ctx.userId, Math.min(settings.success_timeout_ms, budgetLeft)
    );
    consoleTail = result.consoleTail;

    if (result.outcome === "success") {
      msgLog.log(`[boot-verify] ${ctx.serverId}: boot verified on attempt ${attempt} (${quarantined.length} quarantined)`);
      return { success: true, attempts: attempt, quarantined, reason: null, consoleTail };
    }
    if (result.outcome === "ws-error") {
      return { success: false, attempts: attempt, quarantined, reason: "ws-error", consoleTail };
    }

    // Make sure a hung/zombie boot is actually stopped before we touch files.
    if (result.outcome === "timeout") {
      await setServerPowerState(ctx.serverId, ctx.userId, "kill").catch(() => {});
    }

    const crashReportText = await fetchLatestCrashReport(ctx.serverId, ctx.userId);
    const attribution = attributeCrash({
      crashReportText,
      consoleTail: result.consoleTail,
      index: modIndex,
      quarantinedModIds
    });

    if (attribution.jars.length === 0) {
      msgLog.warn(`[boot-verify] ${ctx.serverId}: crash could not be attributed to a mod; stopping loop`);
      return { success: false, attempts: attempt, quarantined, reason: "unattributed", consoleTail };
    }

    const toQuarantine = expandWithDependents(modIndex, attribution.jars);
    const reasonsByJar = new Map(attribution.reasons.map(r => [ r.jar, r.reason ]));
    await quarantineJars({ ...ctx, modIndex }, toQuarantine, reasonsByJar);
    for (const jar of toQuarantine) {
      quarantined.push({ jar, reason: reasonsByJar.get(jar) ?? "dependent of quarantined mod" });
      const id = modIndex.modIdOf?.get(jar);
      if (id) quarantinedModIds.push(id);
    }
  }

  return { success: false, attempts: settings.max_attempts, quarantined, reason: "budget-exhausted", consoleTail };
}

module.exports = { verifyServerBoot, watchBootAttempt, fetchLatestCrashReport, _DEFAULTS: DEFAULTS };
