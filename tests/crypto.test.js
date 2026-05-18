// Set the key before crypto.js is required.
process.env.ENCRYPTION_KEY = "a".repeat(64); // 32-byte test key (valid hex)

jest.mock("../utility/logger.js", () => ({
  log: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

const { encrypt, decrypt, isEncrypted } = require("../utility/crypto.js");

describe("encrypt / decrypt roundtrip", () => {
  test("encrypts to enc:<iv>:<tag>:<ct> format", () => {
    const out = encrypt("hello");
    expect(out).toMatch(/^enc:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
  });

  test("decrypt(encrypt(x)) returns the original plaintext", () => {
    const plaintext = "ptlc_supersecretapikey_1234567890";
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  test("two encryptions of the same value produce different ciphertexts (random IV)", () => {
    expect(encrypt("same")).not.toBe(encrypt("same"));
  });
});

describe("encrypt: null / empty passthrough", () => {
  test.each([
    [ null, null ],
    [ undefined, undefined ],
    [ "", "" ]
  ])("encrypt(%p) === %p", (input, expected) => {
    expect(encrypt(input)).toBe(expected);
  });
});

describe("decrypt: legacy plaintext passthrough", () => {
  test("returns a value lacking the enc: prefix unchanged", () => {
    expect(decrypt("legacy-plaintext-key")).toBe("legacy-plaintext-key");
  });

  test.each([
    [ null ], [ undefined ], [ "" ]
  ])("returns %p unchanged", v => {
    expect(decrypt(v)).toBe(v);
  });
});

describe("isEncrypted", () => {
  test("returns true for an enc:-prefixed string", () => {
    expect(isEncrypted(encrypt("x"))).toBe(true);
  });

  test("returns false for legacy plaintext, null, and non-strings", () => {
    expect(isEncrypted("plain")).toBe(false);
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted(undefined)).toBe(false);
    expect(isEncrypted(42)).toBe(false);
  });
});
