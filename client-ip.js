// Client IP for the per-IP rate limits (H1 /chat, D4 admin login).
//
// Express takes req.ip from X-Forwarded-For, counting TRUST_PROXY_HOPS proxies back from
// the socket. Proxies append to that header, so entries a client writes itself always sit
// to the left of the ones our proxies add and are never chosen. The count must match the
// real chain: too low and req.ip is a proxy address shared by every visitor (one bucket
// for everyone), too high and req.ip is an entry the client wrote (spoofable).
//
// Render's chain was confirmed as "client, Cloudflare, Render internal" ahead of the socket,
// so TRUST_PROXY_HOPS is 3 there. Unset means 1, for local dev and ngrok.
//
// Also here: createMismatchGuard warns (at most every 15 minutes) when Cloudflare's
// True-Client-IP or CF-Connecting-IP disagrees with req.ip, which means the hop count no
// longer matches the chain. It only logs; it never changes the rate limit key or blocks
// anything.
//
// Never logged: raw IP addresses, raw header values, the hash key.

const crypto = require('node:crypto');

const DEFAULT_HOPS = 1;
const MAX_HOPS = 5;
const MISMATCH_REPEAT_MS = 15 * 60 * 1000;

// Returns { hops } or { error }. Unset or empty means the default.
function parseTrustProxyHops(env) {
  const raw = env.TRUST_PROXY_HOPS;
  if (raw === undefined || raw === '') return { hops: DEFAULT_HOPS };
  if (!/^[1-9]$/.test(raw) || Number(raw) > MAX_HOPS) {
    return { error: `TRUST_PROXY_HOPS must be a whole number from 1 to ${MAX_HOPS}.` };
  }
  return { hops: Number(raw) };
}

const normalize = (addr) => String(addr || '').trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');

// Short keyed hash: the same address gives the same 8 characters within one boot, but the
// random key never leaves memory, so a log line cannot be turned back into an address (a
// plain hash of an IPv4 address could be reversed by trying all of them).
function createHasher(key = crypto.randomBytes(32)) {
  return (addr) => (addr ? crypto.createHmac('sha256', key).update(normalize(addr)).digest('hex').slice(0, 8) : 'none');
}

function cloudflareClientIp(req) {
  return normalize(req.headers['true-client-ip'] || req.headers['cf-connecting-ip'] || '') || null;
}

function createMismatchGuard({ hops, now = Date.now, log = console, hash = createHasher() } = {}) {
  let lastWarnAt = null;
  return function mismatchGuard(req, res, next) {
    const edge = cloudflareClientIp(req);
    if (edge && edge !== normalize(req.ip)) {
      const t = now();
      if (lastWarnAt === null || t - lastWarnAt >= MISMATCH_REPEAT_MS) {
        lastWarnAt = t;
        log.warn(
          `[client-ip] WARNING: req.ip (${hash(req.ip)}) does not match the Cloudflare client IP header (${hash(edge)}) with TRUST_PROXY_HOPS=${hops}. Per-IP rate limits may be shared between visitors or spoofable. Check that TRUST_PROXY_HOPS still matches the real proxy chain.`
        );
      }
    }
    next();
  };
}

module.exports = {
  parseTrustProxyHops,
  createHasher,
  createMismatchGuard,
  DEFAULT_HOPS,
  MAX_HOPS
};
