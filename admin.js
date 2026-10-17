// D4: hardened admin login (see docs/inventory-plan.md, "Admin auth").
//
// One password, stored only as a scrypt hash in ADMIN_PASSWORD_HASH, plus a separate admin
// session with its own secret (ADMIN_SESSION_SECRET), its own cookie (admin.sid, Path=/admin)
// and its own in-memory store. server.js mounts the router at /admin only when both env vars
// are set, and keeps the customer session out of /admin entirely.
//
// What this file does:
//   - loadAdminConfig: the startup rules. Both env vars unset means admin is off. Only one
//     set, a malformed hash, or a weak secret is a startup error.
//   - hashPassword / verifyPassword: scrypt from node:crypto, compared in constant time.
//     Any input that is not a usable password still runs one full scrypt, so it costs the
//     same time and gets the same response as a wrong password.
//   - createAdminRouter: login, logout and a placeholder logged-in page. Every POST needs a
//     matching Origin header and a CSRF token. Wrong passwords are limited per IP (5 per 15
//     minutes, then 429), and 20 or more failures in an hour across all IPs writes a loud
//     warning to the log without blocking anyone.
//
// Never logged: passwords, hashes, CSRF tokens, session ids.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');

const scryptAsync = promisify(crypto.scrypt);

// --- Password hashing -------------------------------------------------------------------
// Hash format: scrypt:N:r:p:salt:hash, with salt and hash in base64url. Colons rather than
// "$" so the value survives being pasted into a shell, a .env file or Render's settings.
const SCRYPT_DEFAULTS = { N: 2 ** 15, r: 8, p: 1, keylen: 64, saltBytes: 16 };
const MIN_N = 2 ** 15;
const MAX_N = 2 ** 17;
const MAX_PASSWORD_BYTES = 1024;
// Stand-in input for anything that is not a usable password, so the scrypt still runs.
const DUMMY_INPUT = 'admin-login-dummy-input';

// scrypt needs about 128 * N * r bytes; give it that plus headroom (the Node default cap of
// 32 MiB is exactly the need at N = 2^15, r = 8, which is too tight).
const maxmemFor = (N, r) => 128 * N * r + 16 * 1024 * 1024;

async function hashPassword(password, { N, r, p, keylen, saltBytes } = SCRYPT_DEFAULTS) {
  const salt = crypto.randomBytes(saltBytes);
  const derived = await scryptAsync(password, salt, keylen, { N, r, p, maxmem: maxmemFor(N, r) });
  return ['scrypt', N, r, p, salt.toString('base64url'), derived.toString('base64url')].join(':');
}

// Throws on anything malformed or too cheap. The error never includes the value.
function parsePasswordHash(value) {
  const parts = String(value).trim().split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') throw new Error('not in scrypt:N:r:p:salt:hash form');
  const [N, r, p] = parts.slice(1, 4).map((n) => (/^\d+$/.test(n) ? Number(n) : NaN));
  if (!Number.isInteger(N) || (N & (N - 1)) !== 0 || N < MIN_N || N > MAX_N) {
    throw new Error(`N must be a power of two from ${MIN_N} to ${MAX_N}`);
  }
  if (!Number.isInteger(r) || r < 1 || r > 32) throw new Error('r must be from 1 to 32');
  if (!Number.isInteger(p) || p < 1 || p > 4) throw new Error('p must be from 1 to 4');
  const b64url = /^[A-Za-z0-9_-]+$/;
  if (!b64url.test(parts[4]) || !b64url.test(parts[5])) throw new Error('salt and hash must be base64url');
  const salt = Buffer.from(parts[4], 'base64url');
  const hash = Buffer.from(parts[5], 'base64url');
  if (salt.length < 16) throw new Error('salt must be at least 16 bytes');
  if (hash.length < 32) throw new Error('hash must be at least 32 bytes');
  return { N, r, p, salt, hash };
}

function isUsablePassword(candidate) {
  return typeof candidate === 'string' && candidate.length > 0 && Buffer.byteLength(candidate) <= MAX_PASSWORD_BYTES;
}

// Always runs exactly one scrypt with the stored parameters, whatever the input, then a
// constant-time comparison. derive is injectable for the unit test that proves the scrypt
// runs for unusable input too.
async function verifyPassword(candidate, parsed, derive = scryptAsync) {
  const usable = isUsablePassword(candidate);
  const derived = await derive(usable ? candidate : DUMMY_INPUT, parsed.salt, parsed.hash.length, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
    maxmem: maxmemFor(parsed.N, parsed.r)
  });
  const match = crypto.timingSafeEqual(derived, parsed.hash);
  return usable && match;
}

// --- Startup rules ----------------------------------------------------------------------
const MIN_SECRET_LENGTH = 32;
const MIN_SECRET_DISTINCT = 10;
const PLACEHOLDER_SECRETS = new Set([
  'dev-secret',
  'change_this_to_a_random_string',
  'change_this_to_a_long_random_string_of_at_least_32_characters'
]);

