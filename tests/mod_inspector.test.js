jest.mock("../config.json", () => ({
  mod_id_blocklist: [ "blockedmod", "fancymenu" ],
  mod_id_allowlist: [ "allowedmod" ]
}), { virtual: true });

jest.mock("../utility/verdict_store.js", () => ({
  getInspection: jest.fn(() => null),
  putInspection: jest.fn(),
  getLearnedVerdict: jest.fn(() => null),
  flushVerdictStore: jest.fn(),
  isMixinInfrastructureJar: jest.requireActual("../utility/verdict_store.js").isMixinInfrastructureJar,
  isProtectedLearnedMod: jest.requireActual("../utility/verdict_store.js").isProtectedLearnedMod
}));

const AdmZip = require("adm-zip");
const {
  inspectModJar, decideModInstall, isClientOnlyMod, extractModDeps
} = require("../utility/mod_inspector.js");
const verdictStore = require("../utility/verdict_store.js");

// Build an in-memory JAR with the given entries: { path: content }.
function makeJar(entries) {
  const zip = new AdmZip();
  for (const [ filePath, content ] of Object.entries(entries)) {
    zip.addFile(filePath, Buffer.isBuffer(content) ? content : Buffer.from(content));
  }
  return zip.toBuffer();
}

beforeEach(() => {
  jest.clearAllMocks();
  verdictStore.getLearnedVerdict.mockReturnValue(null);
});

// ─── inspectModJar: explicit declarations only ──────────────────────────────

describe("inspectModJar — explicit declarations", () => {
  test("fabric: environment=client → explicit client", () => {
    const buf = makeJar({ "fabric.mod.json": JSON.stringify({ id: "x", environment: "client" }) });
    expect(inspectModJar(buf)).toEqual({ verdict: "client", confidence: "explicit", loader: "fabric", source: "env-client" });
  });

  test("quilt: minecraft.environment=client → explicit client", () => {
    const buf = makeJar({ "quilt.mod.json": JSON.stringify({ quilt_loader: { id: "x" }, minecraft: { environment: "client" } }) });
    expect(inspectModJar(buf, "quilt")).toMatchObject({ verdict: "client", confidence: "explicit" });
  });

  test("quilt: legacy quilt_loader.environment=client is still honored", () => {
    const buf = makeJar({ "quilt.mod.json": JSON.stringify({ quilt_loader: { id: "x", environment: "client" } }) });
    expect(inspectModJar(buf, "quilt")).toMatchObject({ verdict: "client", confidence: "explicit" });
  });

  test("forge: top-level clientSideOnly=true → explicit client (3dskinlayers/entityculling pattern)", () => {
    const toml = "clientSideOnly=true\n[[mods]]\nmodId=\"x\"\n[[dependencies.x]]\nmodId=\"minecraft\"\nside=\"BOTH\"\n";
    const buf = makeJar({ "META-INF/mods.toml": toml });
    expect(inspectModJar(buf, "forge")).toEqual({ verdict: "client", confidence: "explicit", loader: "forge", source: "clientSideOnly" });
  });

  test("neoforge: reads META-INF/neoforge.mods.toml in preference to forge fallback", () => {
    const buf = makeJar({
      "META-INF/neoforge.mods.toml": "clientSideOnly=true\n[[mods]]\nmodId=\"x\"\n"
    });
    expect(inspectModJar(buf, "neoforge")).toMatchObject({ verdict: "client", confidence: "explicit", loader: "neoforge" });
  });

  test("fabric: no environment field → unknown", () => {
    const buf = makeJar({ "fabric.mod.json": JSON.stringify({ id: "x" }) });
    expect(inspectModJar(buf)).toMatchObject({ verdict: "unknown", loader: "fabric", source: "no-signal" });
  });

  test("universal JAR: forge load with embedded fabric env=client → strong cross-loader (ambientsounds pattern)", () => {
    const buf = makeJar({
      "fabric.mod.json": JSON.stringify({ id: "x", environment: "client" }),
      "META-INF/mods.toml": "[[mods]]\nmodId=\"x\"\n[[dependencies.x]]\nmodId=\"minecraft\"\nside=\"BOTH\"\n"
    });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "client", confidence: "strong", source: "cross-loader-env" });
  });
});

