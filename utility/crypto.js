"use strict";
const { createCipheriv, createDecipheriv, randomBytes } = require("node:crypto");
const msgLog = require("./logger.js");

const ALGO = "aes-256-gcm";
const IV_LEN = 12;  // 96-bit IV — recommended for GCM
const PREFIX = "enc:";

function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("ENCRYPTION_KEY must be a 64-character hex string. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
  }
  return Buffer.from(hex, "hex");
}

/**
 * Encrypts a plaintext string.
 * Returns null/undefined as-is so callers don't need to guard.
 * Format: enc:<iv_hex>:<authTag_hex>:<ciphertext_hex>
 */
function encrypt(plaintext) {
  if (plaintext == null || plaintext === "") return plaintext;
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([ cipher.update(plaintext, "utf8"), cipher.final() ]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${ct.toString("hex")}`;
}

/**
 * Decrypts a value produced by encrypt().
 * Values that don't carry the enc: prefix are treated as legacy plaintext
 * and returned unchanged — this covers the migration window before all keys
 * are re-encrypted.
 * Returns null on authentication failure so callers can detect a bad key.
 */
function decrypt(stored) {
  if (stored == null || stored === "") return stored;
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext

  const parts = stored.slice(PREFIX.length).split(":");
  if (parts.length !== 3) {
    msgLog.error("crypto: malformed encrypted value in database");
    return null;
  }

  const [ ivHex, tagHex, ctHex ] = parts;
  try {
    const key = getKey();
    const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return decipher.update(Buffer.from(ctHex, "hex")).toString("utf8") + decipher.final("utf8");
  } catch (err) {
    msgLog.error(`crypto: decryption failed — key may have changed (${err.message})`);
    return null;
  }
}

/**
 * Returns true if a stored value was produced by encrypt().
 * Used during the startup migration to skip already-encrypted values.
 */
function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

module.exports = { encrypt, decrypt, isEncrypted };
