// Boot-verify remediation registry. Each entry repairs a known unattributable
// (or pre-attribution) failure mode so the boot loop can retry.
"use strict";

const msgLog = require("../logger.js");
const { deleteServerFiles } = require("../server_functions.js");
const {
  repairMissingServerJar,
  repairCorruptedUnixArgs,
  neutralizeKubejsScriptErrors,
  neutralizeUnboundNamespaces,
  restoreParkedJars,
  parkedJarsForMissingDeps,
  filterRestorableParked,
  ensureHeadlessJvmArgs
} = require("./_helpers.js");

const missingServerJar = {
  id: "missing-server-jar",
  description: "Egg SERVER_JARFILE points at a missing jar — retarget to a loader jar on disk",
  matches(consoleTail) {
    return /Unable to access jarfile/i.test(consoleTail);
  },
  async apply(ctx) {
    const ok = await repairMissingServerJar(ctx, ctx.consoleTail || "");
    if (ok) msgLog.warn(`[boot-verify] ${ctx.serverId}: remediation missing-server-jar applied`);
    return ok;
  }
};

const corruptJvmArgfile = {
  id: "corrupt-jvm-argfile",
  description: "unix_args.txt wiped or invalid — restore from Forge/NeoForge libraries tree",
  matches(consoleTail) {
    return /Could not find or load main class @unix_args/i.test(consoleTail) ||
      /Usage: java|enable system assertions|--help-extra/i.test(consoleTail);
  },
  async apply(ctx) {
    const ok = await repairCorruptedUnixArgs(ctx, ctx.consoleTail || "");
    if (ok) {
      await ensureHeadlessJvmArgs(ctx);
      msgLog.warn(`[boot-verify] ${ctx.serverId}: remediation corrupt-jvm-argfile applied`);
    }
    return ok;
  }
};

const kubejsScriptErrors = {
  id: "kubejs-script-errors",
  description: "Park KubeJS startup/server scripts named by console/startup.log errors",
  matches(consoleTail) {
    return /KubeJS startup script syntax errors|There were KubeJS .* script .* ?errors|Error loading script/i.test(consoleTail);
  },
  async apply(ctx) {
    const moved = await neutralizeKubejsScriptErrors(ctx, ctx.consoleTail || "");
    if (moved > 0) {
      msgLog.warn(`[boot-verify] ${ctx.serverId}: remediation kubejs-script-errors moved ${moved}`);
      return true;
    }
    return false;
  }
};

const unboundDatapackNamespaces = {
  id: "unbound-datapack-namespaces",
  description: "Disable datapack/kubejs paths left dangling after a quarantine or missing dep",
  matches(consoleTail, ctx) {
    const unbound = ctx?.attribution?.signals?.unboundNamespaces;
    if (unbound && unbound.size > 0) return true;
    // Only scrub missing-dep namespaces when restore already failed — otherwise
    // MissingMods would neutralize instead of quarantining dependents.
    if ((ctx?.quarantinedModIds?.length ?? 0) > 0) {
      return /Failed to load datapacks|Unknown registry key|Could not parse data|Invalid tag/i.test(consoleTail);
    }
    return false;
  },
  async apply(ctx) {
    const namespaces = new Set();
    for (const ns of ctx.attribution?.signals?.unboundNamespaces ?? []) namespaces.add(ns);
    for (const id of ctx.quarantinedModIds ?? []) namespaces.add(id);
    if (namespaces.size === 0) return false;
    const moved = await neutralizeUnboundNamespaces(ctx, namespaces);
    if (moved > 0) {
      msgLog.warn(
        `[boot-verify] ${ctx.serverId}: remediation unbound-datapack-namespaces moved ${moved}`
      );
      return true;
    }
    return false;
  }
};

