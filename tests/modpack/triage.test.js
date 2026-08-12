"use strict";

jest.mock("../../utility/logger.js", () => ({
  log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), debugExtended: jest.fn()
}));

const {
  sanitizeVerdict, createNoneProvider, createAnthropicProvider, diagnose,
  DEFAULTS, MAX_TOKENS, REQUEST_TIMEOUT_MS
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

describe("anthropic provider request shape", () => {
  function fakeClient(response) {
    const parse = jest.fn().mockResolvedValue(response);
    return { client: { messages: { parse } }, parse };
  }

  test("budgets max_tokens well above the verdict and disables thinking", async () => {
    const { client, parse } = fakeClient({
      parsed_output: { diagnosis: "d", action: "give-up", jars: [], confidence: "high" },
      stop_reason: "end_turn"
    });
    const provider = createAnthropicProvider(DEFAULTS, client);
    await provider.diagnose({ consoleTail: "boom", crashReport: "", modList: [] });

    const [ body, options ] = parse.mock.calls[0];
    // A verdict is a few hundred tokens; the budget must clear the prompt's
    // overhead by a wide margin or the response is truncated to nothing.
    expect(body.max_tokens).toBe(MAX_TOKENS);
    expect(body.max_tokens).toBeGreaterThanOrEqual(4096);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.output_config.effort).toBe("medium");
    expect(options.timeout).toBe(REQUEST_TIMEOUT_MS);
  });

  test("a max_tokens truncation no-ops cleanly instead of throwing", async () => {
    const { client } = fakeClient({ parsed_output: null, stop_reason: "max_tokens" });
    const provider = createAnthropicProvider(DEFAULTS, client);
    await expect(
      provider.diagnose({ consoleTail: "boom", crashReport: "", modList: [] })
    ).resolves.toBeNull();
  });

  test("a thrown SDK error no-ops cleanly", async () => {
    const client = { messages: { parse: jest.fn().mockRejectedValue(new Error("timeout")) } };
    const provider = createAnthropicProvider(DEFAULTS, client);
    await expect(
      provider.diagnose({ consoleTail: "boom", crashReport: "", modList: [] })
    ).resolves.toBeNull();
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