describe("inspectModJar — deleted weak tier stays deleted", () => {
  const mixinConfig = ({ client = [], mixins = [], server = [] }) =>
    JSON.stringify({ package: "com.example.mixin", client, mixins, server });

  test("large client mixin sets are no longer a signal (fancymenu/emi are handled by blocklist/provider)", () => {
    const buf = makeJar({
      "META-INF/mods.toml": "[[mods]]\nmodId=\"x\"\n",
      "x.mixins.json": mixinConfig({ client: Array(80).fill("ClientMixin") })
    });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "unknown", source: "no-signal" });
  });

  test("forge dependency side=CLIENT is no longer a signal", () => {
    const toml = "[[mods]]\nmodId=\"x\"\n[[dependencies.x]]\nmodId=\"minecraft\"\nside=\"CLIENT\"\n";
    const buf = makeJar({ "META-INF/mods.toml": toml });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "unknown" });
  });

  test("client-only fabric entrypoints are no longer a signal", () => {
    const buf = makeJar({ "fabric.mod.json": JSON.stringify({ id: "x", entrypoints: { client: [ "a.b.C" ] } }) });
    expect(inspectModJar(buf, "fabric")).toMatchObject({ verdict: "unknown" });
  });
});

// Build a minimal Java classfile. `modMarker` plants a Forge @Mod descriptor in
// the CP so scanForgeModClientSignals treats the class as a mod container.
// `modAnnotation: true|false|null` emits a RuntimeVisibleAnnotations class
// attribute with @Mod(clientSideOnly=<bool>) (null → no annotation attribute).
function makeClassFile({ className, superName = "java/lang/Object", modMarker = true, modAnnotation = null }) {
  const utf8Index = new Map();
  const cp = []; // 1-based entries as buffers
  const addUtf8 = s => {
    if (utf8Index.has(s)) return utf8Index.get(s);
    const bytes = Buffer.from(s, "utf8");
    const entry = Buffer.alloc(3 + bytes.length);
    entry[0] = 1;
    entry.writeUInt16BE(bytes.length, 1);
    bytes.copy(entry, 3);
    cp.push(entry);
    const idx = cp.length;
    utf8Index.set(s, idx);
    return idx;
  };
  const addClass = name => {
    const u = addUtf8(name);
    const entry = Buffer.alloc(3);
    entry[0] = 7;
    entry.writeUInt16BE(u, 1);
    cp.push(entry);
    return cp.length;
  };
  const addInt = v => {
    const entry = Buffer.alloc(5);
    entry[0] = 3;
    entry.writeInt32BE(v, 1);
    cp.push(entry);
    return cp.length;
  };

  const thisIdx = addClass(className);
  const superIdx = addClass(superName);
  if (modMarker) addUtf8("Lcpw/mods/fml/common/Mod;");

  const classAttrBufs = [];
  if (modAnnotation !== null) {
    const rvaName = addUtf8("RuntimeVisibleAnnotations");
    const typeIdx = addUtf8("Lcpw/mods/fml/common/Mod;");
    const elemIdx = addUtf8("clientSideOnly");
    const constIdx = addInt(modAnnotation ? 1 : 0);
    // num_annotations(2) + type(2) + num_pairs(2) + [name(2) tag(1) const(2)]
    const body = Buffer.alloc(2 + 2 + 2 + 5);
    body.writeUInt16BE(1, 0);
    body.writeUInt16BE(typeIdx, 2);
    body.writeUInt16BE(1, 4);
    body.writeUInt16BE(elemIdx, 6);
    body[8] = 90; // 'Z' boolean
    body.writeUInt16BE(constIdx, 9);
    const attr = Buffer.alloc(6 + body.length);
    attr.writeUInt16BE(rvaName, 0);
    attr.writeUInt32BE(body.length, 2);
    body.copy(attr, 6);
    classAttrBufs.push(attr);
  }

  const cpCount = cp.length + 1;
  const header = Buffer.alloc(10);
  header.writeUInt32BE(0xCAFEBABE, 0);
  header.writeUInt16BE(0x0031, 4); // Java 5
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(cpCount, 8);

  const afterCp = Buffer.alloc(8);
  afterCp.writeUInt16BE(0x0021, 0); // ACC_PUBLIC ACC_SUPER
  afterCp.writeUInt16BE(thisIdx, 2);
  afterCp.writeUInt16BE(superIdx, 4);
  afterCp.writeUInt16BE(0, 6); // no interfaces

  const counts = Buffer.alloc(4); // 0 fields, 0 methods
  const classAttrs = Buffer.alloc(2);
  classAttrs.writeUInt16BE(classAttrBufs.length, 0);

  return Buffer.concat([ header, ...cp, afterCp, counts, classAttrs, ...classAttrBufs ]);
}

