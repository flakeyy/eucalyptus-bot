// Boot-verify loop: start the server, watch the console, quarantine attributed
// crash jars (or apply a remediation), and retry until Done / budget exhausted.
"use strict";

const msgLog = require("./logger.js");
const { PterodactylWebSocket } = require("./pterodactyl_websocket.js");
const {
  setServerPowerState, listServerFiles, getFileContents, writeServerFile
} = require("./server_functions.js");
const {
  attributeCrash, expandWithDependents, createModIndex
} = require("./crash_attribution.js");
const {
  tryRemediations,
  quarantineJars,
  restoreParkedJars,
  neutralizeUnboundNamespaces,
  ensureHeadlessJvmArgs,
  removeServerIconFiles,
  jarsFromDiskForSignals
} = require("./boot_remediations");
const config = require("../config.json");

const DEFAULTS = {
  max_attempts: 8,
  success_timeout_ms: 600_000,
  total_budget_ms: 1_800_000,
  crash_flush_ms: 3_000,
  history_flush_ms: 2_500
};

const CONSOLE_TAIL_LINES = 800;

const SUCCESS_RE = /\bDone \([\d.,]+\s*m?s?\)!/i;
const LOADING_PROGRESS_RE =
  /\[Morph\]:|Ignored smelting recipe|Preparing spawn area|Loading dimension|Applying holder lookups|Injecting existing registry data|FML\]: Registry|Server thread\/INFO.*: Loading/i;
const JAVA_BOOT_RE =
  /LaunchWrapper|ModLauncher|MinecraftForge|NeoForge|Forge Mod Loader|Picked up _JAVA|OpenJDK|Java HotSpot|\[main\/INFO\] \[FML\]|\[Server thread\/INFO\]|Fabric Loader|fabric-loader|KnotServer|net\.fabricmc/i;

const DEFINITE_CRASH_MARKERS = [
  /Minecraft has crashed/i,
  /crash report has been saved to/i,
  /Crash report saved to/i,
  /Failed to start the minecraft server/i,
  /Exception in server tick loop/i,
  /Incompatible mods found/i,
  /LoadingFailedException/,
  /MissingModsException/,
  /ModResolutionException/,
  /ModLoadingCrashException/,
  /Mod loading (?:failures have|error has|has) (?:occurred|failed)/i,
  /Mod loading issue for:/i,
  /A problem occurred running the Server launcher/i,
  /Failed to load datapacks/i,
  /FMLSecurityManager\$ExitTrappedException/,
  /UnsatisfiedLinkError:.*libawt/i,
  /UnsatisfiedLinkError:.*libXrender/i,
  /AWTError:.*DISPLAY/i,
  /Can't connect to X11 window server/i,
  /java\.awt\.HeadlessException/i,
  /No X11 DISPLAY variable was set/i,
  /Could not find or load main class @unix_args/i,
  /Unable to access jarfile/i,
  /agree to the EULA/i,
  /Failed to load eula\.txt/i
];

const PANEL_CRASH_MARKERS = [
  /Detected server process in a crashed state/i
];

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

