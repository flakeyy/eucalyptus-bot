jest.mock("../utility/logger.js", () => ({
  log: jest.fn(),
  debug: jest.fn(),
  debugExtended: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

jest.mock("../utility/pterodactyl_websocket.js", () => {
  const { EventEmitter } = require("events");
  class FakePteroWS extends EventEmitter {
    constructor(serverId, userDiscordId) {
      super();
      this.serverId = serverId;
      this.userDiscordId = userDiscordId;
      this.closed = false;
      FakePteroWS.instances.push(this);
    }
    async connect() {}
    close() { this.closed = true; }
  }
  FakePteroWS.instances = [];
  return { PterodactylWebSocket: FakePteroWS };
});

jest.mock("../utility/server_functions.js", () => ({
  setServerPowerState: jest.fn().mockResolvedValue(204),
  listServerFiles: jest.fn().mockResolvedValue([]),
  getFileContents: jest.fn().mockResolvedValue(null),
  writeServerFile: jest.fn().mockResolvedValue(204),
  createServerDirectory: jest.fn().mockResolvedValue(204),
  renameServerFiles: jest.fn().mockResolvedValue(204)
}));

jest.mock("../utility/verdict_store.js", () => ({
  recordLearnedVerdict: jest.fn(),
  flushVerdictStore: jest.fn()
}));

const { PterodactylWebSocket: FakeWS } = require("../utility/pterodactyl_websocket.js");
const sf = require("../utility/server_functions.js");
const verdictStore = require("../utility/verdict_store.js");
const { verifyServerBoot } = require("../utility/boot_verify.js");
const { createModIndex, addJarToModIndex } = require("../utility/crash_attribution.js");
const AdmZip = require("adm-zip");

function makeJar(entries = { "dummy.txt": "x" }) {
  const zip = new AdmZip();
  for (const [ p, c ] of Object.entries(entries)) zip.addFile(p, Buffer.from(c));
  return zip.toBuffer();
}

// Boot scripts: per-attempt event sequences, played once "start" is issued.
function scriptBoots(scripts) {
  let attempt = 0;
  sf.setServerPowerState.mockImplementation(async (_id, _uid, action) => {
    if (action === "start") {
      const script = scripts[Math.min(attempt, scripts.length - 1)];
      attempt++;
      const ws = FakeWS.instances.at(-1);
      Promise.resolve().then(() => script(ws));
    }
    return 204;
  });
}

const bootSuccess = ws => {
  ws.emit("powerStateChange", "starting");
  ws.emit("consoleLine", "[Server thread/INFO]: Preparing spawn area");
  ws.emit("powerStateChange", "running");
  ws.emit("consoleLine", "[Server thread/INFO]: Done (12.345s)! For help, type \"help\"");
};

const bootCrash = lines => ws => {
  ws.emit("powerStateChange", "starting");
  for (const line of lines) ws.emit("consoleLine", line);
  // Offline after a crash marker confirms the process died (see watchBootAttempt).
  ws.emit("powerStateChange", "offline");
};

const ctx = (overrides = {}) => ({
  serverId: "abc",
  userId: "u1",
  settings: { max_attempts: 3, success_timeout_ms: 5000, total_budget_ms: 30000, crash_flush_ms: 0 },
  ...overrides
});

beforeEach(() => {
  jest.clearAllMocks();
  FakeWS.instances.length = 0;
  sf.listServerFiles.mockResolvedValue([]);
  sf.getFileContents.mockResolvedValue(null);
  sf.renameServerFiles.mockResolvedValue(204);
  sf.createServerDirectory.mockResolvedValue(204);
});

describe("verifyServerBoot", () => {
  test("succeeds on first boot when Done is printed", async () => {
    scriptBoots([ bootSuccess ]);
    const res = await verifyServerBoot(ctx());
    expect(res).toMatchObject({ success: true, attempts: 1, quarantined: [], reason: null });
    expect(FakeWS.instances).toHaveLength(1);
    expect(FakeWS.instances[0].closed).toBe(true);
  });

  test("quarantines the attributed mod, records a learned verdict, and retries to success", async () => {
    const index = createModIndex();
    addJarToModIndex(index, "badmod.jar", makeJar(), { modId: "badmod", sha1: "sha-bad" });
    addJarToModIndex(index, "goodmod.jar", makeJar(), { modId: "goodmod", sha1: "sha-good" });

    scriptBoots([
      bootCrash([ "[main/ERROR]: Minecraft has crashed!", "Mod 'Bad Mod' (badmod) caused the failure" ]),
      bootSuccess
    ]);

    const res = await verifyServerBoot(ctx({ modIndex: index }));

    expect(res.success).toBe(true);
    expect(res.attempts).toBe(2);
    expect(res.quarantined).toEqual([ { jar: "badmod.jar", reason: "loader error names mod 'badmod'" } ]);
    expect(sf.renameServerFiles).toHaveBeenCalledWith("abc", "u1", "/", [
      { from: "mods/badmod.jar", to: "mods-disabled/badmod.jar" }
    ]);
    expect(verdictStore.recordLearnedVerdict).toHaveBeenCalledWith("sha-bad", "crashes-server", expect.objectContaining({
      source: "boot-verify", modId: "badmod", filename: "badmod.jar"
    }));
    expect(verdictStore.flushVerdictStore).toHaveBeenCalled();
  });

  test("quarantines dependents of the offender in the same pass", async () => {
    const index = createModIndex();
    addJarToModIndex(index, "lib.jar", makeJar(), { modId: "lib", sha1: "sha-lib" });
    addJarToModIndex(index, "addon.jar", makeJar(), { modId: "addon", requiredDeps: [ "lib" ], sha1: "sha-addon" });

    scriptBoots([
      bootCrash([ "Mod 'Lib' (lib) has failed to load correctly" ]),
      bootSuccess
    ]);

    const res = await verifyServerBoot(ctx({ modIndex: index }));

    expect(res.success).toBe(true);
    expect(res.quarantined.map(q => q.jar).sort()).toEqual([ "addon.jar", "lib.jar" ]);
  });

  test("uses the newest crash report for attribution", async () => {
    const index = createModIndex();
    addJarToModIndex(index, "backpacked-1.16.5-1.4.2.jar", makeJar(), { modId: "backpacked", sha1: "sha-bp" });

    sf.listServerFiles.mockResolvedValue([
      { attributes: { is_file: true, name: "crash-2026-07-16.txt", modified_at: "2026-07-16T00:00:00Z" } },
      { attributes: { is_file: true, name: "crash-2026-07-17.txt", modified_at: "2026-07-17T02:03:00Z" } }
    ]);
    sf.getFileContents.mockResolvedValue("-- MOD backpacked --\n\tMod File: /data/mods/backpacked-1.16.5-1.4.2.jar\n");

    scriptBoots([ bootCrash([ "Minecraft has crashed", "[main/ERROR]: some crash" ]), bootSuccess ]);

    const res = await verifyServerBoot(ctx({ modIndex: index }));

    expect(sf.getFileContents).toHaveBeenCalledWith("abc", "u1", "/crash-reports/crash-2026-07-17.txt");
    expect(res.quarantined.map(q => q.jar)).toEqual([ "backpacked-1.16.5-1.4.2.jar" ]);
  });

  test("does not re-quarantine from a stale crash report when later boots fail differently", async () => {
    const index = createModIndex();
    addJarToModIndex(index, "badmod.jar", makeJar({ "com/bad/Mod.class": "x" }), {
      modId: "badmod", sha1: "sha-bad"
    });
    addJarToModIndex(index, "unimixins.jar", makeJar({ "mixins.gtnhmixins.json": "{}" }), {
      modId: "unimixins", sha1: "sha-uni"
    });

    sf.listServerFiles.mockResolvedValue([
      { attributes: { is_file: true, name: "crash-first.txt", modified_at: "2026-07-17T03:47:45Z" } }
    ]);
    // Inventory-style mixin names must not expand the quarantine set.
    sf.getFileContents.mockResolvedValue([
      "Caught exception from badmod",
      "at com.bad.Mod.init(Mod.java:1)",
      "Mixin Configs:",
      "mixins.gtnhmixins.json"
    ].join("\n"));

    scriptBoots([
      bootCrash([ "Minecraft has crashed" ]),
      // Second failure: LaunchWrapper death, no new crash report.
      bootCrash([ "Failed to start the minecraft server", "java.lang.ClassNotFoundException: org.spongepowered.asm.launch.MixinTweaker" ])
    ]);

    const res = await verifyServerBoot(ctx({
      modIndex: index,
      settings: { max_attempts: 3, success_timeout_ms: 5000, total_budget_ms: 30000, crash_flush_ms: 0 }
    }));

    expect(res.success).toBe(false);
    expect(res.reason).toBe("unattributed");
    expect(res.attempts).toBe(2);
    expect(res.quarantined.map(q => q.jar)).toEqual([ "badmod.jar" ]);
    expect(sf.renameServerFiles).toHaveBeenCalledTimes(1);
  });

  test("stops with reason 'unattributed' when the crash matches nothing", async () => {
    scriptBoots([ bootCrash([ "Failed to start the minecraft server", "[main/ERROR]: something exploded mysteriously" ]) ]);
    const res = await verifyServerBoot(ctx({ modIndex: createModIndex() }));
    expect(res).toMatchObject({ success: false, attempts: 1, reason: "unattributed" });
    expect(sf.renameServerFiles).not.toHaveBeenCalled();
  });

  test("gives up after max_attempts", async () => {
    const index = createModIndex();
    for (const n of [ 1, 2, 3, 4 ]) {
      addJarToModIndex(index, `bad${n}.jar`, makeJar(), { modId: `bad${n}`, sha1: `sha-${n}` });
    }
    scriptBoots([
      bootCrash([ "Mod 'B1' (bad1) has failed to load correctly" ]),
      bootCrash([ "Mod 'B2' (bad2) has failed to load correctly" ]),
      bootCrash([ "Mod 'B3' (bad3) has failed to load correctly" ])
    ]);

    const res = await verifyServerBoot(ctx({ modIndex: index }));

    expect(res.success).toBe(false);
    expect(res.attempts).toBe(3);
    expect(res.quarantined).toHaveLength(3);
  });

  test("treats a steadily running server that never prints Done as success", async () => {
    scriptBoots([ ws => {
      ws.emit("powerStateChange", "starting");
      ws.emit("powerStateChange", "running");
      // no Done line — some eggs/loaders format it differently
    } ]);
    const res = await verifyServerBoot(ctx({
      settings: { max_attempts: 1, success_timeout_ms: 100, total_budget_ms: 30000 }
    }));
    expect(res.success).toBe(true);
  });

  test("reports ws-error when the websocket cannot connect", async () => {
    scriptBoots([ bootSuccess ]);
    const originalConnect = FakeWS.prototype.connect;
    FakeWS.prototype.connect = jest.fn().mockRejectedValue(new Error("no token"));
    try {
      const res = await verifyServerBoot(ctx());
      expect(res).toMatchObject({ success: false, reason: "ws-error" });
    } finally {
      FakeWS.prototype.connect = originalConnect;
    }
  });
});
