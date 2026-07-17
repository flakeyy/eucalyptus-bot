const AdmZip = require("adm-zip");
const { inspectModJar, isClientOnlyMod, extractModDeps } = require("../utility/mod_inspector.js");

// Build an in-memory JAR with the given entries: { path: stringContent }.
function makeJar(entries) {
  const zip = new AdmZip();
  for (const [ filePath, content ] of Object.entries(entries)) {
    zip.addFile(filePath, Buffer.from(content));
  }
  return zip.toBuffer();
}

const mixinConfig = ({ client = [], mixins = [], server = [] }) =>
  JSON.stringify({ package: "com.example.mixin", client, mixins, server });

// ─── inspectModJar ──────────────────────────────────────────────────────────

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
});

describe("inspectModJar — strong heuristics", () => {
  test("universal JAR: forge load with embedded fabric env=client → strong client (ambientsounds pattern)", () => {
    const buf = makeJar({
      "fabric.mod.json": JSON.stringify({ id: "x", environment: "client" }),
      "META-INF/mods.toml": "[[mods]]\nmodId=\"x\"\n[[dependencies.x]]\nmodId=\"minecraft\"\nside=\"BOTH\"\n"
    });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "client", confidence: "strong", source: "cross-loader-env" });
  });

  test("overwhelmingly client mixin set → strong client (fancymenu/oculus pattern)", () => {
    const buf = makeJar({
      "META-INF/mods.toml": "[[mods]]\nmodId=\"x\"\n[[dependencies.x]]\nmodId=\"minecraft\"\nside=\"BOTH\"\n",
      "x.mixins.json": mixinConfig({ client: Array(20).fill("ClientMixin") })
    });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "client", confidence: "strong", source: "client-mixins" });
  });

  test("client mixins below the dominance threshold → no mixin verdict (simple-voice-chat pattern)", () => {
    const buf = makeJar({
      "fabric.mod.json": JSON.stringify({ id: "x" }),
      "x.mixins.json": mixinConfig({ client: Array(9).fill("C"), mixins: [ "Common" ] })
    });
    expect(inspectModJar(buf, "fabric")).toMatchObject({ verdict: "unknown" });
  });

  test("datapack content vetoes the mixin heuristic", () => {
    const buf = makeJar({
      "META-INF/mods.toml": "[[mods]]\nmodId=\"x\"\n",
      "x.mixins.json": mixinConfig({ client: Array(20).fill("C") }),
      "data/x/recipes/thing.json": "{}"
    });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "unknown" });
  });

  test("main entrypoint vetoes mid-size client-mixin heuristic (fusion pattern)", () => {
    // Fusion ships ~29 client mixins and no common ones, but declares a main
    // entrypoint + environment=* — skipping it cascade-drops Rechiseled.
    const buf = makeJar({
      "fabric.mod.json": JSON.stringify({
        id: "fusion",
        environment: "*",
        entrypoints: { main: [ "com.example.Fusion" ], client: [ "com.example.FusionClient" ] }
      }),
      "fusion.mixins.json": mixinConfig({ client: Array(29).fill("ClientMixin") })
    });
    expect(inspectModJar(buf, "fabric")).toMatchObject({ verdict: "unknown", source: "no-signal" });
  });

  test("huge client-mixin set stays strong despite stub main entrypoint (fancymenu pattern)", () => {
    const buf = makeJar({
      "fabric.mod.json": JSON.stringify({
        id: "fancymenu",
        environment: "*",
        entrypoints: { main: [ "a.Main" ], client: [ "a.Client" ], server: [ "a.Server" ] }
      }),
      "fancymenu.mixins.json": mixinConfig({ client: Array(65).fill("ClientMixin"), mixins: [ "A", "B", "C" ] })
    });
    expect(inspectModJar(buf, "fabric")).toMatchObject({ verdict: "client", confidence: "strong", source: "client-mixins" });
  });

  test("small all-client mixin set → weak only (server libraries like CodeChickenLib ship a few client mixins)", () => {
    const buf = makeJar({
      "META-INF/mods.toml": "[[mods]]\nmodId=\"x\"\n",
      "x.mixins.json": mixinConfig({ client: Array(4).fill("ClientMixin") })
    });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "client", confidence: "weak", source: "client-mixins" });
  });

  test("a single client mixin is not enough evidence (geckolib pattern)", () => {
    const buf = makeJar({
      "META-INF/mods.toml": "[[mods]]\nmodId=\"x\"\n",
      "x.mixins.json": mixinConfig({ client: [ "OnlyOne" ] })
    });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "unknown" });
  });
});

