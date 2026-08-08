// Boot-verify loop (Layer 3): the empirical correctness oracle for modpack
// installs. Starts the server, watches the console over the panel websocket,
// and on a crash attributes the failure to specific mod JAR(s), quarantines
// them into mods-disabled/, records a learned verdict (consulted by Layer 1 at
// precedence slot 3 on future installs), and retries — until the server boots,
// the attempt/time budget runs out, or a crash cannot be attributed.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const AdmZip = require("adm-zip");
const msgLog = require("./logger.js");
const { PterodactylWebSocket } = require("./pterodactyl_websocket.js");
const {
  setServerPowerState, listServerFiles, getFileContents,
  createServerDirectory, renameServerFiles, writeServerFile, deleteServerFiles,
  getServerInfoById, getFileUploadUrl, decompressFile, chmodServerFiles
} = require("./server_functions.js");
const { applicationApiCall } = require("./helper_functions.js");
const {
  attributeCrash, expandWithDependents, createModIndex, promoteParkedJar
} = require("./crash_attribution.js");
const { recordLearnedVerdict, flushVerdictStore, getLearnedVerdict, isProtectedLearnedMod } = require("./verdict_store.js");
const { downloadFile, uploadBufferToServer } = require("./modpack_http.js");
const { getModpackFiles, synthesizeCurseForgeCdnUrl } = require("./curseforge.js");

// CurseForge JustEnoughIDs (Forge 1.12.2) — fixes "maximum id range exceeded".
const JEID_CURSEFORGE_MOD_ID = 296289;
const JEID_PREFERRED_FILE = "JustEnoughIDs-1.0.3-55.jar";

// Minimal X11 libs for Temurin libawt_xawt on headless yolks (Cottage Witch).
// Debian 11 (bullseye) X11 libs — yolk images often ship glibc < 2.38; newer
// Ubuntu noble libs fail with "GLIBC_2.38 not found" after LD_LIBRARY_PATH works.
const X11_NATIVE_DEBS = [
  {
    url: "https://deb.debian.org/debian/pool/main/libx/libxrender/libxrender1_0.9.10-1_amd64.deb",
    soname: "libXrender.so.1"
  },
  {
    url: "https://deb.debian.org/debian/pool/main/libx/libxext/libxext6_1.3.3-1.1_amd64.deb",
    soname: "libXext.so.6"
  },
  {
    url: "https://deb.debian.org/debian/pool/main/libx/libx11/libx11-6_1.7.2-1+deb11u2_amd64.deb",
    soname: "libX11.so.6"
  },
  {
    url: "https://deb.debian.org/debian/pool/main/libx/libxcb/libxcb1_1.14-3_amd64.deb",
    soname: "libxcb.so.1"
  },
  {
    url: "https://deb.debian.org/debian/pool/main/libx/libxau/libxau6_1.0.9-1_amd64.deb",
    soname: "libXau.so.6"
  },
  {
    url: "https://deb.debian.org/debian/pool/main/libx/libxdmcp/libxdmcp6_1.1.2-3_amd64.deb",
    soname: "libXdmcp.so.6"
  },
  {
    url: "https://deb.debian.org/debian/pool/main/libx/libxtst/libxtst6_1.2.3-1_amd64.deb",
    soname: "libXtst.so.6"
  },
  {
    url: "https://deb.debian.org/debian/pool/main/libx/libxi/libxi6_1.7.10-1_amd64.deb",
    soname: "libXi.so.6"
  },
  {
    url: "https://deb.debian.org/debian/pool/main/libb/libbsd/libbsd0_0.11.3-1+deb11u1_amd64.deb",
    soname: "libbsd.so.0"
  },
  {
    url: "https://deb.debian.org/debian/pool/main/libm/libmd/libmd0_1.0.3-3_amd64.deb",
    soname: "libmd.so.0"
  }
];

const DEFAULTS = {
  max_attempts: 8,
  // First boot of a big pack can take minutes (worldgen); loader failures die
  // in 30-90s, so a generous ceiling costs nothing on the crash path.
  success_timeout_ms: 600_000,
  total_budget_ms: 1_800_000,
  // After the first crash marker, wait briefly so attribution lines that follow
  // on the same boot are still in the consoleTail — then finish before a panel
  // auto-restart can merge a second boot into this attempt.
  crash_flush_ms: 3_000,
  // Drop Wings console history replayed on websocket auth before watching.
  history_flush_ms: 2_500
};

const CONSOLE_TAIL_LINES = 800;

const SUCCESS_RE = /\bDone \([\d.,]+\s*m?s?\)!/i;
// Healthy mid-boot noise — if this keeps printing after a crash marker, the
// marker was almost certainly a Wings false positive / history replay.
const LOADING_PROGRESS_RE =
  /\[Morph\]:|Ignored smelting recipe|Preparing spawn area|Loading dimension|Applying holder lookups|Injecting existing registry data|FML\]: Registry|Server thread\/INFO.*: Loading/i;
// Real java/Forge boot — ignore crash markers until we see this (Wings history
// after EnderIO quarantine was killing MC Eternal in a refund loop).
const JAVA_BOOT_RE =
  /LaunchWrapper|ModLauncher|MinecraftForge|NeoForge|Forge Mod Loader|Picked up _JAVA|OpenJDK|Java HotSpot|\[main\/INFO\] \[FML\]|\[Server thread\/INFO\]|Fabric Loader|fabric-loader|KnotServer|net\.fabricmc/i;

// Soft markers often fire while Forge continues loading (optional mods fail).
// Only hard markers end the boot watch — otherwise MC Eternal was killed mid-Morph.
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
  /A problem occurred running the Server launcher/i,
  /Failed to load datapacks/i,
  /FMLSecurityManager\$ExitTrappedException/,
  /UnsatisfiedLinkError:.*libawt/i,
  /UnsatisfiedLinkError:.*libXrender/i,
  /UnsatisfiedLinkError:.*libXtst/i,
  /UnsatisfiedLinkError:.*libXi/i,
  /AWTError:.*DISPLAY/i,
  /Can't connect to X11 window server/i,
  // Swing/AWT GUI on a headless yolk (MissingModsChecker, etc.) — not UnsatisfiedLinkError.
  /java\.awt\.HeadlessException/i,
  /No X11 DISPLAY variable was set/i,
  /Could not find or load main class @unix_args/i,
  /Unable to access jarfile/i,
  /agree to the EULA/i,
  /Failed to load eula\.txt/i
];

// Wings often emits this right after start/kill while java is still fine.
const PANEL_CRASH_MARKERS = [
  /Detected server process in a crashed state/i
];

// Core / pack-defining mod ids — never quarantine via empty-index filename match.
// "Caught exception from gregtech" after removing a client jar is a cascade, not the fix.
const DISK_MATCH_PROTECT_IDS = new Set([
  "minecraft", "forge", "neoforge", "fabricloader", "fabric-api", "java",
  "gregtech", "gregtechceu", "gtceu", "railcraft", "thermalexpansion",
  "thermalfoundation", "codechickenlib", "cofhcore", "mantle", "tconstruct",
  "ic2", "industrialcraft", "mekanism", "ae2", "appliedenergistics2",
  "create", "kubejs", "rhino", "architectury", "groovyscript", "llibrary",
  "frostedheart", "caupona", "guideme", "modern_industrialization", "powah",
  "byg", "biomesyougo", "ftblibrary"
]);

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