// Watches one boot attempt. Resolves
// { outcome: "success" | "crash" | "timeout" | "ws-error", consoleTail }.
// Robustness (history flush, JAVA_BOOT arming, panel false-crash, stale report
// ignore) lives here — the outer loop only reacts to the outcome.
function watchBootAttempt(
  serverId, userId, timeoutMs, crashFlushMs = DEFAULTS.crash_flush_ms,
  {
    ignoreEulaMarkers = false,
    historyFlushMs = DEFAULTS.history_flush_ms,
    ignoreCrashReportNames = null,
    skipStart = false
  } = {}
) {
  return new Promise(resolve => {
    const tail = [];
    let lastState = null;
    let settled = false;
    let crashSuspected = false;
    let definiteCrash = false;
    // True once the JVM/loader process has died (offline/stopping after javaBootSeen).
    // Pterodactyl may auto-restart; we must not clear suspicion and watch that restart.
    let processDied = false;
    let javaBootSeen = false;
    let pullFinishedAt = 0;
    let crashFlushTimer = null;
    let acceptingConsole = false;
    const ws = new PterodactylWebSocket(serverId, userId);
    const ignoreCrashes = ignoreCrashReportNames instanceof Set
      ? ignoreCrashReportNames
      : new Set(ignoreCrashReportNames ?? []);
    const definiteMarkers = ignoreEulaMarkers
      ? DEFINITE_CRASH_MARKERS.filter(re => !/eula/i.test(re.source))
      : DEFINITE_CRASH_MARKERS;
    const earlyBootCrashMarkers = [
      /Could not find or load main class @unix_args/i,
      /Unable to access jarfile/i,
      /UnsatisfiedLinkError:.*libawt/i,
      /UnsatisfiedLinkError:.*libXrender/i,
      /AWTError:.*DISPLAY/i,
      /Can't connect to X11 window server/i,
      /java\.awt\.HeadlessException/i,
      /No X11 DISPLAY variable was set/i,
      /agree to the EULA/i,
      /Failed to load eula\.txt/i
    ];
    const POST_PULL_CRASH_GRACE_MS = 30_000;

    const inPostPullGrace = () =>
      pullFinishedAt > 0 && (Date.now() - pullFinishedAt) < POST_PULL_CRASH_GRACE_MS;

    const clearCrashSuspicion = reason => {
      if (processDied) return; // auto-restart must not wipe a confirmed process death
      if (!crashSuspected) return;
      crashSuspected = false;
      definiteCrash = false;
      if (crashFlushTimer) {
        clearTimeout(crashFlushTimer);
        crashFlushTimer = null;
      }
      if (reason) msgLog.warn(`[boot-verify] ${serverId}: ${reason}`);
    };

    let timer = setTimeout(() => {
      finish(lastState === "running" && !crashSuspected && !processDied ? "success" : "timeout");
    }, timeoutMs);
    let pullExtended = false;

    const finish = outcome => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (crashFlushTimer) clearTimeout(crashFlushTimer);
      ws.close();
      resolve({ outcome, consoleTail: tail.join("\n") });
    };

    const scheduleCrashFinish = () => {
      if (crashFlushTimer) return;
      crashFlushTimer = setTimeout(() => {
        crashFlushTimer = null;
        // Process already died — finish even if the panel auto-restarted into
        // starting/running (otherwise we hang until success_timeout).
        if (processDied) {
          finish("crash");
          return;
        }
        const recent = tail.slice(-120).join("\n");
        const savedNames = [ ...recent.matchAll(/crash reports?\/(\S+\.txt)/gi) ].map(m => m[1]);
        const freshSaved = savedNames.some(n => n && !ignoreCrashes.has(n));
        if (!definiteCrash && (lastState === "running" || lastState === "starting")) {
          clearCrashSuspicion("ignoring panel crashed-state while still running");
          return;
        }
        if (!definiteCrash && LOADING_PROGRESS_RE.test(recent)) {
          clearCrashSuspicion("ignoring crash marker during active loading");
          return;
        }
        if (
          definiteCrash && !freshSaved && lastState === "running" &&
          LOADING_PROGRESS_RE.test(recent)
        ) {
          clearCrashSuspicion(
            "ignoring definite crash while still loading (no new crash report)"
          );
          return;
        }
        finish("crash");
      }, crashFlushMs);
    };

    ws.on("consoleLine", raw => {
      if (!acceptingConsole) return;
      const line = stripAnsi(String(raw));
      if (tail.length === 0 || tail[tail.length - 1] !== line) {
        tail.push(line);
        if (tail.length > CONSOLE_TAIL_LINES) tail.shift();
      }
      if (!pullExtended && /Finished pulling Docker container image/i.test(line)) {
        // Auto-restart after a crash often re-pulls the image — end this attempt
        // instead of clearing suspicion and watching another doomed boot.
        if (processDied) {
          msgLog.warn(
            `[boot-verify] ${serverId}: docker pull during post-crash auto-restart — ending attempt as crash`
          );
          finish("crash");
          return;
        }
        pullExtended = true;
        pullFinishedAt = Date.now();
        clearCrashSuspicion(null);
        javaBootSeen = false;
        clearTimeout(timer);
        const extendMs = Math.max(timeoutMs, 600_000);
        timer = setTimeout(() => {
          finish(lastState === "running" && !crashSuspected && !processDied ? "success" : "timeout");
        }, extendMs);
        msgLog.warn(
          `[boot-verify] ${serverId}: docker pull finished during boot watch — extended timeout by ${extendMs}ms`
        );
      }
      if (JAVA_BOOT_RE.test(line) && !inPostPullGrace()) javaBootSeen = true;
      if (SUCCESS_RE.test(line)) finish("success");
      else if (LOADING_PROGRESS_RE.test(line) && crashSuspected && !definiteCrash && !processDied) {
        clearCrashSuspicion("canceling crash suspicion — still loading");
      }
      else if (
        earlyBootCrashMarkers.some(re => re.test(line)) ||
        (
          javaBootSeen && !inPostPullGrace() &&
          (
            definiteMarkers.some(re => re.test(line)) ||
            PANEL_CRASH_MARKERS.some(re => re.test(line))
          )
        )
      ) {
        const saved = line.match(
          /crash report has been saved to:\s*\S*crash-reports\/(\S+\.txt)/i
        ) || line.match(
          /Crash report saved to:\s*\S*crash-reports\/(\S+\.txt)/i
        );
        if (saved && ignoreCrashes.has(saved[1])) {
          msgLog.warn(
            `[boot-verify] ${serverId}: ignoring replayed crash marker for ${saved[1]}`
          );
          return;
        }
        if (
          definiteMarkers.some(re => re.test(line)) ||
          earlyBootCrashMarkers.some(re => re.test(line))
        ) {
          definiteCrash = true;
        }
        if (earlyBootCrashMarkers.some(re => re.test(line))) javaBootSeen = true;
        crashSuspected = true;
        scheduleCrashFinish();
      }
    });

    ws.on("powerStateChange", state => {
      lastState = state;
      if (settled || inPostPullGrace()) return;

      // JVM/loader was up, then the process stopped. Panel may auto-restart;
      // mark death and end the attempt — do not wait for Done on the restart.
      if ((state === "offline" || state === "stopping") && javaBootSeen) {
        processDied = true;
        crashSuspected = true;
        if (definiteCrash) {
          if (crashFlushTimer) {
            clearTimeout(crashFlushTimer);
            crashFlushTimer = null;
          }
          finish("crash");
          return;
        }
        scheduleCrashFinish();
        return;
      }

      if (
        processDied &&
        (state === "starting" || state === "running")
      ) {
        msgLog.warn(
          `[boot-verify] ${serverId}: panel auto-restarted after process death — ending attempt as crash`
        );
        if (crashFlushTimer) {
          clearTimeout(crashFlushTimer);
          crashFlushTimer = null;
        }
        finish("crash");
      }
    });

    ws.on("error", () => { /* reconnect handled internally; timer bounds us */ });

    ws.once("authenticated", async () => {
      if (historyFlushMs > 0) {
        await new Promise(r => setTimeout(r, historyFlushMs));
      }
      if (settled) return;
      acceptingConsole = true;
      if (skipStart) {
        msgLog.warn(`[boot-verify] ${serverId}: resuming boot watch without restart`);
        return;
      }
      try {
        await setServerPowerState(serverId, userId, "start");
      } catch (err) {
        msgLog.error(`[boot-verify] start failed for ${serverId}: ${err.message}`);
        finish("ws-error");
      }
    });

    ws.connect().catch(err => {
      msgLog.error(`[boot-verify] websocket/start failed for ${serverId}: ${err.message}`);
      finish("ws-error");
    });
  });
}

