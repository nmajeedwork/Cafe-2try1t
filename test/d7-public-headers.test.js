// D7 tests: security headers for the public site (public-headers.js).
//
// Run with:  node --test test/d7-public-headers.test.js
//
// Unit checks read public/*.html and public/*.js directly. Server checks run a real
// `node server.js` child process (test/fixtures/d7-header-capture.js: loopback only, no
// database, no ElevenLabs, made-up secrets). The admin and voice header sets are compared
// with test/fixtures/d7-header-baseline.json, captured from main before public-headers.js
// existed. Nothing is spent.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  extractInlineScripts,
  hashSource,
  inlineScriptHashes,
  buildPolicy,
  parseCspMode,
  createPublicHeaders,
  HSTS_VALUE
} = require('../public-headers');
const { isAdminPath } = require('../admin');
const { startServer, captureHeaderSets } = require('./fixtures/d7-header-capture');
const baseline = require('./fixtures/d7-header-baseline.json');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const HTML_FILES = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html')).sort();
const JS_FILES = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.js')).sort();
const read = (file) => fs.readFileSync(path.join(PUBLIC, file), 'utf8');
const sha = (source) => `'sha256-${crypto.createHash('sha256').update(source).digest('base64')}'`;

const EXPECTED_DIRECTIVES = [
  "default-src 'self'",
  null, // script-src, checked separately
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
];

// A second, independent way to find inline scripts: walk the text by hand rather than with
// the module's regular expression, so a bug in one is not hidden by the same bug in the other.
function inlineScriptsByHand(html) {
  const found = [];
  let at = 0;
  for (;;) {
    const open = html.toLowerCase().indexOf('<script', at);
    if (open === -1) return found;
    const tagEnd = html.indexOf('>', open);
    const close = html.toLowerCase().indexOf('</script>', tagEnd);
    const tag = html.slice(open, tagEnd + 1);
    if (!/\ssrc=/i.test(tag)) found.push(html.slice(tagEnd + 1, close));
    at = close + '</script>'.length;
  }
}

// ------------------------------------------------------------------------------------
// Unit: extraction, hashes, policy, mode
// ------------------------------------------------------------------------------------

test('extractInlineScripts: inline scripts only, exact bytes, any attributes, src excluded', () => {
  const html = [
    '<script>one();</script>',
    '<script src="a.js"></script>',
    '<SCRIPT type="text/javascript">\r\n  two();\r\n</SCRIPT>',
    '<script defer src=b.js></script>',
    '<script></script>',
    '<script data-x="1">three()</script >'
  ].join('\n');
  assert.deepEqual(extractInlineScripts(html), ['one();', '\r\n  two();\r\n', '', 'three()']);
  assert.deepEqual(extractInlineScripts('<p>no scripts</p>'), []);
});