describe("inspectModJar — weak heuristics", () => {
  test("forge: minecraft dependency side=CLIENT → weak client", () => {
    const toml = "[[mods]]\nmodId=\"x\"\n[[dependencies.x]]\nmodId=\"minecraft\"\nside=\"CLIENT\"\n";
    const buf = makeJar({ "META-INF/mods.toml": toml });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "client", confidence: "weak", source: "dep-side-client" });
  });

  test("forge: forge dependency side=CLIENT → weak client (oculus/controlling pattern)", () => {
    const toml = "[[mods]]\nmodId=\"x\"\n[[dependencies.x]]\nmodId=\"forge\"\nside=\"CLIENT\"\n[[dependencies.x]]\nmodId=\"minecraft\"\nside=\"BOTH\"\n";
    const buf = makeJar({ "META-INF/mods.toml": toml });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "client", confidence: "weak", source: "dep-side-client" });
  });

  test("forge: every declared dependency side is CLIENT → weak client (embeddium pattern)", () => {
    const toml = "[[mods]]\nmodId=\"x\"\n[[dependencies.x]]\nmodId=\"oculus\"\nside=\"CLIENT\"\n[[dependencies.x]]\nmodId=\"other\"\nside=\"CLIENT\"\n";
    const buf = makeJar({ "META-INF/mods.toml": toml });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "client", confidence: "weak", source: "all-deps-client" });
  });

  test("fabric: only client/modmenu entrypoints → weak client (entityculling pattern)", () => {
    const buf = makeJar({ "fabric.mod.json": JSON.stringify({ id: "x", entrypoints: { client: [ "a.b.C" ], modmenu: [ "a.b.M" ] } }) });
    expect(inspectModJar(buf, "fabric")).toMatchObject({ verdict: "client", confidence: "weak", source: "client-entrypoints" });
  });

  test("fabric: main entrypoint present → entrypoint heuristic does not fire", () => {
    const buf = makeJar({ "fabric.mod.json": JSON.stringify({ id: "x", entrypoints: { main: [ "a.b.M" ], client: [ "a.b.C" ] } }) });
    expect(inspectModJar(buf, "fabric")).toMatchObject({ verdict: "unknown" });
  });

  test("server-content evidence vetoes dep-side heuristics (supplementaries pattern)", () => {
    const toml = "[[mods]]\nmodId=\"x\"\n[[dependencies.x]]\nmodId=\"minecraft\"\nside=\"CLIENT\"\n";
    const buf = makeJar({
      "META-INF/mods.toml": toml,
      "x.mixins.json": mixinConfig({ client: Array(33).fill("C"), mixins: Array(74).fill("M") }),
      "data/x/recipes/thing.json": "{}"
    });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "unknown" });
  });
});