async function fetchLatestCrashReport(serverId, userId, preferredName = null) {
  let files = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    files = await listServerFiles(serverId, userId, "/crash-reports").catch(() => null);
    if (files !== null) break;
    await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
  }
  if (!files || files.length === 0) return null;

  const txtFiles = files.filter(f => f.attributes?.is_file && /\.txt$/i.test(f.attributes?.name ?? ""));
  if (txtFiles.length === 0) return null;

  let newest = null;
  if (preferredName) {
    const base = String(preferredName).replace(/^.*\//, "");
    newest = txtFiles.find(f => f.attributes.name === base) ?? null;
  }
  if (!newest) {
    newest = [ ...txtFiles ].sort((a, b) => {
      const tb = new Date(b.attributes.modified_at ?? 0) - new Date(a.attributes.modified_at ?? 0);
      if (tb !== 0) return tb;
      const score = n => (/-server\.txt$/i.test(n) ? 2 : /-fml\.txt$/i.test(n) ? 0 : 1);
      return score(b.attributes.name) - score(a.attributes.name);
    })[0];
  }
  if (!newest) return null;
  const name = newest.attributes.name;
  let text = undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    text = await getFileContents(serverId, userId, `/crash-reports/${name}`);
    if (text !== null && text !== undefined) break;
    await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
  }
  return text === null || text === undefined ? null : { name, text };
}

