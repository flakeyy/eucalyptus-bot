"use strict";

/**
 * Last-resort crash triage. Classifies unattributable boots into a structured
 * verdict. Provider interface: anthropic | none. Missing/errored key → no-op.
 */

const crypto = require("crypto");
const msgLog = require("../../logger.js");
const { VERDICT_SCHEMA } = require("./schema.js");
const { isProtectedLearnedMod } = require("../../verdict_store.js");

const DEFAULTS = {
  provider: "anthropic",
  model: "claude-sonnet-5",
  effort: "medium",
  max_calls_per_install: 3,
  min_confidence: "medium"
};

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

function sha1(text) {
  return crypto.createHash("sha1").update(String(text)).digest("hex");
}

function createNoneProvider() {
  return {
    async diagnose() {
      return null;
    }
  };
}

function createAnthropicProvider(settings) {
  let client = null;
  try {
    // Lazy require so missing dep doesn't break boot without triage.
    const Anthropic = require("@anthropic-ai/sdk");
    if (!process.env.ANTHROPIC_API_KEY) return createNoneProvider();
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  } catch (err) {
    msgLog.debugExtended(`[triage] anthropic sdk unavailable: ${err.message}`);
    return createNoneProvider();
  }

  return {
    async diagnose(ctx) {
      const prompt = buildPrompt(ctx);
      try {
        const res = await client.messages.parse({
          model: settings.model || DEFAULTS.model,
          max_tokens: 1024,
          output_config: {
            effort: settings.effort || DEFAULTS.effort,
            format: { type: "json_schema", schema: VERDICT_SCHEMA }
          },
          messages: [ { role: "user", content: prompt } ]
        });
        return res.parsed_output ?? null;
      } catch (err) {
        msgLog.warn(`[triage] anthropic call failed: ${err.message}`);
        return null;
      }
    }
  };
}

function buildPrompt(ctx) {
  const lines = [
    "You are classifying a Minecraft dedicated-server crash after a modpack install.",
    "Return ONLY a structured verdict. Prefer give-up when unsure.",
    "Never invent jar names — only use jars from the installed/parked list.",
    "",
    "## Installed / parked mods",
    ...(ctx.modList || []).slice(0, 400),
    "",
    "## Console tail",
    String(ctx.consoleTail || "").slice(-12000),
    "",
    "## Newest crash report",
    String(ctx.crashReport || "").slice(-8000)
  ];
  return lines.join("\n");
}

/**
 * Validate and sanitize a raw verdict against modIndex + protected IDs.
 * low confidence → report-only (action forced to give-up).
 */
function sanitizeVerdict(raw, modIndex, settings = {}) {
  if (!raw || typeof raw !== "object") return null;
  const min = settings.min_confidence || DEFAULTS.min_confidence;
  const action = [ "quarantine", "restore", "give-up" ].includes(raw.action) ? raw.action : "give-up";
  const confidence = [ "high", "medium", "low" ].includes(raw.confidence) ? raw.confidence : "low";
  const diagnosis = typeof raw.diagnosis === "string" ? raw.diagnosis.slice(0, 500) : "";

  const known = new Set();
  if (modIndex) {
    for (const name of modIndex.byFileName?.values?.() || []) known.add(name);
    for (const name of modIndex.byModId?.values?.() || []) known.add(name);
    for (const name of modIndex.parkedJars || []) known.add(name);
  }

  const jars = [];
  for (const j of Array.isArray(raw.jars) ? raw.jars : []) {
    const base = String(j).split("/").pop();
    if (!base) continue;
    if (known.size && ![ ...known ].some(k => k === base || k.toLowerCase() === base.toLowerCase())) {
      continue; // reject jars not in modIndex
    }
    if (isProtectedLearnedMod({ filename: base })) continue;
    jars.push(base);
  }

  let finalAction = action;
  if (CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[min]) {
    finalAction = "give-up";
  }
  if ((finalAction === "quarantine" || finalAction === "restore") && jars.length === 0) {
    finalAction = "give-up";
  }

  return { diagnosis, action: finalAction, jars, confidence };
}

/**
 * @param {object} ctx  { consoleTail, crashReport, modList, modIndex }
 * @param {object} [opts]
 * @param {object} [opts.settings]  config.triage block
 * @param {object} [opts.provider]  inject fake for tests
 * @param {Map}    [opts.cache]     sha1 → verdict
 * @param {{ calls: number }} [opts.budget]
 */
async function diagnose(ctx, opts = {}) {
  const settings = { ...DEFAULTS, ...(opts.settings || {}) };
  const budget = opts.budget || { calls: 0 };
  if (budget.calls >= (settings.max_calls_per_install || DEFAULTS.max_calls_per_install)) {
    return null;
  }

  const cacheKey = sha1([ ctx.consoleTail, ctx.crashReport, (ctx.modList || []).join(",") ].join("\0"));
  const cache = opts.cache || diagnose._cache || (diagnose._cache = new Map());
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  let provider = opts.provider;
  if (!provider) {
    provider = settings.provider === "none"
      ? createNoneProvider()
      : createAnthropicProvider(settings);
  }

  budget.calls += 1;
  const raw = await provider.diagnose(ctx);
  const verdict = sanitizeVerdict(raw, ctx.modIndex, settings);
  cache.set(cacheKey, verdict);
  return verdict;
}

module.exports = {
  diagnose,
  sanitizeVerdict,
  createNoneProvider,
  buildPrompt,
  DEFAULTS,
  VERDICT_SCHEMA
};