// Build a minimal Java classfile. `modMarker` plants a Forge @Mod descriptor in
// the CP so scanForgeModClientSignals treats the class as a mod container.
// `initNewClass` emits `new <class>; pop; return` in <clinit> (eager client ref).
// `fieldDesc` adds an instance field (e.g. "Lnet/minecraft/client/Minecraft;").
// `interfaces` lists interface class names the class implements.
function makeClassFile({
  className,
  superName = "java/lang/Object",
  interfaces = [],
  modMarker = true,
  initNewClass = null,
  fieldDesc = null
}) {
  const strings = [ className, superName, ...interfaces ];
  if (modMarker) strings.push("Lcpw/mods/fml/common/Mod;");
  if (initNewClass) strings.push(initNewClass, "<clinit>", "()V", "Code");
  if (fieldDesc) {
    strings.push("f", fieldDesc);
    for (const m of fieldDesc.match(/L([^;]+);/g) || []) strings.push(m.slice(1, -1));
  }

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

  for (const s of strings) addUtf8(s);
  const thisIdx = addClass(className);
  const superIdx = addClass(superName);
  const ifaceIdxs = interfaces.map(addClass);
  let initNewIdx = null;
  if (initNewClass) initNewIdx = addClass(initNewClass);

  // Ensure marker utf8 exists even if unused as a type
  if (modMarker) addUtf8("Lcpw/mods/fml/common/Mod;");

  const methods = [];
  if (initNewClass) {
    // Code: new #initNewIdx; pop; return
    const codeBytes = Buffer.from([ 187, (initNewIdx >> 8) & 0xff, initNewIdx & 0xff, 87, 177 ]);
    const codeAttr = Buffer.alloc(2 + 4 + 2 + 2 + 4 + codeBytes.length + 2 + 2);
    let o = 0;
    codeAttr.writeUInt16BE(addUtf8("Code"), o); o += 2;
    const codeAttrLenPos = o; o += 4;
    codeAttr.writeUInt16BE(2, o); o += 2; // max_stack
    codeAttr.writeUInt16BE(0, o); o += 2; // max_locals
    codeAttr.writeUInt32BE(codeBytes.length, o); o += 4;
    codeBytes.copy(codeAttr, o); o += codeBytes.length;
    codeAttr.writeUInt16BE(0, o); o += 2; // exception_table_length
    codeAttr.writeUInt16BE(0, o); o += 2; // attributes_count
    codeAttr.writeUInt32BE(o - codeAttrLenPos - 4, codeAttrLenPos);

    const method = Buffer.alloc(8 + codeAttr.length);
    method.writeUInt16BE(0x0008, 0); // ACC_STATIC
    method.writeUInt16BE(addUtf8("<clinit>"), 2);
    method.writeUInt16BE(addUtf8("()V"), 4);
    method.writeUInt16BE(1, 6); // one attribute
    codeAttr.copy(method, 8);
    methods.push(method);
  }

  const fields = [];
  if (fieldDesc) {
    const field = Buffer.alloc(8);
    field.writeUInt16BE(0, 0); // access
    field.writeUInt16BE(addUtf8("f"), 2);
    field.writeUInt16BE(addUtf8(fieldDesc), 4);
    field.writeUInt16BE(0, 6); // no attributes
    fields.push(field);
  }

  const cpCount = cp.length + 1;
  const header = Buffer.alloc(10);
  header.writeUInt32BE(0xCAFEBABE, 0);
  header.writeUInt16BE(0x0031, 4); // Java 5
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(cpCount, 8);

  const afterCp = Buffer.alloc(6 + 2 + ifaceIdxs.length * 2);
  afterCp.writeUInt16BE(0x0021, 0); // ACC_PUBLIC ACC_SUPER
  afterCp.writeUInt16BE(thisIdx, 2);
  afterCp.writeUInt16BE(superIdx, 4);
  afterCp.writeUInt16BE(ifaceIdxs.length, 6);
  ifaceIdxs.forEach((idx, i) => afterCp.writeUInt16BE(idx, 8 + i * 2));

  const fieldCount = Buffer.alloc(2);
  fieldCount.writeUInt16BE(fields.length, 0);
  const methodCount = Buffer.alloc(2);
  methodCount.writeUInt16BE(methods.length, 0);
  const classAttrs = Buffer.alloc(2);
  classAttrs.writeUInt16BE(0, 0);

  return Buffer.concat([ header, ...cp, afterCp, fieldCount, ...fields, methodCount, ...methods, classAttrs ]);
}

function makeForgeJar(classes) {
  const entries = { "mcmod.info": "[{ \"modid\": \"x\" }]" };
  for (const [ name, opts ] of Object.entries(classes)) {
    entries[`${name}.class`] = makeClassFile({ className: name, ...opts });
  }
  // makeJar expects string content — pass Buffers via a local zip builder
  const zip = new AdmZip();
  for (const [ filePath, content ] of Object.entries(entries)) {
    zip.addFile(filePath, Buffer.isBuffer(content) ? content : Buffer.from(content));
  }
  return zip.toBuffer();
}