describe("inspectModJar — legacy Forge @Mod bytecode", () => {
  test("@Mod(clientSideOnly=true) → explicit client (EnchantmentDescriptions 1.12 pattern)", () => {
    const buf = makeJar({
      "mcmod.info": "[{ \"modid\": \"x\" }]",
      "com/example/ClientMod.class": makeClassFile({ className: "com/example/ClientMod", modAnnotation: true })
    });
    expect(inspectModJar(buf, "forge")).toMatchObject({
      verdict: "client", confidence: "explicit", source: "mod-annotation-clientSideOnly"
    });
  });

  test("@Mod(clientSideOnly=false) → unknown", () => {
    const buf = makeJar({
      "mcmod.info": "[{ \"modid\": \"x\" }]",
      "com/example/ContentMod.class": makeClassFile({ className: "com/example/ContentMod", modAnnotation: false })
    });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "unknown" });
  });

  test("mixed multi-mod JAR (one clientSideOnly, one not) does NOT count (CraftTweaker pattern)", () => {
    const buf = makeJar({
      "mcmod.info": "[{ \"modid\": \"x\" }]",
      "com/example/MainMod.class": makeClassFile({ className: "com/example/MainMod", modAnnotation: false }),
      "com/example/ClientSub.class": makeClassFile({ className: "com/example/ClientSub", modAnnotation: true })
    });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "unknown" });
  });

  test("clean @Mod with no annotation data → unknown/no-metadata (no more forge-mod-no-client-ref rescue)", () => {
    const buf = makeJar({
      "mcmod.info": "[{ \"modid\": \"x\" }]",
      "com/example/ContentMod.class": makeClassFile({ className: "com/example/ContentMod" })
    });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "unknown" });
  });

  test("does not run when inspecting as fabric", () => {
    const buf = makeJar({
      "fabric.mod.json": JSON.stringify({ id: "x" }),
      "com/example/ClientMod.class": makeClassFile({ className: "com/example/ClientMod", modAnnotation: true })
    });
    expect(inspectModJar(buf, "fabric")).toMatchObject({ verdict: "unknown", loader: "fabric" });
  });
});

describe("inspectModJar — loader preference and fallbacks", () => {
  test("loaderType=quilt with no quilt.mod.json falls back to fabric.mod.json", () => {
    const buf = makeJar({ "fabric.mod.json": JSON.stringify({ id: "x", environment: "client" }) });
    expect(inspectModJar(buf, "quilt")).toMatchObject({ verdict: "client", confidence: "explicit" });
  });

  test("no metadata files → no-metadata sentinel", () => {
    const buf = makeJar({ "other.txt": "irrelevant" });
    expect(inspectModJar(buf)).toEqual({ verdict: "unknown", confidence: null, loader: null, source: "no-metadata" });
  });

  test("non-zip buffer → error sentinel", () => {
    expect(inspectModJar(Buffer.from("not a zip"))).toEqual({ verdict: "unknown", confidence: null, loader: null, source: "error" });
  });
});

