"use strict";

jest.mock("../../utility/logger.js", () => ({
  log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), debugExtended: jest.fn()
}));

const {
  searchModpacks,
  searchModpacksDetailed,
  parsePackChoice,
  clearSearchCache,
  scoreHit,
  rankHits,
  normalizeSearchText
} = require("../../utility/modpack/search.js");

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

describe("normalizeSearchText / scoreHit", () => {
  test("normalizes punctuation and case", () => {
    expect(normalizeSearchText("  All the Mods 9 - ATM9 ")).toBe("all the mods 9 atm9");
  });

  test("exact / initials beat unrelated high-download packs", () => {
    const atm = { name: "All the Mods 10 - ATM10", slug: "all-the-mods-10", downloadCount: 1_000_000 };
    const noise = { name: "Simply Optimized", slug: "sop", downloadCount: 50_000_000 };
    expect(scoreHit("atm", atm)).toBeGreaterThan(scoreHit("atm", noise));
    // "atm10" is a whole word in the title after normalize
    expect(scoreHit("atm10", atm)).toBeGreaterThan(900);
  });

  test("whole-word title match beats prefix fan packs (pixelmon)", () => {
    const official = { name: "The Pixelmon Modpack", slug: "the-pixelmon-modpack", downloadCount: 20_000_000 };
    const fan = { name: "Pixelmon Realms", slug: "pixelmon-realms", downloadCount: 600_000 };
    expect(scoreHit("pixelmon", official)).toBeGreaterThan(scoreHit("pixelmon", fan));
  });

  test("rankHits puts ATM above mega-download unrelated pack for query atm", () => {
    const ranked = rankHits("atm", [
      { source: "mr", value: "mr:sop", name: "Simply Optimized", slug: "sop", downloadCount: 200 },
      { source: "cf", value: "cf:1", name: "All the Mods 10 - ATM10", slug: "all-the-mods-10", downloadCount: 100 }
    ]);
    expect(ranked.map(h => h.value)).toEqual([ "cf:1" ]);
  });

  test("rankHits drops zero-relevance noise when strong matches exist", () => {
    const ranked = rankHits("rlcraft", [
      { source: "cf", value: "cf:285109", name: "RLCraft", slug: "rlcraft", downloadCount: 1e7 },
      { source: "cf", value: "cf:999", name: "Unrelated Junk", slug: "junk", downloadCount: 1e9 }
    ]);
    expect(ranked.map(h => h.value)).toEqual([ "cf:285109" ]);
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

  test("merges CF + MR results, ranks by relevance, and caches", async () => {
    // CF search, MR search, then slug resolves (CF slug + MR project) — order may vary
    // but all use fetch. Return ATM from CF search and SOP from MR; noise downloads high on SOP.
    global.fetch.mockImplementation(async url => {
      const u = String(url);
      if (u.includes("api.curseforge.com") && u.includes("searchFilter=")) {
        return {
          ok: true,
          json: async () => ({
            data: [ { id: 1, name: "All the Mods 10 - ATM10", slug: "all-the-mods-10", downloadCount: 100 } ]
          })
        };
      }
      if (u.includes("api.modrinth.com/v2/search")) {
        return {
          ok: true,
          json: async () => ({
            hits: [ { project_id: "abc", slug: "sop", title: "Simply Optimized", downloads: 200 } ]
          })
        };
      }
      // slug lookups
      return { ok: false, json: async () => ({}) };
    });

    const first = await searchModpacks("atm");
    expect(first[0]).toEqual({ name: "All the Mods 10 - ATM10 (CurseForge)", value: "cf:1" });
    // Unrelated high-download SOP is filtered out (no textual match for "atm").
    expect(first.every(c => c.value !== "mr:sop")).toBe(true);

    const fetchCount = global.fetch.mock.calls.length;
    const second = await searchModpacks("ATM");
    expect(second).toEqual(first);
    expect(global.fetch).toHaveBeenCalledTimes(fetchCount); // cache hit
  });

  test("degrades when one provider fails", async () => {
    global.fetch.mockImplementation(async url => {
      const u = String(url);
      if (u.includes("api.curseforge.com") && u.includes("searchFilter=")) {
        throw new Error("cf down");
      }
      if (u.includes("api.modrinth.com/v2/search")) {
        return {
          ok: true,
          json: async () => ({ hits: [ { project_id: "x", slug: "pack", title: "Pack", downloads: 1 } ] })
        };
      }
      return { ok: false, json: async () => ({}) };
    });

    const results = await searchModpacks("pack");
    expect(results).toEqual([ { name: "Pack (Modrinth)", value: "mr:pack" } ]);
  });

  test("searchModpacksDetailed includes scores and uses CF popularity sort", async () => {
    global.fetch.mockImplementation(async url => {
      const u = String(url);
      if (u.includes("api.curseforge.com") && u.includes("searchFilter=")) {
        expect(u).toContain("sortField=2");
        expect(u).toContain("sortOrder=desc");
        return {
          ok: true,
          json: async () => ({
            data: [ { id: 285109, name: "RLCraft", slug: "rlcraft", downloadCount: 1e7 } ]
          })
        };
      }
      if (u.includes("api.modrinth.com/v2/search")) {
        return { ok: true, json: async () => ({ hits: [] }) };
      }
      return { ok: false, json: async () => ({}) };
    });

    const hits = await searchModpacksDetailed("rlcraft");
    expect(hits[0].value).toBe("cf:285109");
    expect(hits[0].score).toBeGreaterThan(1000);
  });
});