function secretWeakness(secret, customerSecret) {
  if (secret.length < MIN_SECRET_LENGTH) return `shorter than ${MIN_SECRET_LENGTH} characters`;
  if (new Set(secret).size < MIN_SECRET_DISTINCT) return `fewer than ${MIN_SECRET_DISTINCT} distinct characters`;
  if (PLACEHOLDER_SECRETS.has(secret)) return 'a placeholder value';
  if (customerSecret && secret === customerSecret) return 'the same as SESSION_SECRET';
  return null;
}

// Returns { enabled: false }, { enabled: true, passwordHash, sessionSecret }, or { error }.
// An empty string counts as unset. Error messages name variables, never their values.
function loadAdminConfig(env) {
  const hashValue = env.ADMIN_PASSWORD_HASH || '';
  const secret = env.ADMIN_SESSION_SECRET || '';
  if (!hashValue && !secret) return { enabled: false };
  if (!hashValue || !secret) {
    const missing = hashValue ? 'ADMIN_SESSION_SECRET' : 'ADMIN_PASSWORD_HASH';
    return {
      error: `Admin is half configured: ${missing} is not set. Set both ADMIN_PASSWORD_HASH and ADMIN_SESSION_SECRET, or neither to switch admin off.`
    };
  }
  let passwordHash;
  try {
    passwordHash = parsePasswordHash(hashValue);
  } catch (err) {
    return { error: `ADMIN_PASSWORD_HASH is invalid (${err.message}). Generate one with scripts/hash-admin-password.js.` };
  }
  const weakness = secretWeakness(secret, env.SESSION_SECRET);
  if (weakness) return { error: `ADMIN_SESSION_SECRET is too weak (${weakness}).` };
  return { enabled: true, passwordHash, sessionSecret: secret };
}

// --- Router -----------------------------------------------------------------------------
const ADMIN_PATH = '/admin';
const SESSION_COOKIE = 'admin.sid';
const PRE_COOKIE = 'admin.pre';
const ABSOLUTE_MS = 8 * 60 * 60 * 1000;
const IDLE_MS = 60 * 60 * 1000;
const PRE_LOGIN_MS = 15 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const ALERT_WINDOW_MINUTES = 60;
const ALERT_THRESHOLD = 20;
const ALERT_REPEAT_MS = 15 * 60 * 1000;

const ADMIN_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  // Not no-referrer: under that policy browsers send "Origin: null" on every form POST,
  // even same-origin ones (Fetch spec, "append a request Origin header"), so the strict
  // Origin check below would refuse every real login. same-origin keeps the real Origin on
  // our own POSTs and still sends no Referer to other sites.
  'Referrer-Policy': 'same-origin'
};

const randomToken = () => crypto.randomBytes(32).toString('base64url');

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Reads one cookie without adding a cookie parser dependency.
function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function loadPage(file) {
  return fs.readFileSync(path.join(__dirname, 'admin', file), 'utf8');
}

