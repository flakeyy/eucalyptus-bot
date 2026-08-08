// Crash attribution (Layer 3 support): maps a crash report / console tail back
// to the mod JAR(s) that caused it, using an index built at install time.
//
// The index is cheap to build — it only needs zip entry names and metadata that
// the install engine already extracts (modId, mixin config names, package
// prefixes of shipped classes).

"use strict";

const AdmZip = require("adm-zip");

// Minimum package-prefix depth used for stack-frame matching. Two segments
// ("com/example") is too generic for some mods but still unique in practice
// because we index the exact prefixes each JAR ships.
const PREFIX_SEGMENTS = 3;

// ── Index construction ──────────────────────────────────────────────────────

function packagePrefixesOf(entryNames) {
  const prefixes = new Set();
  for (const name of entryNames) {
    if (!name.endsWith(".class") || name.startsWith("META-INF/")) continue;
    const parts = name.replace(/\.class$/, "").split("/");
    if (parts.length < 2) continue;
    for (const depth of [ 2, PREFIX_SEGMENTS ]) {
      if (parts.length > depth) prefixes.add(parts.slice(0, depth).join("/"));
    }
  }
  return prefixes;
}

// Creates an empty index. Add jars with addJarToModIndex / addParkedJarToModIndex.
function createModIndex() {
  return {
    byModId: new Map(),       // modId (lowercase) → filename
    byMixinConfig: new Map(), // mixin config name → filename
    byPackage: new Map(),     // package prefix (slash form) → Set<filename>
    byFileName: new Map(),    // lowercase basename → filename
    depsOf: new Map(),        // filename → [required modIds]
    modIdOf: new Map(),       // filename → modId
    // Rescuable skips parked under mods-disabled/ (not active in byModId).
    parkedByModId: new Map(), // modId (lowercase) → filename
    parkedJars: new Set()     // filenames sitting in mods-disabled/
  };
}

// Indexes a jar uploaded to mods-disabled/ instead of mods/. Kept out of
// byModId so missing-dep attribution does not treat it as already loaded.
function addParkedJarToModIndex(index, filename, meta = {}) {
  const base = filename.split("/").pop();
  index.parkedJars.add(base);
  if (meta.modId) {
    index.parkedByModId.set(meta.modId.toLowerCase(), base);
    index.modIdOf.set(base, meta.modId);
  }
  if (meta.sha1) {
    index.sha1Of = index.sha1Of ?? new Map();
    index.sha1Of.set(base, meta.sha1);
  }
}

// Promotes a parked jar into the active index after restore to mods/.
function promoteParkedJar(index, filename) {
  const base = filename.split("/").pop();
  if (!index.parkedJars.has(base)) return;
  index.parkedJars.delete(base);
  const modId = index.modIdOf.get(base);
  if (modId) {
    index.parkedByModId.delete(modId.toLowerCase());
    index.byModId.set(modId.toLowerCase(), base);
  }
  index.byFileName.set(base.toLowerCase(), base);
  if (!index.depsOf.has(base)) index.depsOf.set(base, []);
}

// Indexes one installed JAR. `meta` = { modId, requiredDeps, sha1 } from the
// install engine (already extracted there — no re-parse).
function mixinConfigStem(configName) {
  return String(configName)
    .toLowerCase()
    .replace(/\.json$/i, "")
    .replace(/^mixins?\./, "")
    .replace(/[.-]?mixins?$/, "")
    .replace(/[.-]?common$/, "")
    .replace(/[.-]?server$/, "")
    .replace(/[.-]?client$/, "");
}

function mixinOwnerScore(configName, jarBasename, modId) {
  const stem = mixinConfigStem(configName);
  if (!stem || stem.length < 2) return 0;
  const id = String(modId ?? "").toLowerCase();
  const jar = String(jarBasename ?? "").toLowerCase();
  if (id && (id === stem || id.startsWith(stem) || stem.startsWith(id))) return 40 + stem.length;
  // biomesoplenty jar ↔ bop.mixins.json: common abbreviation prefixes
  if (id && stem.length >= 3 && id.startsWith(stem)) return 30 + stem.length;
  if (jar.startsWith(stem) || jar.includes(`-${stem}-`) || jar.includes(`_${stem}_`)) {
    return 20 + stem.length;
  }
  // Filename contains stem as a token (biomesoplenty has no "bop", score stays low)
  if (stem.length >= 4 && jar.includes(stem)) return 10;
  return 1;
}

function pickMixinConfigOwner(configName, existingJar, candidateJar, index) {
  const existingScore = mixinOwnerScore(
    configName, existingJar, index.modIdOf.get(existingJar)
  );
  const candidateScore = mixinOwnerScore(
    configName, candidateJar, index.modIdOf.get(candidateJar)
  );
  if (candidateScore > existingScore) return candidateJar;
  if (candidateScore < existingScore) return existingJar;
  // Tie: ambiguous — leave existing (stable) rather than flipping each install.
  return existingJar;
}

