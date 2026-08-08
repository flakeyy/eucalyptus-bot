"use strict";

/**
 * Structured output schema for last-resort crash triage.
 * Classifier only — never an actor. Closed action set enforced in code.
 *
 * Anthropic structured-output schemas require additionalProperties: false on
 * every object and reject minimum/maxLength-style constraints.
 */

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [ "diagnosis", "action", "jars", "confidence" ],
  properties: {
    diagnosis: { type: "string" },
    action: { type: "string", enum: [ "quarantine", "restore", "give-up" ] },
    jars: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: [ "high", "medium", "low" ] }
  }
};

module.exports = { VERDICT_SCHEMA };
