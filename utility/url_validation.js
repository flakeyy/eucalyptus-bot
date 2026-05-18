"use strict";
const dns = require("node:dns").promises;

function isPrivateIPv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return true;
  const [ a, b ] = parts;
  if (a === 0) return true;                           // 0.0.0.0/8
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 127) return true;                         // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;            // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 CGNAT
  if (a >= 224) return true;                          // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function isPrivateIPv6(ip) {
  const s = ip.toLowerCase();
  if (s === "::1" || s === "::") return true;
  const v4Mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isPrivateIPv4(v4Mapped[1]);
  if (/^fe[89ab]/.test(s)) return true;  // fe80::/10 link-local
  if (/^f[cd]/.test(s)) return true;     // fc00::/7 unique local
  if (/^ff/.test(s)) return true;        // ff00::/8 multicast
  return false;
}

/**
 * Validates that a URL is safe to fetch from untrusted-input code paths.
 * Enforces HTTPS and rejects hostnames that resolve to private, loopback,
 * link-local, CGNAT, or multicast/reserved addresses.
 *
 * Mitigates SSRF where attacker-controlled URLs (e.g. modpack metadata)
 * would otherwise let the bot probe internal services. Note this is a
 * pre-fetch check; a sophisticated attacker could exploit a TOCTOU via
 * DNS rebinding, but the bot does not re-issue requests on redirects with
 * the resolved IP, so the practical window is narrow.
 *
 * @param {string} url
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
async function validateExternalUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: `disallowed protocol: ${parsed.protocol}` };
  }
  const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (!hostname) {
    return { ok: false, reason: "empty hostname" };
  }
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (err) {
    return { ok: false, reason: `DNS lookup failed: ${err.message}` };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: "DNS returned no addresses" };
  }
  for (const { address, family } of addresses) {
    const blocked = family === 4 ? isPrivateIPv4(address) : isPrivateIPv6(address);
    if (blocked) {
      return { ok: false, reason: `host resolves to non-public address: ${address}` };
    }
  }
  return { ok: true };
}

module.exports = { validateExternalUrl, isPrivateIPv4, isPrivateIPv6 };