function addJarToModIndex(index, filename, buffer, meta = {}) {
  const base = filename.split("/").pop();
  index.byFileName.set(base.toLowerCase(), base);
  if (meta.modId) {
    index.byModId.set(meta.modId.toLowerCase(), base);
    index.modIdOf.set(base, meta.modId);
  }
  index.depsOf.set(base, meta.requiredDeps ?? []);
  if (meta.sha1) {
    index.sha1Of = index.sha1Of ?? new Map();
    index.sha1Of.set(base, meta.sha1);
  }

  let zip;
  try { zip = new AdmZip(buffer); } catch { return; }
  const entryNames = zip.getEntries().filter(e => !e.isDirectory).map(e => e.entryName);

  for (const name of entryNames) {
    // Mixin configs live at the JAR root: foo.mixins.json / mixins.foo.json
    if (!name.includes("/") && /mixins?.*\.json$/i.test(name) && !/refmap/i.test(name)) {
      const existing = index.byMixinConfig.get(name);
      if (!existing) {
        index.byMixinConfig.set(name, base);
      } else if (existing !== base) {
        // Two jars ship the same config name (e.g. SpellBundle copies bop.mixins.json).
        // Keep the owner whose modId/filename best matches the config stem.
        const prefer = pickMixinConfigOwner(name, existing, base, index);
        index.byMixinConfig.set(name, prefer);
      }
    }
  }
  for (const prefix of packagePrefixesOf(entryNames)) {
    if (!index.byPackage.has(prefix)) index.byPackage.set(prefix, new Set());
    index.byPackage.get(prefix).add(base);
  }
}

// ── Crash text parsing ──────────────────────────────────────────────────────

