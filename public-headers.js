// D7: security headers for the public site (see docs/inventory-plan.md and
// docs/hardening-report.md).
//
// The Content Security Policy allows scripts only from this site plus the exact inline
// scripts in public/*.html, which are found and hashed (sha256) once at boot. Editing an
// inline script is therefore safe: the next start hashes the new bytes. Adding an inline
// event handler (onclick=...), a style attribute or a <style> block is not: the policy has
// no 'unsafe-inline' and would block it (test/d7-public-headers.test.js checks for these).
//
// PUBLIC_CSP_MODE picks how the policy is sent:
//   report-only (default)  Content-Security-Policy-Report-Only: the browser runs everything
//                          as before and only logs "[Report Only]" lines in the Console for
//                          what the policy would block, so a mistake cannot break the site.
//   enforce                Content-Security-Policy: the browser blocks it.
// Anything else refuses to start. There is no report endpoint; the Console is the record.
//
// The other headers do not depend on the hash list and are always sent:
//   X-Content-Type-Options   nosniff
//   Referrer-Policy          strict-origin-when-cross-origin
//   X-Frame-Options          DENY (also covers framing while the CSP is report-only)
//   Permissions-Policy       camera, microphone, geolocation, payment and usb all off
//   Cross-Origin-Opener-Policy  same-origin
//   Strict-Transport-Security   max-age 7 days, outside NODE_ENV=development only (unset
//                               NODE_ENV counts as production, as for secure cookies); no
//                               includeSubDomains, no preload
//
// Which responses get them (see createPublicHeaders):
//   /admin and below   nothing: the admin router sets its own headers (admin.js)
//   /voice/*           nosniff only: TwiML for Twilio, not a page
//   everything else    the full set: pages, static files, /api/*, 404s and error replies

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CSP_MODES = new Set(['report-only', 'enforce']);
const HSTS_VALUE = 'max-age=604800';

// Every <script> without a src attribute, with the exact bytes between its tags.
function extractInlineScripts(html) {
  const scripts = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    if (!/\bsrc\s*=/i.test(match[1])) scripts.push(match[2]);
  }
  return scripts;
}

function hashSource(source) {
  return `'sha256-${crypto.createHash('sha256').update(source, 'utf8').digest('base64')}'`;
}

// The sorted, de-duplicated hashes of every inline script in every .html file in dir.
function inlineScriptHashes(dir) {
  const hashes = new Set();
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.html')).sort()) {
    for (const source of extractInlineScripts(fs.readFileSync(path.join(dir, file), 'utf8'))) {
      hashes.add(hashSource(source));
    }
  }
  return [...hashes].sort();
}

function buildPolicy(hashes) {
  return [
    "default-src 'self'",
    `script-src ${["'self'", ...hashes].join(' ')}`,
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ');
}

function parseCspMode(env) {
  const raw = env.PUBLIC_CSP_MODE;
  const mode = raw === undefined || raw === '' ? 'report-only' : String(raw).trim();
  if (!CSP_MODES.has(mode)) {
    return { error: `PUBLIC_CSP_MODE must be "report-only" or "enforce" (got ${JSON.stringify(String(raw))}).` };
  }
  return { mode };
}

// isAdminPath comes from admin.js, so both agree on what counts as an admin path.
function createPublicHeaders({ publicDir, mode, isDev, isAdminPath }) {
  const hashes = inlineScriptHashes(publicDir);
  const policy = buildPolicy(hashes);
  const pageHeaders = {
    [mode === 'enforce' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only']: policy,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin'
  };
  if (!isDev) pageHeaders['Strict-Transport-Security'] = HSTS_VALUE;

  function middleware(req, res, next) {
    if (isAdminPath(req.path)) return next();
    const lower = req.path.toLowerCase();
    if (lower === '/voice' || lower.startsWith('/voice/')) {
      res.set('X-Content-Type-Options', 'nosniff');
      return next();
    }
    res.set(pageHeaders);
    return next();
  }

  return { middleware, policy, hashes, headers: pageHeaders };
}

module.exports = {
  extractInlineScripts,
  hashSource,
  inlineScriptHashes,
  buildPolicy,
  parseCspMode,
  createPublicHeaders,
  HSTS_VALUE
};