// ─── decideModInstall: the Layer 1 precedence table ─────────────────────────

describe("decideModInstall — precedence table", () => {
  const clientInspection = { verdict: "client", confidence: "explicit", loader: "forge", source: "env-client" };
  const unknownInspection = { verdict: "unknown", confidence: null, loader: null, source: "no-signal" };

  test("slot 1: blocklist beats everything, never rescuable", () => {
    const d = decideModInstall({
      inspection: unknownInspection, providerServerSide: "required", modId: "blockedmod"
    });
    expect(d).toMatchObject({ install: false, slot: 1, source: "blocklist", rescuable: false });
  });

  test("slot 2: allowlist installs over explicit client metadata", () => {
    const d = decideModInstall({
      inspection: clientInspection, providerServerSide: "unsupported", modId: "allowedmod"
    });
    expect(d).toMatchObject({ install: true, slot: 2, source: "allowlist" });
  });

  test("slot 2: server_side_overrides rescues known Modrinth mislabels (Pam's pattern)", () => {
    const d = decideModInstall({
      inspection: unknownInspection,
      providerServerSide: "unsupported",
      filename: "Pam's HarvestCraft 1.12.2zg.jar"
    });
    expect(d).toMatchObject({ install: true, slot: 2, source: "server-side-override" });
  });

  test("slot 2: chameleon installs despite Modrinth unsupported (Storage Drawers lib)", () => {
    const d = decideModInstall({
      inspection: unknownInspection,
      providerServerSide: "unsupported",
      modId: "chameleon",
      filename: "Chameleon-1.12-4.1.3.jar"
    });
    expect(d).toMatchObject({ install: true, slot: 2, source: "server-side-override" });
  });

  test("slot 2: NotEnoughItems installs despite Modrinth unsupported (GTNH lib)", () => {
    const d = decideModInstall({
      inspection: unknownInspection,
      providerServerSide: "unsupported",
      modId: "NotEnoughItems",
      filename: "NotEnoughItems-2.8.44-GTNH.jar"
    });
    expect(d).toMatchObject({ install: true, slot: 2, source: "server-side-override" });
  });

  test("slot 3: learned crash verdict skips even when the provider says required", () => {
    const d = decideModInstall({
      inspection: unknownInspection, providerServerSide: "required",
      sha1: "abc", learnedVerdict: "crashes-server"
    });
    expect(d).toMatchObject({ install: false, slot: 3, source: "learned-crashes-server", rescuable: true });
  });

  test("slot 3: UniMixins is never skipped via learned verdict (MixinTweaker provider)", () => {
    const d = decideModInstall({
      inspection: unknownInspection,
      sha1: "uni",
      filename: "+unimixins-all-1.7.10-0.3.0.jar",
      modId: "unimixins",
      learnedVerdict: "crashes-server"
    });
    expect(d).toMatchObject({ install: true, slot: 9, source: "default" });
  });

  test("slot 3: protected core mods ignore learned crashes-server (EnderIO)", () => {
    const d = decideModInstall({
      inspection: unknownInspection,
      sha1: "eio",
      filename: "EnderIO-1.12.2-5.3.70.jar",
      modId: "enderio",
      learnedVerdict: "crashes-server",
      providerServerSide: null
    });
    expect(d.install).toBe(true);
    expect(d.slot).not.toBe(3);
  });

  test("slot 3: learned verdict is consulted from the verdict store by sha1", () => {
    verdictStore.getLearnedVerdict.mockReturnValue("crashes-server");
    const d = decideModInstall({ inspection: unknownInspection, sha1: "deadbeef" });
    expect(d).toMatchObject({ install: false, slot: 3 });
    expect(verdictStore.getLearnedVerdict).toHaveBeenCalledWith("deadbeef");
  });

  test("slot 4: provider required/optional installs over explicit client metadata", () => {
    expect(decideModInstall({ inspection: clientInspection, providerServerSide: "required" }))
      .toMatchObject({ install: true, slot: 4 });
    expect(decideModInstall({ inspection: clientInspection, providerServerSide: "optional" }))
      .toMatchObject({ install: true, slot: 4 });
  });

  test("slot 5: explicit client metadata skips on unsupported/null, never rescuable", () => {
    expect(decideModInstall({ inspection: clientInspection, providerServerSide: "unsupported" }))
      .toMatchObject({ install: false, slot: 5, source: "env-client", rescuable: false });
    expect(decideModInstall({ inspection: clientInspection }))
      .toMatchObject({ install: false, slot: 5, rescuable: false });
  });

  test("slot 6: curated client list skips, rescuable (Blur pattern)", () => {
    const d = decideModInstall({ inspection: unknownInspection, filename: "Blur-1.0.4-14.jar" });
    expect(d).toMatchObject({ install: false, slot: 6, source: "curated-client-list", rescuable: true });
  });

  test("slot 6: CustomMainMenu skipped by modId and GTNH_ filename prefix", () => {
    expect(decideModInstall({
      inspection: unknownInspection, modId: "custommainmenu", filename: "something-else.jar"
    })).toMatchObject({ install: false, slot: 6, source: "curated-client-list", rescuable: true });
    expect(decideModInstall({
      inspection: unknownInspection, filename: "GTNH_custommainmenu-1.14.1.jar"
    })).toMatchObject({ install: false, slot: 6, source: "curated-client-list", rescuable: true });
  });

  test("slot 6: provider required/optional beats the curated list", () => {
    const d = decideModInstall({
      inspection: unknownInspection, providerServerSide: "optional", filename: "Blur-1.0.4-14.jar"
    });
    expect(d).toMatchObject({ install: true, slot: 4 });
  });

  test("slot 7: provider unsupported skips unknowns, rescuable (fusion pattern)", () => {
    const d = decideModInstall({ inspection: unknownInspection, providerServerSide: "unsupported" });
    expect(d).toMatchObject({ install: false, slot: 7, source: "provider-unsupported", rescuable: true });
  });

  test("slot 8: crash-proof scan hit skips, rescuable", () => {
    const d = decideModInstall({
      inspection: unknownInspection,
      crashRisk: { risk: true, detail: "a --init--> net/minecraft/client/Minecraft" }
    });
    expect(d).toMatchObject({ install: false, slot: 8, source: "crash-risk", rescuable: true });
  });

  test("slot 8: protected core mods ignore crash-risk skips (AE2)", () => {
    const d = decideModInstall({
      inspection: unknownInspection,
      modId: "appliedenergistics2",
      filename: "appliedenergistics2-8.4.4.jar",
      crashRisk: { risk: true, detail: "ae2 --init--> net/minecraft/client/Minecraft" }
    });
    expect(d).toMatchObject({ install: true, slot: 9 });
  });

  test("slot 9: default installs", () => {
    expect(decideModInstall({ inspection: unknownInspection })).toMatchObject({ install: true, slot: 9 });
  });
});