function createAdminRouter(config, { isDev = false, now = Date.now, log = console } = {}) {
  const loginPage = loadPage('login.html');
  const homePage = loadPage('home.html');
  const cookieBase = { path: ADMIN_PATH, httpOnly: true, secure: !isDev, sameSite: 'strict' };

  // Login CSRF is stateless so anonymous visitors never create store entries: the admin.pre
  // cookie holds "<issuedAt>.<random>", and the form carries an HMAC of it keyed with the
  // admin secret.
  const preToken = (nonce) =>
    crypto.createHmac('sha256', config.sessionSecret).update(`login:${nonce}`).digest('base64url');

  function renderLogin(res, status, message) {
    const nonce = `${now()}.${randomToken()}`;
    res.cookie(PRE_COOKIE, nonce, { ...cookieBase, maxAge: PRE_LOGIN_MS });
    const html = loginPage
      .replace('{{CSRF_TOKEN}}', preToken(nonce))
      .replace('{{MESSAGE}}', message ? `<p class="message">${message}</p>` : '');
    res.status(status).type('html').send(html);
  }

  const plain = (res, status, text) => res.status(status).type('text/plain').send(text);
  const forbidden = (res) => plain(res, 403, 'Forbidden');

  // Origin must be present and match this server exactly. req.protocol comes from the one
  // trusted proxy hop (any TRUST_PROXY_HOPS count, see server.js).
  function requireSameOrigin(req, res, next) {
    const origin = req.get('origin');
    if (!origin || origin !== `${req.protocol}://${req.get('host')}`) return forbidden(res);
    return next();
  }

  function requireLoginCsrf(req, res, next) {
    const nonce = readCookie(req, PRE_COOKIE);
    const sent = req.body && req.body._csrf;
    const issuedAt = nonce ? Number(nonce.split('.')[0]) : NaN;
    const fresh = Number.isFinite(issuedAt) && now() - issuedAt >= 0 && now() - issuedAt < PRE_LOGIN_MS;
    if (!nonce || !fresh || !safeEqual(sent, preToken(nonce))) return forbidden(res);
    return next();
  }

  // Global alert: wrong passwords per minute for the last hour, at most 61 small entries.
  const failureBuckets = new Map();
  let lastAlertAt = null;
  function recordFailure() {
    const t = now();
    const minute = Math.floor(t / 60000);
    failureBuckets.set(minute, (failureBuckets.get(minute) || 0) + 1);
    let total = 0;
    for (const [key, count] of failureBuckets) {
      if (key <= minute - ALERT_WINDOW_MINUTES) failureBuckets.delete(key);
      else total += count;
    }
    log.warn('[admin] login failed');
    if (total >= ALERT_THRESHOLD && (lastAlertAt === null || t - lastAlertAt >= ALERT_REPEAT_MS)) {
      lastAlertAt = t;
      log.warn(
        `[admin] WARNING: ${total} failed admin logins in the last hour across all IPs. Someone may be guessing the admin password. Nobody is blocked by this alert.`
      );
    }
  }

  // Per IP: each attempt is counted before the password check, and a successful login
  // (status below 400) gives its hit back. So 5 wrong passwords in 15 minutes, then 429,
  // even for the right password. req.ip depends on TRUST_PROXY_HOPS matching the real
  // proxy chain (see client-ip.js).
  const loginLimiter = rateLimit({
    windowMs: LOGIN_WINDOW_MS,
    limit: LOGIN_MAX_FAILURES,
    skipSuccessfulRequests: true,
    standardHeaders: false,
    legacyHeaders: false,
    handler: (req, res) => plain(res, 429, 'Too many failed attempts. Try again later.')
  });

  const router = express.Router();

  router.use((req, res, next) => {
    res.set(ADMIN_HEADERS);
    // Express matches the mount path without regard to case, but the admin cookie is only
    // sent on exactly /admin, so anything else is simply not an admin page.
    if (!req.originalUrl.startsWith(ADMIN_PATH)) return plain(res, 404, 'Not found');
    return next();
  });

  router.use(
    session({
      name: SESSION_COOKIE,
      secret: config.sessionSecret,
      store: new session.MemoryStore(),
      resave: false,
      saveUninitialized: false,
      rolling: false,
      cookie: { ...cookieBase }
    })
  );

  // Expiry: 8 hours from login (absolute, the cookie's fixed Expires date and this check)
  // and 60 minutes without a request (idle). Either one ends the session.
  router.use((req, res, next) => {
    const admin = req.session && req.session.admin;
    if (!admin) return next();
    const t = now();
    if (t - admin.loginAt >= ABSOLUTE_MS || t - admin.lastSeen >= IDLE_MS) {
      return req.session.destroy(() => {
        res.clearCookie(SESSION_COOKIE, cookieBase);
        next();
      });
    }
    admin.lastSeen = t;
    req.admin = admin;
    return next();
  });

  router.get('/', (req, res) => {
    if (!req.admin) return res.redirect(303, `${ADMIN_PATH}/login`);
    return res.type('html').send(homePage.replace('{{CSRF_TOKEN}}', req.admin.csrf));
  });

  router.get('/login', (req, res) => {
    if (req.admin) return res.redirect(303, ADMIN_PATH);
    return renderLogin(res, 200, '');
  });

  router.post('/login', requireSameOrigin, requireLoginCsrf, loginLimiter, async (req, res, next) => {
    let ok;
    try {
      ok = await verifyPassword(req.body && req.body.password, config.passwordHash);
    } catch (err) {
      return next(err);
    }
    if (!ok) {
      recordFailure();
      return renderLogin(res, 401, 'Wrong password.');
    }
    // Never reuse a session id from before login.
    if (!req.session) req.sessionStore.generate(req);
    return req.session.regenerate((err) => {
      if (err) return next(err);
      const t = now();
      req.session.admin = { loginAt: t, lastSeen: t, csrf: randomToken() };
      req.session.cookie.expires = new Date(t + ABSOLUTE_MS);
      return req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        res.clearCookie(PRE_COOKIE, cookieBase);
        log.log('[admin] login succeeded');
        return res.redirect(303, ADMIN_PATH);
      });
    });
  });

  router.post('/logout', requireSameOrigin, (req, res, next) => {
    if (!req.admin || !safeEqual(req.body && req.body._csrf, req.admin.csrf)) return forbidden(res);
    return req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie(SESSION_COOKIE, cookieBase);
      log.log('[admin] logged out');
      return res.redirect(303, `${ADMIN_PATH}/login`);
    });
  });

  router.use((req, res) => plain(res, 404, 'Not found'));

  // Errors stay inside the router so they never reach Express's default error page.
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    log.error('[admin] request error:', err && err.message);
    plain(res, 500, 'Something went wrong.');
  });

  return router;
}

// True for /admin and anything under it, in any letter case. server.js uses it to keep the
// customer session middleware off these paths.
function isAdminPath(urlPath) {
  const lower = String(urlPath).toLowerCase();
  return lower === ADMIN_PATH || lower.startsWith(`${ADMIN_PATH}/`);
}

module.exports = {
  loadAdminConfig,
  createAdminRouter,
  isAdminPath,
  hashPassword,
  verifyPassword,
  parsePasswordHash,
  isUsablePassword,
  MAX_PASSWORD_BYTES,
  ABSOLUTE_MS,
  IDLE_MS
};
