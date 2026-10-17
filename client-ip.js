// Client IP for the per-IP rate limits (H1 /chat, D4 admin login).
//
// Express takes req.ip from X-Forwarded-For, counting TRUST_PROXY_HOPS proxies back from
// the socket. Proxies append to that header, so entries a client writes itself always sit
// to the left of the ones our proxies add and are never chosen. The count must match the
// real chain: too low and req.ip is a proxy address shared by every visitor (one bucket
// for everyone), too high and req.ip is an entry the client wrote (spoofable).
//
// Render's chain was observed as "client, Cloudflare, Render internal" ahead of the socket,
// which would make 3 the right count, but that is not documented by Render. So the count is
// an env setting (default 1, the old behavior), confirmed on Render with IP_DEBUG first.
//
// Also here:
//   - createMismatchGuard: warns (at most every 15 minutes) when Cloudflare's True-Client-IP
//     or CF-Connecting-IP disagrees with req.ip, which means the hop count no longer matches
//     the chain. It only logs; it never changes the rate limit key or blocks anything.
//   - createIpDebugLogger: TEMPORARY. With IP_DEBUG=true, GET /admin/login logs the shape of
//     the chain and what req.ip would be for each hop count, as short keyed hashes. To be
//     removed once the real hop count is confirmed.
//
// Never logged: raw IP addresses, raw header values, the hash key.

const crypto = require('node:crypto');

const DEFAULT_HOPS = 1;
const MAX_HOPS = 5;
const MISMATCH_REPEAT_MS = 15 * 60 * 1000;
const DEBUG_MAX_LINES = 50;
const DEBUG_HOPS_SHOWN = 4;

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

// Nearest first: the socket address, then X-Forwarded-For from right to left. This is the
// order Express walks when it picks req.ip.
function forwardedChain(req) {
  const xff = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map(normalize)
    .filter(Boolean);
  return [normalize(req.socket && req.socket.remoteAddress), ...xff.reverse()];
}

// What req.ip would be with "trust proxy" set to this many hops: the first address past the
// trusted ones, or the farthest one if every address is trusted (same as Express).
function addressForHops(chain, hops) {
  return chain[Math.min(hops, chain.length - 1)];
}

function isPrivate(addr) {
  const a = normalize(addr).toLowerCase();
  const v4 = a.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) {
    const [first, second] = [Number(v4[1]), Number(v4[2])];
    return (
      first === 10 ||
      first === 127 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254) ||
      (first === 100 && second >= 64 && second <= 127)
    );
  }
  return a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
}

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
          `[client-ip] WARNING: req.ip (${hash(req.ip)}) does not match the Cloudflare client IP header (${hash(edge)}) with TRUST_PROXY_HOPS=${hops}. Per-IP rate limits may be shared between visitors or spoofable. Check the hop count with IP_DEBUG=true.`
        );
      }
    }
    next();
  };
}

// TEMPORARY, see the top of this file.
function createIpDebugLogger({ enabled, hops, log = console, hash = createHasher(), maxLines = DEBUG_MAX_LINES } = {}) {
  let lines = 0;
  return function ipDebug(req, res, next) {
    if (!enabled || lines >= maxLines) return next();
    lines += 1;
    const chain = forwardedChain(req);
    const xff = chain.slice(1).reverse();
    const parts = [
      `[ip-debug] line=${lines}/${maxLines}`,
      `hops_setting=${hops}`,
      `xff_entries=${xff.length}`,
      `kinds=${xff.map((a) => (isPrivate(a) ? 'private' : 'public')).join(',') || 'none'}`,
      `socket=${isPrivate(chain[0]) ? 'private' : 'public'}`
    ];
    for (let n = 1; n <= DEBUG_HOPS_SHOWN; n += 1) parts.push(`hop${n}=${hash(addressForHops(chain, n))}`);
    const tci = normalize(req.headers['true-client-ip'] || '') || null;
    const cfip = normalize(req.headers['cf-connecting-ip'] || '') || null;
    parts.push(`req_ip=${hash(req.ip)}`, `tci=${hash(tci)}`, `cfip=${hash(cfip)}`);
    parts.push(`tci_matches_req_ip=${tci ? tci === normalize(req.ip) : 'no_header'}`);
    log.log(parts.join(' '));
    return next();
  };
}

module.exports = {
  parseTrustProxyHops,
  forwardedChain,
  addressForHops,
  isPrivate,
  createHasher,
  createMismatchGuard,
  createIpDebugLogger,
  DEFAULT_HOPS,
  MAX_HOPS
};
