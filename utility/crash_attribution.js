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

// Creates an empty index. Add jars with addJarToModIndex.
function createModIndex() {
  return {
    byModId: new Map(),       // modId (lowercase) → filename
    byMixinConfig: new Map(), // mixin config name → filename
    byPackage: new Map(),     // package prefix (slash form) → Set<filename>
    byFileName: new Map(),    // lowercase basename → filename
    depsOf: new Map(),        // filename → [required modIds]
    modIdOf: new Map()        // filename → modId
  };
}

// Indexes one installed JAR. `meta` = { modId, requiredDeps, sha1 } from the
// install engine (already extracted there — no re-parse).
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
      index.byMixinConfig.set(name, base);
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
    missingDeps: new Set()
  };
  if (!text) return out;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    // Forge crash report: "Mod File: /data/mods/foo.jar" or "Mod File: foo.jar"
    let m = line.match(/Mod File:\s*(?:.*[\\/])?([^\\/]+\.jar)/i);
    if (m) out.jarFiles.add(m[1]);

    // Forge 1.13+ loading errors: "Mod ID: 'modid'" / "mod modid failure"
    m = line.match(/Mod ID:\s*'([\w-]+)'/i);
    if (m) out.modIds.add(m[1].toLowerCase());

    // Forge LoadingFailedException / errored mod lines:
    // "Failure message: Backpacked (backpacked) has failed to load correctly"
    // "... Some Mod (somemod) encountered an error during the common_setup event phase"
    m = line.match(/[^()]{0,80}\(([a-z][\w-]*)\) (?:has failed to load|encountered an error)/i);
    if (m) out.modIds.add(m[1].toLowerCase());

    // Fabric entrypoint failures: "Could not execute entrypoint stage 'main' due to errors, provided by 'modid'!"
    m = line.match(/provided by '([\w-]+)'/i);
    if (m) out.modIds.add(m[1].toLowerCase());

    // Fabric: "Mod 'Nice Name' (modid) ..." (crash + dependency errors)
    m = line.match(/\bMod '[^']*' \(([\w-]+)\)/);
    if (m) {
      out.modIds.add(m[1].toLowerCase());
      // "requires ... of mod 'X' (depid), which is missing"
      const dep = line.match(/requires .* of (?:mod )?'[^']*' \(([\w-]+)\), which is missing/);
      if (dep) {
        out.missingDeps.add(dep[1].toLowerCase());
        out.modIds.delete(m[1].toLowerCase()); // the dependent is a victim, not the cause
      }
    }

    // Fabric/Quilt dependency error alt form: "requires version ... of mod modid"
    m = line.match(/\brequires [^,]* of mod ([\w-]+), which is missing/i);
    if (m) out.missingDeps.add(m[1].toLowerCase());

    // Forge missing dependency table: "Mod 'modid' requires 'depid'"
    m = line.match(/Mod '([\w-]+)' requires '([\w-]+)'/i);
    if (m) out.missingDeps.add(m[2].toLowerCase());

    // Mixin errors: "... in config [foo.mixins.json]" / "from mod (modid)"
    for (const mm of line.matchAll(/([\w.-]+mixins?[\w.-]*\.json)/gi)) {
      out.mixinConfigs.add(mm[1]);
    }
    m = line.match(/from mod \(?([\w-]+)\)?/i);
    if (m && /mixin/i.test(line)) out.modIds.add(m[1].toLowerCase());

    // Stack frames: "at com.example.mod.Foo.bar(Foo.java:10)" — skip JRE/loader frames.
    m = line.match(/^at ([\w$.]+)\.[\w$<>]+\(/);
    if (m) {
      const cls = m[1];
      if (!/^(java|javax|jdk|sun|com\.sun|net\.minecraft|net\.minecraftforge|net\.neoforged|cpw\.mods|net\.fabricmc|org\.quiltmc|org\.spongepowered|com\.mojang|joptsimple|io\.netty|com\.google|org\.apache|org\.objectweb|kotlin)\b/.test(cls)) {
        out.stackClasses.push(cls.replace(/\./g, "/"));
      }
    }
  }
  return out;
}

// ── Attribution ─────────────────────────────────────────────────────────────

// Given crash text(s) and the install-time index, returns the offending jar
// basenames plus human-readable reasons, ordered by signal confidence:
// direct jar mention > modId > mixin config > missing dep > stack package.
// `quarantinedModIds` lets missing-dependency errors that point at an
// already-quarantined dep pull the *dependents* into quarantine too.
function attributeCrash({ crashReportText = null, consoleTail = null, index, quarantinedModIds = [] }) {
  const signals = extractCrashSignals([ crashReportText, consoleTail ].filter(Boolean).join("\n"));
  const jars = new Map(); // basename → reason (first, highest-confidence)
  const add = (base, reason) => {
    if (base && !jars.has(base)) jars.set(base, reason);
  };

  for (const jf of signals.jarFiles) {
    // Fall back to the literal jar name for installs without an index (direct
    // server-pack uploads) — the quarantine rename validates existence anyway.
    add(index.byFileName.get(jf.toLowerCase()) ?? jf, `named in crash report (${jf})`);
  }
  for (const id of signals.modIds) {
    add(index.byModId.get(id), `loader error names mod '${id}'`);
  }
  for (const cfg of signals.mixinConfigs) {
    add(index.byMixinConfig.get(cfg), `mixin config ${cfg}`);
  }

  // Missing dependency: if the missing dep is one we quarantined (or skipped),
  // the fix is to quarantine the dependents that require it.
  const quarantined = new Set(quarantinedModIds.map(s => s.toLowerCase()));
  for (const dep of signals.missingDeps) {
    if (quarantined.has(dep) || !index.byModId.has(dep)) {
      for (const [ base, deps ] of index.depsOf) {
        if ((deps ?? []).some(d => d.toLowerCase() === dep)) {
          add(base, `requires missing/quarantined mod '${dep}'`);
        }
      }
    } else {
      // Dep exists in mods/ but failed to load — treat it as the offender.
      add(index.byModId.get(dep), `dependency '${dep}' failed to load`);
    }
  }

  // Stack frames, top-down: first frame owned by exactly one indexed jar wins.
  for (const cls of signals.stackClasses) {
    const parts = cls.split("/");
    for (const depth of [ PREFIX_SEGMENTS, 2 ]) {
      if (parts.length <= depth) continue;
      const owners = index.byPackage.get(parts.slice(0, depth).join("/"));
      if (owners && owners.size === 1) {
        add([ ...owners ][0], `stack frame in ${cls.replace(/\//g, ".")}`);
        break;
      }
    }
    if (jars.size > 0) break; // top-most attributable frame is enough
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
function expandWithDependents(index, jarBasenames) {
  const result = new Set(jarBasenames);
  let changed = true;
  while (changed) {
    changed = false;
    const removedIds = new Set(
      [ ...result ].map(b => index.modIdOf.get(b)).filter(Boolean).map(s => s.toLowerCase())
    );
    for (const [ base, deps ] of index.depsOf) {
      if (result.has(base)) continue;
      if ((deps ?? []).some(d => removedIds.has(d.toLowerCase()))) {
        result.add(base);
        changed = true;
      }
    }
  }
  return [ ...result ];
}

module.exports = {
  createModIndex,
  addJarToModIndex,
  extractCrashSignals,
  attributeCrash,
  expandWithDependents
};