describe("isClientOnlyMod — boolean wrapper", () => {
  const clientInspection = { verdict: "client", confidence: "explicit", loader: "forge", source: "env-client" };
  const unknownInspection = { verdict: "unknown", confidence: null, loader: null, source: "no-signal" };

  test("provider required/optional always installs", () => {
    expect(isClientOnlyMod(clientInspection, "required")).toBe(false);
    expect(isClientOnlyMod(clientInspection, "optional")).toBe(false);
  });

  test("explicit client skips when the provider does not vouch", () => {
    expect(isClientOnlyMod(clientInspection, "unsupported")).toBe(true);
    expect(isClientOnlyMod(clientInspection, null)).toBe(true);
    expect(isClientOnlyMod(clientInspection)).toBe(true);
  });

  test("with no JAR signal pack-authored unsupported is followed; null installs", () => {
    expect(isClientOnlyMod(unknownInspection, "unsupported")).toBe(true);
    expect(isClientOnlyMod(unknownInspection, "optional")).toBe(false);
    expect(isClientOnlyMod(unknownInspection, null)).toBe(false);
  });
});

// ─── extractModDeps ─────────────────────────────────────────────────────────

describe("extractModDeps — modId and required dependencies", () => {
  test("fabric: returns id and filters out system mods (minecraft, java)", () => {
    const buf = makeJar({ "fabric.mod.json": JSON.stringify({
      id: "mymod",
      depends: { minecraft: ">=1.20", java: ">=17", fabric: "*", otherlib: "1.0" }
    }) });

    const result = extractModDeps(buf);
    expect(result.modId).toBe("mymod");
    expect(result.requiredDeps.sort()).toEqual([ "fabric", "otherlib" ].sort());
  });

  test("quilt: handles both string and object dependency entries", () => {
    const buf = makeJar({ "quilt.mod.json": JSON.stringify({
      quilt_loader: {
        id: "mymod",
        depends: [ "lib_a", { id: "lib_b" }, { id: "minecraft" } ]
      }
    }) });

    const result = extractModDeps(buf);
    expect(result.modId).toBe("mymod");
    expect(result.requiredDeps.sort()).toEqual([ "lib_a", "lib_b" ].sort());
  });

  test("forge: skips mandatory=false, type=\"optional\", and side=\"CLIENT\" deps", () => {
    const toml =
      "[[mods]]\nmodId=\"mymod\"\n" +
      "[[dependencies.mymod]]\nmodId=\"required_lib\"\n" +
      "[[dependencies.mymod]]\nmodId=\"optional_lib\"\nmandatory=false\n" +
      "[[dependencies.mymod]]\nmodId=\"typed_optional\"\ntype=\"optional\"\n" +
      "[[dependencies.mymod]]\nmodId=\"client_only_dep\"\nside=\"CLIENT\"\n" +
      "[[dependencies.mymod]]\nmodId=\"minecraft\"\n"; // system, filtered

    const result = extractModDeps(makeJar({ "META-INF/mods.toml": toml }));
    expect(result.modId).toBe("mymod");
    expect(result.requiredDeps).toEqual([ "required_lib" ]);
  });

  test("forge 1.12 mcmod.info: reads modid and requiredMods (Storage Drawers → chameleon)", () => {
    const mcmod = JSON.stringify([ {
      modid: "storagedrawers",
      requiredMods: [ "forge", "chameleon" ],
      dependencies: [ "chameleon" ],
      useDependencyInformation: true
    } ]);
    const result = extractModDeps(makeJar({ "mcmod.info": mcmod }), "forge");
    expect(result.modId).toBe("storagedrawers");
    expect(result.requiredDeps).toEqual([ "chameleon" ]);
  });

  test("forge 1.12 mcmod.info: still finds modId when only requiredMods is forge", () => {
    const mcmod = JSON.stringify([ {
      modid: "chameleon",
      requiredMods: [ "forge" ],
      useDependencyInformation: true
    } ]);
    expect(extractModDeps(makeJar({ "mcmod.info": mcmod }), "forge")).toEqual({
      modId: "chameleon",
      requiredDeps: []
    });
  });

  test("returns null modId and empty deps for an invalid zip", () => {
    expect(extractModDeps(Buffer.from("not a zip"))).toEqual({ modId: null, requiredDeps: [] });
  });

  test("returns null modId and empty deps for a JAR with no metadata", () => {
    expect(extractModDeps(makeJar({ "README.txt": "hi" }))).toEqual({ modId: null, requiredDeps: [] });
  });
});
