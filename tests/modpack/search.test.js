"use strict";

jest.mock("../../utility/logger.js", () => ({
  log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), debugExtended: jest.fn()
}));

const { searchModpacks, parsePackChoice, clearSearchCache } = require("../../utility/modpack/search.js");

describe("parsePackChoice", () => {
  test.each([
    [ "cf:520914", { source: "curseforge", id: "520914" } ],
    [ "mr:sop", { source: "modrinth", id: "sop" } ],
    [ "MR:better-mc", { source: "modrinth", id: "better-mc" } ],
    [ "garbage", null ],
    [ "", null ]
  ])("%s → %j", (input, expected) => {
    expect(parsePackChoice(input)).toEqual(expected);
  });
});

describe("searchModpacks", () => {
  beforeEach(() => {
    clearSearchCache();
    global.fetch = jest.fn();
    process.env.CURSEFORGE_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.CURSEFORGE_API_KEY;
  });

  test("returns empty for short queries", async () => {
    expect(await searchModpacks("a")).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("merges CF + MR results and caches", async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [ { id: 1, name: "ATM10", slug: "atm10", downloadCount: 100 } ] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ hits: [ { project_id: "abc", slug: "sop", title: "Simply Optimized", downloads: 200 } ] })
      });

    const first = await searchModpacks("atm");
    expect(first).toEqual([
      { name: "Simply Optimized (Modrinth)", value: "mr:sop" },
      { name: "ATM10 (CurseForge)", value: "cf:1" }
    ]);
    expect(global.fetch).toHaveBeenCalledTimes(2);

    const second = await searchModpacks("ATM");
    expect(second).toEqual(first);
    expect(global.fetch).toHaveBeenCalledTimes(2); // cache hit
  });

  test("degrades when one provider fails", async () => {
    global.fetch
      .mockRejectedValueOnce(new Error("cf down"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ hits: [ { project_id: "x", slug: "pack", title: "Pack", downloads: 1 } ] })
      });

    const results = await searchModpacks("pack");
    expect(results).toEqual([ { name: "Pack (Modrinth)", value: "mr:pack" } ]);
  });
});