// Extracts candidate signals from crash-report/console text:
//   modIds        - mod ids named in loader error messages
//   mixinConfigs  - mixin config json names
//   jarFiles      - jar filenames mentioned directly (Forge "Mod File:" etc.)
//   stackClasses  - fully-qualified class names from stack frames
//   missingDeps   - modIds reported as missing dependencies
function extractCrashSignals(text) {
  const out = {
    modIds: new Set(),
    mixinConfigs: new Set(),
    jarFiles: new Set(),
    stackClasses: [],
    missingDeps: new Set(),
    dependentModIds: new Set(), // mods that require a missing dep (victims to quarantine)
    unboundNamespaces: new Set(), // datapack/registry namespaces with unbound values
    clientClassMissing: false, // ClassMetadataNotFound for net.minecraft.client.*
    // Explicit hard-fails that may name pack-defining mods (Ender IO cannot continue).
    hardFailModIds: new Set()
  };
  if (!text) return out;

  // FML prints "-- MOD id --" / "Mod File:" *before* the Failure message, so we
  // buffer the section and only commit jar/modId once we know whether this mod
  // is the offender or just a victim of a missing dependency gate.
  let pendingModId = null;
  let pendingJar = null;
  const commitPendingOffender = () => {
    if (pendingModId) out.modIds.add(pendingModId);
    if (pendingJar) out.jarFiles.add(pendingJar);
    pendingModId = null;
    pendingJar = null;
  };
  const dropPending = () => {
    pendingModId = null;
    pendingJar = null;
  };

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    // Wings/Forge STDERR wrappers bury the real message after a println frame.
    // e.g. "[11:08:51] [Server thread/INFO] [STDERR]: [pkg.Class:method:92]: \tat ..."
    let line = rawLine.trim()
      .replace(/^\[.*?\]\s*\[[^\]]*\]\s*\[STDERR\]:\s*(?:\[[^\]]+\]:\s*)?/i, "")
      .replace(/^\[java\.lang\.Throwable\$WrappedPrintStream:[^\]]+\]:\s*/i, "")
      .replace(/^\[java\.lang\.ThreadGroup:[^\]]+\]:\s*/i, "");
    line = line.trim();

    // Shutdown-cascade NPEs (AppEng.serverStopped, Tombstone.onServerStopping) are
    // not the boot failure — skip "Caught exception from" / stack frames there.
    const isShutdownFrame = /(?:serverStopped|onServerStopping|serverStopping|handleServerStopped)\b/i.test(line);

    // Forge FML section header: "-- MOD backpacked --"
    // NeoForge 1.21+: "-- Mod loading issue for: sophisticatedstorageinmotion --"
    let m = line.match(/^-- MOD ([\w.-]+) --$/i) ||
      line.match(/^-- Mod loading issue for:\s*([\w.-]+) --$/i);
    if (m) {
      commitPendingOffender();
      pendingModId = m[1].toLowerCase();
      pendingJar = null;
      continue;
    }

    // Forge crash report: "Mod File: /data/mods/foo.jar" or "Mod File: foo.jar"
    // NeoForge prints "Mod file:" — /i covers both.
    m = line.match(/Mod File:\s*(?:.*[\\/])?([^\\/]+\.jar)/i);
    if (m) {
      if (pendingModId) pendingJar = m[1];
      else out.jarFiles.add(m[1]);
      continue;
    }

    // NeoForge: "Currently, sophisticatedstorage is not installed"
    m = line.match(/Currently,\s*([\w.-]+)\s+is not installed/i);
    if (m) {
      const dep = m[1].toLowerCase();
      if (!/^(forge|minecraft|neoforge|java|fabricloader)$/i.test(dep)) {
        out.missingDeps.add(dep);
        dropPending();
      }
      continue;
    }

    // FML 1.7 MissingModsException: "... requires mods [NotEnoughItems] to be available"
    m = line.match(/requires mods \[([^\]]+)\]/i);
    if (m) {
      for (const dep of m[1].split(/,/)) {
        const id = dep.trim().toLowerCase();
        if (id) out.missingDeps.add(id);
      }
      dropPending();
      continue;
    }

    // FML 1.12 MissingModsException:
    // "Mod gasconduits (GasConduits) requires [enderio@[5.3.70,), enderioconduits@[5.3.70,)]"
    // Nested [version,] ranges break a naive `[^\]]+` capture — pull ids via `modid@`.
    m = line.match(/\bMod ([\w-]+) \([^)]+\) requires \[/i);
    if (m) {
      out.dependentModIds.add(m[1].toLowerCase());
      // Also treat the dependent as a modId so disk/filename matching can find it
      // when depsOf metadata is incomplete (GasConduits after EnderIO quarantine).
      out.modIds.add(m[1].toLowerCase());
      for (const idm of line.matchAll(/\b([a-z][\w-]*)@/gi)) {
        const id = idm[1].toLowerCase();
        if (id && id !== "unknown") out.missingDeps.add(id);
      }
      continue;
    }

    // Forge version/dep gate: "Mod foo requires curios 5.8.0 or above" /
    // "Mod subtle_effects requires forge 47.4.14 or above".
    m = line.match(/\bMod ([\w.-]+) requires ([\w.-]+) /i);
    if (m) {
      const mod = m[1].toLowerCase();
      const dep = m[2].toLowerCase();
      if (/^(forge|minecraft|neoforge|java|fabricloader)$/i.test(dep)) {
        if (pendingModId === mod || pendingModId === null) commitPendingOffender();
        else out.modIds.add(mod);
      } else if (dep === "mods") {
        // Bare "requires mods" without brackets — noise (bracket form handled above).
      } else {
        out.missingDeps.add(dep);
        out.dependentModIds.add(mod);
        if (pendingModId === mod || pendingModId === null) dropPending();
        else out.modIds.delete(mod);
      }
      continue;
    }

    // Forge 1.13+ loading errors: "Mod ID: 'modid'" / "mod modid failure"
    m = line.match(/Mod ID:\s*'([\w-]+)'/i);
    if (m) out.modIds.add(m[1].toLowerCase());

    // Official crash-report footer: "Suspected Mods: Foo (foomod), Bar (barmod)"
    m = line.match(/Suspected Mods:\s*(.+)/i);
    if (m && !/^Unknown$/i.test(m[1].trim())) {
      for (const mm of m[1].matchAll(/\(([a-z][\w-]*)\)/gi)) {
        const id = mm[1].toLowerCase();
        if (!/^(minecraft|forge|neoforge|java)$/i.test(id)) out.modIds.add(id);
      }
    }

    // Description line often names the failing system before the shutdown cascade.
    m = line.match(/^Description:\s*(.+)/i);
    if (m) {
      const desc = m[1];
      for (const mm of desc.matchAll(/\(([a-z][\w-]*)\)/g)) {
        const id = mm[1].toLowerCase();
        if (!/^(minecraft|forge|neoforge|java)$/i.test(id)) out.modIds.add(id);
      }
    }

    // Ender IO (and similar) abort with an explicit "cannot continue" after printing
    // the real errors above — treat as a hard fail even when the mod is protected.
    if (/Ender\s*IO\s+cannot continue/i.test(line) || /enderio cannot continue/i.test(line)) {
      out.hardFailModIds.add("enderio");
    }

    // Forge LoadingFailedException / errored mod lines:
    // "Failure message: Backpacked (backpacked) has failed to load correctly"
    // "... Some Mod (somemod) encountered an error during the common_setup event phase"
    m = line.match(/[^()]{0,80}\(([a-z][\w-]*)\) (?:has failed to load|encountered an error)/i);
    if (m) {
      const id = m[1].toLowerCase();
      out.modIds.add(id);
      if (pendingModId === id) commitPendingOffender();
    }

    // Forge 1.7.x / 1.12 FML: "Caught exception from custommainmenu"
    // Ignore when the frame is a server-stop cascade (not the boot failure).
    m = line.match(/Caught exception from ([\w-]+)/i);
    if (m && !isShutdownFrame) {
      // Peek next few lines for serverStopped before committing.
      let shutdown = false;
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        if (/(?:serverStopped|onServerStopping|serverStopping)\b/i.test(lines[j])) {
          shutdown = true;
          break;
        }
        if (/^Caused by:/i.test(lines[j].replace(/^\[.*?\]\s*\[[^\]]*\]\s*\[STDERR\]:\s*(?:\[[^\]]+\]:\s*)?/i, "").trim())) {
          break;
        }
      }
      if (!shutdown) out.modIds.add(m[1].toLowerCase());
    }

    // Fabric entrypoint failures: "Could not execute entrypoint stage 'main' due to errors, provided by 'modid'!"
    m = line.match(/provided by '([\w-]+)'/i);
    if (m) out.modIds.add(m[1].toLowerCase());

    // Fabric: "Mod 'Nice Name' (modid) ..." (crash + dependency errors)
    m = line.match(/\bMod '[^']*' \(([\w-]+)\)/);
    if (m) {
      const dependentId = m[1].toLowerCase();
      out.modIds.add(dependentId);
      // "requires ... of mod 'X' (depid), which is missing"
      // "requires version 1.1.4 of vinery, which is missing!"
      const dep = line.match(/requires .* of (?:mod )?(?:'[^']*' \(([\w-]+)\)|([\w-]+)), which is missing/i);
      if (dep) {
        out.missingDeps.add((dep[1] || dep[2]).toLowerCase());
        out.modIds.delete(dependentId);
        out.dependentModIds.add(dependentId);
      }
    }

    // HARD_DEP_NO_CANDIDATE astralvinery 1.2.0 {depends vinery @ [1.1.4]}
    m = line.match(/\bHARD_DEP(?:_NO_CANDIDATE)?\s+([\w-]+)\s/i);
    if (m) out.dependentModIds.add(m[1].toLowerCase());

    // Fabric/Quilt dependency error alt form: "requires version ... of mod modid"
    m = line.match(/\brequires [^,]* of mod ([\w-]+), which is missing/i);
    if (m) out.missingDeps.add(m[1].toLowerCase());

    // Fabric resolution summary: "Fix: add [add:vinery 1.1.4 ([[1.1.4,1.1.4]])]"
    m = line.match(/\badd:([\w-]+)\s/i);
    if (m) out.missingDeps.add(m[1].toLowerCase());

    // Forge missing dependency table: "Mod 'modid' requires 'depid'"
    m = line.match(/Mod '([\w-]+)' requires '([\w-]+)'/i);
    if (m) out.missingDeps.add(m[2].toLowerCase());

    // Unbound datapack/registry entries for a missing mod:
    // "Unbound values in registry ResourceKey[minecraft:root / minecraft:worldgen/biome]: [hexerei:willow_swamp]"
    m = line.match(/Unbound values in registry.*?:\s*\[([^\]]+)\]/i);
    if (m) {
      for (const entry of m[1].split(/,/)) {
        const ns = entry.trim().split(":")[0].toLowerCase();
        if (ns && /^[a-z][\w-]*$/.test(ns) && ns !== "minecraft") {
          out.missingDeps.add(ns);
          out.unboundNamespaces.add(ns);
        }
      }
    }

    // KubeJS / script packs referencing a parked content mod's effect/item:
    // "Missing effect 'drinkbeer:drunk'" / "Missing item 'modid:foo'"
    m = line.match(/\bMissing (?:effect|item|block|fluid|entity|enchantment|biome) '([\w-]+):/i);
    if (m) {
      const ns = m[1].toLowerCase();
      if (ns !== "minecraft") out.missingDeps.add(ns);
    }

    // Mixin *failure* lines only. Crash-report System Details (and helpers like
    // MoreCrashInfo) inventory every loaded config — treating those as offenders
    // quarantines innocent mixin providers (e.g. UniMixins) and bricks the pack.
    // Handler frames (`handler$...$foolproof$... from mod foolproof`) name the
    // offending mod — do NOT also scrape every `*.mixins.json` token on the line
    // (ATM10 stacks listed many APP: configs and mass-quarantined CTM/relics/…).
    const explicitMixinFail =
      /mixin apply failed|critical injection failure|Unable to apply [Mm]ixin|Error applying [Mm]ixin|@Mixin target .+ was not found/i.test(line);
    const handlerFromMod =
      /handler\$\w+\$/i.test(line) && /from mod \(?[\w-]+\)?/i.test(line);
    if (explicitMixinFail) {
      for (const mm of line.matchAll(/((?:[\w.-]+)?mixins?\.[\w.-]+\.json|[\w.-]+mixins?[\w.-]*\.json)/gi)) {
        out.mixinConfigs.add(mm[1]);
      }
      m = line.match(/from mod \(?([\w-]+)\)?/i);
      if (m) out.modIds.add(m[1].toLowerCase());
    } else if (handlerFromMod) {
      // One config tied to this handler's "from mod", not every APP: token on the line.
      m = line.match(
        /((?:[\w.-]+)?mixins?\.[\w.-]+\.json|[\w.-]+mixins?[\w.-]*\.json)[^:\n]*:[^\n]*?from mod \(?([\w-]+)\)?/i
      ) || line.match(/from mod \(?([\w-]+)\)?/i);
      if (m && m[2]) {
        out.mixinConfigs.add(m[1]);
        out.modIds.add(m[2].toLowerCase());
      } else if (m) {
        out.modIds.add(m[1].toLowerCase());
      }
    }

    // Mixin target class missing — often a soft-dep on a library (kubejs, etc.).
    // Record the FQCN for package matching; map well-known packages to missingDeps
    // so dependents can be quarantined without yanking the library itself.
    // Class name may wrap to the next log line after the colon.
    m = line.match(/ClassMetadataNotFoundException:\s*([\w.$]+)/i)
      || (i + 1 < lines.length && /ClassMetadataNotFoundException:\s*$/i.test(line)
        ? String(lines[i + 1]).trim().match(/^([\w.$]+)\s*$/)
        : null);
    if (m) {
      const rawName = m[1];
      const fqcn = rawName.replace(/\./g, "/").replace(/\$/g, "/");
      if (/\/kubejs\//i.test(fqcn) || /\bkubejs\b/i.test(rawName)) out.missingDeps.add("kubejs");
      // Client-only class on a dedicated server → flag for curated-client quarantine.
      // Do NOT push vanilla client FQCNs into stackClasses (that mis-attributes to
      // innocent jars via package/filename heuristics).
      if (/^net\/minecraft\/client\//i.test(fqcn) || /^net\.minecraft\.client\./i.test(rawName)) {
        out.clientClassMissing = true;
      } else {
        out.stackClasses.push(fqcn);
      }
    }

    // Client LWJGL / GLFW pulled in by a leftover client jar on NeoForge/Forge.
    // (Do NOT flag vanilla client NoClassDefFoundError here — those still need
    // stack-frame attribution to the offending mod, e.g. CustomMainMenu→GuiScreen.)
    if (/ClassNotFoundException:\s*org\.lwjgl\b/i.test(line) || /NoClassDefFoundError:\s*org\/lwjgl\b/i.test(line)) {
      out.clientClassMissing = true;
    }

    // NeoForge / ModLauncher modular frames:
    //   at TRANSFORMER/foolproof@1.0/toni.foolproof.Foo.bar(
    //   at LAYER SERVICE/sodium_service@0.8/net.caffeinemc.mods.sodium...
    m = line.match(
      /\bat (?:TRANSFORMER|LAYER SERVICE)\/([\w.-]+?)@[^\s/]+\/([\w.$]+)\.([\w$<>]+)\(/i
    );
    if (m) {
      const modKey = m[1].toLowerCase().replace(/_service$/i, "");
      if (!/^(minecraft|neoforge|forge|fml_loader|java\.base|com\.google)$/i.test(modKey)) {
        out.modIds.add(modKey);
      }
      const cls = m[2];
      if (
        !isShutdownFrame &&
        !/^(java|javax|jdk|sun|com\.sun|net\.minecraft|net\.minecraftforge|net\.neoforged|cpw\.mods|net\.fabricmc|org\.quiltmc|org\.spongepowered|com\.mojang|joptsimple|io\.netty|com\.google|org\.apache|org\.objectweb|kotlin)\b/.test(cls)
      ) {
        out.stackClasses.push(cls.replace(/\./g, "/"));
      }
    }

    // Stack frames: "at com.example.mod.Foo.bar(Foo.java:10)" — skip JRE/loader frames.
    // Allow leading whitespace / already-stripped STDERR prefixes.
    m = line.match(/\bat ([\w$.]+)\.([\w$<>]+)\(/);
    if (m && !m[1].includes("/")) {
      const cls = m[1];
      if (
        !isShutdownFrame &&
        !/^(java|javax|jdk|sun|com\.sun|net\.minecraft|net\.minecraftforge|net\.neoforged|cpw\.mods|net\.fabricmc|org\.quiltmc|org\.spongepowered|com\.mojang|joptsimple|io\.netty|com\.google|org\.apache|org\.objectweb|kotlin)\b/.test(cls)
      ) {
        out.stackClasses.push(cls.replace(/\./g, "/"));
        // Pair jar locator on the same frame (BYG AWT crashes etc.) — first only,
        // so we do not mass-quarantine every jar named in a long stack.
        if (out.jarFiles.size === 0) {
          const jarM = line.match(/\[([^\]%\n]+\.jar)/i);
          if (
            jarM &&
            !/^(server|forge|neoforge|minecraft|modlauncher|bootstraplauncher|datafixerupper|guava|eventbus)/i.test(jarM[1])
          ) {
            out.jarFiles.add(jarM[1].trim());
          }
        }
      }
    }
  }

  // Trailing section with Mod File but no Failure message we recognized.
  commitPendingOffender();
  return out;
}

// ── Attribution ─────────────────────────────────────────────────────────────

// Given crash text(s) and the install-time index, returns the offending jar
// basenames plus human-readable reasons, ordered by signal confidence:
// direct jar mention > modId > mixin config > missing dep > stack package.
// `quarantinedModIds` lets missing-dependency errors that point at an
// already-quarantined dep pull the *dependents* into quarantine too.
function mergeCrashSignals(primary, secondary) {
  const out = {
    modIds: new Set(primary.modIds),
    mixinConfigs: new Set(primary.mixinConfigs),
    jarFiles: new Set(primary.jarFiles),
    stackClasses: [ ...primary.stackClasses ],
    missingDeps: new Set(primary.missingDeps),
    dependentModIds: new Set(primary.dependentModIds ?? []),
    unboundNamespaces: new Set(primary.unboundNamespaces ?? []),
    clientClassMissing: !!(primary.clientClassMissing),
    hardFailModIds: new Set(primary.hardFailModIds ?? [])
  };
  if (!secondary) return out;

  // Console tails often include a panel auto-restart's second boot. Its
  // "Mod File:" / discovery lines are not the original failure and will
  // mass-quarantine innocent jars if merged blindly — only fill gaps.
  if (out.jarFiles.size === 0) {
    for (const j of secondary.jarFiles) out.jarFiles.add(j);
  }
  if (out.modIds.size === 0) {
    for (const id of secondary.modIds) out.modIds.add(id);
  }
  for (const cfg of secondary.mixinConfigs) out.mixinConfigs.add(cfg);
  for (const dep of secondary.missingDeps) out.missingDeps.add(dep);
  for (const id of secondary.dependentModIds ?? []) out.dependentModIds.add(id);
  for (const id of secondary.hardFailModIds ?? []) out.hardFailModIds.add(id);
  for (const ns of secondary.unboundNamespaces ?? []) out.unboundNamespaces.add(ns);
  if (secondary.clientClassMissing) out.clientClassMissing = true;
  // Append console stacks the crash report doesn't already list (report is
  // preferred order; console fills frames truncated from a short tail).
  const seen = new Set(out.stackClasses);
  for (const cls of secondary.stackClasses) {
    if (!seen.has(cls)) {
      out.stackClasses.push(cls);
      seen.add(cls);
    }
  }
  return out;
}

// Distinctive path segment → unique jar basename. Require token boundaries so
// short segments like "default" do not match defaultworldgenerator-*.jar.
const GENERIC_PKG_SEGMENTS = new Set([
  "com", "org", "net", "java", "javax", "jdk", "sun", "minecraft", "minecraftforge",
  "neoforged", "fabricmc", "quiltmc", "spongepowered", "mojang", "apache", "google",
  "common", "server", "client", "shared", "api", "impl", "util", "utils", "lib",
  "core", "mod", "mods", "init", "main", "default", "handler", "event", "proxy",
  "network", "block", "item", "tile", "entity", "world", "render", "gui"
]);

// Pack-defining / shared libraries — never treat as the quarantine target when a
// crash merely names them (cascade after removing a client jar, or mixin against
// a missing optional API). Dependents / mixin configs remain fair game.
const PROTECT_FROM_QUARANTINE = new Set([
  "minecraft", "forge", "neoforged", "fabricloader", "fabric-api", "java",
  "gregtech", "gregtechceu", "gtceu", "kubejs", "rhino", "architectury",
  "groovyscript", "llibrary",
  "codechickenlib", "cofhcore", "mantle",
  "enderio", "enderioconduits", "enderiobase", "enderiopowertools", "enderiomachines",
  "thermalexpansion", "thermalfoundation", "mekanism",
  "create", "ae2", "appliedenergistics2", "ic2", "industrialcraft",
  "thaumcraft", "botania", "tconstruct", "frostedheart", "caupona",
  "guideme", "modern_industrialization", "powah",
  "ftblibrary", "ftbchunks", "ftbquests", "ftbteams",
  "minecolonies",
  // Major content mods — never stack-frame / hard-fail quarantine.
  "astralsorcery",
  // Script hosts / pack content — never quarantine; cascades brick the pack.
  "crafttweaker", "contenttweaker", "mtlib", "modtweaker",
  // Pack-title content mods wrongly learned from one bad attribution.
  "the_vault", "irons_spellbooks", "custommachinery"
]);

function isProtectedQuarantineJar(index, jarBasename) {
  if (!jarBasename) return false;
  const id = index.modIdOf?.get(jarBasename);
  if (id && PROTECT_FROM_QUARANTINE.has(String(id).toLowerCase())) return true;
  // Known non-protected modId — do not filename-match (kubejs-thermal ≠ kubejs).
  if (id) return false;
  const lower = String(jarBasename).toLowerCase();
  // CraftTweaker2-*.jar / ContentTweaker-*.jar — primary artifact ≠ modId token.
  if (/^crafttweaker2?[-_.]/i.test(lower)) return true;
  if (/^contenttweaker[-_.]/i.test(lower)) return true;
  for (const protectedId of PROTECT_FROM_QUARANTINE) {
    if (protectedId.length < 5) continue;
    // enderio-1.12.2.jar / EnderIO-5.3.70.jar — versioned primary artifact only.
    if (new RegExp(`^${escapeRegExp(protectedId)}[-_.][0-9]`, "i").test(lower)) return true;
    if (lower === `${protectedId}.jar`) return true;
  }
  return false;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function jarFromFilenameHeuristic(index, needle) {
  if (!needle || needle.length < 8) return null;
  const n = needle.toLowerCase();
  if (GENERIC_PKG_SEGMENTS.has(n)) return null;
  const token = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(n)}(?:[^a-z0-9]|$)`, "i");
  const hits = [ ...index.byFileName.values() ].filter(f => token.test(f));
  return hits.length === 1 ? hits[0] : null;
}

function jarFromStackClass(index, cls) {
  const parts = cls.split("/").filter(Boolean);
  for (const depth of [ PREFIX_SEGMENTS, 2 ]) {
    if (parts.length <= depth) continue;
    const owners = index.byPackage.get(parts.slice(0, depth).join("/"));
    if (owners && owners.size === 1) return [ ...owners ][0];
  }
  // Jar slipped onto disk without package indexing (override filter miss): match
  // a unique filename against a distinctive package/class segment.
  for (const seg of parts) {
    if (seg.length < 5 || GENERIC_PKG_SEGMENTS.has(seg.toLowerCase())) continue;
    const hit = jarFromFilenameHeuristic(index, seg);
    if (hit) return hit;
  }
  return null;
}

function attributeCrash({ crashReportText = null, consoleTail = null, index, quarantinedModIds = [] }) {
  // Prefer the on-disk crash report when present; console is fallback / gap-fill.
  const primaryText = crashReportText || consoleTail;
  const secondaryText = crashReportText && consoleTail ? consoleTail : null;
  const signals = mergeCrashSignals(
    extractCrashSignals(primaryText),
    secondaryText ? extractCrashSignals(secondaryText) : null
  );
  const jars = new Map(); // basename → reason (first, highest-confidence)
  const add = (base, reason) => {
    if (!base || jars.has(base) || isProtectedQuarantineJar(index, base)) return;
    jars.set(base, reason);
  };
  const addHard = (base, reason) => {
    if (!base || jars.has(base)) return;
    jars.set(base, reason);
  };

  // "Ender IO cannot continue" is a dedicated-server abort banner — often a
  // cascade after we dropped a script/content dep (ContentTweaker). Never use it
  // to quarantine pack-defining mods; prefer other signals printed above it.
  for (const id of signals.hardFailModIds ?? []) {
    if (PROTECT_FROM_QUARANTINE.has(id)) continue;
    const mapped = index.byModId.get(id)
      ?? jarFromFilenameHeuristic(index, id)
      ?? null;
    addHard(mapped, `hard failure: '${id}' cannot continue`);
  }

  for (const id of signals.modIds) {
    if (PROTECT_FROM_QUARANTINE.has(id)) continue;
    // Empty index (server-pack path): try a filename heuristic so modId-only
    // signals still quarantine something instead of stalling unattributed.
    const mapped = index.byModId.get(id)
      ?? jarFromFilenameHeuristic(index, id)
      ?? null;
    add(mapped, `loader error names mod '${id}'`);
  }
  for (const cfg of signals.mixinConfigs) {
    add(index.byMixinConfig.get(cfg), `mixin config ${cfg}`);
  }

  // Missing dependency: if the missing dep is one we quarantined (or skipped),
  // the fix is to quarantine the dependents that require it.
  const quarantined = new Set(quarantinedModIds.map(s => s.toLowerCase()));
  for (const dep of signals.missingDeps) {
    if (!/^[a-z][\w-]*$/i.test(dep)) continue; // ignore parse junk like ")"
    const depMissingOrProtected = quarantined.has(dep)
      || !index.byModId.has(dep)
      || PROTECT_FROM_QUARANTINE.has(dep);
    if (depMissingOrProtected) {
      for (const [ base, deps ] of index.depsOf) {
        if ((deps ?? []).some(d => String(d).toLowerCase().split("@")[0] === dep)) {
          add(base, `requires missing/quarantined mod '${dep}'`);
        }
      }
      // Prefer byModId — short ids like "art" fail the filename heuristic (len≥8).
      for (const id of signals.dependentModIds ?? []) {
        if (PROTECT_FROM_QUARANTINE.has(id)) continue;
        const hit = index.byModId.get(id) ?? jarFromFilenameHeuristic(index, id);
        if (hit) add(hit, `requires missing mod '${dep}'`);
      }
    } else {
      // Dep exists in mods/ but failed to load — treat it as the offender.
      add(index.byModId.get(dep), `dependency '${dep}' failed to load`);
    }
  }

  // "Mod File:" lines are strong when they name the real offender, but FML also
  // lists every dependent that failed a version/dep gate. Prefer missingDeps /
  // modId hits when those already produced jars; only fall back to Mod File
  // when nothing else attributed (typical server-pack empty index).
  if (signals.missingDeps.size === 0 || jars.size === 0) {
    for (const jf of signals.jarFiles) {
      add(index.byFileName.get(jf.toLowerCase()) ?? jf, `named in crash report (${jf})`);
    }
  }

  // Forge 1.12 registry ID overflow — strong signal from the first mod register*
  // frame (MeatballCraft BloodArsenal). Must not wait behind weak stack-frame caps.
  if (jars.size === 0 && /maximum id range exceeded|Invalid id \d+/i.test(primaryText || "")) {
    for (const cls of signals.stackClasses) {
      if (!/regist/i.test(cls)) continue;
      if (/^net\/(minecraft|minecraftforge)\//i.test(cls)) continue;
      const hit = jarFromStackClass(index, cls);
      if (hit && !isProtectedQuarantineJar(index, hit)) {
        add(hit, `registry id overflow in ${cls.replace(/\//g, ".")}`);
        break;
      }
    }
  }

  // Stack frames, top-down — only when nothing stronger attributed. Skip entirely
  // on clientClassMissing: those stacks are cascade noise (AoA3 BlockRegister etc.)
  // after a ParticleManager/LWJGL client-mixin failure.
  if (jars.size === 0 && !signals.clientClassMissing) {
    for (const cls of signals.stackClasses) {
      if (/update\.?checker|ThreadGetResources|ThreadUpdateChecker|metrics|snoop|analytics|patreon/i.test(cls)) {
        continue;
      }
      // Never attribute via vanilla client class FQCNs (ClassMetadataNotFound noise).
      if (/^net\/minecraft\/client\//i.test(cls)) continue;
      const hit = jarFromStackClass(index, cls);
      if (hit && !isProtectedQuarantineJar(index, hit)) {
        add(hit, `stack frame in ${cls.replace(/\//g, ".")}`);
        break;
      }
    }
  }

  return {
    jars: [ ...jars.keys() ],
    reasons: [ ...jars.entries() ].map(([ jar, reason ]) => ({ jar, reason })),
    signals
  };
}

// Expands a set of quarantined jars with every installed jar that hard-requires
// one of their modIds (transitively) — a dependent left behind would fail on the
// missing dependency at the next boot.
// Multi-mod jars (EnderIO) only record one modId in the index — expand aliases
// so dependents of enderioconduits/etc. are pulled when the primary jar is removed.
const MODID_EXPAND_ALIASES = {
  enderio: [
    "enderio", "enderioconduits", "enderiobase", "enderiopowertools", "enderiomachines",
    "enderiointegrationtic", "enderiointegrationforestry", "enderiointegrationticlate",
    "enderioconduitsappliedenergistics", "enderioconduitsopencomputers",
    "enderioconduitsrefinedstorage", "gasconduits"
  ]
};

function expandWithDependents(index, jarBasenames) {
  const result = new Set(jarBasenames);
  let changed = true;
  while (changed) {
    changed = false;
    const removedIds = new Set();
    let enderioFamily = false;
    for (const b of result) {
      const id = index.modIdOf.get(b);
      if (id) {
        const lower = String(id).toLowerCase();
        removedIds.add(lower);
        for (const alias of MODID_EXPAND_ALIASES[lower] ?? []) removedIds.add(alias);
        if (lower === "enderio" || MODID_EXPAND_ALIASES.enderio.includes(lower)) {
          enderioFamily = true;
        }
      }
      if (/^enderio[-_.]/i.test(b) || /enderio/i.test(b)) {
        enderioFamily = true;
        for (const alias of MODID_EXPAND_ALIASES.enderio) removedIds.add(alias);
      }
    }
    for (const [ base, deps ] of index.depsOf) {
      if (result.has(base)) continue;
      if ((deps ?? []).some(d => removedIds.has(d.toLowerCase()))) {
        result.add(base);
        changed = true;
      }
    }
    // EnderIO ships many jars (conduits-mekanism = gasconduits) that share no
    // depsOf edge; pull the whole EnderIO-* family plus known soft dependents.
    if (enderioFamily) {
      for (const base of index.byFileName?.values?.() ?? []) {
        if (result.has(base)) continue;
        if (
          /^enderio/i.test(base) ||
          /endertweaker|modularpowersuits|mpsextra|enderstorage|gasconduit/i.test(base)
        ) {
          result.add(base);
          changed = true;
        }
      }
    }
  }
  return [ ...result ];
}

module.exports = {
  createModIndex,
  addJarToModIndex,
  addParkedJarToModIndex,
  promoteParkedJar,
  extractCrashSignals,
  attributeCrash,
  expandWithDependents
};
