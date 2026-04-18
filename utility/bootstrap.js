const crypto = require("node:crypto");

let bootstrapToken = null;

function generateBootstrapToken() {
  bootstrapToken = crypto.randomBytes(16).toString("hex");
  return bootstrapToken;
}

function validateAndConsumeToken(token) {
  if (!bootstrapToken || token !== bootstrapToken) return false;
  bootstrapToken = null;
  return true;
}

function isBootstrapActive() {
  return bootstrapToken !== null;
}

module.exports = { generateBootstrapToken, validateAndConsumeToken, isBootstrapActive };
