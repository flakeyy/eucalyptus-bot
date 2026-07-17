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
    store.recordLearnedVerdict("real", "crashes-server", {
      filename: "bad.jar",
      detail: "stack frame in com.example.Bad"
    });
    expect(store.getLearnedVerdict("uni")).toBeNull();
    expect(store.getLearnedVerdict("camp")).toBeNull();
    expect(store.getLearnedVerdict("dep")).toBeNull();
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
        realsha: {
          learnedVerdict: "crashes-server",
          filename: "GTNH_custommainmenu-1.14.1.jar",
          detail: "stack frame in lumien.custommainmenu.CustomMainMenu"
        }
      }
    }));
    store._resetForTests(storePath);
    expect(store.getLearnedVerdict("unisha")).toBeNull();
    expect(store.getLearnedVerdict("campsha")).toBeNull();
    expect(store.getLearnedVerdict("realsha")).toBe("crashes-server");
    const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
    expect(raw.entries.unisha.learnedVerdict).toBeUndefined();
    expect(raw.entries.campsha.learnedVerdict).toBeUndefined();
    expect(raw.entries.realsha.learnedVerdict).toBe("crashes-server");
  });
});
