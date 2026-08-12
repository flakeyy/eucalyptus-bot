"use strict";

jest.mock("../../utility/logger.js", () => ({
  log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), debugExtended: jest.fn()
}));

jest.mock("../../utility/curseforge.js", () => {
  const actual = jest.requireActual("../../utility/curseforge.js");
  return {
    ...actual,
    getModpackFiles: jest.fn(),
    getFilesByIds: jest.fn()
  };
});

const { listModpackFiles } = require("../../utility/modpack_providers.js");
const cf = require("../../utility/curseforge.js");

/** A client file with a linked server pack, as CurseForge returns them. */
function clientFile(id, { serverPackFileId = null, name = `Pack ${id}` } = {}) {
  return {
    id,
    displayName: name,
    fileName: `${name}.zip`,
    downloadUrl: `https://cdn.example.com/${id}.zip`,
    fileDate: "2026-01-01T00:00:00Z",
    fileLength: 1_048_576,
    isServerPack: false,
    serverPackFileId,
    gameVersions: [ "1.20.1", "Forge" ]
  };
}

function serverPack(id, overrides = {}) {
  return {
    id,
    displayName: `Server Pack ${id}`,
    downloadUrl: `https://cdn.example.com/server-${id}.zip`,
    fileDate: "2026-01-01T00:00:00Z",
    fileLength: 2_097_152,
    isServerPack: true,
    gameVersions: [],
    ...overrides
  };
}

describe("listModpackFiles (curseforge) — one option per version", () => {
  beforeEach(() => jest.clearAllMocks());

  const modpack = { id: 1, raw: { id: 1, latestFilesIndexes: [] }, loaderType: "forge" };

  test("emits the server pack instead of both, and marks it in the description", async () => {
    cf.getModpackFiles.mockResolvedValue([
      clientFile(10, { serverPackFileId: 110, name: "v1" }),
      clientFile(20, { serverPackFileId: 120, name: "v2" })
    ]);
    cf.getFilesByIds.mockResolvedValue([ serverPack(110), serverPack(120) ]);

    const options = await listModpackFiles("curseforge", modpack);

    // Two published versions → two options, not four interleaved in pairs.
    expect(options).toHaveLength(2);
    expect(options.map(o => o.id)).toEqual([ "110", "120" ]);
    expect(options.every(o => o.isServerPack)).toBe(true);
    expect(options[0].description).toContain("Server pack");
  });

  test("falls back to the client pack when no server pack is linked", async () => {
    cf.getModpackFiles.mockResolvedValue([ clientFile(10, { name: "v1" }) ]);
    cf.getFilesByIds.mockResolvedValue([]);

    const options = await listModpackFiles("curseforge", modpack);

    expect(options).toHaveLength(1);
    expect(options[0].id).toBe("10");
    expect(options[0].isServerPack).toBe(false);
    expect(options[0].description).toContain("Client pack");
  });

  test("server-pack option inherits loader/MC metadata from its client file", async () => {
    // Server pack entries routinely ship empty gameVersions; dropping the client
    // file entirely would lose loader and MC detection with it.
    cf.getModpackFiles.mockResolvedValue([ clientFile(10, { serverPackFileId: 110 }) ]);
    cf.getFilesByIds.mockResolvedValue([ serverPack(110, { gameVersions: [] }) ]);

    const [ option ] = await listModpackFiles("curseforge", modpack);

    expect(option.mcVersion).toBe("1.20.1");
    expect(option.loaderType).toBe("forge");
    expect(option.description).toContain("1.20.1");
  });
});
