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
    expect([ ...s.dependentModIds ]).toContain("sodium-extra");
  });

  test("Fabric requires version X of modid captures missing dep + dependent", () => {
    const s = extractCrashSignals([
      "Mod 'AstralVinery' (astralvinery) 1.2.0 requires version 1.1.4 of vinery, which is missing!",
      "HARD_DEP_NO_CANDIDATE astralvinery 1.2.0 {depends vinery @ [1.1.4]}"
    ].join("\n"));
    expect([ ...s.missingDeps ]).toContain("vinery");
    expect([ ...s.dependentModIds ]).toContain("astralvinery");
    expect([ ...s.modIds ]).not.toContain("astralvinery");
  });

  test("mixin config names are captured from failure lines", () => {
    const s = extractCrashSignals("Mixin apply failed fancymenu.mixins.json:MixinTitleScreen from mod (fancymenu)");
    expect([ ...s.mixinConfigs ]).toContain("fancymenu.mixins.json");
    expect([ ...s.modIds ]).toContain("fancymenu");
  });

  test("mixin config inventory listings are ignored (not failures)", () => {
    const inventory = [
      "Mixin Configs:",
      "\tmixins.gtnhmixins.json | com.gtnewhorizon.mixins | 1000 | true | 12",
      "\te4mc_retro_minecraft.mixins.json | com.e4mc.mixin | 1000 | true | 3",
      "\tcoretweaks.mixin.json | makamys.coretweaks.mixin | 500 | false | 8",
      "\tcampfirebackport.mixin.json | connectionwith.campfire | 1000 | true | 2"
    ].join("\n");
    const s = extractCrashSignals(inventory);
    expect([ ...s.mixinConfigs ]).toEqual([]);
  });

  test("Forge 1.7 Caught exception from captures the mod id", () => {
    const s = extractCrashSignals("[Server thread/ERROR] [FML]: Caught exception from custommainmenu");
    expect([ ...s.modIds ]).toContain("custommainmenu");
  });

  test("FML 1.7 requires mods [X] captures missing deps", () => {
    const s = extractCrashSignals(
      "The mod blockrenderer6343 (BlockRenderer6343) requires mods [NotEnoughItems] to be available"
    );
    expect([ ...s.missingDeps ]).toEqual([ "notenoughitems" ]);
  });

  test("FML 1.12 MissingModsException captures dependent and missing deps", () => {
    const s = extractCrashSignals(
      "net.minecraftforge.fml.common.MissingModsException: Mod gasconduits (GasConduits) requires [enderio@[5.3.70,), enderioconduits@[5.3.70,)]"
    );
    expect([ ...s.dependentModIds ]).toContain("gasconduits");
    expect([ ...s.missingDeps ]).toEqual(expect.arrayContaining([ "enderio", "enderioconduits" ]));
    expect([ ...s.missingDeps ]).not.toContain(")");
  });

  test("ClassMetadataNotFound for kubejs class records missingDep without treating junk", () => {
    const s = extractCrashSignals(
      "Caused by: org.spongepowered.asm.mixin.throwables.ClassMetadataNotFoundException: dev.latvian.mods.kubejs.event.EventHandler"
    );
    expect([ ...s.missingDeps ]).toContain("kubejs");
    expect(s.stackClasses.some(c => c.includes("kubejs"))).toBe(true);
  });

  test("Unbound registry biome namespaces become missingDeps", () => {
    const s = extractCrashSignals(
      "Caused by: java.lang.IllegalStateException: Unbound values in registry ResourceKey[minecraft:root / minecraft:worldgen/biome]: [hexerei:willow_swamp]"
    );
    expect([ ...s.missingDeps ]).toContain("hexerei");
    expect([ ...s.unboundNamespaces ]).toContain("hexerei");
  });

  test("Missing effect namespace becomes missingDeps (KubeJS drinkbeer)", () => {
    const s = extractCrashSignals(
      "Caused by: java.lang.RuntimeException: Missing effect 'drinkbeer:drunk'. Check spelling"
    );
    expect([ ...s.missingDeps ]).toContain("drinkbeer");
  });

  test("wrapped ClassMetadataNotFoundException sets clientClassMissing", () => {
    const s = extractCrashSignals(
      "Caused by: org.spongepowered.asm.mixin.throwables.ClassMetadataNotFoundException:\n" +
      "net.minecraft.client.particle.ParticleManager"
    );
    expect(s.clientClassMissing).toBe(true);
  });

  test("org.lwjgl ClassNotFoundException sets clientClassMissing", () => {
    const s = extractCrashSignals("Caused by: java.lang.ClassNotFoundException: org.lwjgl.Version");
    expect(s.clientClassMissing).toBe(true);
  });

  test("NeoForge LAYER SERVICE sodium_service yields sodium modId", () => {
    const s = extractCrashSignals(
      "at LAYER SERVICE/sodium_service@0.8.12-beta.2+mc1.21.1/net.caffeinemc.mods.sodium.client.compatibility.checks.PreLaunchChecks.checkEnvironment(PreLaunchChecks.java:25)"
    );
    expect([ ...s.modIds ]).toContain("sodium");
  });

  test("mixin-injected handler from mod foolproof is captured", () => {
    const s = extractCrashSignals(
      "at TRANSFORMER/minecraft@1.21.1/net.minecraft.CrashReport.handler$dak000$foolproof$injectCustomHeader(CrashReport.java:520) " +
      "~[server.jar%23382!/:?] {pl:mixin:APP:mixins.foolproof.json:CrashReportMixin from mod foolproof}"
    );
    expect([ ...s.modIds ]).toContain("foolproof");
    expect([ ...s.mixinConfigs ]).toContain("mixins.foolproof.json");
  });

  test("Caught exception from during serverStopped is ignored", () => {
    const s = extractCrashSignals([
      "net.minecraftforge.fml.common.LoaderExceptionModCrash: Caught exception from Applied Energistics 2 (appliedenergistics2)",
      "Caused by: java.lang.NullPointerException",
      "\tat appeng.core.AppEng.serverStopped(AppEng.java:271)"
    ].join("\n"));
    expect([ ...s.modIds ]).not.toContain("appliedenergistics2");
  });

  test("BYG AWT stack pairs jar basename from locator", () => {
    const s = extractCrashSignals(
      "\tat potionstudios.byg.common.item.BYGItems.lambda$static$2(BYGItems.java:38) " +
      "~[Oh_The_Biomes_You'll_Go-forge-1.19.2-2.0.1.6.jar%23652!/:2.0.1.6] {re:mixin}"
    );
    expect(s.stackClasses).toContain("potionstudios/byg/common/item/BYGItems");
    expect([ ...s.jarFiles ]).toContain("Oh_The_Biomes_You'll_Go-forge-1.19.2-2.0.1.6.jar");
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

  test("registry id overflow attributes to registering mod", () => {
    const index = createModIndex();
    index.byFileName.set("BloodArsenal-1.12.2-2.2.2-31.jar", "BloodArsenal-1.12.2-2.2.2-31.jar");
    const report = [
      "Description: Exception in server tick loop",
      "java.lang.RuntimeException: Invalid id 4096 - maximum id range exceeded.",
      "\tat net.minecraftforge.registries.ForgeRegistry.add(ForgeRegistry.java:295)",
      "\tat arcaratus.bloodarsenal.core.RegistrarBloodArsenalBlocks.registerBlock(RegistrarBloodArsenalBlocks.java:125)"
    ].join("\n");
    const result = attributeCrash({ crashReportText: report, index });
    expect(result.jars).toContain("BloodArsenal-1.12.2-2.2.2-31.jar");
    expect(result.reasons[0].reason).toMatch(/registry id overflow/);
  });

  test("CustomMainMenu GuiScreen crash matches filename when packages were never indexed", () => {
    const index = createModIndex();
    index.byFileName.set("custommainmenu-1.12.2.jar", "custommainmenu-1.12.2.jar");
    const report = [
      "cpw.mods.fml.common.LoaderException: java.lang.NoClassDefFoundError: net/minecraft/client/gui/GuiScreen",
      "Caused by: java.lang.NoClassDefFoundError: net/minecraft/client/gui/GuiScreen",
      "\tat lumien.custommainmenu.CustomMainMenu.preInit(CustomMainMenu.java:47)",
      "\tat makamys.coretweaks.optimization.transformerproxy.TransformerProxy.invoke(TransformerProxy.java:53)"
    ].join("\n");
    const result = attributeCrash({ crashReportText: report, index });
    expect(result.jars).toEqual([ "custommainmenu-1.12.2.jar" ]);
    expect(result.reasons[0].reason).toMatch(/stack frame in lumien\.custommainmenu/);
  });

  test("mixin config ownership prefers the jar whose modId matches the config stem", () => {
    const index = createModIndex();
    addJarToModIndex(index, "BiomesOPlenty-1.12.2.jar", makeJar({
      "bop.mixins.json": "{}",
      "biomesoplenty/core/BiomesOPlenty.class": "x"
    }), { modId: "biomesoplenty" });
    addJarToModIndex(index, "SpellBundle-1.12.2.jar", makeJar({
      "bop.mixins.json": "{}",
      "spellbundle/SpellBundle.class": "x"
    }), { modId: "spellbundle" });
    expect(index.byMixinConfig.get("bop.mixins.json")).toBe("BiomesOPlenty-1.12.2.jar");
    const result = attributeCrash({
      consoleTail: "Mixin apply failed bop.mixins.json:Something",
      index
    });
    expect(result.jars).toEqual([ "BiomesOPlenty-1.12.2.jar" ]);
  });

  test("System Details mixin inventory does not quarantine innocent providers", () => {
    const index = indexWith({
      "+unimixins-all-1.7.10-0.3.0.jar": {
        entries: { "mixins.gtnhmixins.json": "{}" },
        meta: { modId: "unimixins" }
      },
      "GTNH_coretweaks-0.3.4.7-GTNH.jar": {
        entries: {
          "coretweaks.mixin.json": "{}",
          "makamys/coretweaks/optimization/TransformerProxy.class": "x"
        },
        meta: { modId: "coretweaks" }
      },
      "GTNH_custommainmenu-1.14.1.jar": {
        entries: { "lumien/custommainmenu/CustomMainMenu.class": "x" },
        meta: { modId: "custommainmenu" }
      }
    });
    const crash = [
      "[Server thread/ERROR] [FML]: Caught exception from custommainmenu",
      "java.lang.NoClassDefFoundError: net/minecraft/client/gui/GuiScreen",
      "at lumien.custommainmenu.CustomMainMenu.preInit(CustomMainMenu.java:47)",
      "at makamys.coretweaks.optimization.transformerproxy.TransformerProxy.invokeNextHandler(TransformerProxy.java:53)",
      "-- System Details --",
      "Mixin Configs:",
      "mixins.gtnhmixins.json",
      "coretweaks.mixin.json"
    ].join("\n");
    const result = attributeCrash({ crashReportText: crash, index });
    expect(result.jars).toEqual([ "GTNH_custommainmenu-1.14.1.jar" ]);
  });

  test("returns empty attribution when nothing matches", () => {
    const index = indexWith({ "a.jar": { meta: { modId: "a" } } });
    const result = attributeCrash({ consoleTail: "watchdog: server overloaded", index });
    expect(result.jars).toEqual([]);
  });

  test("MissingModsException quarantines the dependent, not protected libraries", () => {
    const index = indexWith({
      "GasConduits-1.12.2.jar": {
        meta: { modId: "gasconduits", requiredDeps: [ "enderio", "enderioconduits" ] }
      },
      "EnderTweaker.jar": { meta: { modId: "endertweaker", requiredDeps: [ "enderio" ] } }
    });
    const result = attributeCrash({
      consoleTail:
        "MissingModsException: Mod gasconduits (GasConduits) requires [enderio@[5.3.70,), enderioconduits@[5.3.70,)]",
      index
    });
    expect(result.jars).toEqual(expect.arrayContaining([ "GasConduits-1.12.2.jar", "EnderTweaker.jar" ]));
  });

  test("MissingModsException attributes short dependent modId art via byModId", () => {
    const index = indexWith({
      "AdvancedRocketryTweaker-1.12.2.jar": {
        meta: { modId: "art", requiredDeps: [ "crafttweaker" ] }
      },
      "CraftTweaker2-1.12-4.1.20.700.jar": { meta: { modId: "crafttweaker" } }
    });
    const result = attributeCrash({
      consoleTail:
        "MissingModsException: Mod art (Advanced Rocketry Tweaker) requires [crafttweaker]",
      index,
      quarantinedModIds: [ "crafttweaker" ]
    });
    expect(result.jars).toContain("AdvancedRocketryTweaker-1.12.2.jar");
    expect(result.jars).not.toContain("CraftTweaker2-1.12-4.1.20.700.jar");
  });

  test("does not quarantine CraftTweaker via stack-frame cascade", () => {
    const index = indexWith({
      "CraftTweaker2-1.12-4.1.20.700.jar": {
        entries: { "crafttweaker/mc1120/item/MCItemStack.class": "x" },
        meta: { modId: "crafttweaker" }
      },
      "badaddon.jar": { meta: { modId: "badaddon", requiredDeps: [ "crafttweaker" ] } }
    });
    const result = attributeCrash({
      consoleTail: [
        "java.lang.NullPointerException",
        "at crafttweaker.mc1120.item.MCItemStack.matches(MCItemStack.java:10)"
      ].join("\n"),
      index
    });
    expect(result.jars).not.toContain("CraftTweaker2-1.12-4.1.20.700.jar");
  });

  test("does not quarantine protected core mods named in loader errors", () => {
    const index = indexWith({
      "gregtech-5.09.51.482.jar": { meta: { modId: "gregtech" } },
      "custommainmenu-1.12.2.jar": { meta: { modId: "custommainmenu" } }
    });
    const result = attributeCrash({
      consoleTail: "[FML]: Caught exception from gregtech",
      index
    });
    expect(result.jars).toEqual([]);
  });

  test("does not quarantine EnderIO via stack-frame cascade", () => {
    const index = indexWith({
      "EnderIO-1.12.2-5.3.70.jar": {
        entries: { "crazypants/enderio/base/init/CommonProxy.class": "x" },
        meta: { modId: "enderio" }
      },
      "gasconduits.jar": { meta: { modId: "gasconduits", requiredDeps: [ "enderio" ] } }
    });
    const result = attributeCrash({
      consoleTail: [
        "java.lang.NoClassDefFoundError: something",
        "at crazypants.enderio.base.init.CommonProxy.init(CommonProxy.java:10)"
      ].join("\n"),
      index
    });
    expect(result.jars).not.toContain("EnderIO-1.12.2-5.3.70.jar");
  });

  test("kubejs ClassMetadataNotFound quarantines dependents, not kubejs itself", () => {
    const index = indexWith({
      "kubejs-forge-1902.jar": { meta: { modId: "kubejs" } },
      "kubejs-thermal.jar": { meta: { modId: "kubejs_thermal", requiredDeps: [ "kubejs" ] } }
    });
    const result = attributeCrash({
      consoleTail:
        "Caused by: org.spongepowered.asm.mixin.throwables.ClassMetadataNotFoundException: dev.latvian.mods.kubejs.event.EventHandler",
      index
    });
    expect(result.jars).toContain("kubejs-thermal.jar");
    expect(result.jars).not.toContain("kubejs-forge-1902.jar");
  });

  test("falls back to the literal jar name when the index is empty (direct server-pack uploads)", () => {
    const result = attributeCrash({ crashReportText: forgeCrashReport, index: createModIndex() });
    expect(result.jars).toEqual([ "backpacked-1.16.5-1.4.2.jar" ]);
  });

  test("ignores console-tail Mod File noise when a crash report already names the offender", () => {
    const report = [
      "-- MOD subtle_effects --",
      "Details:",
      "\tMod File: /home/container/mods/SubtleEffects-forge-1.20.1-1.14.3.jar",
      "\tFailure message: Mod subtle_effects requires forge 47.4.14 or above"
    ].join("\n");
    const consoleNoise = [
      "Mod File: /home/container/mods/curios-forge-5.14.1+1.20.1.jar",
      "Mod File: /home/container/mods/fabric-api-0.92.6+1.11.14+1.20.1.jar",
      "Mod File: /home/container/mods/resourcefullib-forge-1.20.1-2.1.29.jar"
    ].join("\n");
    const result = attributeCrash({
      crashReportText: report,
      consoleTail: consoleNoise,
      index: createModIndex()
    });
    expect(result.jars).toEqual([ "SubtleEffects-forge-1.20.1-1.14.3.jar" ]);
  });

  test("Forge 'requires other-mod' gates attribute the missing dep, not every dependent jar", () => {
    const index = indexWith({
      "curios-forge-5.14.1+1.20.1.jar": { meta: { modId: "curios" } },
      "artifacts-forge-9.5.19.jar": { meta: { modId: "artifacts", requiredDeps: [ "curios" ] } },
      "Icarus-Forge-2.13.1.jar": { meta: { modId: "icarus", requiredDeps: [ "curios" ] } }
    });
    const report = [
      "-- MOD icarus --",
      "\tMod File: /home/container/mods/Icarus-Forge-2.13.1.jar",
      "\tFailure message: Mod icarus requires curios 5.8.0 or above",
      "-- MOD artifacts --",
      "\tMod File: /home/container/mods/artifacts-forge-9.5.19.jar",
      "\tFailure message: Mod artifacts requires curios 5.8.1+1.20.1 or above"
    ].join("\n");
    const result = attributeCrash({ crashReportText: report, index });
    expect(result.jars).toEqual([ "curios-forge-5.14.1+1.20.1.jar" ]);
    expect([ ...result.signals.missingDeps ]).toContain("curios");
  });

  test("Ender IO cannot continue does not quarantine protected EnderIO", () => {
    const index = indexWith({
      "EnderIO-1.12.2-5.3.70.jar": { meta: { modId: "enderio" } },
      "ae2.jar": { meta: { modId: "appliedenergistics2" } }
    });
    const report = [
      "Description: Exception in server tick loop",
      "java.lang.RuntimeException: Ender IO cannot continue, see error messages above",
      "\tat crazypants.enderio.base.EnderIO.preInit(EnderIO.java:100)"
    ].join("\n");
    const result = attributeCrash({ crashReportText: report, index });
    expect(result.jars).not.toContain("EnderIO-1.12.2-5.3.70.jar");
    expect(result.reasons.some(r => /hard failure.*enderio/i.test(r.reason))).toBe(false);
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

  test("EnderIO quarantine pulls dependents of enderioconduits aliases", () => {
    const index = indexWith({
      "EnderIO-1.12.2-5.3.70.jar": { meta: { modId: "enderio" } },
      "EnderTweaker-1.12.2-1.2.3.jar": {
        meta: { modId: "endertweaker", requiredDeps: [ "enderioconduits" ] }
      },
      "other.jar": { meta: { modId: "other" } }
    });
    const result = expandWithDependents(index, [ "EnderIO-1.12.2-5.3.70.jar" ]).sort();
    expect(result).toEqual([
      "EnderIO-1.12.2-5.3.70.jar",
      "EnderTweaker-1.12.2-1.2.3.jar"
    ]);
  });

  test("EnderIO quarantine pulls all EnderIO-* jars including conduits-mekanism", () => {
    const index = indexWith({
      "EnderIO-1.12.2-5.3.70.jar": { meta: { modId: "enderio" } },
      "EnderIO-conduits-mekanism-1.12.2-5.3.70.jar": { meta: { modId: "gasconduits" } },
      "EnderTweaker-1.12.2-1.2.3.jar": { meta: { modId: "endertweaker" } },
      "other.jar": { meta: { modId: "other" } }
    });
    const result = expandWithDependents(index, [ "EnderIO-1.12.2-5.3.70.jar" ]).sort();
    expect(result).toContain("EnderIO-conduits-mekanism-1.12.2-5.3.70.jar");
    expect(result).toContain("EnderTweaker-1.12.2-1.2.3.jar");
    expect(result).not.toContain("other.jar");
  });
});
