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
    async connect() {
      // Mirror real Wings auth so boot-verify can open the console gate.
      Promise.resolve().then(() => this.emit("authenticated"));
    }
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
  renameServerFiles: jest.fn().mockResolvedValue(204),
  deleteServerFiles: jest.fn().mockResolvedValue(204),
  getServerInfoById: jest.fn().mockResolvedValue({
    statusCode: 200,
    body: { json: async () => ({ attributes: { internal_id: 1 } }) }
  })
}));

jest.mock("../utility/helper_functions.js", () => ({
  applicationApiCall: jest.fn().mockResolvedValue({
    statusCode: 200,
    body: {
      json: async () => ({
        attributes: {
          egg: 6,
          container: {
            startup_command: "java -Xms128M @unix_args.txt",
            image: "ghcr.io/test/java:17",
            environment: { JAVA_ARGS: "" }
          }
        }
      })
    }
  })
}));

jest.mock("../utility/verdict_store.js", () => ({
  recordLearnedVerdict: jest.fn(),
  flushVerdictStore: jest.fn(),
  getLearnedVerdict: jest.fn(() => null),
  isProtectedLearnedMod: jest.fn(() => false)
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
  // Crash markers are ignored until java/Forge boot is seen (history gate).
  ws.emit("consoleLine", "[main/INFO] [FML]: Forge Mod Loader has started");
  for (const line of lines) ws.emit("consoleLine", line);
  // Offline after a crash marker confirms the process died (see watchBootAttempt).
  ws.emit("powerStateChange", "offline");
};

const ctx = (overrides = {}) => ({
  serverId: "abc",
  userId: "u1",
  settings: {
    max_attempts: 3, success_timeout_ms: 5000, total_budget_ms: 30000,
    crash_flush_ms: 0, history_flush_ms: 0
  },
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
  test("detects Forge 'crash report has been saved to' and quarantines MissingMods dependent", async () => {
    const index = createModIndex();
    addJarToModIndex(index, "GasConduits.jar", makeJar(), {
      modId: "gasconduits", requiredDeps: [ "enderio" ], sha1: "sha-gas"
    });

    scriptBoots([
      bootCrash([
        "MissingModsException: Mod gasconduits (GasConduits) requires [enderio@[5.3.70,)]",
        "This crash report has been saved to: /home/container/./crash-reports/crash-x.txt"
      ]),
      bootSuccess
    ]);

    const res = await verifyServerBoot(ctx({ modIndex: index }));
    expect(res.success).toBe(true);
    expect(res.quarantined.map(q => q.jar)).toContain("GasConduits.jar");
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
      bootCrash([
        "Mod 'Lib' (lib) has failed to load correctly",
        "Minecraft has crashed!"
      ]),
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
      settings: {
        max_attempts: 3, success_timeout_ms: 5000, total_budget_ms: 30000,
        crash_flush_ms: 0, history_flush_ms: 0
      }
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
    // Crashed JVMs must be killed so the panel does not leave a zombie process.
    expect(sf.setServerPowerState).toHaveBeenCalledWith("abc", "u1", "kill");
  });

  test("gives up after max_attempts", async () => {
    const index = createModIndex();
    for (const n of [ 1, 2, 3, 4 ]) {
      addJarToModIndex(index, `bad${n}.jar`, makeJar(), { modId: `bad${n}`, sha1: `sha-${n}` });
    }
    scriptBoots([
      bootCrash([
        "Mod 'B1' (bad1) has failed to load correctly",
        "Minecraft has crashed!"
      ]),
      bootCrash([
        "Mod 'B2' (bad2) has failed to load correctly",
        "Minecraft has crashed!"
      ]),
      bootCrash([
        "Mod 'B3' (bad3) has failed to load correctly",
        "Minecraft has crashed!"
      ])
    ]);

    const res = await verifyServerBoot(ctx({ modIndex: index }));

    expect(res.success).toBe(false);
    expect(res.attempts).toBe(3);
    expect(res.quarantined).toHaveLength(3);
  });

  test("does not quarantine protected EnderIO on cannot-continue; attributes MissingMods dependents instead", async () => {
    const index = createModIndex();
    addJarToModIndex(index, "EnderIO-1.12.2-5.3.72.jar", makeJar({
      "crazypants/enderio/EnderIO.class": "x"
    }), { modId: "enderio", sha1: "sha-eio" });
    addJarToModIndex(index, "UberConduitProbe-1.0.jar", makeJar(), {
      modId: "uberconduitprobe", requiredDeps: [ "enderio" ], sha1: "sha-ucp"
    });

    scriptBoots([
      bootCrash([
        "Ender IO cannot continue!",
        "Minecraft has crashed!"
      ]),
      bootCrash([
        "MissingModsException: Mod uberconduitprobe (Uber Conduit Probe) requires [enderio@[5.2.60,)]",
        "This crash report has been saved to: /home/container/./crash-reports/crash-ucp.txt"
      ]),
      bootSuccess
    ]);

    sf.listServerFiles.mockImplementation(async (_id, _uid, dir) => {
      if (String(dir).includes("crash-reports")) {
        return [ { attributes: { is_file: true, name: "crash-ucp.txt", modified_at: "2026-07-20T01:00:00Z" } } ];
      }
      return [];
    });
    sf.getFileContents.mockResolvedValue(
      "Mod uberconduitprobe (Uber Conduit Probe) requires [enderio@[5.2.60,)]\n"
    );

    const res = await verifyServerBoot(ctx({
      modIndex: index,
      settings: {
        max_attempts: 4, success_timeout_ms: 5000, total_budget_ms: 60000,
        crash_flush_ms: 0, history_flush_ms: 0
      }
    }));

    // First crash (hard-fail only) is unattributed for protected EnderIO — may
    // refund/stop; second path must still never quarantine EnderIO itself.
    expect(res.quarantined.map(q => q.jar)).not.toContain("EnderIO-1.12.2-5.3.72.jar");
  });

  test("quarantines MissingModsChecker on Fabric HeadlessException without Forge JAVA_BOOT lines", async () => {
    const index = createModIndex();
    addJarToModIndex(index, "missingmodschecker.jar", makeJar({
      "toni/missingmodschecker/MissingModsWindow.class": "x"
    }), { modId: "missingmodschecker", sha1: "sha-mmc" });

    scriptBoots([
      ws => {
        ws.emit("powerStateChange", "starting");
        ws.emit("consoleLine", "[main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.19.3");
        ws.emit("consoleLine", "[main/ERROR]: Error thrown while opening! Exiting");
        ws.emit("consoleLine", "java.awt.HeadlessException:");
        ws.emit("consoleLine", "No X11 DISPLAY variable was set,");
        ws.emit("consoleLine", "\tat toni.missingmodschecker.MissingModsWindow.<init>(MissingModsWindow.java:55)");
        ws.emit("consoleLine", "[Elytra Daemon]: ---------- Detected server process in a crashed state! ----------");
        ws.emit("consoleLine", "[Elytra Daemon]: Exit code: 1");
        ws.emit("powerStateChange", "offline");
      },
      bootSuccess
    ]);

    const res = await verifyServerBoot(ctx({ modIndex: index }));

    expect(res.success).toBe(true);
    expect(res.attempts).toBe(2);
    expect(res.quarantined.map(q => q.jar)).toContain("missingmodschecker.jar");
  });

  test("ends attempt as crash when panel auto-restarts after process death (no Done wait)", async () => {
    const index = createModIndex();
    addJarToModIndex(index, "addon.jar", makeJar(), {
      modId: "addon", requiredDeps: [ "missinglib" ], sha1: "sha-addon"
    });
    index.parkedJars.add("missinglib.jar");
    index.parkedByModId.set("missinglib", "missinglib.jar");
    index.modIdOf.set("missinglib.jar", "missinglib");

    scriptBoots([
      ws => {
        ws.emit("powerStateChange", "starting");
        ws.emit("consoleLine", "[main/INFO] [FML]: Forge Mod Loader has started");
        ws.emit("consoleLine", "Mod loading failures have occurred; consult the issue messages for more details");
        ws.emit("consoleLine", "ModLoadingCrashException: Mod loading has failed");
        ws.emit("consoleLine", "-- Mod loading issue for: addon --");
        ws.emit("consoleLine", "Failure message: Mod addon requires missinglib 1.0 or above");
        ws.emit("consoleLine", "Currently, missinglib is not installed");
        // Process dies; panel brings it back before Done — must not hang.
        ws.emit("powerStateChange", "offline");
        ws.emit("powerStateChange", "starting");
        ws.emit("consoleLine", "[Server thread/INFO]: Preparing spawn area");
      },
      bootSuccess
    ]);

    const res = await verifyServerBoot(ctx({
      modIndex: index,
      settings: {
        max_attempts: 3, success_timeout_ms: 5000, total_budget_ms: 30000,
        crash_flush_ms: 0, history_flush_ms: 0
      }
    }));

    expect(res.success).toBe(true);
    expect(res.attempts).toBe(2);
    expect(sf.renameServerFiles).toHaveBeenCalled();
  });

  test("treats a steadily running server that never prints Done as success", async () => {
    scriptBoots([ ws => {
      ws.emit("powerStateChange", "starting");
      ws.emit("powerStateChange", "running");
      // no Done line — some eggs/loaders format it differently
    } ]);
    const res = await verifyServerBoot(ctx({
      settings: {
        max_attempts: 1, success_timeout_ms: 100, total_budget_ms: 30000,
        crash_flush_ms: 0, history_flush_ms: 0
      }
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

  test("restores a parked missing dep from mods-disabled/ and retries without quarantining", async () => {
    const index = createModIndex();
    addJarToModIndex(index, "blockrenderer.jar", makeJar(), {
      modId: "blockrenderer6343", requiredDeps: [ "NotEnoughItems" ], sha1: "sha-br"
    });
    index.parkedJars.add("NotEnoughItems-2.8.44-GTNH.jar");
    index.parkedByModId.set("notenoughitems", "NotEnoughItems-2.8.44-GTNH.jar");
    index.modIdOf.set("NotEnoughItems-2.8.44-GTNH.jar", "NotEnoughItems");

    scriptBoots([
      bootCrash([
        "Minecraft has crashed!",
        "The mod blockrenderer6343 (BlockRenderer6343) requires mods [NotEnoughItems] to be available"
      ]),
      bootSuccess
    ]);

    const res = await verifyServerBoot(ctx({ modIndex: index }));

    expect(res.success).toBe(true);
    expect(res.attempts).toBe(2);
    expect(res.quarantined).toEqual([]);
    expect(sf.renameServerFiles).toHaveBeenCalledWith("abc", "u1", "/", [
      { from: "mods-disabled/NotEnoughItems-2.8.44-GTNH.jar", to: "mods/NotEnoughItems-2.8.44-GTNH.jar" }
    ]);
    expect(index.parkedJars.has("NotEnoughItems-2.8.44-GTNH.jar")).toBe(false);
    expect(index.byModId.get("notenoughitems")).toBe("NotEnoughItems-2.8.44-GTNH.jar");
    expect(verdictStore.recordLearnedVerdict).not.toHaveBeenCalled();
  });
});
