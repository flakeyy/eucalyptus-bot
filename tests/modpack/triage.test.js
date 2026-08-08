"use strict";

const {
  sanitizeVerdict, createNoneProvider, diagnose, DEFAULTS
} = require("../../utility/modpack/triage/index.js");
const { createModIndex } = require("../../utility/crash_attribution.js");

describe("sanitizeVerdict", () => {
  const index = createModIndex();
  index.byFileName.set("badclient.jar", "badclient.jar");
  index.byFileName.set("ok.jar", "ok.jar");

  test("rejects jars not in modIndex", () => {
    const v = sanitizeVerdict({
      diagnosis: "x",
      action: "quarantine",
      jars: [ "unknown.jar", "badclient.jar" ],
      confidence: "high"
    }, index);
    expect(v.jars).toEqual([ "badclient.jar" ]);
    expect(v.action).toBe("quarantine");
  });

  test("low confidence takes no action", () => {
    const v = sanitizeVerdict({
      diagnosis: "maybe",
      action: "quarantine",
      jars: [ "badclient.jar" ],
      confidence: "low"
    }, index);
    expect(v.action).toBe("give-up");
  });

  test("never quarantines protected mods", () => {
    index.byFileName.set("mekanism-1.jar", "mekanism-1.jar");
    const v = sanitizeVerdict({
      diagnosis: "x",
      action: "quarantine",
      jars: [ "mekanism-1.jar" ],
      confidence: "high"
    }, index);
    expect(v.jars).toEqual([]);
    expect(v.action).toBe("give-up");
  });
});

describe("diagnose", () => {
  test("missing key / none provider is a silent no-op", async () => {
    const verdict = await diagnose(
      { consoleTail: "boom", modList: [], modIndex: createModIndex() },
      { provider: createNoneProvider(), settings: { ...DEFAULTS, provider: "none" } }
    );
    expect(verdict).toBeNull();
  });

  test("call cap holds", async () => {
    const fake = {
      diagnose: jest.fn().mockResolvedValue({
        diagnosis: "x", action: "give-up", jars: [], confidence: "high"
      })
    };
    const budget = { calls: 0 };
    const settings = { ...DEFAULTS, max_calls_per_install: 2, provider: "none" };
    const ctx = { consoleTail: "a", crashReport: "b", modList: [], modIndex: createModIndex() };
    // Bust cache between calls with distinct tails
    await diagnose({ ...ctx, consoleTail: "1" }, { provider: fake, settings, budget });
    await diagnose({ ...ctx, consoleTail: "2" }, { provider: fake, settings, budget });
    const third = await diagnose({ ...ctx, consoleTail: "3" }, { provider: fake, settings, budget });
    expect(fake.diagnose).toHaveBeenCalledTimes(2);
    expect(third).toBeNull();
    expect(budget.calls).toBe(2);
  });

  test("golden: fabric dependency log → quarantine named jar via mocked client", async () => {
    const index = createModIndex();
    index.byFileName.set("fancy-menu.jar", "fancy-menu.jar");
    const fake = {
      diagnose: async () => ({
        diagnosis: "FancyMenu is client-only and crashed the dedicated server.",
        action: "quarantine",
        jars: [ "fancy-menu.jar" ],
        confidence: "high"
      })
    };
    const verdict = await diagnose(
      { consoleTail: "FancyMenu", modList: [ "fancy-menu.jar" ], modIndex: index },
      { provider: fake, settings: DEFAULTS, cache: new Map(), budget: { calls: 0 } }
    );
    expect(verdict).toMatchObject({
      action: "quarantine",
      jars: [ "fancy-menu.jar" ],
      confidence: "high"
    });
  });
});
