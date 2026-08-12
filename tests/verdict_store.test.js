const fs = require("fs");
const os = require("os");
const path = require("path");

const store = require("../utility/verdict_store.js");

let tmpDir;
let storePath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verdict-store-"));
  storePath = path.join(tmpDir, "verdict_store.json");
  store._resetForTests(storePath);
});

afterEach(() => {
  store._resetForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("verdict store", () => {
  test("inspection round-trip survives flush + reload", () => {
    const inspection = { verdict: "client", confidence: "explicit", loader: "fabric", source: "env-client" };
    store.putInspection("sha1abc", "fabric:v8", inspection);
    store.flushVerdictStore();

    store._resetForTests(storePath);
    expect(store.getInspection("sha1abc", "fabric:v8")).toEqual(inspection);
    expect(store.getInspection("sha1abc", "forge:v8")).toBeNull();
    expect(store.getInspection("other", "fabric:v8")).toBeNull();
  });

  test("learned verdict round-trip with metadata", () => {
    store.recordLearnedVerdict("sha1abc", "crashes-server", {
      source: "boot-verify", modId: "badmod", filename: "bad.jar", detail: "named in crash report"
    });
    store.flushVerdictStore();

    store._resetForTests(storePath);
    expect(store.getLearnedVerdict("sha1abc")).toBe("crashes-server");
    expect(store.getLearnedVerdict("unknown")).toBeNull();
    expect(store.getLearnedVerdict(null)).toBeNull();

    const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
    expect(raw.entries.sha1abc).toMatchObject({
      learnedVerdict: "crashes-server", source: "boot-verify", modId: "badmod", filename: "bad.jar"
    });
  });

  test("clearLearnedVerdict removes the verdict but keeps other data", () => {
    store.putInspection("sha1abc", "any:v8", { verdict: "unknown" });
    store.recordLearnedVerdict("sha1abc", "crashes-server", { detail: "loader error names mod 'bad'" });
    store.clearLearnedVerdict("sha1abc");
    store.flushVerdictStore();

    store._resetForTests(storePath);
    expect(store.getLearnedVerdict("sha1abc")).toBeNull();
    expect(store.getInspection("sha1abc", "any:v8")).toEqual({ verdict: "unknown" });
  });

  test("crash scan round-trip", () => {
    const scan = { risk: true, detail: "a --init--> b", reason: "init-reaches-client-only" };
    store.putCrashScan("sha1abc", "1.20.1:v1", scan);
    store.flushVerdictStore();

    store._resetForTests(storePath);
    expect(store.getCrashScan("sha1abc", "1.20.1:v1")).toEqual(scan);
    expect(store.getCrashScan("sha1abc", "1.19.2:v1")).toBeNull();
  });

  test("flush is a no-op when nothing changed", () => {
    store.getLearnedVerdict("whatever"); // loads the (missing) store
    store.flushVerdictStore();
    expect(fs.existsSync(storePath)).toBe(false);
  });

  test("corrupt store file is replaced instead of crashing", () => {
    fs.writeFileSync(storePath, "{not json");
    store._resetForTests(storePath);
    expect(store.getLearnedVerdict("x")).toBeNull();
    store.recordLearnedVerdict("x", "crashes-server", { detail: "loader error names mod 'x'" });
    store.flushVerdictStore();
    expect(JSON.parse(fs.readFileSync(storePath, "utf8")).entries.x.learnedVerdict).toBe("crashes-server");
  });

  test("refuses to record low-confidence mixin-config / dependent learned verdicts", () => {
    store.recordLearnedVerdict("uni", "crashes-server", {
      filename: "+unimixins-all-1.7.10-0.3.0.jar",
      detail: "stack frame in something"
    });
    store.recordLearnedVerdict("camp", "crashes-server", {
      filename: "campfirebackport.jar",
      detail: "mixin config campfirebackport.mixin.json"
    });
    store.recordLearnedVerdict("dep", "crashes-server", {
      filename: "addon.jar",
      detail: "dependent of quarantined mod"
    });
    store.recordLearnedVerdict("stacky", "crashes-server", {
      filename: "noisy.jar",
      detail: "stack frame in com.example.Bad"
    });
    store.recordLearnedVerdict("real", "crashes-server", {
      filename: "bad.jar",
      detail: "ClassMetadataNotFoundException: net.minecraft.client.particle.ParticleManager"
    });
    expect(store.getLearnedVerdict("uni")).toBeNull();
    expect(store.getLearnedVerdict("camp")).toBeNull();
    expect(store.getLearnedVerdict("dep")).toBeNull();
    expect(store.getLearnedVerdict("stacky")).toBeNull();
    expect(store.getLearnedVerdict("real")).toBe("crashes-server");
  });

  test("load scrubs previously poisoned mixin-config learned verdicts", () => {
    fs.writeFileSync(storePath, JSON.stringify({
      version: 1,
      entries: {
        unisha: {
          learnedVerdict: "crashes-server",
          filename: "+unimixins-all-1.7.10-0.3.0.jar",
          detail: "mixin config mixins.gtnhmixins.json"
        },
        campsha: {
          learnedVerdict: "crashes-server",
          filename: "campfirebackport-1.7.10-1.11.3.jar",
          detail: "mixin config campfirebackport.mixin.json"
        },
        stacksha: {
          learnedVerdict: "crashes-server",
          filename: "noisy.jar",
          detail: "stack frame in lumien.custommainmenu.CustomMainMenu"
        },
        realsha: {
          learnedVerdict: "crashes-server",
          filename: "badclient.jar",
          detail: "ClassMetadataNotFoundException: net.minecraft.client.gui.GuiScreen"
        }
      }
    }));
    store._resetForTests(storePath);
    expect(store.getLearnedVerdict("unisha")).toBeNull();
    expect(store.getLearnedVerdict("campsha")).toBeNull();
    expect(store.getLearnedVerdict("stacksha")).toBeNull();
    expect(store.getLearnedVerdict("realsha")).toBe("crashes-server");
    const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
    expect(raw.entries.unisha.learnedVerdict).toBeUndefined();
    expect(raw.entries.campsha.learnedVerdict).toBeUndefined();
    expect(raw.entries.stacksha.learnedVerdict).toBeUndefined();
    expect(raw.entries.realsha.learnedVerdict).toBe("crashes-server");
  });
});

describe("data/protected_mods.json", () => {
  const protectedMods = require("../data/protected_mods.json");

  test("stays under its declared cap", () => {
    // Each entry is a mod the boot loop can never quarantine. Growth past the
    // cap should be a decision, not something a later reader discovers.
    expect(protectedMods.entries.length).toBeLessThanOrEqual(protectedMods.max_entries);
  });

  test("every entry carries a lowercase modId and a rationale", () => {
    for (const entry of protectedMods.entries) {
      expect(entry.modId).toBe(String(entry.modId).toLowerCase());
      expect(entry.modId).not.toMatch(/\s/);
      expect(typeof entry.note).toBe("string");
      expect(entry.note.length).toBeGreaterThan(0);
    }
  });

  test("modIds are unique", () => {
    const ids = protectedMods.entries.map(e => e.modId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("the data file is what isProtectedLearnedMod actually consults", () => {
    for (const entry of protectedMods.entries) {
      expect(store.isProtectedLearnedMod({ modId: entry.modId })).toBe(true);
    }
    expect(store.isProtectedLearnedMod({ modId: "definitely-not-in-the-list" })).toBe(false);
  });
});

describe("isProtectedLearnedMod matching", () => {
  // Regression: CoFH Core is `cofhcore` on 1.12 and `cofh_core` on 1.16+.
  // The list carried only the 1.12 spelling, so on ATM9 (1.20.1) cofh_core was
  // skipped as client-only at install time while five Thermal mods that
  // hard-require it were installed — the server could not boot.
  test.each([
    [ "modern underscored modId", { modId: "cofh_core" } ],
    [ "modern underscored filename", { filename: "cofh_core-1.20.1-11.0.2.56.jar" } ],
    [ "legacy unseparated filename", { filename: "CoFHCore-1.12.2-4.6.6.1-universal.jar" } ],
    [ "thermal_expansion filename", { filename: "thermal_expansion-1.20.1-11.0.1.29.jar" } ],
    [ "thermal_foundation filename", { filename: "thermal_foundation-1.20.1-11.0.6.70.jar" } ]
  ])("protects %s", (_label, input) => {
    expect(store.isProtectedLearnedMod(input)).toBe(true);
  });

  // Regression: "forge" is 5 chars, so the filename token loop matched every
  // jar named *-forge-*.jar. That silently protected most of a Forge pack from
  // quarantine. Loader cores are modId-only via "filenameMatch": false.
  test.each([
    [ "journeymap-1.20.1-5.10.3-forge.jar" ],
    [ "MouseTweaks-forge-mc1.20.1-2.25.1.jar" ],
    [ "Controlling-forge-1.20.1-12.0.2.jar" ],
    [ "sodiumdynamiclights-forge-1.0.10-1.20.1.jar" ]
  ])("does not protect client mod %s merely for containing 'forge'", filename => {
    expect(store.isProtectedLearnedMod({ filename })).toBe(false);
  });

  test("loader cores are still protected by modId", () => {
    for (const modId of [ "forge", "neoforge", "minecraft", "fabricloader", "fabric-api", "java" ]) {
      expect(store.isProtectedLearnedMod({ modId })).toBe(true);
    }
  });

  test("a protected id does not match an unrelated longer name", () => {
    expect(store.isProtectedLearnedMod({ filename: "createaddon-1.20.1.jar" })).toBe(false);
    expect(store.isProtectedLearnedMod({ modId: "jei" })).toBe(false);
  });
});
