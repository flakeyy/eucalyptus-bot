"use strict";

jest.mock("../utility/logger.js", () => ({
  log: jest.fn(),
  debug: jest.fn(),
  debugExtended: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

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

const { registry, tryRemediations } = require("../utility/boot_remediations");
const { createModIndex } = require("../utility/crash_attribution.js");

describe("boot_remediations registry", () => {
  test("registry stays small (≤ 8 entries)", () => {
    expect(registry.length).toBeGreaterThan(0);
    expect(registry.length).toBeLessThanOrEqual(8);
  });

  test("every entry has id, description, matches, apply", () => {
    for (const rem of registry) {
      expect(typeof rem.id).toBe("string");
      expect(rem.id.length).toBeGreaterThan(0);
      expect(typeof rem.description).toBe("string");
      expect(typeof rem.matches).toBe("function");
      expect(typeof rem.apply).toBe("function");
    }
  });

  test("ids are the five planned remediations", () => {
    expect(registry.map(r => r.id).sort()).toEqual([
      "corrupt-jvm-argfile",
      "kubejs-script-errors",
      "missing-dependency-restore",
      "missing-server-jar",
      "unbound-datapack-namespaces"
    ].sort());
  });

  test("missing-server-jar matches Unable to access jarfile", () => {
    const rem = registry.find(r => r.id === "missing-server-jar");
    expect(rem.matches("Error: Unable to access jarfile server.jar", {})).toBe(true);
    expect(rem.matches("Minecraft has crashed!", {})).toBe(false);
  });

  test("corrupt-jvm-argfile matches @unix_args main-class error", () => {
    const rem = registry.find(r => r.id === "corrupt-jvm-argfile");
    expect(rem.matches("Error: Could not find or load main class @unix_args.txt", {})).toBe(true);
    expect(rem.matches("Done (1.2s)!", {})).toBe(false);
  });

  test("kubejs-script-errors matches KubeJS startup failures", () => {
    const rem = registry.find(r => r.id === "kubejs-script-errors");
    expect(rem.matches("KubeJS startup script syntax errors!", {})).toBe(true);
    expect(rem.matches("There were KubeJS server script errors", {})).toBe(true);
    expect(rem.matches("normal forge boot", {})).toBe(false);
  });

  test("unbound-datapack-namespaces matches unbound signal sets", () => {
    const rem = registry.find(r => r.id === "unbound-datapack-namespaces");
    expect(rem.matches("Failed to load datapacks", {
      attribution: { signals: { unboundNamespaces: new Set([ "hexerei" ]) } }
    })).toBe(true);
    expect(rem.matches("Failed to load datapacks", {
      attribution: { signals: { unboundNamespaces: new Set() } },
      quarantinedModIds: [ "byg" ]
    })).toBe(true);
    expect(rem.matches("clean boot", {
      attribution: { signals: { unboundNamespaces: new Set() } },
      quarantinedModIds: []
    })).toBe(false);
  });

  test("missing-dependency-restore matches parked MissingMods deps", () => {
    const rem = registry.find(r => r.id === "missing-dependency-restore");
    const index = createModIndex();
    index.parkedJars.add("NotEnoughItems-2.8.jar");
    index.parkedByModId.set("notenoughitems", "NotEnoughItems-2.8.jar");
    index.modIdOf.set("NotEnoughItems-2.8.jar", "NotEnoughItems");

    expect(rem.matches(
      "MissingModsException: requires mods [NotEnoughItems]",
      {
        modIndex: index,
        attribution: { signals: { missingDeps: new Set([ "NotEnoughItems" ]) } },
        quarantinedJars: new Set(),
        hardFailedJars: new Set()
      }
    )).toBe(true);

    expect(rem.matches(
      "MissingModsException: requires mods [NotEnoughItems]",
      {
        modIndex: createModIndex(),
        attribution: { signals: { missingDeps: new Set([ "NotEnoughItems" ]) } },
        quarantinedJars: new Set(),
        hardFailedJars: new Set()
      }
    )).toBe(false);
  });

  test("tryRemediations returns null when nothing matches", async () => {
    const result = await tryRemediations("harmless console noise", {
      serverId: "s1",
      userId: "u1",
      modIndex: createModIndex(),
      attribution: { signals: { missingDeps: new Set(), unboundNamespaces: new Set() } },
      quarantinedModIds: [],
      quarantinedJars: new Set(),
      hardFailedJars: new Set()
    });
    expect(result).toBeNull();
  });
});
