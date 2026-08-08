"use strict";

const AdmZip = require("adm-zip");
const {
  jarHasServerAppliedClientMixins,
  scanEntrypointClientCpRefs,
  assessClientSignals
} = require("../utility/client_signals.js");
const { makeClassFile } = require("./fixtures/classfile.js");

function makeJar(files) {
  const zip = new AdmZip();
  for (const [ name, data ] of Object.entries(files)) {
    zip.addFile(name, Buffer.isBuffer(data) ? data : Buffer.from(data));
  }
  return zip.toBuffer();
}

describe("jarHasServerAppliedClientMixins", () => {
  test("flags common mixin config targeting ParticleManager", () => {
    const buf = makeJar({
      "example.mixins.json": "{\n  \"package\": \"ex.mixin\",\n  \"mixins\": [\"ParticleMixin\"]\n}\n// net.minecraft.client.particle.ParticleManager\n"
    });
    expect(jarHasServerAppliedClientMixins(buf)).toBe(true);
  });

  test("ignores explicit client mixin configs", () => {
    const buf = makeJar({
      "example.client.mixins.json": "// net.minecraft.client.Minecraft\n{}"
    });
    expect(jarHasServerAppliedClientMixins(buf)).toBe(false);
  });
});

describe("scanEntrypointClientCpRefs", () => {
  test("flags @Mod class with client CP ref", () => {
    const cls = makeClassFile({
      className: "com/example/ModMain",
      modMarker: true,
      initNewClass: "net/minecraft/client/Minecraft"
    });
    const buf = makeJar({ "com/example/ModMain.class": cls });
    const { hit, root } = scanEntrypointClientCpRefs(buf);
    expect(root).toBe("com/example/ModMain");
    expect(hit).toContain("net/minecraft/client/Minecraft");
  });

  test("flags fabric server entrypoint with client CP ref", () => {
    const cls = makeClassFile({
      className: "com/example/Server",
      initNewClass: "net/minecraft/client/gui/screen/Screen"
    });
    const buf = makeJar({
      "fabric.mod.json": JSON.stringify({
        id: "x",
        entrypoints: { server: [ "com.example.Server" ], client: [ "com.example.Client" ] }
      }),
      "com/example/Server.class": cls
    });
    expect(scanEntrypointClientCpRefs(buf).hit).toContain("net/minecraft/client/");
  });

  test("clean when entrypoint has no client refs", () => {
    const cls = makeClassFile({ className: "com/example/Safe", modMarker: true });
    const buf = makeJar({ "com/example/Safe.class": cls });
    expect(scanEntrypointClientCpRefs(buf)).toEqual({ hit: null, root: null });
  });
});

describe("assessClientSignals", () => {
  test("mixin hit takes precedence", () => {
    const buf = makeJar({
      "foo.mixins.json": "net.minecraft.client.gui.screen.TitleScreen"
    });
    expect(assessClientSignals(buf)).toMatchObject({
      risk: true,
      reason: "client-mixin-on-server"
    });
  });

  test("entrypoint CP hit", () => {
    const cls = makeClassFile({
      className: "com/example/ModMain",
      modMarker: true,
      initNewClass: "net/minecraft/client/Minecraft"
    });
    const buf = makeJar({ "com/example/ModMain.class": cls });
    expect(assessClientSignals(buf)).toMatchObject({
      risk: true,
      reason: "entrypoint-client-cp"
    });
  });

  test("clean jar", () => {
    const buf = makeJar({
      "fabric.mod.json": JSON.stringify({ id: "x", entrypoints: { main: [ "a.Main" ] } })
    });
    expect(assessClientSignals(buf)).toMatchObject({ risk: false, reason: "clean" });
  });
});
