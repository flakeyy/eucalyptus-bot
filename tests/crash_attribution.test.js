const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const {
  createModIndex,
  addJarToModIndex,
  extractCrashSignals,
  attributeCrash,
  expandWithDependents
} = require("../utility/crash_attribution.js");

const forgeCrashReport = fs.readFileSync(path.join(__dirname, "fixtures/forge_crash_report.txt"), "utf8");
const fabricCrashLog = fs.readFileSync(path.join(__dirname, "fixtures/fabric_crash_log.txt"), "utf8");
const fabricDependencyLog = fs.readFileSync(path.join(__dirname, "fixtures/fabric_dependency_log.txt"), "utf8");

function makeJar(entries) {
  const zip = new AdmZip();
  for (const [ p, content ] of Object.entries(entries)) {
    zip.addFile(p, Buffer.isBuffer(content) ? content : Buffer.from(content));
  }
  return zip.toBuffer();
}

function indexWith(jars) {
  const index = createModIndex();
  for (const [ filename, { entries = {}, meta = {} } ] of Object.entries(jars)) {
    addJarToModIndex(index, filename, makeJar(entries), meta);
  }
  return index;
}

describe("extractCrashSignals", () => {
  test("Forge crash report: jar file, mod id, and stack classes", () => {
    const s = extractCrashSignals(forgeCrashReport);
    expect([ ...s.jarFiles ]).toContain("backpacked-1.16.5-1.4.2.jar");
    expect([ ...s.modIds ]).toContain("backpacked");
    expect(s.stackClasses).toContain("com/mrcrayfish/backpacked/Backpacked");
    // Loader/JRE frames are filtered out
    expect(s.stackClasses.some(c => c.startsWith("net/minecraftforge"))).toBe(false);
    expect(s.stackClasses.some(c => c.startsWith("java/"))).toBe(false);
  });

  test("Fabric entrypoint crash: offending mod id from 'provided by'", () => {
    const s = extractCrashSignals(fabricCrashLog);
    expect([ ...s.modIds ]).toContain("xaerominimap");
    expect(s.stackClasses).toContain("xaero/minimap/XaeroMinimap");
  });

  test("Fabric missing dependency: dep id captured, dependent treated as victim", () => {
    const s = extractCrashSignals(fabricDependencyLog);
    expect([ ...s.missingDeps ]).toContain("sodium");
    expect([ ...s.modIds ]).not.toContain("sodium-extra");
  });

  test("mixin config names are captured", () => {
    const s = extractCrashSignals("Mixin apply failed fancymenu.mixins.json:MixinTitleScreen from mod (fancymenu)");
    expect([ ...s.mixinConfigs ]).toContain("fancymenu.mixins.json");
    expect([ ...s.modIds ]).toContain("fancymenu");
  });
});

describe("attributeCrash", () => {
  test("Forge crash report attributes to the offending jar via Mod File / modId", () => {
    const index = indexWith({
      "backpacked-1.16.5-1.4.2.jar": {
        entries: { "com/mrcrayfish/backpacked/Backpacked.class": "x" },
        meta: { modId: "backpacked", sha1: "sha-backpacked" }
      },
      "other-mod.jar": { meta: { modId: "othermod" } }
    });
    const result = attributeCrash({ crashReportText: forgeCrashReport, index });
    expect(result.jars).toEqual([ "backpacked-1.16.5-1.4.2.jar" ]);
  });

  test("Fabric crash log attributes by mod id", () => {
    const index = indexWith({
      "XaerosMinimap_24.jar": { meta: { modId: "xaerominimap" } },
      "sodium.jar": { meta: { modId: "sodium" } }
    });
    const result = attributeCrash({ consoleTail: fabricCrashLog, index });
    expect(result.jars).toEqual([ "XaerosMinimap_24.jar" ]);
  });

  test("missing dependency pointing at a quarantined mod pulls in the dependents", () => {
    const index = indexWith({
      "sodium-extra.jar": { meta: { modId: "sodium-extra", requiredDeps: [ "sodium" ] } },
      "unrelated.jar": { meta: { modId: "unrelated" } }
    });
    const result = attributeCrash({
      consoleTail: fabricDependencyLog,
      index,
      quarantinedModIds: [ "sodium" ]
    });
    expect(result.jars).toEqual([ "sodium-extra.jar" ]);
  });

  test("stack-frame package matching when no direct signals exist", () => {
    const index = indexWith({
      "somemod.jar": {
        entries: { "com/example/somemod/Thing.class": "x" },
        meta: { modId: "somemod" }
      },
      "othermod.jar": {
        entries: { "org/other/mod/Widget.class": "x" },
        meta: { modId: "othermod" }
      }
    });
    const tail = [
      "[Server thread/ERROR]: Encountered an unexpected exception",
      "java.lang.NoClassDefFoundError: net/minecraft/client/Minecraft",
      "at com.example.somemod.Thing.tick(Thing.java:10)",
      "at net.minecraft.server.MinecraftServer.tickServer(MinecraftServer.java:900)"
    ].join("\n");
    const result = attributeCrash({ consoleTail: tail, index });
    expect(result.jars).toEqual([ "somemod.jar" ]);
  });

  test("mixin config maps back to the shipping jar", () => {
    const index = indexWith({
      "fancy.jar": {
        entries: { "fancymenu.mixins.json": JSON.stringify({ package: "de.keksuccino" }) },
        meta: { modId: "fancymenu" }
      }
    });
    const result = attributeCrash({
      consoleTail: "Mixin apply failed fancymenu.mixins.json:MixinTitleScreen",
      index
    });
    expect(result.jars).toEqual([ "fancy.jar" ]);
  });

  test("returns empty attribution when nothing matches", () => {
    const index = indexWith({ "a.jar": { meta: { modId: "a" } } });
    const result = attributeCrash({ consoleTail: "watchdog: server overloaded", index });
    expect(result.jars).toEqual([]);
  });

  test("falls back to the literal jar name when the index is empty (direct server-pack uploads)", () => {
    const result = attributeCrash({ crashReportText: forgeCrashReport, index: createModIndex() });
    expect(result.jars).toEqual([ "backpacked-1.16.5-1.4.2.jar" ]);
  });
});

describe("expandWithDependents", () => {
  test("transitively pulls in mods that require quarantined modIds", () => {
    const index = indexWith({
      "lib.jar": { meta: { modId: "lib" } },
      "addon.jar": { meta: { modId: "addon", requiredDeps: [ "lib" ] } },
      "addon2.jar": { meta: { modId: "addon2", requiredDeps: [ "addon" ] } },
      "independent.jar": { meta: { modId: "independent" } }
    });
    const result = expandWithDependents(index, [ "lib.jar" ]).sort();
    expect(result).toEqual([ "addon.jar", "addon2.jar", "lib.jar" ]);
  });
});