describe("inspectModJar — legacy Forge @Mod bytecode", () => {
  test("eager <clinit> ref to net/minecraft/client → strong client (Sound Filters pattern)", () => {
    const buf = makeForgeJar({
      "com/example/ClientMod": { initNewClass: "net/minecraft/client/Minecraft" }
    });
    expect(inspectModJar(buf, "forge")).toMatchObject({
      verdict: "client", confidence: "strong", source: "mod-class-client-ref"
    });
  });

  test("field type net/minecraft/client → strong client", () => {
    const buf = makeForgeJar({
      "com/example/ClientMod": { fieldDesc: "Lnet/minecraft/client/Minecraft;" }
    });
    expect(inspectModJar(buf, "forge")).toMatchObject({
      verdict: "client", confidence: "strong", source: "mod-class-client-ref"
    });
  });

  test("in-JAR field type implementing a client interface → strong client (Blur pattern)", () => {
    const buf = makeForgeJar({
      "com/example/ClientMod": { fieldDesc: "Lcom/example/ShaderPack;" },
      "com/example/ShaderPack": {
        modMarker: false,
        interfaces: [ "net/minecraft/client/resources/IResourceManagerReloadListener" ]
      }
    });
    expect(inspectModJar(buf, "forge")).toMatchObject({
      verdict: "client", confidence: "strong", source: "mod-class-client-ref"
    });
  });

  test("@Mod class with no client linkage stays unknown (Pam's / BiblioCraft pattern)", () => {
    const buf = makeForgeJar({
      "com/example/ContentMod": {}
    });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "unknown" });
  });

  test("raw CP client names without eager linkage do not flag (BiblioCraft @SideOnly pattern)", () => {
    // Class CP mentions a client type only as an unused UTF8/Class entry via
    // initNewClass omitted — plant a Class CP entry by using it as superName? That
    // would flag. Instead: no client field/init; only the Mod marker.
    const buf = makeForgeJar({ "com/example/UniversalMod": {} });
    expect(inspectModJar(buf, "forge")).toMatchObject({ verdict: "unknown" });
  });

  test("does not run when inspecting as fabric", () => {
    const zip = new AdmZip();
    zip.addFile("fabric.mod.json", Buffer.from(JSON.stringify({ id: "x" })));
    zip.addFile("com/example/ClientMod.class", makeClassFile({
      className: "com/example/ClientMod",
      initNewClass: "net/minecraft/client/Minecraft"
    }));
    expect(inspectModJar(zip.toBuffer(), "fabric")).toMatchObject({ verdict: "unknown", loader: "fabric" });
  });
});

describe("inspectModJar — loader preference and fallbacks", () => {
  test("multi-loader JAR + loaderType=fabric: forge dep sides do not leak across loaders", () => {
    const buf = makeJar({
      "fabric.mod.json": JSON.stringify({ id: "x" }),
      "META-INF/mods.toml": "[[mods]]\nmodId=\"x\"\n[[dependencies.x]]\nmodId=\"minecraft\"\nside=\"CLIENT\"\n"
    });
    // Dep-side declarations are weak signals scoped to their own loader; only
    // explicit env/clientSideOnly declarations cross loaders (as "strong").
    expect(inspectModJar(buf, "fabric")).toMatchObject({ verdict: "unknown" });
  });

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

// ─── isClientOnlyMod ────────────────────────────────────────────────────────

describe("isClientOnlyMod — combining JAR verdicts with provider metadata", () => {
  const verdict = confidence => ({ verdict: "client", confidence, loader: "forge", source: "test" });
  const unknown = { verdict: "unknown", confidence: null, loader: null, source: "no-signal" };

  test("explicit and strong verdicts are trusted over the provider", () => {
    expect(isClientOnlyMod(verdict("explicit"), "required")).toBe(true);
    expect(isClientOnlyMod(verdict("strong"), "optional")).toBe(true);
  });

  test("weak verdicts yield to a provider that says the mod runs on servers", () => {
    expect(isClientOnlyMod(verdict("weak"), "optional")).toBe(false);
    expect(isClientOnlyMod(verdict("weak"), "required")).toBe(false);
    expect(isClientOnlyMod(verdict("weak"), "unsupported")).toBe(true);
    expect(isClientOnlyMod(verdict("weak"), null)).toBe(true);
    expect(isClientOnlyMod(verdict("weak"))).toBe(true);
  });

  test("with no JAR signal pack-authored unsupported is followed", () => {
    expect(isClientOnlyMod(unknown, "unsupported")).toBe(true);
    expect(isClientOnlyMod(unknown, "optional")).toBe(false);
    expect(isClientOnlyMod(unknown, null)).toBe(false);
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

  test("returns null modId and empty deps for an invalid zip", () => {
    expect(extractModDeps(Buffer.from("not a zip"))).toEqual({ modId: null, requiredDeps: [] });
  });

  test("returns null modId and empty deps for a JAR with no metadata", () => {
    expect(extractModDeps(makeJar({ "README.txt": "hi" }))).toEqual({ modId: null, requiredDeps: [] });
  });
});