test('hashSource and buildPolicy: CSP sha256 format and the exact policy string', () => {
  assert.equal(hashSource(''), "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='");
  assert.equal(hashSource('one();'), sha('one();'));
  assert.equal(
    buildPolicy(["'sha256-A'", "'sha256-B'"]),
    "default-src 'self'; script-src 'self' 'sha256-A' 'sha256-B'; style-src 'self' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; " +
      "base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
  assert.equal(buildPolicy([]).split('; ')[1], "script-src 'self'");
});

test('parseCspMode: report-only by default, enforce on request, anything else is an error', () => {
  assert.deepEqual(parseCspMode({}), { mode: 'report-only' });
  assert.deepEqual(parseCspMode({ PUBLIC_CSP_MODE: '' }), { mode: 'report-only' });
  assert.deepEqual(parseCspMode({ PUBLIC_CSP_MODE: 'report-only' }), { mode: 'report-only' });
  assert.deepEqual(parseCspMode({ PUBLIC_CSP_MODE: 'enforce' }), { mode: 'enforce' });
  assert.deepEqual(parseCspMode({ PUBLIC_CSP_MODE: ' enforce ' }), { mode: 'enforce' });
  for (const bad of ['Enforce', 'off', 'true', 'reportonly', 'none']) {
    assert.match(parseCspMode({ PUBLIC_CSP_MODE: bad }).error, /PUBLIC_CSP_MODE must be "report-only" or "enforce"/, bad);
  }
});

// ------------------------------------------------------------------------------------
// The real pages: every inline script covered, nothing else allowed
// ------------------------------------------------------------------------------------

const live = createPublicHeaders({ publicDir: PUBLIC, mode: 'enforce', isDev: false, isAdminPath });

test('every inline script in public/*.html is covered by a hash in the policy', () => {
  const perFile = {};
  for (const file of HTML_FILES) {
    const scripts = inlineScriptsByHand(read(file));
    perFile[file] = scripts.length;
    for (const source of scripts) {
      const hash = sha(source);
      assert.ok(live.hashes.includes(hash), `${file}: inline script ${hash} is not covered`);
      assert.ok(live.policy.includes(` ${hash}`), `${file}: ${hash} missing from the policy string`);
    }
  }
  // The reveal opt-in (about, index, menu share the same bytes) and Home's featured cards.
  assert.deepEqual(perFile, { 'about.html': 1, 'index.html': 2, 'menu.html': 1, 'order.html': 0 });
  assert.equal(live.hashes.length, 2);
  assert.deepEqual(live.hashes, inlineScriptHashes(PUBLIC));
  // script-src is exactly 'self' plus those hashes: no 'unsafe-inline', no other host.
  const directives = live.policy.split('; ');
  assert.equal(directives[1], `script-src 'self' ${live.hashes.join(' ')}`);
  EXPECTED_DIRECTIVES.forEach((expected, i) => expected && assert.equal(directives[i], expected));
  assert.equal(directives.length, EXPECTED_DIRECTIVES.length);
  assert.ok(!live.policy.includes('unsafe'));
});

test('an unknown or changed inline script is not covered', () => {
  const reveal = inlineScriptsByHand(read('index.html'))[0];
  for (const source of [`${reveal} `, reveal.replace('js-reveal', 'js-revea1'), 'alert(1)', '', ' ']) {
    assert.ok(!live.hashes.includes(sha(source)), `${JSON.stringify(source.slice(0, 30))} must not be allowed`);
  }
});

test('public HTML has nothing the policy would block: no handlers, inline styles or javascript: URLs', () => {
  for (const file of HTML_FILES) {
    const html = read(file);
    const tags = html.match(/<[a-z][^>]*>/gi) || [];
    for (const tag of tags) {
      assert.ok(!/\son[a-z]+\s*=/i.test(tag), `${file}: inline event handler in ${tag}`);
      assert.ok(!/\sstyle\s*=/i.test(tag), `${file}: style attribute in ${tag}`);
    }
    assert.ok(!/<style\b/i.test(html), `${file}: <style> block`);
    assert.ok(!/javascript:/i.test(html), `${file}: javascript: URL`);
  }
});

test('public JS writes no inline styles and builds no code from strings', () => {
  const sources = [...JS_FILES.map((f) => [f, read(f)]), ...HTML_FILES.flatMap((f) => inlineScriptsByHand(read(f)).map((s) => [`${f} inline`, s]))];
  for (const [name, source] of sources) {
    for (const pattern of [/\.style\b/, /cssText/, /insertRule/, /setAttribute\(\s*['"]style/, /style=/, /\beval\(/, /new Function\(/, /setTimeout\(\s*['"]/, /setInterval\(\s*['"]/]) {
      assert.ok(!pattern.test(source), `${name} matches ${pattern}`);
    }
  }
});

test('every image and script the pages load is on this site, and the file exists', () => {
  const refs = [];
  for (const file of HTML_FILES) {
    const html = read(file);
    for (const [, src] of html.matchAll(/\ssrc\s*=\s*"([^"]+)"/gi)) refs.push([file, src]);
    for (const [, src] of html.matchAll(/'(\/images\/[^']+)'/g)) refs.push([`${file} script`, src]);
  }
  assert.ok(refs.length >= 10);
  for (const [where, src] of refs) {
    assert.ok(!/^[a-z]+:|^\/\//i.test(src), `${where}: ${src} is not same origin`);
    assert.ok(fs.existsSync(path.join(PUBLIC, src.replace(/^\//, ''))), `${where}: ${src} does not exist`);
  }
  // The only other origins anywhere in the pages are the two Google Fonts hosts.
  const origins = new Set(HTML_FILES.flatMap((f) => [...read(f).matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1])));
  assert.deepEqual([...origins].sort(), ['fonts.googleapis.com', 'fonts.gstatic.com']);
});

test('the middleware: full set on pages, nothing on admin, nosniff only on voice', () => {
  const calls = (urlPath, headers) => {
    const set = {};
    const res = { set: (name, value) => Object.assign(set, typeof name === 'object' ? name : { [name]: value }) };
    let nexted = false;
    headers.middleware({ path: urlPath }, res, () => (nexted = true));
    assert.ok(nexted);
    return set;
  };
  const dev = createPublicHeaders({ publicDir: PUBLIC, mode: 'report-only', isDev: true, isAdminPath });
  const page = calls('/menu', dev);
  assert.equal(page['Content-Security-Policy-Report-Only'], dev.policy);
  assert.ok(!('Content-Security-Policy' in page));
  assert.ok(!('Strict-Transport-Security' in page), 'no HSTS in development');
  assert.equal(calls('/menu', live)['Strict-Transport-Security'], HSTS_VALUE);
  assert.equal(HSTS_VALUE, 'max-age=604800');
  for (const adminPath of ['/admin', '/admin/login', '/ADMIN/stock', '/Admin']) assert.deepEqual(calls(adminPath, live), {}, adminPath);
  for (const voicePath of ['/voice/incoming', '/voice/process-speech', '/VOICE/continue']) {
    assert.deepEqual(calls(voicePath, live), { 'X-Content-Type-Options': 'nosniff' }, voicePath);
  }
  // Paths that only look similar get the full set.
  for (const other of ['/administrator', '/voices', '/api/menu', '/']) assert.ok('Content-Security-Policy' in calls(other, live), other);
});

// ------------------------------------------------------------------------------------
// Real server: the headers on the wire
// ------------------------------------------------------------------------------------

const PAGE_PATHS = ['/', '/menu', '/about', '/order', '/menu.html', '/app.js', '/site.css', '/tokens.css', '/images/hero.webp', '/api/menu', '/api/availability', '/no-such-page'];
const EXPECTED_TYPES = {
  '/': /^text\/html/,
  '/menu': /^text\/html/,
  '/about': /^text\/html/,
  '/order': /^text\/html/,
  '/menu.html': /^text\/html/,
  '/app.js': /^application\/javascript|^text\/javascript/,
  '/site.css': /^text\/css/,
  '/tokens.css': /^text\/css/,
  '/images/hero.webp': /^image\/webp/,
  '/api/menu': /^application\/json/,
  '/api/availability': /^application\/json/
};

// Express's own 404 page (finalhandler) sets an enforcing "default-src 'none'" on itself.
// That is stricter than ours and only on that plain error page, so it is expected there.
const EXPRESS_404_CSP = "default-src 'none'";

function assertPageHeaders(headers, label, { mode, hsts, express404 = false }) {
  const policy = buildPolicy(inlineScriptHashes(PUBLIC));
  const cspName = mode === 'enforce' ? 'content-security-policy' : 'content-security-policy-report-only';
  const otherName = mode === 'enforce' ? 'content-security-policy-report-only' : 'content-security-policy';
  if (express404) {
    assert.equal(headers.get('content-security-policy'), EXPRESS_404_CSP, `${label}: the Express 404 page's own CSP`);
    if (mode !== 'enforce') assert.equal(headers.get(cspName), policy, `${label}: ${cspName}`);
  } else {
    assert.equal(headers.get(cspName), policy, `${label}: ${cspName}`);
    assert.equal(headers.get(otherName), null, `${label}: no ${otherName}`);
  }
  assert.equal(headers.get('x-content-type-options'), 'nosniff', label);
  assert.equal(headers.get('referrer-policy'), 'strict-origin-when-cross-origin', label);
  assert.equal(headers.get('x-frame-options'), 'DENY', label);
  assert.equal(headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=(), payment=(), usb=()', label);
  assert.equal(headers.get('cross-origin-opener-policy'), 'same-origin', label);
  assert.equal(headers.get('strict-transport-security'), hsts ? 'max-age=604800' : null, `${label}: HSTS`);
  assert.equal(headers.get('x-powered-by'), null, `${label}: no X-Powered-By`);
}

test('server, development, default mode: report-only CSP and the full set on every public response', async () => {
  const server = await startServer();
  try {
    assert.match(server.output(), /\[headers\] public CSP mode: report-only, 2 inline script hashes/);
    for (const urlPath of PAGE_PATHS) {
      const res = await fetch(`${server.base}${urlPath}`);
      assertPageHeaders(res.headers, `GET ${urlPath}`, { mode: 'report-only', hsts: false, express404: urlPath === '/no-such-page' });
      if (EXPECTED_TYPES[urlPath]) assert.match(res.headers.get('content-type'), EXPECTED_TYPES[urlPath], urlPath);
      if (urlPath !== '/no-such-page') assert.equal(res.status, 200, urlPath);
    }
    // The D7 error handler's replies carry them too.
    const bad = await fetch(`${server.base}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    assert.equal(bad.status, 400);
    assertPageHeaders(bad.headers, 'bad JSON to /chat', { mode: 'report-only', hsts: false });
  } finally {
    server.stop();
  }
});

test('server: admin and voice headers equal the pre D7 baseline, minus X-Powered-By, plus nosniff on voice', async () => {
  const server = await startServer();
  try {
    const now = await captureHeaderSets(server.base);
    assert.deepEqual(Object.keys(now), Object.keys(baseline));
    for (const [label, before] of Object.entries(baseline)) {
      const expected = { ...before.headers };
      delete expected['x-powered-by'];
      if (label.startsWith('POST /voice/')) expected['x-content-type-options'] = 'nosniff';
      assert.equal(now[label].status, before.status, label);
      assert.deepEqual(now[label].headers, Object.fromEntries(Object.entries(expected).sort(([a], [b]) => a.localeCompare(b))), label);
    }
    // The admin CSP is byte for byte the one admin.js has always sent.
    assert.equal(
      now['GET /admin/login'].headers['content-security-policy'],
      "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    );
    assert.equal(now['POST /voice/incoming (bad signature)'].status, 403, 'Twilio validation unchanged');
  } finally {
    server.stop();
  }
});

test('server, enforce mode: Content-Security-Policy is sent and Report-Only is not', async () => {
  const server = await startServer({ PUBLIC_CSP_MODE: 'enforce' });
  try {
    assert.match(server.output(), /public CSP mode: enforce/);
    for (const urlPath of ['/', '/order', '/app.js']) {
      assertPageHeaders((await fetch(`${server.base}${urlPath}`)).headers, urlPath, { mode: 'enforce', hsts: false });
    }
    const admin = await fetch(`${server.base}/admin/login`);
    assert.equal(admin.headers.get('content-security-policy'), baseline['GET /admin/login'].headers['content-security-policy']);
  } finally {
    server.stop();
  }
});

test('server, outside development: HSTS for 7 days, production and NODE_ENV unset alike', async () => {
  for (const env of [{ NODE_ENV: 'production' }, { NODE_ENV: '' }]) {
    const server = await startServer(env);
    try {
      for (const urlPath of ['/', '/api/menu']) {
        assertPageHeaders((await fetch(`${server.base}${urlPath}`)).headers, `${JSON.stringify(env)} ${urlPath}`, { mode: 'report-only', hsts: true });
      }
      const admin = await fetch(`${server.base}/admin/login`);
      assert.equal(admin.headers.get('strict-transport-security'), null, 'admin headers unchanged');
    } finally {
      server.stop();
    }
  }
});

test('server: an invalid PUBLIC_CSP_MODE refuses to start', async () => {
  for (const value of ['off', 'Enforce', 'yes']) {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'd7-hdr-bad-')),
      env: { PATH: process.env.PATH, NODE_ENV: 'development', PORT: '0', PUBLIC_CSP_MODE: value },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (c) => (output += c));
    child.stderr.on('data', (c) => (output += c));
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code, 1, value);
    assert.match(output, /FATAL: PUBLIC_CSP_MODE must be "report-only" or "enforce".*Refusing to start\./, value);
    assert.ok(!/listening on/.test(output), value);
  }
});