/**
 * Runs the boot-verify loop.
 * ctx = { serverId, userId, modIndex?, onProgress?, settings? }
 */
async function verifyServerBoot(ctx) {
  const settings = { ...DEFAULTS, ...(ctx.settings ?? {}) };
  const modIndex = ctx.modIndex ?? createModIndex();
  const onProgress = ctx.onProgress ?? (() => {});
  const started = Date.now();
  const quarantined = [];
  const quarantinedModIds = [];
  const quarantinedJars = new Set();
  const hardFailedJars = new Set();
  let lastCrashReportName = null;
  const seenCrashReportNames = new Set();
  let consoleTail = "";
  let eulaAccepted = false;
  let stackFrameQuarantines = 0;
  let mixinConfigQuarantines = 0;
  let skipWeakOnlyQuarantine = false;
  let staleCrashRefunded = false;
  const triageBudget = { calls: 0 };

  // Preconditions every install: headless JVM + nogui + never leave a server-icon.
  // (eula.txt is written by utility/modpack/job.js before we run.)
  await ensureHeadlessJvmArgs(ctx);
  await removeServerIconFiles(ctx);

  for (let attempt = 1; attempt <= settings.max_attempts; attempt++) {
    const budgetLeft = settings.total_budget_ms - (Date.now() - started);
    if (budgetLeft <= 0) {
      return { success: false, attempts: attempt - 1, quarantined, reason: "budget-exhausted", consoleTail };
    }

    await removeServerIconFiles(ctx);
    await onProgress(
      attempt === 1
        ? "Verifying server boot (this can take several minutes)..."
        : `Boot attempt ${attempt}/${settings.max_attempts} after quarantining ${quarantined.length} mod(s)...`
    );
    msgLog.log(`[boot-verify] ${ctx.serverId}: boot attempt ${attempt}/${settings.max_attempts}`);

    const result = await watchBootAttempt(
      ctx.serverId, ctx.userId,
      Math.min(settings.success_timeout_ms, budgetLeft),
      settings.crash_flush_ms,
      {
        ignoreEulaMarkers: eulaAccepted,
        historyFlushMs: settings.history_flush_ms,
        ignoreCrashReportNames: seenCrashReportNames
      }
    );
    consoleTail = result.consoleTail;

    if (result.outcome === "success") {
      msgLog.log(`[boot-verify] ${ctx.serverId}: boot verified on attempt ${attempt} (${quarantined.length} quarantined)`);
      return { success: true, attempts: attempt, quarantined, reason: null, consoleTail };
    }
    if (result.outcome === "ws-error") {
      return { success: false, attempts: attempt, quarantined, reason: "ws-error", consoleTail };
    }

    // Definite crash markers in a "timeout" tail (Fabric Knot before JAVA_BOOT).
    if (
      result.outcome === "timeout" &&
      DEFINITE_CRASH_MARKERS.some(re => re.test(consoleTail))
    ) {
      msgLog.warn(
        `[boot-verify] ${ctx.serverId}: timeout console contains definite crash marker — treating as crash`
      );
      result.outcome = "crash";
    }

    if (result.outcome === "timeout") {
      msgLog.warn(`[boot-verify] ${ctx.serverId}: boot timed out without Done/crash marker`);
      return { success: false, attempts: attempt, quarantined, reason: "timeout", consoleTail };
    }

    await setServerPowerState(ctx.serverId, ctx.userId, "kill").catch(() => {});

    if (!eulaAccepted && (/agree to the EULA/i.test(consoleTail) || /Failed to load eula\.txt/i.test(consoleTail))) {
      msgLog.warn(`[boot-verify] ${ctx.serverId}: EULA not accepted; writing eula.txt and retrying`);
      await writeServerFile(ctx.serverId, ctx.userId, "/eula.txt", "eula=true\n").catch(() => {});
      eulaAccepted = true;
      attempt--;
      continue;
    }

    const savedTo = consoleTail.match(
      /crash report has been saved to:\s*(\S*crash-reports\/\S+\.txt)/i
    );
    const preferredCrash = savedTo
      ? savedTo[1].replace(/^.*crash-reports\//i, "")
      : null;
    const latestCrash = await fetchLatestCrashReport(ctx.serverId, ctx.userId, preferredCrash);
    let crashReportText = null;
    if (latestCrash && latestCrash.name !== lastCrashReportName) {
      crashReportText = latestCrash.text;
      lastCrashReportName = latestCrash.name;
      seenCrashReportNames.add(latestCrash.name);
    } else if (latestCrash && latestCrash.name === lastCrashReportName) {
      msgLog.warn(`[boot-verify] ${ctx.serverId}: ignoring stale crash report ${latestCrash.name}`);
      seenCrashReportNames.add(latestCrash.name);
    }

    const attribution = attributeCrash({
      crashReportText,
      consoleTail,
      index: modIndex,
      quarantinedModIds
    });

    const remCtx = {
      ...ctx,
      modIndex,
      onProgress,
      consoleTail,
      crashReportText,
      attribution,
      quarantined,
      quarantinedModIds,
      quarantinedJars,
      hardFailedJars
    };

    // Prefer remediations that can fix the failure without quarantining
    // (missing dep restore, jarfile race, corrupted argfile, kubejs, unbound ns).
    const rem = await tryRemediations(consoleTail, remCtx);
    if (rem) {
      if (rem.id === "kubejs-script-errors") skipWeakOnlyQuarantine = true;
      if (rem.refundAttempt) attempt--;
      continue;
    }

    let freshJars = attribution.jars.filter(j => !quarantinedJars.has(j));

    // Last-resort triage when deterministic attribution found nothing.
    if (freshJars.length === 0 && config.triage?.provider !== "none") {
      try {
        const { diagnose } = require("./modpack/triage");
        const modList = [
          ...[ ...(modIndex.byFileName?.values?.() || []) ],
          ...[ ...(modIndex.parkedJars || []) ].map(j => `[parked] ${j}`)
        ];
        const verdict = await diagnose({
          consoleTail,
          crashReport: crashReportText,
          modList,
          modIndex
        }, {
          settings: config.triage,
          budget: triageBudget
        });
        if (verdict?.diagnosis) {
          msgLog.warn(`[boot-verify] ${ctx.serverId}: triage: ${verdict.diagnosis} (${verdict.action}/${verdict.confidence})`);
          await onProgress(`Triage: ${verdict.diagnosis}`);
        }
        if (verdict?.action === "quarantine" && verdict.jars?.length) {
          freshJars = verdict.jars.filter(j => !quarantinedJars.has(j));
          for (const jar of freshJars) {
            attribution.reasons.push({ jar, reason: `triage: ${verdict.diagnosis}` });
          }
        } else if (verdict?.action === "restore" && verdict.jars?.length) {
          await restoreParkedJars({ ...ctx, modIndex }, verdict.jars);
          attempt--;
          continue;
        } else if (verdict?.action === "give-up" && verdict.diagnosis) {
          return {
            success: false,
            attempts: attempt,
            quarantined,
            reason: "unattributed",
            diagnosis: verdict.diagnosis,
            consoleTail
          };
        }
      } catch (err) {
        msgLog.debugExtended(`[boot-verify] triage skipped: ${err.message}`);
      }
    }
    {
      const reasonsByJarEarly = new Map(attribution.reasons.map(r => [ r.jar, r.reason ]));
      const isStack = r => /^stack frame/i.test(r ?? "");
      const isMixin = r => /^mixin config /i.test(r ?? "");
      const isWeak = r => isStack(r) || isMixin(r);
      const weakOnly = freshJars.filter(j => isWeak(reasonsByJarEarly.get(j)));
      const strong = freshJars.filter(j => !isWeak(reasonsByJarEarly.get(j)));
      const headlessGuiCrash =
        /java\.awt\.HeadlessException|No X11 DISPLAY variable was set/i.test(consoleTail);
      if (!crashReportText && weakOnly.length > 0 && strong.length === 0 && !headlessGuiCrash) {
        msgLog.warn(
          `[boot-verify] ${ctx.serverId}: skipping weak quarantine without fresh crash report ` +
          `(${weakOnly.join(", ")})`
        );
        freshJars = [];
      } else if (weakOnly.length > 0 && strong.length === 0) {
        const allStack = weakOnly.every(j => isStack(reasonsByJarEarly.get(j)));
        const allMixin = weakOnly.every(j => isMixin(reasonsByJarEarly.get(j)));
        const overBudget = allStack
          ? stackFrameQuarantines >= 2
          : allMixin
            ? mixinConfigQuarantines >= 2
            : (stackFrameQuarantines + mixinConfigQuarantines) >= 3;
        if (skipWeakOnlyQuarantine || overBudget) {
          freshJars = [];
        } else {
          freshJars = [ weakOnly[0] ];
        }
      } else if (strong.length > 0) {
        freshJars = strong;
      }
    }

    if (freshJars.length === 0) {
      const diskHits = await jarsFromDiskForSignals(ctx, attribution.signals, quarantinedJars);
      if (diskHits.length > 0) {
        for (const jar of diskHits) {
          attribution.jars.push(jar);
          attribution.reasons.push({ jar, reason: "server-pack filename match for crash mod id" });
        }
        freshJars = diskHits;
      }
    }

    if (freshJars.length === 0) {
      if (!staleCrashRefunded && !crashReportText && attempt < settings.max_attempts) {
        staleCrashRefunded = true;
        msgLog.warn(
          `[boot-verify] ${ctx.serverId}: unattributed with no fresh crash report; refunding attempt`
        );
        attempt--;
        continue;
      }
      msgLog.warn(`[boot-verify] ${ctx.serverId}: crash could not be attributed to a new mod; stopping loop`);
      return { success: false, attempts: attempt, quarantined, reason: "unattributed", consoleTail };
    }

    const toQuarantine = (
      attribution.signals?.clientClassMissing
        ? freshJars
        : expandWithDependents(modIndex, freshJars)
    ).filter(j => !quarantinedJars.has(j));
    const reasonsByJar = new Map(attribution.reasons.map(r => [ r.jar, r.reason ]));
    if (toQuarantine.some(j => /^stack frame/i.test(reasonsByJar.get(j) ?? ""))) {
      stackFrameQuarantines++;
    }
    if (toQuarantine.some(j => /^mixin config /i.test(reasonsByJar.get(j) ?? ""))) {
      mixinConfigQuarantines++;
    }
    await quarantineJars({ ...ctx, modIndex }, toQuarantine, reasonsByJar);
    const newModIds = [];
    for (const jar of toQuarantine) {
      const reason = reasonsByJar.get(jar) ?? "dependent of quarantined mod";
      quarantined.push({ jar, reason });
      quarantinedJars.add(jar);
      if (/^hard failure:/i.test(reason)) hardFailedJars.add(jar);
      const id = modIndex.modIdOf?.get(jar);
      if (id) {
        quarantinedModIds.push(id);
        newModIds.push(id);
      }
    }
    const nsToNeutralize = [
      ...newModIds,
      ...(attribution.signals?.missingDeps ?? [])
    ];
    if (nsToNeutralize.length > 0) {
      await neutralizeUnboundNamespaces(ctx, nsToNeutralize);
    }
  }

  await setServerPowerState(ctx.serverId, ctx.userId, "kill").catch(() => {});
  return { success: false, attempts: settings.max_attempts, quarantined, reason: "budget-exhausted", consoleTail };
}

module.exports = {
  verifyServerBoot,
  watchBootAttempt,
  fetchLatestCrashReport,
  _DEFAULTS: DEFAULTS
};