const missingDependencyRestore = {
  id: "missing-dependency-restore",
  description: "Restore a jar parked in mods-disabled/ that MissingModsException still requires",
  matches(consoleTail, ctx) {
    const missing = [ ...(ctx?.attribution?.signals?.missingDeps ?? []) ];
    if (!/MissingModsException|requires mods |requires \[|ModResolutionException|is not installed|Mod loading (?:failures|issue)/i.test(consoleTail) &&
        missing.length === 0) {
      return false;
    }
    const modIndex = ctx?.modIndex;
    if (!modIndex) return false;

    // Undo a soft quarantine when MissingMods still needs that jar.
    for (const dep of missing) {
      const depLc = String(dep).toLowerCase();
      for (const jar of ctx.quarantinedJars ?? []) {
        if (ctx.hardFailedJars?.has(jar)) continue;
        const id = String(modIndex.modIdOf?.get(jar) ?? "").toLowerCase();
        if (id === depLc || (depLc === "crafttweaker" && /^crafttweaker2?[-_.]/i.test(jar))) {
          return true;
        }
      }
    }

    const parked = parkedJarsForMissingDeps(modIndex, missing);
    const restorable = filterRestorableParked(
      modIndex, parked, ctx.quarantinedJars, ctx.hardFailedJars
    );
    return restorable.length > 0;
  },
  async apply(ctx) {
    const missing = [ ...(ctx.attribution?.signals?.missingDeps ?? []) ];
    const modIndex = ctx.modIndex;
    const onProgress = ctx.onProgress ?? (() => {});

    // Prefer undo of soft quarantines that MissingMods still requires.
    const undo = [];
    for (const dep of missing) {
      const depLc = String(dep).toLowerCase();
      for (const jar of ctx.quarantinedJars ?? []) {
        if (ctx.hardFailedJars?.has(jar)) continue;
        const id = String(modIndex.modIdOf?.get(jar) ?? "").toLowerCase();
        if (id === depLc || (depLc === "crafttweaker" && /^crafttweaker2?[-_.]/i.test(jar))) {
          undo.push(jar);
        }
      }
    }
    const uniqueUndo = [ ...new Set(undo) ];
    if (uniqueUndo.length > 0) {
      await onProgress(`Restoring ${uniqueUndo.length} quarantined mod(s) required as dependencies...`);
      await restoreParkedJars(ctx, uniqueUndo);
      for (const jar of uniqueUndo) {
        ctx.quarantinedJars?.delete(jar);
        const id = modIndex.modIdOf?.get(jar);
        if (id && Array.isArray(ctx.quarantinedModIds)) {
          const idx = ctx.quarantinedModIds.findIndex(
            x => String(x).toLowerCase() === String(id).toLowerCase()
          );
          if (idx >= 0) ctx.quarantinedModIds.splice(idx, 1);
        }
        if (Array.isArray(ctx.quarantined)) {
          const qIdx = ctx.quarantined.findIndex(q => q.jar === jar);
          if (qIdx >= 0) ctx.quarantined.splice(qIdx, 1);
        }
        msgLog.warn(`[boot-verify] ${ctx.serverId}: restored quarantined dep ${jar}`);
      }
      return true;
    }

    const toRestore = filterRestorableParked(
      modIndex,
      parkedJarsForMissingDeps(modIndex, missing),
      ctx.quarantinedJars,
      ctx.hardFailedJars
    );
    if (toRestore.length === 0) return false;
    await onProgress(`Restoring ${toRestore.length} parked mod(s) required as dependencies...`);
    await restoreParkedJars(ctx, toRestore);
    // Drop world so registry leftovers from the failed boot do not stick.
    await deleteServerFiles(ctx.serverId, ctx.userId, [ "world" ]).catch(() => {});
    msgLog.warn(
      `[boot-verify] ${ctx.serverId}: remediation missing-dependency-restore restored ${toRestore.join(", ")}`
    );
    // Burn the attempt (do not refund) — matches prior boot_verify behavior.
    ctx.refundAttempt = false;
    return true;
  }
};

const registry = [
  missingServerJar,
  corruptJvmArgfile,
  missingDependencyRestore,
  kubejsScriptErrors,
  unboundDatapackNamespaces
];

async function tryRemediations(consoleTail, ctx) {
  const remCtx = { ...ctx, consoleTail, refundAttempt: true };
  for (const rem of registry) {
    try {
      if (!rem.matches(consoleTail, remCtx)) continue;
      if (await rem.apply(remCtx)) {
        return { id: rem.id, refundAttempt: remCtx.refundAttempt !== false };
      }
    } catch (err) {
      msgLog.warn(`[boot-verify] ${ctx.serverId}: remediation ${rem.id} failed: ${err.message}`);
    }
  }
  return null;
}

module.exports = {
  registry,
  tryRemediations,
  // Re-export helpers remediations / tests may need.
  ...require("./_helpers.js")
};
