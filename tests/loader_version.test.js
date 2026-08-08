const {
  parseCurseforgeManifestLoader,
  parseMrpackLoaderSpec,
  formatEggLoaderVersion,
  buildLoaderEggEnv,
  detectLoaderVersionFromBuffer
} = require("../utility/loader_version.js");
const AdmZip = require("adm-zip");

describe("parseCurseforgeManifestLoader", () => {
  test("reads primary forge build and mc version", () => {
    expect(parseCurseforgeManifestLoader({
      minecraft: {
        version: "1.20.1",
        modLoaders: [ { id: "forge-47.4.20", primary: true } ]
      }
    })).toEqual({ loaderType: "forge", build: "47.4.20", mcVersion: "1.20.1" });
  });

  test("falls back to the first loader when none is primary", () => {
    expect(parseCurseforgeManifestLoader({
      minecraft: {
        version: "1.21.1",
        modLoaders: [ { id: "neoforge-21.1.77" } ]
      }
    })).toEqual({ loaderType: "neoforge", build: "21.1.77", mcVersion: "1.21.1" });
  });
});

describe("parseMrpackLoaderSpec", () => {
  test("reads forge + minecraft from dependencies", () => {
    expect(parseMrpackLoaderSpec({
      minecraft: "1.20.1",
      forge: "47.4.0"
    })).toEqual({ loaderType: "forge", build: "47.4.0", mcVersion: "1.20.1" });
  });

  test("reads fabric-loader", () => {
    expect(parseMrpackLoaderSpec({
      minecraft: "1.20.1",
      "fabric-loader": "0.16.14"
    })).toEqual({ loaderType: "fabric", build: "0.16.14", mcVersion: "1.20.1" });
  });
});

describe("formatEggLoaderVersion", () => {
  test("forge becomes mc-build maven coords", () => {
    expect(formatEggLoaderVersion("forge", "1.20.1", "47.4.20")).toBe("1.20.1-47.4.20");
  });

  test("forge does not double-prefix a full version", () => {
    expect(formatEggLoaderVersion("forge", "1.20.1", "1.20.1-47.4.20")).toBe("1.20.1-47.4.20");
  });

  test("legacy forge 1.7.10 / 1.8.9 use mc-build-mc maven coords", () => {
    expect(formatEggLoaderVersion("forge", "1.7.10", "10.13.4.1614")).toBe("1.7.10-10.13.4.1614-1.7.10");
    expect(formatEggLoaderVersion("forge", "1.7.10", "1.7.10-10.13.4.1614")).toBe("1.7.10-10.13.4.1614-1.7.10");
    expect(formatEggLoaderVersion("forge", "1.7.10", "1.7.10-10.13.4.1614-1.7.10")).toBe("1.7.10-10.13.4.1614-1.7.10");
    expect(formatEggLoaderVersion("forge", "1.8.9", "11.15.1.2318")).toBe("1.8.9-11.15.1.2318-1.8.9");
  });

  test("neoforge stays bare except 1.20.1 bridge builds", () => {
    expect(formatEggLoaderVersion("neoforge", "1.21.1", "21.1.77")).toBe("21.1.77");
    expect(formatEggLoaderVersion("neoforge", "1.20.1", "47.1.100")).toBe("1.20.1-47.1.100");
  });
});

describe("buildLoaderEggEnv", () => {
  const config = {
    loader_version_variables: {
      forge: "FORGE_VERSION",
      neoforge: "NEOFORGE_VERSION",
      fabric: "LOADER_VERSION"
    },
    forge_build_type_variable: "BUILD_TYPE"
  };

  test("pins FORGE_VERSION from the pack", () => {
    const res = buildLoaderEggEnv({
      loaderType: "forge",
      mcVersion: "1.20.1",
      loaderSpec: { loaderType: "forge", build: "47.4.20", mcVersion: "1.20.1" },
      config
    });
    expect(res).toEqual({
      envOverrides: { FORGE_VERSION: "1.20.1-47.4.20" },
      resolvedVersion: "1.20.1-47.4.20",
      source: "pack"
    });
  });

  test("falls back to BUILD_TYPE=latest when forge is unpinned", () => {
    const res = buildLoaderEggEnv({
      loaderType: "forge",
      mcVersion: "1.20.1",
      loaderSpec: null,
      config
    });
    expect(res.source).toBe("latest-fallback");
    expect(res.envOverrides).toEqual({ BUILD_TYPE: "latest", FORGE_VERSION: "" });
  });
});

describe("detectLoaderVersionFromBuffer", () => {
  test("reads forge from a curseforge manifest zip", () => {
    const zip = new AdmZip();
    zip.addFile("manifest.json", Buffer.from(JSON.stringify({
      minecraft: {
        version: "1.20.1",
        modLoaders: [ { id: "forge-47.4.20", primary: true } ]
      }
    })));
    expect(detectLoaderVersionFromBuffer(zip.toBuffer())).toEqual({
      loaderType: "forge",
      build: "47.4.20",
      mcVersion: "1.20.1"
    });
  });
});
