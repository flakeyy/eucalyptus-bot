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
    store.recordLearnedVerdict("sha1abc", "crashes-server");
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
    store.recordLearnedVerdict("x", "crashes-server");
    store.flushVerdictStore();
    expect(JSON.parse(fs.readFileSync(storePath, "utf8")).entries.x.learnedVerdict).toBe("crashes-server");
  });
});