// Starts the server and watches one boot attempt.
// Resolves { outcome: "success" | "crash" | "timeout" | "ws-error", consoleTail }.
//
// Crash detection is console-marker driven (not offline-driven): Fabric/Forge
// launchers re-exec after unpacking, and this panel auto-restarts once on crash.
// Offline alone is ignored. After a crash marker we flush a short window of
// follow-up console lines for attribution, then finish before an auto-restart
// can merge boots. Silent deaths (no marker) fall through to timeout.
//
// ignoreEulaMarkers: after we have already written eula=true, Wings may still
// replay the previous "agree to the EULA" lines on websocket connect — treat
// those as stale noise rather than a fresh EULA failure.
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
    let javaBootSeen = false;
    let pullFinishedAt = 0;
    let crashFlushTimer = null;
    // Drop console until we issue start — Wings often replays recent history on
    // auth, which would otherwise re-trigger crash/EULA markers from a prior boot.
    let acceptingConsole = false;
    const ws = new PterodactylWebSocket(serverId, userId);
    const ignoreCrashes = ignoreCrashReportNames instanceof Set
      ? ignoreCrashReportNames
      : new Set(ignoreCrashReportNames ?? []);
    const definiteMarkers = ignoreEulaMarkers
      ? DEFINITE_CRASH_MARKERS.filter(re => !/eula/i.test(re.source))
      : DEFINITE_CRASH_MARKERS;
    // Immediate post-pull failures (bad jar / AWT) — still arm during grace.
    const earlyBootCrashMarkers = [
      /Could not find or load main class @unix_args/i,
      /Unable to access jarfile/i,
      /UnsatisfiedLinkError:.*libawt/i,
      /UnsatisfiedLinkError:.*libXrender/i,
      /UnsatisfiedLinkError:.*libXtst/i,
      /UnsatisfiedLinkError:.*libXi/i,
      /AWTError:.*DISPLAY/i,
      /Can't connect to X11 window server/i,
      /java\.awt\.HeadlessException/i,
      /No X11 DISPLAY variable was set/i,
      /agree to the EULA/i,
      /Failed to load eula\.txt/i
    ];
    // Wings replays prior boot FML+crash lines right after docker pull; that set
    // javaBootSeen and definiteCrash instantly (MC Eternal refund loop).
    const POST_PULL_CRASH_GRACE_MS = 30_000;

    const inPostPullGrace = () =>
      pullFinishedAt > 0 && (Date.now() - pullFinishedAt) < POST_PULL_CRASH_GRACE_MS;

    const clearCrashSuspicion = reason => {
      if (!crashSuspected) return;
      crashSuspected = false;
      definiteCrash = false;
      if (crashFlushTimer) {
        clearTimeout(crashFlushTimer);
        crashFlushTimer = null;
      }
      if (reason) {
        msgLog.warn(`[boot-verify] ${serverId}: ${reason}`);
      }
    };

    let timer = setTimeout(() => {
      // Generous timeout reached: a server that is up and running just never
      // printed a recognizable Done line — treat steady running as success.
      finish(lastState === "running" && !crashSuspected ? "success" : "timeout");
    }, timeoutMs);
    // Egg startup patches (headless / icon rm) can force a Wings image pull that
    // burns most of success_timeout_ms before java even starts — slide the timer.
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
        const recent = tail.slice(-120).join("\n");
        const savedNames = [ ...recent.matchAll(
          /crash reports?\/(\S+\.txt)/gi
        ) ].map(m => m[1]);
        const freshSaved = savedNames.some(n => n && !ignoreCrashes.has(n));
        // Panel "crashed state" while java is still starting/running is a false
        // positive (MC Eternal Morph/recipe flood after EnderIO quarantine).
        if (
          !definiteCrash &&
          (lastState === "running" || lastState === "starting")
        ) {
          clearCrashSuspicion("ignoring panel crashed-state while still running");
          return;
        }
        if (
          !definiteCrash &&
          LOADING_PROGRESS_RE.test(recent)
        ) {
          clearCrashSuspicion("ignoring crash marker during active loading");
          return;
        }
        // History often replays "Minecraft has crashed" after grace while the
        // current boot is still loading Morph — require a NEW report or offline.
        if (
          definiteCrash &&
          !freshSaved &&
          lastState === "running" &&
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
      // Deduplicate spam (DawnCraft entity-attribute floods) so crash lines stay in the tail.
      if (tail.length === 0 || tail[tail.length - 1] !== line) {
        tail.push(line);
        if (tail.length > CONSOLE_TAIL_LINES) tail.shift();
      }
      if (
        !pullExtended &&
        /Finished pulling Docker container image/i.test(line)
      ) {
        pullExtended = true;
        pullFinishedAt = Date.now();
        // History that slipped past the flush window is pre-java — drop false crashes.
        clearCrashSuspicion(null);
        javaBootSeen = false;
        clearTimeout(timer);
        const extendMs = Math.max(timeoutMs, 600_000);
        timer = setTimeout(() => {
          finish(lastState === "running" && !crashSuspected ? "success" : "timeout");
        }, extendMs);
        msgLog.warn(
          `[boot-verify] ${serverId}: docker pull finished during boot watch — extended timeout by ${extendMs}ms`
        );
      }
      // Do not arm javaBootSeen from Wings history in the post-pull burst.
      if (JAVA_BOOT_RE.test(line) && !inPostPullGrace()) javaBootSeen = true;
      if (SUCCESS_RE.test(line)) finish("success");
      else if (LOADING_PROGRESS_RE.test(line) && crashSuspected && !definiteCrash) {
        clearCrashSuspicion("canceling crash suspicion — still loading");
      }
      else if (
        earlyBootCrashMarkers.some(re => re.test(line)) ||
        (
          javaBootSeen &&
          !inPostPullGrace() &&
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
        // Early-boot markers also count as java having started.
        if (earlyBootCrashMarkers.some(re => re.test(line))) javaBootSeen = true;
        crashSuspected = true;
        scheduleCrashFinish();
      }
    });

    ws.on("powerStateChange", state => {
      lastState = state;
      // Offline confirms death only for definite crashes after java actually started.
      // Panel "crashed state" + brief offline flaps otherwise kill healthy Morph boots.
      if (
        crashSuspected &&
        definiteCrash &&
        javaBootSeen &&
        !inPostPullGrace() &&
        (state === "offline" || state === "stopping") &&
        !settled
      ) {
        if (crashFlushTimer) {
          clearTimeout(crashFlushTimer);
          crashFlushTimer = null;
        }
        finish("crash");
      }
    });

    ws.on("error", () => { /* reconnect is handled internally; timer bounds us */ });

    ws.once("authenticated", async () => {
      // Let Wings finish replaying buffered console from the prior boot before
      // we start watching — otherwise EULA/crash markers from history fire
      // immediately and burn the attempt.
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

// Fetches the newest crash report, or null. Returns { name, text } so callers
// can detect when LaunchWrapper-style failures leave no new report and the
// previous crash would otherwise be re-attributed forever.
async function fetchLatestCrashReport(serverId, userId, preferredName = null) {
  // Wings often 500s listing/reading crash-reports right after a crash — retry
  // only on API failure (null), not when the directory is genuinely empty.
  let files = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    files = await listServerFiles(serverId, userId, "/crash-reports").catch(() => null);
    if (files !== null) break;
    await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
  }
  if (!files || files.length === 0) return null;

  const txtFiles = files.filter(f => f.attributes?.is_file && /\.txt$/i.test(f.attributes?.name ?? ""));
  if (txtFiles.length === 0) return null;

  // Prefer an explicit path from the console ("This crash report has been saved to").
  let newest = null;
  if (preferredName) {
    const base = String(preferredName).replace(/^.*\//, "");
    newest = txtFiles.find(f => f.attributes.name === base) ?? null;
  }
  if (!newest) {
    // Prefer *-server.txt over *-fml.txt / *-client.txt when timestamps tie —
    // FML reports are often stale leftover from an earlier attempt.
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

// Restores parked rescuable skips from mods-disabled/ back into mods/ when a
// MissingModsException names them — opposite of quarantine.
async function restoreParkedJars(ctx, jars) {
  const { serverId, userId, modIndex } = ctx;
  const moves = jars.map(jar => ({ from: `mods-disabled/${jar}`, to: `mods/${jar}` }));
  await renameServerFiles(serverId, userId, "/", moves).catch(() => {});
  for (const jar of jars) {
    if (modIndex) promoteParkedJar(modIndex, jar);
    msgLog.warn(`[boot-verify] restored parked dep ${jar} from mods-disabled/`);
  }
}

// When a crash names unbound registry namespaces (e.g. hexerei:willow_swamp) for
// mods that never landed on disk — or after we quarantine a mod — disable
// matching datapack/kubejs data + script folders so the next boot does not
// re-register dangling references (Create: Astral CustomMachinery codecs,
// Cottage Witch BYG kubejs tag hangs, ATM10 kubejs startup errors).
async function neutralizeUnboundNamespaces(ctx, namespaces) {
  const nsList = [ ...namespaces ].map(n => String(n).toLowerCase()).filter(Boolean);
  if (nsList.length === 0) return 0;
  const moves = [];
  const tryList = async dir => {
    const files = await listServerFiles(ctx.serverId, ctx.userId, dir).catch(() => null);
    return files ?? [];
  };
  const matchesNs = name => {
    const lower = String(name).toLowerCase();
    return nsList.some(ns => ns.length >= 3 && (lower === ns || lower.includes(ns)));
  };

  await createServerDirectory(ctx.serverId, ctx.userId, "/", "datapacks-disabled").catch(() => {});
  await createServerDirectory(ctx.serverId, ctx.userId, "/", "kubejs-data-disabled").catch(() => {});
  await createServerDirectory(ctx.serverId, ctx.userId, "/", "kubejs-scripts-disabled").catch(() => {});

  for (const entry of await tryList("/datapacks")) {
    const name = entry.attributes?.name;
    if (!name || entry.attributes?.is_file) continue;
    if (matchesNs(name)) {
      moves.push({ from: `datapacks/${name}`, to: `datapacks-disabled/${name}` });
    }
  }

  for (const entry of await tryList("/kubejs/data")) {
    const name = entry.attributes?.name;
    if (!name || entry.attributes?.is_file) continue;
    if (nsList.includes(name.toLowerCase()) || matchesNs(name)) {
      moves.push({ from: `kubejs/data/${name}`, to: `kubejs-data-disabled/${name}` });
      continue;
    }
    // Create: Astral keeps CustomMachinery machine JSON under pack namespaces
    // (e.g. kubejs/data/astral/machines), not kubejs/data/custommachinery.
    // Sibling recipe folders still reference those machines after CM is
    // quarantined — park every kubejs/data namespace once CM is unbound.
    if (nsList.some(ns => ns.includes("custommachinery"))) {
      moves.push({ from: `kubejs/data/${name}`, to: `kubejs-data-disabled/${name}` });
    }
  }

  for (const entry of await tryList("/world/datapacks")) {
    const name = entry.attributes?.name;
    if (!name || entry.attributes?.is_file) continue;
    if (matchesNs(name)) {
      moves.push({ from: `world/datapacks/${name}`, to: `datapacks-disabled/world-${name}` });
    }
  }

  // Script filenames often embed the mod id (byg_tags.js, custommachinery_*.js).
  for (const scriptsDir of [ "startup_scripts", "server_scripts", "client_scripts" ]) {
    for (const entry of await tryList(`/kubejs/${scriptsDir}`)) {
      const name = entry.attributes?.name;
      if (!name || !entry.attributes?.is_file) continue;
      if (!/\.(js|ts)$/i.test(name)) continue;
      if (matchesNs(name)) {
        moves.push({
          from: `kubejs/${scriptsDir}/${name}`,
          to: `kubejs-scripts-disabled/${scriptsDir}-${name}`
        });
      }
    }
  }

  if (moves.length === 0) return 0;
  await renameServerFiles(ctx.serverId, ctx.userId, "/", moves).catch(() => {});
  for (const m of moves) {
    msgLog.warn(`[boot-verify] neutralized unbound-namespace path: ${m.from}`);
  }
  // Drop the world so biome registry leftovers from the failed boot do not stick.
  await deleteServerFiles(ctx.serverId, ctx.userId, [ "world" ]).catch(() => {});
  return moves.length;
}

async function neutralizeKubejsScriptTree(ctx, scriptsDir) {
  const entries = await listServerFiles(ctx.serverId, ctx.userId, `/kubejs/${scriptsDir}`).catch(() => null);
  if (!entries?.length) return 0;
  await createServerDirectory(ctx.serverId, ctx.userId, "/", "kubejs-scripts-disabled").catch(() => {});
  const moves = entries
    .map(e => e.attributes?.name)
    .filter(n => typeof n === "string")
    .map(name => ({
      from: `kubejs/${scriptsDir}/${name}`,
      to: `kubejs-scripts-disabled/${scriptsDir}-${name}`
    }));
  if (moves.length === 0) return 0;
  await renameServerFiles(ctx.serverId, ctx.userId, "/", moves).catch(() => {});
  for (const m of moves) {
    msgLog.warn(`[boot-verify] neutralized kubejs tree path: ${m.from}`);
  }
  return moves.length;
}

// Undo an over-aggressive startup_scripts park for pack-defining folders/files.
async function restoreParkedKubejsStartupDirs(ctx, nameHints = []) {
  const hints = nameHints.map(h => String(h).toLowerCase()).filter(Boolean);
  if (hints.length === 0) return 0;
  const disabled = await listServerFiles(ctx.serverId, ctx.userId, "/kubejs-scripts-disabled").catch(() => null);
  if (!disabled?.length) return 0;
  const moves = [];
  for (const e of disabled) {
    const name = e.attributes?.name;
    if (!name) continue;
    const lower = name.toLowerCase();
    if (!hints.some(h => lower.includes(h.replace(/\//g, "%2f")) || lower.includes(h))) continue;

    let dest = null;
    // New encoding: encodeURIComponent(rel) e.g. startup_scripts%2FModern-Industrialization%2Fatm_stuff.js
    try {
      const decoded = decodeURIComponent(name);
      if (decoded.includes("_scripts/") && decoded !== name) {
        dest = `kubejs/${decoded}`;
      }
    } catch { /* not URI-encoded */ }
    // Legacy tree park: startup_scripts-<dirname>
    if (!dest && lower.startsWith("startup_scripts-") && !/\.(js|ts)$/i.test(name)) {
      dest = `kubejs/startup_scripts/${name.slice("startup_scripts-".length)}`;
    }
    // Legacy file park: startup_scripts-Modern-Industrialization-atm_stuff.js
    if (!dest && lower.startsWith("startup_scripts-") && /\.(js|ts)$/i.test(name)) {
      const rest = name.slice("startup_scripts-".length);
      // Best-effort: first segment may contain hyphens (Modern-Industrialization).
      for (const hint of nameHints) {
        const h = String(hint);
        if (rest.toLowerCase().startsWith(h.toLowerCase())) {
          const after = rest.slice(h.length).replace(/^-/, "");
          dest = after
            ? `kubejs/startup_scripts/${h}/${after.replace(/-/g, "/")}`
            : `kubejs/startup_scripts/${h}`;
          break;
        }
      }
    }
    if (!dest) continue;
    moves.push({ from: `kubejs-scripts-disabled/${name}`, to: dest });
  }
  if (moves.length === 0) return 0;
  await renameServerFiles(ctx.serverId, ctx.userId, "/", moves).catch(() => {});
  for (const m of moves) {
    msgLog.warn(`[boot-verify] restored kubejs startup path: ${m.to}`);
  }
  return moves.length;
}

// Dedicated servers on headless Docker images crash when AWT loads (BYG Color,
// server-icon.png → Component.<clinit>). NEVER replace unix_args.txt — eggs put
// the main class / classpath there; overwriting it yields
// "Could not find or load main class @unix_args.txt".
// Prefer user_jvm_args.txt when the egg reads it; also INSERT the flag into a
// readable, valid unix_args.txt (before the main class) for Forge eggs that
// only launch with `@unix_args.txt`.
function insertJvmFlagBeforeMainClass(argfileText, flag) {
  if (!argfileText) return argfileText;
  // Remove contradictory headless=false so our true wins.
  const text = argfileText.replace(/-Djava\.awt\.headless=false\b/g, "");
  if (text.includes("java.awt.headless")) return text;
  const lines = text.split(/\r?\n/);
  let insertAt = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith("#")) {
      insertAt = i + 1;
      continue;
    }
    if (
      t.startsWith("-X") || t.startsWith("-D") || t.startsWith("-javaagent") ||
      t === "-cp" || t === "-classpath" || t === "--add-opens" || t === "--add-exports" ||
      t.startsWith("--add-opens=") || t.startsWith("--add-exports=")
    ) {
      insertAt = i + 1;
      if (t === "-cp" || t === "-classpath" || t === "--add-opens" || t === "--add-exports") {
        insertAt = Math.min(i + 2, lines.length);
      }
      continue;
    }
    break; // main class or launcher args
  }
  lines.splice(insertAt, 0, flag);
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function looksLikeValidJvmArgfile(text) {
  if (!text || text.length < 20) return false;
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 3) return false;
  return /-jar|\bnogui\b|cpw\.mods|neoforged|minecraftforge|fabricmc|BootstrapLauncher/i.test(text);
}

async function writeServerFileOk(ctx, filePath, contents) {
  for (let tryNum = 1; tryNum <= 3; tryNum++) {
    const status = await writeServerFile(ctx.serverId, ctx.userId, filePath, contents);
    if (status === 204 || status === 200) return true;
    msgLog.warn(`[boot-verify] ${ctx.serverId}: write ${filePath} returned ${status} (try ${tryNum}/3)`);
    await new Promise(r => setTimeout(r, 1500 * tryNum));
  }
  return false;
}

// 1.19.x DedicatedServer loads AWT via Component when server-icon.png exists.
// Other 1.19.2 packs boot fine without an icon; Cottage Witch ships one.
async function removeServerIconFiles(ctx) {
  const names = new Set([ "server-icon.png", "server-icon.jpg", "server-icon.jpeg", "icon.png" ]);
  const root = await listServerFiles(ctx.serverId, ctx.userId, "/").catch(() => null);
  for (const f of root ?? []) {
    const name = f.attributes?.name;
    if (name && /server-?icon/i.test(name)) names.add(name);
  }
  const list = [ ...names ];
  if (list.length === 0) return 0;
  await deleteServerFiles(ctx.serverId, ctx.userId, list).catch(() => {});
  return list.length;
}

function isAwtLinkCrash(consoleTail) {
  if (/AWTError:.*DISPLAY|Can't connect to X11 window server|MinecraftServerGui/i.test(consoleTail)) {
    return true;
  }
  const link = /UnsatisfiedLinkError:.*(?:libawt|libXrender|libXtst|libXi|GLIBC_[\d.]+)/i.test(consoleTail);
  const awtCtx = /(?:DedicatedServer|java\.awt\.(?:Component|Color|Toolkit)|biomesyougo|\bbyg\b|\/home\/container\/native\/)/i.test(consoleTail);
  return link && awtCtx;
}

// Prior boot-verify builds prefixed `rm`/`export` onto egg startup. That breaks
// multiline Forge eggs (`java -version` then `java -jar {{SERVER_JARFILE}}`) and
// can leave SERVER_JARFILE stuck on missing server.jar. Strip our wrappers only.
function stripEggStartupWrappers(startup) {
  let s = String(startup ?? "").trim();
  if (!s) return s;
  for (let i = 0; i < 8; i++) {
    const next = s
      .replace(/^\s*rm -f server-icon\.png server-icon\.jpg server-icon\.jpeg\s*;\s*/i, "")
      .replace(/^\s*export\s+JAVA_TOOL_OPTIONS=\S+\s*;\s*/i, "")
      .replace(/^\s*export\s+_JAVA_OPTIONS=\S+\s*;\s*/i, "")
      .replace(/^\s*export\s+LD_LIBRARY_PATH=[^\n;]*;?\s*/i, "")
      .replace(/^\s*LD_LIBRARY_PATH="[^"]*"\s+/i, "")
      .replace(/^\s*_JAVA_OPTIONS=\S+\s+/i, "")
      .replace(/^\s*JAVA_TOOL_OPTIONS=\S+\s+/i, "")
      .replace(/^\s*LD_LIBRARY_PATH=\S+\s+/i, "")
      .replace(/\s+-Djava\.awt\.headless=true\b/g, "")
      .trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

async function patchEggStartup(ctx, mutate) {
  try {
    const infoRes = await getServerInfoById(ctx.serverId, ctx.userId);
    if (infoRes.statusCode !== 200) return false;
    const info = await infoRes.body.json();
    const internalId = info?.attributes?.internal_id;
    if (!internalId) return false;
    const appRes = await applicationApiCall(`application/servers/${internalId}`, "GET");
    if (appRes.statusCode !== 200) return false;
    const app = await appRes.body.json();
    const attrs = app?.attributes;
    const container = attrs?.container;
    if (!attrs || !container) return false;

    const beforeStartup = String(container.startup_command ?? attrs.startup ?? "");
    const environment = { ...(container.environment ?? {}) };
    const result = mutate({ startup: beforeStartup, environment });
    if (!result || result.changed === false) return true;

    const startup = result.startup ?? beforeStartup;
    const body = JSON.stringify({
      startup,
      environment: result.environment ?? environment,
      egg: attrs.egg ?? attrs.egg_id,
      image: container.image,
      skip_scripts: true
    });
    const patch = await applicationApiCall(`application/servers/${internalId}/startup`, "PATCH", body);
    if (patch.statusCode === 200 || patch.statusCode === 204) {
      msgLog.log(`[boot-verify] ${ctx.serverId}: patched egg startup (${result.reason || "updated"})`);
      return true;
    }
    msgLog.warn(`[boot-verify] ${ctx.serverId}: startup patch returned ${patch.statusCode}`);
    return false;
  } catch (err) {
    msgLog.warn(`[boot-verify] ${ctx.serverId}: startup patch failed: ${err.message}`);
    return false;
  }
}

// Icon removal is file-delete only — never rewrite egg startup for this.

// Only set env JAVA_TOOL_OPTIONS / _JAVA_OPTIONS. Never rewrite the startup
// command string (multiline eggs + SERVER_JARFILE break when we prefix rm/export).
async function ensureHeadlessInEggStartup(ctx) {
  const flag = "-Djava.awt.headless=true";
  return patchEggStartup(ctx, ({ startup, environment }) => {
    let changed = false;
    const cleaned = stripEggStartupWrappers(startup);
    if (cleaned !== startup) {
      startup = cleaned;
      changed = true;
    }
    {
      const cur = String(environment.JAVA_TOOL_OPTIONS ?? "");
      if (!cur.includes("java.awt.headless")) {
        environment.JAVA_TOOL_OPTIONS = `${cur} ${flag}`.trim();
        changed = true;
      }
    }
    {
      const cur = String(environment._JAVA_OPTIONS ?? "");
      if (!cur.includes("java.awt.headless")) {
        environment._JAVA_OPTIONS = `${cur} ${flag}`.trim();
        changed = true;
      }
    }
    if (Object.prototype.hasOwnProperty.call(environment, "DISPLAY") && environment.DISPLAY) {
      environment.DISPLAY = "";
      changed = true;
    }
    // Always try to clear DISPLAY even when the egg did not define the key —
    // some yolks inject :0.0 at runtime and that forces MinecraftServerGui.
    if (!Object.prototype.hasOwnProperty.call(environment, "DISPLAY")) {
      environment.DISPLAY = "";
      changed = true;
    }
    for (const key of [ "JAVA_ARGS", "EXTRA_ARGS", "JVM_ARGS", "JVM_OPTIONS" ]) {
      if (!(key in environment)) continue;
      const cur = String(environment[key] ?? "");
      if (cur.includes("java.awt.headless")) continue;
      environment[key] = `${cur} ${flag}`.trim();
      changed = true;
    }
    if (!changed) return { changed: false };
    return {
      startup,
      environment,
      changed: true,
      reason: "headless env (+unwrap prior startup hacks)"
    };
  });
}

async function ensureHeadlessJvmArgs(ctx) {
  const flag = "-Djava.awt.headless=true";
  let applied = false;

  // 0) Egg startup / JAVA_ARGS — most reliable when file writes fail.
  if (await ensureHeadlessInEggStartup(ctx)) applied = true;

  // 1) user_jvm_args.txt (NeoForge / modern eggs that `@` this file).
  {
    const name = "user_jvm_args.txt";
    const existing = await getFileContents(ctx.serverId, ctx.userId, `/${name}`);
    if (existing === null) {
      const root = await listServerFiles(ctx.serverId, ctx.userId, "/").catch(() => null);
      const present = (root ?? []).some(f => f.attributes?.name === name);
      if (present) {
        msgLog.warn(`[boot-verify] ${ctx.serverId}: skip ${name} headless — could not read existing file`);
      } else if (await writeServerFileOk(ctx, `/${name}`, `${flag}\n`)) {
        msgLog.log(`[boot-verify] ${ctx.serverId}: wrote ${flag} to /${name}`);
        applied = true;
      }
    } else if (existing.includes("java.awt.headless")) {
      applied = true;
    } else {
      const next = existing.trim() ? `${existing.trim()}\n${flag}\n` : `${flag}\n`;
      if (await writeServerFileOk(ctx, `/${name}`, next)) {
        msgLog.log(`[boot-verify] ${ctx.serverId}: wrote ${flag} to /${name}`);
        applied = true;
      }
    }
  }

  // 2) Insert into unix_args.txt when we have a valid template (root or libraries).
  {
    let unix = await getFileContents(ctx.serverId, ctx.userId, "/unix_args.txt");
    let libraryPath = null;
    if ((!unix || !looksLikeValidJvmArgfile(unix)) && !unix?.includes("java.awt.headless")) {
      for (const base of [
        "libraries/net/minecraftforge/forge",
        "libraries/net/neoforged/neoforge"
      ]) {
        const versions = await listServerFiles(ctx.serverId, ctx.userId, `/${base}`).catch(() => null);
        for (const v of versions ?? []) {
          const ver = v.attributes?.name;
          if (!ver || v.attributes?.is_file) continue;
          const rel = `${base}/${ver}/unix_args.txt`;
          const candidate = await getFileContents(ctx.serverId, ctx.userId, `/${rel}`);
          if (candidate && looksLikeValidJvmArgfile(candidate)) {
            unix = candidate;
            libraryPath = rel;
            break;
          }
        }
        if (unix && looksLikeValidJvmArgfile(unix)) break;
      }
    }
    if (unix && unix.includes("java.awt.headless")) {
      applied = true;
    } else if (unix && looksLikeValidJvmArgfile(unix)) {
      const next = insertJvmFlagBeforeMainClass(unix, flag);
      const wroteRoot = await writeServerFileOk(ctx, "/unix_args.txt", next);
      const wroteLib = libraryPath
        ? await writeServerFileOk(ctx, `/${libraryPath}`, next)
        : false;
      if (wroteRoot) {
        msgLog.log(`[boot-verify] ${ctx.serverId}: inserted ${flag} into /unix_args.txt`);
        applied = true;
      }
      if (wroteLib) {
        msgLog.log(`[boot-verify] ${ctx.serverId}: inserted ${flag} into /${libraryPath}`);
        applied = true;
      }
      // Eggs often symlink root unix_args → libraries/...; if root write failed
      // but library succeeded, replace the root file so `@unix_args.txt` is current.
      if (wroteLib && !wroteRoot) {
        await deleteServerFiles(ctx.serverId, ctx.userId, [ "unix_args.txt" ]).catch(() => {});
        if (await writeServerFileOk(ctx, "/unix_args.txt", next)) {
          msgLog.log(`[boot-verify] ${ctx.serverId}: rewrote /unix_args.txt after library patch`);
          applied = true;
        }
      }
      if (!wroteRoot && !wroteLib) {
        msgLog.warn(`[boot-verify] ${ctx.serverId}: unix_args headless insert failed after retries`);
      }
    }
  }

  // 3) DedicatedServer opens MinecraftServerGui without `nogui` — that forces
  // X11 even when headless=true (Cottage Witch AWTError on DISPLAY=:0.0).
  if (await ensureNoguiInUnixArgs(ctx)) applied = true;

  return applied;
}

async function ensureNoguiInUnixArgs(ctx) {
  const patch = async rel => {
    const text = await getFileContents(ctx.serverId, ctx.userId, `/${rel}`);
    if (!text || !looksLikeValidJvmArgfile(text)) return false;
    if (/(?:^|\s)nogui(?:\s|$)/m.test(text)) return true;
    const next = `${text.trimEnd()}\nnogui\n`;
    if (await writeServerFileOk(ctx, `/${rel}`, next)) {
      msgLog.log(`[boot-verify] ${ctx.serverId}: appended nogui to /${rel}`);
      return true;
    }
    return false;
  };
  let ok = await patch("unix_args.txt");
  for (const base of [
    "libraries/net/minecraftforge/forge",
    "libraries/net/neoforged/neoforge"
  ]) {
    const versions = await listServerFiles(ctx.serverId, ctx.userId, `/${base}`).catch(() => null);
    for (const v of versions ?? []) {
      const ver = v.attributes?.name;
      if (!ver || v.attributes?.is_file) continue;
      if (await patch(`${base}/${ver}/unix_args.txt`)) ok = true;
    }
  }
  return ok;
}

// If SERVER_JARFILE points at a missing server.jar, point it at a Forge/NeoForge
// jar still on disk (common after egg startup patches reset the env default).
async function repairMissingServerJar(ctx, consoleTail = "") {
  if (!/Unable to access jarfile/i.test(consoleTail)) return false;
  const root = await listServerFiles(ctx.serverId, ctx.userId, "/").catch(() => null);
  const names = (root ?? []).map(f => f.attributes?.name).filter(Boolean);
  let jar =
    names.find(n => /^forge-.*-universal\.jar$/i.test(n)) ||
    names.find(n => /^forge-.*\.jar$/i.test(n) && !/installer/i.test(n)) ||
    names.find(n => /^neoforge-.*\.jar$/i.test(n) && !/installer/i.test(n)) ||
    names.find(n => /^minecraft_server.*\.jar$/i.test(n)) ||
    names.find(n => n === "server.jar");
  // Forge installer layout: libraries/net/minecraftforge/forge/<ver>/forge-*-universal.jar
  if (!jar) {
    for (const base of [
      "libraries/net/minecraftforge/forge",
      "libraries/net/neoforged/neoforge"
    ]) {
      const versions = await listServerFiles(ctx.serverId, ctx.userId, `/${base}`).catch(() => null);
      for (const v of versions ?? []) {
        const ver = v.attributes?.name;
        if (!ver || v.attributes?.is_file) continue;
        const files = await listServerFiles(ctx.serverId, ctx.userId, `/${base}/${ver}`).catch(() => null);
        const hit = (files ?? [])
          .map(f => f.attributes?.name)
          .find(n => n && /\.jar$/i.test(n) && !/installer|shim/i.test(n));
        if (hit) {
          jar = hit;
          // Copy basename into root as server.jar for eggs that hardcode it.
          const contents = await getFileContents(ctx.serverId, ctx.userId, `/${base}/${ver}/${hit}`);
          if (contents !== null) {
            // Binary jars cannot be written via text contents API — set SERVER_JARFILE
            // to the relative libraries path instead when the egg expands it.
            msgLog.warn(
              `[boot-verify] ${ctx.serverId}: found loader jar at ${base}/${ver}/${hit}`
            );
          }
          return patchEggStartup(ctx, ({ startup, environment }) => {
            const cleaned = stripEggStartupWrappers(startup);
            environment.SERVER_JARFILE = `${base}/${ver}/${hit}`;
            if ("SERVER_JAR" in environment) environment.SERVER_JAR = environment.SERVER_JARFILE;
            return {
              startup: cleaned,
              environment,
              changed: true,
              reason: `SERVER_JARFILE=${environment.SERVER_JARFILE}`
            };
          });
        }
      }
    }
  }
  if (!jar) {
    // Last resort: prefer @unix_args / run scripts over -jar server.jar.
    const hasUnix = names.includes("unix_args.txt") || names.includes("user_jvm_args.txt");
    if (hasUnix) {
      return patchEggStartup(ctx, ({ startup, environment }) => {
        const cleaned = stripEggStartupWrappers(startup);
        let next = cleaned;
        if (/server\.jar/i.test(next) && !/@unix_args/i.test(next)) {
          next = next.replace(
            /-jar\s+\{\{SERVER_JARFILE\}\}|-jar\s+server\.jar/i,
            "@unix_args.txt"
          );
        }
        if (next === cleaned && String(environment.SERVER_JARFILE ?? "") === "server.jar") {
          // Can't invent a jar — unwrap startup so a later install can recover.
          return { startup: cleaned, environment, changed: cleaned !== startup, reason: "unwrap after missing server.jar" };
        }
        return {
          startup: next,
          environment,
          changed: next !== startup,
          reason: "prefer @unix_args over missing server.jar"
        };
      });
    }
    msgLog.warn(`[boot-verify] ${ctx.serverId}: Unable to access jarfile but no forge/server jar found`);
    return false;
  }
  return patchEggStartup(ctx, ({ startup, environment }) => {
    const cleaned = stripEggStartupWrappers(startup);
    const cur = String(environment.SERVER_JARFILE ?? environment.SERVER_JAR ?? "");
    if (cur === jar && names.includes(cur) && cleaned === startup) return { changed: false };
    environment.SERVER_JARFILE = jar;
    if ("SERVER_JAR" in environment) environment.SERVER_JAR = jar;
    msgLog.warn(`[boot-verify] ${ctx.serverId}: set SERVER_JARFILE=${jar}`);
    return {
      startup: cleaned,
      environment,
      changed: true,
      reason: `SERVER_JARFILE=${jar}`
    };
  });
}

// If a prior boot-verify wiped unix_args.txt down to only -Djava.awt.headless,
// try to restore a copy from the Forge/NeoForge installer libraries tree.
async function repairCorruptedUnixArgs(ctx, consoleTail = "") {
  if (
    !/Could not find or load main class @unix_args/i.test(consoleTail) &&
    !/Usage: java|enable system assertions|--help-extra/i.test(consoleTail)
  ) {
    return false;
  }
  const cur = await getFileContents(ctx.serverId, ctx.userId, "/unix_args.txt");
  if (cur && /-jar|\bnogui\b|cpw\.mods|neoforged|minecraftforge|fabricmc/i.test(cur) &&
      cur.split("\n").length > 3) {
    return false; // looks intact
  }

  const tryCopy = async rel => {
    const text = await getFileContents(ctx.serverId, ctx.userId, `/${rel}`);
    if (!text || text.length < 20) return false;
    if (!/-jar|\bnogui\b|cpw\.mods|neoforged|minecraftforge/i.test(text)) return false;
    await writeServerFile(ctx.serverId, ctx.userId, "/unix_args.txt", text);
    msgLog.warn(`[boot-verify] ${ctx.serverId}: restored /unix_args.txt from /${rel}`);
    return true;
  };

  for (const base of [
    "libraries/net/minecraftforge/forge",
    "libraries/net/neoforged/neoforge"
  ]) {
    const versions = await listServerFiles(ctx.serverId, ctx.userId, `/${base}`).catch(() => null);
    for (const v of versions ?? []) {
      const ver = v.attributes?.name;
      if (!ver || v.attributes?.is_file) continue;
      if (await tryCopy(`${base}/${ver}/unix_args.txt`)) return true;
      if (await tryCopy(`${base}/${ver}/win_args.txt`)) return true;
    }
  }
  return false;
}

async function rescueJeidFromParked(ctx) {
  const dirs = [ "mods-client-only", "mods-disabled", "mods-parked" ];
  const moves = [];
  await createServerDirectory(ctx.serverId, ctx.userId, "/", "mods").catch(() => {});
  for (const dir of dirs) {
    const entries = await listServerFiles(ctx.serverId, ctx.userId, `/${dir}`).catch(() => null);
    for (const e of entries ?? []) {
      const name = e.attributes?.name;
      if (!name || !/\.jar$/i.test(name)) continue;
      if (!/jeid|justenoughids|notenoughids|neid/i.test(name)) continue;
      moves.push({ from: `${dir}/${name}`, to: `mods/${name}` });
    }
  }
  if (moves.length === 0) return 0;
  await renameServerFiles(ctx.serverId, ctx.userId, "/", moves).catch(() => {});
  for (const m of moves) {
    msgLog.warn(`[boot-verify] rescued JEID jar: ${m.from} → ${m.to}`);
  }
  return moves.length;
}

function isJeidJarName(name) {
  return /jeid|justenoughids|notenoughids|\bneid\b/i.test(String(name || ""));
}

async function jeidAlreadyPresent(ctx) {
  for (const dir of [ "mods", "mods-disabled", "mods-client-only", "mods-parked" ]) {
    const entries = await listServerFiles(ctx.serverId, ctx.userId, `/${dir}`).catch(() => null);
    for (const e of entries ?? []) {
      const name = e.attributes?.name;
      if (name && /\.jar$/i.test(name) && isJeidJarName(name)) return true;
    }
  }
  return false;
}

function pickJeidFile(files) {
  const list = Array.isArray(files) ? files : [];
  const for112 = list.filter(f => (f.gameVersions || []).includes("1.12.2"));
  const pool = for112.length > 0 ? for112 : list;
  return pool.find(f => f.fileName === JEID_PREFERRED_FILE)
    || pool.find(f => f.fileName && !/thin/i.test(f.fileName) && /\.jar$/i.test(f.fileName))
    || pool[0]
    || null;
}

async function uploadJarToMods(ctx, filename, buffer) {
  await createServerDirectory(ctx.serverId, ctx.userId, "/", "mods").catch(() => {});
  const zip = new AdmZip();
  zip.addFile(`mods/${filename}`, buffer, "", 0o100644 << 16);
  const zipName = `_boot_verify_${filename.replace(/[^\w.-]+/g, "_")}.zip`;
  const uploadUrl = await getFileUploadUrl(ctx.serverId, ctx.userId);
  if (!uploadUrl) throw new Error("no upload URL for JEID install");
  const uploadRes = await uploadBufferToServer(uploadUrl, zipName, zip.toBuffer());
  if (!uploadRes.ok) throw new Error(`JEID upload HTTP ${uploadRes.status}`);
  await decompressFile(ctx.serverId, ctx.userId, "/", zipName);
  await chmodServerFiles(ctx.serverId, ctx.userId, "/", [ { file: `mods/${filename}`, mode: "644" } ]).catch(() => {});
  await deleteServerFiles(ctx.serverId, ctx.userId, [ zipName ]).catch(() => {});
}

// Download JustEnoughIDs into mods/ when a 1.12 pack hits registry ID overflow
// and the jar was never shipped (MeatballCraft). Returns true if a jar was added.
async function ensureJeidInstalled(ctx) {
  if (await jeidAlreadyPresent(ctx)) return false;
  if (!process.env.CURSEFORGE_API_KEY) {
    msgLog.warn(`[boot-verify] ${ctx.serverId}: cannot download JEID (no CURSEFORGE_API_KEY)`);
    return false;
  }
  const files = await getModpackFiles(JEID_CURSEFORGE_MOD_ID);
  const file = pickJeidFile(files);
  if (!file?.fileName) {
    msgLog.warn(`[boot-verify] ${ctx.serverId}: no JEID 1.12.2 file on CurseForge`);
    return false;
  }
  const url = file.downloadUrl || synthesizeCurseForgeCdnUrl(file.id, file.fileName);
  if (!url) {
    msgLog.warn(`[boot-verify] ${ctx.serverId}: JEID file ${file.fileName} has no download URL`);
    return false;
  }
  const buffer = await downloadFile(url);
  await uploadJarToMods(ctx, file.fileName, buffer);
  msgLog.warn(`[boot-verify] ${ctx.serverId}: installed ${file.fileName} into mods/ (registry ID fix)`);
  return true;
}

function tarExtractDebMember(debPath, workDir) {
  const r = spawnSync("tar", [ "-xf", debPath, "-C", workDir ], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`tar extract deb failed: ${r.stderr || r.stdout || r.status}`);
  }
}

function findDataTar(workDir) {
  for (const name of fs.readdirSync(workDir)) {
    if (/^data\.tar\./i.test(name)) return path.join(workDir, name);
  }
  return null;
}

function listTarEntries(archivePath) {
  const r = spawnSync("tar", [ "-tf", archivePath ], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`tar list failed: ${r.stderr || r.stdout || r.status}`);
  }
  return String(r.stdout || "").split(/\r?\n/).filter(Boolean);
}

function extractTarMemberToFile(archivePath, member, outPath) {
  const r = spawnSync("tar", [ "-xOf", archivePath, member ], { encoding: "buffer", maxBuffer: 20 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout || r.stdout.length === 0) {
    throw new Error(`tar extract member failed: ${member}: ${r.stderr || r.status}`);
  }
  fs.writeFileSync(outPath, r.stdout);
}

function pickSharedObjectMember(entries, soname) {
  // Prefer the real library (libFoo.so.N.M.P) over the soname symlink (libFoo.so.N).
  const base = soname.replace(/\.so\.\d+$/i, ".so.");
  const real = entries
    .filter(e => {
      const leaf = e.split("/").pop();
      return leaf && leaf.startsWith(base) && /^lib.+\.so\.\d+\.\d+/.test(leaf);
    })
    .sort((a, b) => b.length - a.length);
  if (real.length > 0) return real[0];
  return entries.find(e => e.split("/").pop() === soname) || null;
}

async function extractX11NativesToDir(destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const written = [];
  for (const deb of X11_NATIVE_DEBS) {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pterobot-x11-"));
    try {
      const debPath = path.join(workDir, path.basename(new URL(deb.url).pathname));
      const buf = await downloadFile(deb.url);
      fs.writeFileSync(debPath, buf);
      tarExtractDebMember(debPath, workDir);
      const dataTar = findDataTar(workDir);
      if (!dataTar) throw new Error(`no data.tar in ${path.basename(debPath)}`);
      const member = pickSharedObjectMember(listTarEntries(dataTar), deb.soname);
      if (!member) throw new Error(`no ${deb.soname} in ${path.basename(debPath)}`);
      const outPath = path.join(destDir, deb.soname);
      extractTarMemberToFile(dataTar, member, outPath);
      written.push(deb.soname);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
  return written;
}

async function uploadNativeLibs(ctx, localDir, filenames) {
  await createServerDirectory(ctx.serverId, ctx.userId, "/", "native").catch(() => {});
  const zip = new AdmZip();
  for (const name of filenames) {
    zip.addFile(`native/${name}`, fs.readFileSync(path.join(localDir, name)), "", 0o100755 << 16);
  }
  const zipName = "_boot_verify_native_x11.zip";
  const uploadUrl = await getFileUploadUrl(ctx.serverId, ctx.userId);
  if (!uploadUrl) throw new Error("no upload URL for native libs");
  const uploadRes = await uploadBufferToServer(uploadUrl, zipName, zip.toBuffer());
  if (!uploadRes.ok) throw new Error(`native upload HTTP ${uploadRes.status}`);
  await decompressFile(ctx.serverId, ctx.userId, "/", zipName);
  await chmodServerFiles(
    ctx.serverId, ctx.userId, "/",
    filenames.map(file => ({ file: `native/${file}`, mode: "755" }))
  ).catch(() => {});
  await deleteServerFiles(ctx.serverId, ctx.userId, [ zipName ]).catch(() => {});
}

// Eggs only expose a fixed env-var allowlist — LD_LIBRARY_PATH is dropped from
// container.environment on PATCH. Prefix the java command itself (not a separate
// `export` line): Elytra/Wings may not keep newline-separated exports in the
// same shell as the JVM, which left Cottage Witch still missing libXrender.
const LD_LIBRARY_PREFIX =
  "DISPLAY= LD_LIBRARY_PATH=\"/home/container/native${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}\" ";

function injectLdLibraryPathPrefix(startup) {
  const s = stripEggStartupWrappers(String(startup ?? ""));
  if (!s) return s;
  if (/^\s*(?:DISPLAY=\s*)?LD_LIBRARY_PATH=.*\/home\/container\/native/im.test(s)) return s;
  if (/^\s*java\b/m.test(s)) {
    return s.replace(/^(\s*)java\b/m, `$1${LD_LIBRARY_PREFIX}java`);
  }
  return `${LD_LIBRARY_PREFIX}${s}`;
}

async function ensureLdLibraryPath(ctx) {
  return patchEggStartup(ctx, ({ startup, environment }) => {
    const next = injectLdLibraryPathPrefix(startup);
    let changed = next !== String(startup ?? "").trim();
    // Best-effort: some panels keep custom keys; harmless if stripped.
    if (!String(environment.LD_LIBRARY_PATH ?? "").includes("/home/container/native")) {
      environment.LD_LIBRARY_PATH = "/home/container/native";
      changed = true;
    }
    if (!changed) return { changed: false };
    return {
      startup: next,
      environment,
      changed: true,
      reason: "inline LD_LIBRARY_PATH for native/ X11 libs"
    };
  });
}

// Upload Ubuntu X11 shared libs into /native and set LD_LIBRARY_PATH so
// Temurin's libawt_xawt can load on headless yolks (libXrender missing).
async function ensureX11NativeLibs(ctx, { forceRefresh = false } = {}) {
  const needed = new Set(X11_NATIVE_DEBS.map(d => d.soname));
  const existing = await listServerFiles(ctx.serverId, ctx.userId, "/native").catch(() => null);
  const have = new Set((existing ?? []).map(e => e.attributes?.name).filter(Boolean));
  const missing = [ ...needed ].filter(n => !have.has(n));
  if (forceRefresh || missing.length > 0) {
    if (forceRefresh && have.size > 0) {
      await deleteServerFiles(
        ctx.serverId, ctx.userId,
        [ ...have ].map(n => `native/${n}`)
      ).catch(() => {});
    }
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), "pterobot-native-"));
    try {
      const names = await extractX11NativesToDir(destDir);
      await uploadNativeLibs(ctx, destDir, names);
      msgLog.warn(`[boot-verify] ${ctx.serverId}: uploaded X11 natives: ${names.join(", ")}`);
    } finally {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
  }
  await ensureLdLibraryPath(ctx);
  return true;
}

// KubeJS hard-fails the whole loader on startup script syntax errors. Pull
// referenced .js paths from logs/kubejs/startup.log and disable those files.
async function neutralizeKubejsScriptErrors(ctx, consoleTail = "") {
  if (!/KubeJS startup script syntax errors|There were KubeJS .* script .* errors|Error loading script/i.test(consoleTail)) {
    return 0;
  }
  let logText = "";
  try {
    logText = await getFileContents(ctx.serverId, ctx.userId, "/logs/kubejs/startup.log") || "";
  } catch { /* optional */ }
  if (!logText) {
    try {
      logText = await getFileContents(ctx.serverId, ctx.userId, "/logs/kubejs/server.log") || "";
    } catch { /* optional */ }
  }
  const combined = `${consoleTail}\n${logText}`;
  const files = new Set();
  for (const m of combined.matchAll(/(?:kubejs\/)?((?:startup|server|client)_scripts\/[^\s:'"()#]+\.(?:js|ts))/gi)) {
    files.add(m[1].replace(/\\/g, "/"));
  }
  // Bare filenames next to "Error loading script" / Rhino "(file.js#12)".
  for (const m of combined.matchAll(/Error loading script[:\s]+['"]?([^\s'"]+\.(?:js|ts))/gi)) {
    const rel = m[1].replace(/\\/g, "/");
    if (rel.includes("_scripts/")) files.add(rel.replace(/^.*?((?:startup|server|client)_scripts\/)/i, "$1"));
    else files.add(rel.split("/").pop());
  }
  for (const m of combined.matchAll(/\(([A-Za-z0-9_./\\-]+\.(?:js|ts))#\d+\)/g)) {
    const rel = m[1].replace(/\\/g, "/");
    files.add(rel.includes("_scripts/") ? rel.replace(/^.*?((?:startup|server|client)_scripts\/)/i, "$1") : rel.split("/").pop());
  }
  // KubeJS 6: "[ERROR] ! path/to/Script.js: ..." or "Script.js#12:"
  for (const m of combined.matchAll(
    /\[ERROR\][^\n]*?(?:startup_scripts\/)?([A-Za-z0-9_ .'/-]+\.(?:js|ts))/gi
  )) {
    const rel = m[1].replace(/\\/g, "/").trim();
    if (rel.includes("_scripts/")) files.add(rel.replace(/^.*?((?:startup|server|client)_scripts\/)/i, "$1"));
    else if (rel.includes("/")) files.add(`startup_scripts/${rel}`);
    else files.add(rel.split("/").pop());
  }
  // Resolve bare filenames under startup_scripts/ (incl. nested category dirs).
  const resolved = new Set();
  const listDeepJs = async (scriptsDir, maxDepth = 2) => {
    const out = [];
    const walk = async (rel, depth) => {
      const entries = await listServerFiles(ctx.serverId, ctx.userId, `/kubejs/${rel}`).catch(() => null);
      for (const e of entries ?? []) {
        const name = e.attributes?.name;
        if (!name) continue;
        const child = `${rel}/${name}`;
        if (e.attributes?.is_file) {
          if (/\.(js|ts)$/i.test(name)) out.push(child);
          continue;
        }
        if (depth < maxDepth) await walk(child, depth + 1);
      }
    };
    await walk(scriptsDir, 0);
    return out;
  };

  const allStartupJs = await listDeepJs("startup_scripts");
  const allServerJs = await listDeepJs("server_scripts");
  const allJs = [ ...allStartupJs, ...allServerJs ];

  for (const rel of files) {
    const norm = rel.replace(/\\/g, "/");
    const base = norm.includes("/") ? norm.split("/").pop() : norm;
    let found = false;
    for (const path of allJs) {
      if (path === norm || path.endsWith(`/${base}`)) {
        resolved.add(path);
        found = true;
      }
    }
    if (!found) {
      resolved.add(norm.includes("_scripts/") ? norm : `startup_scripts/${base}`);
    }
  }

  // Never park whole category folders (Modern-Industrialization/) — that drops
  // item registrations (ATM10 kubejs:modularium). Fallback: remaining top-level .js
  // only, then nested non-MI scripts when errors persist (ATM10 AE/FD/IE packs).
  if (resolved.size === 0) {
    for (const path of allStartupJs) {
      if (path.split("/").length === 2) resolved.add(path);
    }
  }
  if (resolved.size === 0 && /KubeJS startup script syntax errors|There were KubeJS/i.test(combined)) {
    for (const path of allStartupJs) {
      if (path.split("/").length < 3) continue;
      if (/Modern-Industrialization|modern_industrialization/i.test(path)) continue;
      resolved.add(path);
    }
  }
  if (resolved.size === 0) return 0;

  // Drop directory targets — only move concrete script files that still exist.
  const existingSet = new Set(allJs);
  const fileTargets = [ ...resolved ].filter(rel =>
    /\.(js|ts)$/i.test(rel) && existingSet.has(rel)
  );
  if (fileTargets.length === 0) return 0;

  await createServerDirectory(ctx.serverId, ctx.userId, "/", "kubejs-scripts-disabled").catch(() => {});
  // encodeURIComponent so restore can reverse unambiguously (dashes in
  // "Modern-Industrialization" broke the old slash→dash scheme).
  const moves = fileTargets
    .filter(rel => {
      // Never park MI registration scripts — ATM10 kubejs:modularium lives there.
      if (/Modern-Industrialization|modern_industrialization/i.test(rel)) {
        msgLog.warn(`[boot-verify] skip neutralizing protected kubejs script: kubejs/${rel}`);
        return false;
      }
      return true;
    })
    .map(rel => ({
      from: `kubejs/${rel}`,
      to: `kubejs-scripts-disabled/${encodeURIComponent(rel)}`
    }));
  if (moves.length === 0) return 0;
  await renameServerFiles(ctx.serverId, ctx.userId, "/", moves).catch(() => {});
  for (const m of moves) {
    msgLog.warn(`[boot-verify] neutralized kubejs script: ${m.from}`);
  }
  return moves.length;
}

// Parked jars that a crash reports as missing dependencies.
function parkedJarsForMissingDeps(modIndex, missingDeps) {
  const out = [];
  for (const dep of missingDeps ?? []) {
    const id = String(dep).toLowerCase();
    const jar = modIndex?.parkedByModId?.get(id);
    if (jar) {
      out.push(jar);
      continue;
    }
    // Filename token fallback when the parked skip had no resolved modId.
    // Normalize _ ↔ - so modern_industrialization matches Modern-Industrialization-*.jar.
    if (id.length < 5 || !modIndex?.parkedJars) continue;
    const normalized = id.replace(/_/g, "-");
    const token = new RegExp(
      `(?:^|[^a-z0-9])${escapeRegExp(normalized)}(?:[^a-z0-9]|$)`,
      "i"
    );
    for (const parked of modIndex.parkedJars) {
      if (token.test(String(parked).replace(/_/g, "-"))) out.push(parked);
    }
  }
  return [ ...new Set(out) ];
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Server-pack installs leave an empty modIndex. Match crash modIds / missing-dep
// dependents to unique jar basenames still in mods/ (token-boundary, len≥5).
// Prefer dependentModIds (MissingMods victims); only then offender modIds.
async function jarsFromDiskForSignals(ctx, signals, alreadyKnown = new Set()) {
  let files = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    files = await listServerFiles(ctx.serverId, ctx.userId, "/mods").catch(() => null);
    if (files !== null) break;
    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
  }
  if (!files?.length) return [];
  const names = files
    .map(f => f.attributes?.name)
    .filter(n => typeof n === "string" && /\.jar$/i.test(n) && !alreadyKnown.has(n));
  if (names.length === 0) return [];

  // Client-only class missing: curated client jars only. Crash modId needles
  // false-positive (GuideME / JEI) and cascade into AE2 via dependents.
  if (signals?.clientClassMissing) {
    try {
      const curated = require("../data/client_side_mods.json");
      const { isProtectedLearnedMod } = require("./verdict_store.js");
      const prefixes = (curated.filenamePrefixes ?? []).map(p => String(p).toLowerCase());
      const modIds = new Set((curated.modIds ?? []).map(id => String(id).toLowerCase()));
      const clientHits = [];
      for (const name of names) {
        if (isProtectedLearnedMod({ filename: name })) continue;
        const lower = name.toLowerCase();
        if (prefixes.some(p => p.length >= 5 && lower.startsWith(p))) {
          clientHits.push(name);
          continue;
        }
        for (const id of modIds) {
          if (id.length < 5) continue;
          const token = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(id)}(?:[^a-z0-9]|$)`, "i");
          if (token.test(lower)) {
            clientHits.push(name);
            break;
          }
        }
        if (clientHits.length >= 20) break;
      }
      return [ ...new Set(clientHits) ];
    } catch {
      return [];
    }
  }

  const needles = new Set();
  const addNeedle = id => {
    const n = String(id).toLowerCase();
    if (n.length < 5 || DISK_MATCH_PROTECT_IDS.has(n)) return;
    needles.add(n);
  };
  for (const id of signals?.dependentModIds ?? []) addNeedle(id);
  // Only fall back to modIds when we have no dependent victims to target.
  if (needles.size === 0) {
    for (const id of signals?.modIds ?? []) addNeedle(id);
  }

  const hits = [];
  for (const needle of needles) {
    const token = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(needle)}(?:[^a-z0-9]|$)`, "i");
    const matched = names.filter(n => token.test(n));
    if (matched.length === 1) hits.push(matched[0]);
  }

  return [ ...new Set(hits) ];
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
  const quarantinedJars = new Set();
  // Hard-fail quarantines (EnderIO "cannot continue") must never be undo-restored
  // just because a dependent still lists them as a MissingMods requirement.
  const hardFailedJars = new Set();
  let lastCrashReportName = null;
  const seenCrashReportNames = new Set();
  let consoleTail = "";
  let eulaAccepted = false;
  let neutralizedQuarantineIds = false;
  let neutralizedScriptsOnTimeout = false;
  let awtHeadlessRetried = 0;
  let x11NativesInstalled = false;
  let jeidInstallAttempted = false;
  let staleCrashRefunded = false;
  let loadingRefunds = 0;
  let stackFrameQuarantines = 0;
  let mixinConfigQuarantines = 0;
  let skipWeakOnlyQuarantine = false;

  // Headless AWT via user_jvm_args.txt and/or insert into valid unix_args.txt.
  // wrapEggStartupCommand also bakes icon rm + export headless into egg startup.
  await ensureHeadlessJvmArgs(ctx);
  // Proactively remove server-icon.png — DedicatedServer.<clinit> loads it via
  // AWT and crashes headless Docker hosts that lack libXrender.
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

    // Recover from a wiped unix_args.txt (older boot-verify headless bug).
    if (await repairCorruptedUnixArgs(ctx, consoleTail)) {
      await ensureHeadlessJvmArgs(ctx);
      attempt--;
      continue;
    }

    // Egg SERVER_JARFILE reset to missing server.jar after startup patches.
    if (await repairMissingServerJar(ctx, consoleTail)) {
      attempt--;
      continue;
    }

    if (result.outcome === "success") {
      msgLog.log(`[boot-verify] ${ctx.serverId}: boot verified on attempt ${attempt} (${quarantined.length} quarantined)`);
      return { success: true, attempts: attempt, quarantined, reason: null, consoleTail };
    }
    if (result.outcome === "ws-error") {
      return { success: false, attempts: attempt, quarantined, reason: "ws-error", consoleTail };
    }

    // False crash: watcher ended but console still shows Morph/loading and the
    // only crash report is one we already handled. Do NOT kill — resume watch.
    if (result.outcome === "crash" && LOADING_PROGRESS_RE.test(consoleTail)) {
      const peekSaved = consoleTail.match(
        /crash report has been saved to:\s*\S*crash-reports\/(\S+\.txt)/i
      );
      const peekName = peekSaved?.[1] ?? null;
      const latestPeek = await fetchLatestCrashReport(
        ctx.serverId, ctx.userId, peekName
      );
      const staleOnly = !latestPeek || seenCrashReportNames.has(latestPeek.name);
      if (staleOnly && loadingRefunds < 2) {
        loadingRefunds++;
        msgLog.warn(
          `[boot-verify] ${ctx.serverId}: false crash during loading (stale report); ` +
          `resuming watch (${loadingRefunds}/2)`
        );
        const resumed = await watchBootAttempt(
          ctx.serverId, ctx.userId,
          Math.min(settings.success_timeout_ms, settings.total_budget_ms - (Date.now() - started)),
          settings.crash_flush_ms,
          {
            ignoreEulaMarkers: eulaAccepted,
            historyFlushMs: 0,
            ignoreCrashReportNames: seenCrashReportNames,
            skipStart: true
          }
        );
        consoleTail = [ consoleTail, resumed.consoleTail ].filter(Boolean).join("\n");
        if (resumed.outcome === "success") {
          msgLog.log(`[boot-verify] ${ctx.serverId}: boot verified after resume (${quarantined.length} quarantined)`);
          return { success: true, attempts: attempt, quarantined, reason: null, consoleTail };
        }
        result.outcome = resumed.outcome;
        result.consoleTail = consoleTail;
        if (resumed.outcome === "crash" && LOADING_PROGRESS_RE.test(resumed.consoleTail)) {
          // Still false — fall through to kill/refund path with capped refunds.
        } else if (resumed.outcome !== "crash") {
          // timeout / ws-error handled below via result.outcome
        }
      }
    }

    if (result.outcome === "timeout") {
      // Safety net: HeadlessException / other definite markers can land in the
      // tail before JAVA_BOOT_RE arms (Fabric Knot). Treat as a crash so we
      // attribute + quarantine instead of burning the whole attempt budget.
      if (DEFINITE_CRASH_MARKERS.some(re => re.test(consoleTail))) {
        msgLog.warn(
          `[boot-verify] ${ctx.serverId}: timeout console contains definite crash marker — treating as crash`
        );
        result.outcome = "crash";
      }
    }

    if (result.outcome === "timeout") {
      // Cottage Witch: BYG quarantine leaves kubejs tag scripts hanging with no
      // crash marker. Park server_scripts once and retry. Also retry when the
      // only signal is a client-dist Rhino probe (PoseStack) after an AWT fix.
      if (!neutralizedScriptsOnTimeout) {
        await setServerPowerState(ctx.serverId, ctx.userId, "kill").catch(() => {});
        let movedNs = 0;
        let movedScripts = 0;
        if (quarantinedModIds.length > 0) {
          movedNs = await neutralizeUnboundNamespaces(ctx, quarantinedModIds);
          movedScripts = await neutralizeKubejsScriptTree(ctx, "server_scripts");
        } else if (/invalid dist DEDICATED_SERVER|PoseStack|blaze3d/i.test(consoleTail)) {
          movedScripts = await neutralizeKubejsScriptTree(ctx, "client_scripts");
        }
        neutralizedScriptsOnTimeout = true;
        if (movedNs + movedScripts > 0) {
          msgLog.warn(
            `[boot-verify] ${ctx.serverId}: timeout — neutralized ` +
            `${movedNs + movedScripts} kubejs/datapack path(s); retrying`
          );
          attempt--;
          continue;
        }
      }
      msgLog.warn(`[boot-verify] ${ctx.serverId}: boot timed out without Done/crash marker`);
      return { success: false, attempts: attempt, quarantined, reason: "timeout", consoleTail };
    }

    // Forge/NeoForge often leave a zombie JVM after a loader crash (ModernFix
    // threads, etc.). Always kill before we rename jars, retry, or give up —
    // otherwise the next start races the old process and the panel looks "up".
    await setServerPowerState(ctx.serverId, ctx.userId, "kill").catch(() => {});

    // AWT/Xrender — handle BEFORE attribution. Cottage Witch hits DedicatedServer
    // icon load with no mod jar in the stack; returning unattributed skipped the
    // old post-quarantine AWT retry. Icon is file-delete only (egg startup is
    // never rewritten for rm — that broke multiline Forge eggs). When headless
    // alone is not enough (Temurin still loads libawt_xawt), inject Ubuntu X11
    // .so files into /native + LD_LIBRARY_PATH.
    if (
      awtHeadlessRetried < 5 &&
      isAwtLinkCrash(consoleTail)
    ) {
      awtHeadlessRetried++;
      await ensureHeadlessJvmArgs(ctx);
      await removeServerIconFiles(ctx);
      // Nuke any leftover png that might be loaded as a favicon.
      const root = await listServerFiles(ctx.serverId, ctx.userId, "/").catch(() => null);
      const pngs = (root ?? [])
        .map(f => f.attributes?.name)
        .filter(n => n && /\.png$/i.test(n) && /icon|logo|pack/i.test(n));
      if (pngs.length) await deleteServerFiles(ctx.serverId, ctx.userId, pngs).catch(() => {});
      try {
        const glibcMismatch = /GLIBC_[\d.]+[' ]not found/i.test(consoleTail);
        await ensureX11NativeLibs(ctx, {
          forceRefresh: glibcMismatch || awtHeadlessRetried === 1
        });
        x11NativesInstalled = true;
      } catch (err) {
        msgLog.warn(`[boot-verify] ${ctx.serverId}: X11 native inject failed: ${err.message}`);
      }
      msgLog.warn(
        `[boot-verify] ${ctx.serverId}: AWT/libX* crash — headless + icon rm` +
        `${x11NativesInstalled ? " + X11 natives" : ""} ` +
        `(try ${awtHeadlessRetried}/5); retrying`
      );
      attempt--;
      continue;
    }

    // EULA gate: reinstall leaves eula unaccepted. Accept and retry without
    // burning a quarantine slot. Refund the attempt so a stale console replay
    // of the EULA line cannot exhaust max_attempts before a real boot.
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
    // Ignore a crash report we already acted on — early LaunchWrapper failures
    // (e.g. after quarantining UniMixins) often write no new report.
    let crashReportText = null;
    if (latestCrash && latestCrash.name !== lastCrashReportName) {
      crashReportText = latestCrash.text;
      lastCrashReportName = latestCrash.name;
      seenCrashReportNames.add(latestCrash.name);
    } else if (latestCrash && latestCrash.name === lastCrashReportName) {
      msgLog.warn(`[boot-verify] ${ctx.serverId}: ignoring stale crash report ${latestCrash.name}`);
      seenCrashReportNames.add(latestCrash.name);
    }

    // Forge 1.12 registry ID overflow — restore parked JEID, or download it
    // (MeatballCraft never ships JustEnoughIDs). Quarantining content mods is
    // the wrong fix and burns the attempt budget.
    if (/maximum id range exceeded|Invalid id \d+/i.test(consoleTail + (crashReportText || ""))) {
      const rescued = await rescueJeidFromParked(ctx);
      if (rescued > 0) {
        msgLog.warn(`[boot-verify] ${ctx.serverId}: restored ${rescued} JEID/NotEnoughIDs jar(s); retrying`);
        attempt--;
        continue;
      }
      if (!jeidInstallAttempted) {
        jeidInstallAttempted = true;
        try {
          const installed = await ensureJeidInstalled(ctx);
          if (installed) {
            attempt--;
            continue;
          }
        } catch (err) {
          msgLog.warn(`[boot-verify] ${ctx.serverId}: JEID download/install failed: ${err.message}`);
        }
      }
    }

    // Prefer KubeJS script scrub over weak stack-frame quarantines — but only
    // park scripts named by startup.log / top-level .js / nested non-MI. Never
    // wipe MI category folders (that dropped ATM10 registrations → modularium).
    if (/KubeJS startup script syntax errors|There were KubeJS .* script .* errors|Error loading script/i.test(consoleTail)) {
      const kubeMoved = await neutralizeKubejsScriptErrors(ctx, consoleTail);
      if (kubeMoved > 0) {
        msgLog.warn(
          `[boot-verify] ${ctx.serverId}: neutralized ${kubeMoved} kubejs script(s); retrying boot`
        );
        attempt--;
        continue;
      }
      // Errors remain but nothing new to park — do not waste the attempt on a
      // weak stack-frame quarantine (ATM10 alltheleaks) while KubeJS is still hard-failing.
      skipWeakOnlyQuarantine = true;
      msgLog.warn(
        `[boot-verify] ${ctx.serverId}: KubeJS errors remain but no scrubable scripts left; skipping weak attribution`
      );
    }

    // Datapacks referencing kubejs: items after a script park (ATM10 modularium).
    // ResourceKey lines embed colons (`minecraft:item`) and often wrap before
    // `kubejs:id` — do not stop the match at the first `:`.
    {
      const missingKube = new Set();
      for (const m of consoleTail.matchAll(
        /Unknown registry key[\s\S]{0,240}?kubejs:([a-z0-9_]+)/gi
      )) {
        missingKube.add(m[1]);
      }
      if (missingKube.size > 0) {
        // Prefer restoring parked MI startup scripts that register these items.
        const restored = await restoreParkedKubejsStartupDirs(ctx, [
          "Modern-Industrialization", "modern_industrialization", "mi"
        ]);
        // Only scrub kubejs/data when restore found nothing — wiping all pack
        // data after a successful MI restore still left modularium dangling
        // via world/mod datapacks and burned the attempt.
        let moved = 0;
        if (restored === 0) {
          moved = await neutralizeUnboundNamespaces(ctx, [ "kubejs", ...missingKube ]);
          if (moved === 0) {
            const dataEntries = await listServerFiles(ctx.serverId, ctx.userId, "/kubejs/data").catch(() => null);
            const dirs = (dataEntries ?? [])
              .filter(e => e.attributes?.name && !e.attributes?.is_file)
              .map(e => e.attributes.name);
            if (dirs.length > 0) {
              moved = await neutralizeUnboundNamespaces(ctx, dirs);
            }
          }
        } else {
          // Drop world so stale registry leftovers do not stick after restore.
          await deleteServerFiles(ctx.serverId, ctx.userId, [ "world" ]).catch(() => {});
        }
        if (restored + moved > 0) {
          msgLog.warn(
            `[boot-verify] ${ctx.serverId}: fixed missing kubejs items ` +
            `${[ ...missingKube ].join(", ")} (restored ${restored}, neutralized ${moved}); retrying`
          );
          attempt--;
          continue;
        }
      }
    }

    const attribution = attributeCrash({
      crashReportText,
      consoleTail: result.consoleTail,
      index: modIndex,
      quarantinedModIds
    });

    // Prefer restoring a parked missing dep over quarantining everyone who needs it.
    // Always restore pack-defining protected mods (ATM10 parked MI then refused
    // restore because of a stale learned verdict). Never restore jars we already
    // quarantined this session, or non-protected learned crashers.
    // Undo a bad quarantine when MissingMods still needs that mod (MC Eternal
    // CraftTweaker removed via stack-frame noise, then art hard-requires it).
    // Never undo hard failures — Divine Journey restored EnderIO in a loop after
    // "cannot continue", then burned the budget on the same crash.
    {
      const undo = [];
      for (const dep of attribution.signals?.missingDeps ?? []) {
        const depLc = String(dep).toLowerCase();
        for (const jar of quarantinedJars) {
          if (hardFailedJars.has(jar)) continue;
          const id = String(modIndex.modIdOf?.get(jar) ?? "").toLowerCase();
          if (id === depLc || (depLc === "crafttweaker" && /^crafttweaker2?[-_.]/i.test(jar))) {
            undo.push(jar);
          }
        }
      }
      const uniqueUndo = [ ...new Set(undo) ];
      if (uniqueUndo.length > 0) {
        await onProgress(`Restoring ${uniqueUndo.length} quarantined mod(s) required as dependencies...`);
        await restoreParkedJars({ ...ctx, modIndex }, uniqueUndo);
        for (const jar of uniqueUndo) {
          quarantinedJars.delete(jar);
          const id = modIndex.modIdOf?.get(jar);
          if (id) {
            const idx = quarantinedModIds.findIndex(x => String(x).toLowerCase() === String(id).toLowerCase());
            if (idx >= 0) quarantinedModIds.splice(idx, 1);
          }
          const qIdx = quarantined.findIndex(q => q.jar === jar);
          if (qIdx >= 0) quarantined.splice(qIdx, 1);
          msgLog.warn(`[boot-verify] ${ctx.serverId}: restored quarantined dep ${jar}`);
        }
        attempt--;
        continue;
      }
    }
    const toRestore = parkedJarsForMissingDeps(modIndex, attribution.signals?.missingDeps)
      .filter(j => modIndex.parkedJars?.has(j) && !quarantinedJars.has(j) && !hardFailedJars.has(j))
      .filter(j => {
        const id = modIndex.modIdOf?.get(j);
        if (isProtectedLearnedMod({ modId: id, filename: j })) return true;
        const sha1 = modIndex.sha1Of?.get(j);
        return !sha1 || getLearnedVerdict(sha1) !== "crashes-server";
      });
    if (toRestore.length > 0) {
      await onProgress(
        `Restoring ${toRestore.length} parked mod(s) required as dependencies...`
      );
      await restoreParkedJars({ ...ctx, modIndex }, toRestore);
      continue;
    }

    // Parked/missing deps leave datapack+kubejs references (Create: Astral
    // custommachinery machines). Neutralize those namespaces even when we do
    // not restore the jar. Use filename fallback (not only parkedByModId) so
    // learned skips without a resolved modId still scrub their data.
    const missingForNeutralize = [ ...(attribution.signals?.missingDeps ?? []) ]
      .filter(id => {
        const jars = parkedJarsForMissingDeps(modIndex, [ id ]);
        if (jars.some(j => toRestore.includes(j))) return false;
        // Always scrub when we are not restoring — true missing deps poison
        // datapacks the same way parked learned crashers do.
        return true;
      });
    if (missingForNeutralize.length > 0) {
      const moved = await neutralizeUnboundNamespaces(ctx, missingForNeutralize);
      if (moved > 0) {
        msgLog.warn(
          `[boot-verify] ${ctx.serverId}: neutralized ${moved} path(s) for parked missing deps ` +
          `${missingForNeutralize.join(", ")}; retrying boot`
        );
        // Also quarantine dependents that hard-require the parked crasher.
        const depJars = attribution.jars.filter(j => !quarantinedJars.has(j));
        if (depJars.length > 0) {
          const reasonsByJar = new Map(attribution.reasons.map(r => [ r.jar, r.reason ]));
          await quarantineJars({ ...ctx, modIndex }, depJars, reasonsByJar);
          for (const jar of depJars) {
            quarantined.push({ jar, reason: reasonsByJar.get(jar) ?? "dependent of quarantined mod" });
            quarantinedJars.add(jar);
            const id = modIndex.modIdOf?.get(jar);
            if (id) quarantinedModIds.push(id);
          }
        }
        attempt--;
        continue;
      }
    }

    let freshJars = attribution.jars.filter(j => !quarantinedJars.has(j));
    // Stack-frame / mixin-config hits alone thrash packs (MeatballCraft, ATM10).
    // Cap each weak signal type separately — a shared budget blocked MC Eternal
    // (2 mixin quarantines then a real tick-loop stack frame was discarded).
    {
      const reasonsByJarEarly = new Map(attribution.reasons.map(r => [ r.jar, r.reason ]));
      const isStack = r => /^stack frame/i.test(r ?? "");
      const isMixin = r => /^mixin config /i.test(r ?? "");
      const isWeak = r => isStack(r) || isMixin(r);
      const weakOnly = freshJars.filter(j => isWeak(reasonsByJarEarly.get(j)));
      const strong = freshJars.filter(j => !isWeak(reasonsByJarEarly.get(j)));
      // MissingModsChecker etc. open a Swing window and die with HeadlessException —
      // no crash report is written, but the stack frame naming the GUI class is solid.
      const headlessGuiCrash =
        /java\.awt\.HeadlessException|No X11 DISPLAY variable was set/i.test(consoleTail);
      // No fresh crash report: console stack frames are often Wings history /
      // cascade noise (MC Eternal CraftTweaker after EnderIO).
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
          msgLog.warn(
            `[boot-verify] ${ctx.serverId}: skipping further weak quarantines ` +
            `(${weakOnly.join(", ")})`
          );
          freshJars = [];
        } else {
          freshJars = [ weakOnly[0] ];
        }
      } else if (strong.length > 0) {
        freshJars = strong;
      }
    }
    if (freshJars.length === 0) {
      // Server-pack path: empty modIndex — match dependent/offender modIds to
      // unique jars still in mods/ (token-boundary; never uses bare stack segs).
      const diskHits = await jarsFromDiskForSignals(
        ctx, attribution.signals, quarantinedJars
      );
      if (diskHits.length > 0) {
        for (const jar of diskHits) {
          attribution.jars.push(jar);
          attribution.reasons.push({ jar, reason: "server-pack filename match for crash mod id" });
        }
        freshJars = diskHits;
        msgLog.warn(`[boot-verify] ${ctx.serverId}: attributed via mods/ mod-id match: ${diskHits.join(", ")}`);
      }
    }
    if (freshJars.length === 0) {
      const unbound = attribution.signals?.unboundNamespaces ?? new Set();
      if (unbound.size > 0) {
        const moved = await neutralizeUnboundNamespaces(ctx, unbound);
        if (moved > 0) {
          msgLog.warn(
            `[boot-verify] ${ctx.serverId}: neutralized ${moved} path(s) for unbound namespaces ` +
            `${[ ...unbound ].join(", ")}; retrying boot`
          );
          attempt--;
          continue;
        }
      }
      // Quarantined mods often leave kubejs/datapack references that hang or
      // syntax-error — neutralize those namespaces before giving up.
      if (!neutralizedQuarantineIds && quarantinedModIds.length > 0) {
        const moved = await neutralizeUnboundNamespaces(ctx, quarantinedModIds);
        neutralizedQuarantineIds = true;
        if (moved > 0) {
          msgLog.warn(
            `[boot-verify] ${ctx.serverId}: neutralized ${moved} path(s) for quarantined mods; retrying boot`
          );
          attempt--;
          continue;
        }
      }
      // Stale crash report + Morph/loading noise often means Wings history / a
      // false kill of a still-loading boot. Cap refunds — unlimited attempt--
      // burned MC Eternal's budget on docker-pull restarts.
      if (
        !crashReportText &&
        attempt < settings.max_attempts &&
        loadingRefunds < 2 &&
        LOADING_PROGRESS_RE.test(consoleTail)
      ) {
        loadingRefunds++;
        msgLog.warn(
          `[boot-verify] ${ctx.serverId}: unattributed during active loading; ` +
          `refunding attempt (${loadingRefunds}/2)`
        );
        attempt--;
        continue;
      }
      if (!staleCrashRefunded && !crashReportText && attempt < settings.max_attempts) {
        staleCrashRefunded = true;
        msgLog.warn(
          `[boot-verify] ${ctx.serverId}: unattributed with no fresh crash report; refunding attempt`
        );
        attempt--;
        continue;
      }
      msgLog.warn(`[boot-verify] ${ctx.serverId}: crash could not be attributed to a new mod; stopping loop`);
      if (crashReportText) {
        const desc = crashReportText.match(/^Description:\s*(.+)$/im)?.[1];
        const caused = [ ...crashReportText.matchAll(/^Caused by:\s*(.+)$/gim) ]
          .map(m => m[1]).slice(0, 5);
        const frames = crashReportText.split(/\r?\n/)
          .map(l => l.trim())
          .filter(l => /^\tat /.test(l) &&
            !/^\tat (java\.|sun\.|jdk\.|net\.minecraft|net\.minecraftforge|cpw\.mods)/.test(l))
          .slice(0, 12);
        msgLog.warn(
          `[boot-verify] ${ctx.serverId}: unattributed crash report ` +
          `${lastCrashReportName || "?"} Description=${desc || "(none)"}\n` +
          (caused.length ? `Caused by: ${caused.join(" | ")}\n` : "") +
          (frames.length ? frames.join("\n") : crashReportText.split(/\r?\n/).slice(0, 40).join("\n"))
        );
      }
      return { success: false, attempts: attempt, quarantined, reason: "unattributed", consoleTail };
    }

    // Client-class crashes: quarantine only the attributed client jars — do NOT
    // expand to dependents (quarantining GuideME would cascade into AE2).
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
    // Immediately neutralize datapack/kubejs leftovers for freshly quarantined
    // mods AND any missing deps they named (parked CustomMachinery etc.).
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
  verifyServerBoot, watchBootAttempt, fetchLatestCrashReport, _DEFAULTS: DEFAULTS,
  pickJeidFile, pickSharedObjectMember, isJeidJarName, injectLdLibraryPathPrefix,
  JEID_CURSEFORGE_MOD_ID, JEID_PREFERRED_FILE
};
