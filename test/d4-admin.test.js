// D4 admin login tests.
//
// Run with:  node --test test/d4-admin.test.js
//
// Zero spend. Server checks run a real `node server.js` child process with a clean
// environment, a working directory with no .env, and test/fixtures/voice-preload.js, which
// blocks every non-loopback request. The one /chat call goes to a fake Anthropic API on
// 127.0.0.1. The admin password below is a made-up test value, hashed at test time.
// Clock-driven checks (idle and absolute expiry, the global alert) mount the admin router
// in this process with a fake clock.
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');

const admin = require('../admin');

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(__dirname, 'fixtures', 'voice-preload.js');
const TEST_PASSWORD = 'test-only-admin-password-not-real';
const TEST_SECRET = 'test-only-admin-session-secret-0123456789abcdef';
const CUSTOMER_SECRET = 'test-only-customer-session-secret-not-real';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let TEST_HASH;
const seenSecrets = new Set([TEST_PASSWORD]); // checked against every log at the end

// ------------------------------------------------------------------------------------
// Fake Anthropic API (only the customer-cookie checks call /chat)
// ------------------------------------------------------------------------------------

const fake = { server: null, port: null };
before(async () => {
  TEST_HASH = await admin.hashPassword(TEST_PASSWORD);
  seenSecrets.add(TEST_HASH);
  fake.server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_fake',
          type: 'message',
          role: 'assistant',
          model: 'fake',
          content: [{ type: 'text', text: 'OK' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 }
        })
      );
    });
  });
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  fake.port = fake.server.address().port;
  main = await startServer({ env: adminEnv() });
});
after(() => {
  fake.server.closeAllConnections();
  fake.server.close();
});

// ------------------------------------------------------------------------------------
// Server child processes
// ------------------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const children = new Set();
after(() => {
  for (const child of children) child.kill();
});

async function startServer({ env = {}, expectExit = false } = {}) {
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-admin-'));
  const child = spawn(process.execPath, ['--require', PRELOAD, path.join(ROOT, 'server.js')], {
    cwd,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      PORT: String(port),
      SESSION_SECRET: CUSTOMER_SECRET,
      ANTHROPIC_API_KEY: 'test-anthropic-key-not-real',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${fake.port}`,
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.add(child);
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

  if (expectExit) {
    const code = await Promise.race([exited, sleep(15000).then(() => 'still running')]);
    child.kill();
    children.delete(child);
    return { code, output };
  }
  const startedAt = Date.now();
  while (!/listening on/.test(output)) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${output}`);
    if (Date.now() - startedAt > 30000) throw new Error(`server did not start:\n${output}`);
    await sleep(25);
  }
  return {
    base: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    output: () => output,
    stop: () => {
      child.kill();
      children.delete(child);
    }
  };
}

const adminEnv = (extra = {}) => ({ ADMIN_PASSWORD_HASH: TEST_HASH, ADMIN_SESSION_SECRET: TEST_SECRET, ...extra });

// ------------------------------------------------------------------------------------
// A small browser: a cookie jar that honors cookie paths, and a client IP sent the way
// the one trusted proxy hop would send it (X-Forwarded-For, X-Forwarded-Proto: https).
// ------------------------------------------------------------------------------------

function parseSetCookie(header) {
  const [pair, ...attrs] = header.split(';').map((s) => s.trim());
  const eq = pair.indexOf('=');
  const cookie = { name: pair.slice(0, eq), value: pair.slice(eq + 1), attrs: {}, raw: header };
  for (const attr of attrs) {
    const [k, ...v] = attr.split('=');
    cookie.attrs[k.toLowerCase()] = v.length ? v.join('=') : true;
  }
  return cookie;
}

class Browser {
  constructor(server, { ip = '203.0.113.10', https = true } = {}) {
    this.server = server;
    this.ip = ip;
    this.https = https;
    this.jar = new Map(); // name -> { value, path }
  }

  get origin() {
    return `${this.https ? 'https' : 'http'}://${this.server.host}`;
  }

  cookieHeader(urlPath) {
    const parts = [];
    for (const [name, c] of this.jar) {
      const p = c.path || '/';
      if (urlPath === p || urlPath.startsWith(p.endsWith('/') ? p : `${p}/`)) parts.push(`${name}=${c.value}`);
    }
    return parts.join('; ');
  }

  async request(method, urlPath, { form, json, headers = {}, cookie } = {}) {
    const h = { 'x-forwarded-for': this.ip, ...headers };
    if (this.https) h['x-forwarded-proto'] = 'https';
    const jarCookies = cookie === undefined ? this.cookieHeader(urlPath) : cookie;
    if (jarCookies) h.cookie = jarCookies;
    let body;
    if (form) {
      h['content-type'] = 'application/x-www-form-urlencoded';
      body = typeof form === 'string' ? form : new URLSearchParams(form).toString();
    } else if (json) {
      h['content-type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await fetch(`${this.server.base}${urlPath}`, { method, headers: h, body, redirect: 'manual' });
    const text = await res.text();
    const setCookies = res.headers.getSetCookie().map(parseSetCookie);
    for (const c of setCookies) {
      const expired = c.attrs.expires && new Date(c.attrs.expires).getTime() <= Date.now();
      if (expired || c.value === '') this.jar.delete(c.name);
      else this.jar.set(c.name, { value: c.value, path: c.attrs.path });
    }
    return { status: res.status, headers: res.headers, text, setCookies };
  }

  get(urlPath, opts) {
    return this.request('GET', urlPath, opts);
  }

  post(urlPath, opts = {}) {
    return this.request('POST', urlPath, { ...opts, headers: { origin: this.origin, ...(opts.headers || {}) } });
  }

  async loginForm() {
    const res = await this.get('/admin/login');
    assert.equal(res.status, 200);
    const token = res.text.match(/name="_csrf" value="([^"]+)"/)[1];
    seenSecrets.add(token);
    return token;
  }

  async login(password = TEST_PASSWORD, extra = {}) {
    const token = await this.loginForm();
    return this.post('/admin/login', { form: { _csrf: token, password }, ...extra });
  }

  sid() {
    const c = this.jar.get('admin.sid');
    if (c) seenSecrets.add(decodeURIComponent(c.value));
    return c && c.value;
  }
}

const ADMIN_HEADERS = {
  'x-robots-tag': 'noindex, nofollow',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin'
};

function assertAdminHeaders(res, label) {
  for (const [name, value] of Object.entries(ADMIN_HEADERS)) {
    assert.equal(res.headers.get(name), value, `${label}: ${name}`);
  }
  assert.match(res.headers.get('content-security-policy') || '', /frame-ancestors 'none'/, `${label}: CSP`);
}

const withoutToken = (html) => html.replace(/name="_csrf" value="[^"]+"/, 'name="_csrf" value="X"');

// ------------------------------------------------------------------------------------
// Startup rules (unit)
// ------------------------------------------------------------------------------------

test('config: both unset means admin is off; empty strings count as unset', () => {
  assert.deepEqual(admin.loadAdminConfig({}), { enabled: false });
  assert.deepEqual(admin.loadAdminConfig({ ADMIN_PASSWORD_HASH: '', ADMIN_SESSION_SECRET: '' }), { enabled: false });
});

test('config: only one set, a malformed or cheap hash, or a weak secret is an error that never shows the value', () => {
  const cheapHash = TEST_HASH.replace(/^scrypt:32768:/, 'scrypt:1024:');
  const cases = [
    [{ ADMIN_PASSWORD_HASH: TEST_HASH }, /ADMIN_SESSION_SECRET is not set/],
    [{ ADMIN_SESSION_SECRET: TEST_SECRET }, /ADMIN_PASSWORD_HASH is not set/],
    [adminEnv({ ADMIN_PASSWORD_HASH: 'plain-text-password-here' }), /ADMIN_PASSWORD_HASH is invalid/],
    [adminEnv({ ADMIN_PASSWORD_HASH: cheapHash }), /ADMIN_PASSWORD_HASH is invalid \(N must be/],
    [adminEnv({ ADMIN_SESSION_SECRET: 'short-secret' }), /too weak \(shorter than 32/],
    [adminEnv({ ADMIN_SESSION_SECRET: 'ab'.repeat(20) }), /too weak \(fewer than 10 distinct/],
    [
      adminEnv({ ADMIN_SESSION_SECRET: 'change_this_to_a_long_random_string_of_at_least_32_characters' }),
      /too weak \(a placeholder value\)/
    ],
    [adminEnv({ SESSION_SECRET: TEST_SECRET }), /too weak \(the same as SESSION_SECRET\)/]
  ];
  for (const [env, pattern] of cases) {
    const result = admin.loadAdminConfig(env);
    assert.match(result.error || '', pattern);
    for (const value of Object.values(env)) assert.ok(!result.error.includes(value), 'error must not contain a value');
  }
  const ok = admin.loadAdminConfig(adminEnv({ SESSION_SECRET: CUSTOMER_SECRET }));
  assert.equal(ok.enabled, true);
});

test('verifyPassword: right password passes, wrong fails, and unusable input still runs one scrypt', async () => {
  const parsed = admin.parsePasswordHash(TEST_HASH);
  assert.equal(await admin.verifyPassword(TEST_PASSWORD, parsed), true);
  assert.equal(await admin.verifyPassword(`${TEST_PASSWORD}x`, parsed), false);

  const realScrypt = require('node:util').promisify(crypto.scrypt);
  for (const input of [undefined, '', 42, ['a', 'b'], 'x'.repeat(admin.MAX_PASSWORD_BYTES + 1)]) {
    let calls = 0;
    const counting = (...args) => {
      calls += 1;
      return realScrypt(...args);
    };
    assert.equal(await admin.verifyPassword(input, parsed, counting), false);
    assert.equal(calls, 1, `scrypt must run once for ${typeof input}`);
  }
});

// ------------------------------------------------------------------------------------
// Startup rules (real server)
// ------------------------------------------------------------------------------------

test('server: both unset gives the ordinary 404 on every /admin path', async () => {
  const server = await startServer();
  try {
    assert.match(server.output(), /admin is off/);
    const b = new Browser(server);
    const norm = (text, p) => text.replace(p, 'PATH');
    for (const method of ['GET', 'POST']) {
      const baseline = await b.request(method, '/no-such-page');
      for (const p of ['/admin', '/admin/', '/admin/login', '/admin/logout', '/admin/anything', '/ADMIN/login']) {
        const res = await b.request(method, p, method === 'POST' ? { form: { password: TEST_PASSWORD } } : {});
        assert.equal(res.status, 404, `${method} ${p}`);
        assert.equal(norm(res.text, p), norm(baseline.text, '/no-such-page'), `${method} ${p} body`);
        assert.equal(res.headers.get('x-robots-tag'), null);
      }
    }
  } finally {
    server.stop();
  }
});

test('server: only one var set, or a weak secret, refuses to start and never prints the value', async () => {
  const cases = [
    { ADMIN_PASSWORD_HASH: TEST_HASH },
    { ADMIN_SESSION_SECRET: TEST_SECRET },
    adminEnv({ ADMIN_SESSION_SECRET: 'too-short-but-secret-ish' }),
    adminEnv({ ADMIN_PASSWORD_HASH: 'not-a-hash-value' })
  ];
  for (const env of cases) {
    const { code, output } = await startServer({ env, expectExit: true });
    assert.equal(code, 1, `exit code for ${Object.keys(env).join(',')}`);
    assert.match(output, /FATAL: .*Refusing to start\./);
    assert.doesNotMatch(output, /listening on/);
    for (const value of Object.values(env)) assert.ok(!output.includes(value), 'output must not contain a value');
  }
});

// ------------------------------------------------------------------------------------
// The admin router inside the real server (production mode, behind a pretend proxy)
// ------------------------------------------------------------------------------------

let main; // started in the before hook at the top, once the test hash exists
after(() => main && main.stop());

test('login page: admin headers, admin.pre cookie flags, nothing indexed or cached', async () => {
  const b = new Browser(main, { ip: '203.0.113.20' });
  const res = await b.get('/admin/login');
  assert.equal(res.status, 200);
  assertAdminHeaders(res, 'GET /admin/login');
  const pre = res.setCookies.find((c) => c.name === 'admin.pre');
  assert.equal(pre.attrs.path, '/admin');
  assert.equal(pre.attrs.httponly, true);
  assert.equal(pre.attrs.secure, true);
  assert.equal(pre.attrs.samesite, 'Strict');
  assert.ok(!res.setCookies.some((c) => c.name === 'admin.sid'), 'no session before login');
  assert.ok(!res.setCookies.some((c) => c.name === 'connect.sid'), 'no customer session under /admin');

  for (const [p, status] of [
    ['/admin', 303],
    ['/admin/nope', 404],
    ['/ADMIN/login', 404]
  ]) {
    const r = await b.get(p);
    assert.equal(r.status, status, p);
    assertAdminHeaders(r, `GET ${p}`);
  }
});

test('right password: 303 to /admin, session cookie flags, 8 hour Expires, stock page', async () => {
  const b = new Browser(main, { ip: '203.0.113.21' });
  const before = Date.now();
  const res = await b.login();
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/admin');
  assertAdminHeaders(res, 'POST /admin/login ok');
  const sid = res.setCookies.find((c) => c.name === 'admin.sid');
  assert.ok(sid, 'admin.sid issued');
  b.sid();
  assert.equal(sid.attrs.path, '/admin');
  assert.equal(sid.attrs.httponly, true);
  assert.equal(sid.attrs.secure, true);
  assert.equal(sid.attrs.samesite, 'Strict');
  const expires = new Date(sid.attrs.expires).getTime();
  const eight = 8 * 60 * 60 * 1000;
  assert.ok(Math.abs(expires - (before + eight)) < 60 * 1000, 'Expires is 8 hours after login');

  const home = await b.get('/admin/stock');
  assert.equal(home.status, 200);
  assert.match(home.text, /<h1>Stock<\/h1>/);
  assertAdminHeaders(home, 'GET /admin logged in');
  const again = await b.get('/admin/stock');
  const resent = again.setCookies.find((c) => c.name === 'admin.sid');
  if (resent) assert.equal(new Date(resent.attrs.expires).getTime(), expires, 'Expires never slides');
});

test('wrong password: 401 with the login form again, not logged in', async () => {
  const b = new Browser(main, { ip: '203.0.113.22' });
  const res = await b.login('definitely-the-wrong-password');
  assert.equal(res.status, 401);
  assert.match(res.text, /Wrong password\./);
  assertAdminHeaders(res, 'POST /admin/login wrong');
  assert.ok(!res.setCookies.some((c) => c.name === 'admin.sid'));
  assert.equal((await b.get('/admin/stock')).status, 303);
});

test('unknown state (missing, empty, oversized, repeated field) gets exactly the wrong-password response', async () => {
  const forms = [
    (t) => ({ _csrf: t, password: 'definitely-the-wrong-password' }),
    (t) => ({ _csrf: t }),
    (t) => ({ _csrf: t, password: '' }),
    (t) => ({ _csrf: t, password: 'x'.repeat(5000) }),
    (t) => `_csrf=${encodeURIComponent(t)}&password=a&password=b`
  ];
  const bodies = [];
  for (const [i, make] of forms.entries()) {
    const b = new Browser(main, { ip: `203.0.113.${30 + i}` });
    const token = await b.loginForm();
    const res = await b.post('/admin/login', { form: make(token) });
    assert.equal(res.status, 401, `variant ${i}`);
    bodies.push(withoutToken(res.text));
  }
  for (const body of bodies) assert.equal(body, bodies[0]);
});

test('per IP: 5 wrong passwords, then 429 even for the right password; other IPs are not affected', async () => {
  const attacker = new Browser(main, { ip: '198.51.100.7' });
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await attacker.login('wrong-password-guess')).status, 401, `attempt ${i + 1}`);
  }
  const blocked = await attacker.login();
  assert.equal(blocked.status, 429);
  assertAdminHeaders(blocked, 'POST /admin/login 429');
  assert.ok(!blocked.setCookies.some((c) => c.name === 'admin.sid'));

  const owner = new Browser(main, { ip: '192.0.2.50' });
  assert.equal((await owner.login()).status, 303, 'a different IP still logs in');
});

test('per IP: a spoofed X-Forwarded-For entry is ignored; only the address the proxy saw counts', async () => {
  const victim = '192.0.2.77';
  // A client claims to be the victim; the trusted proxy appends the real address.
  const spoofer = new Browser(main, { ip: `${victim}, 198.51.100.99` });
  for (let i = 0; i < 6; i += 1) await spoofer.login('wrong-password-guess');
  assert.equal((await spoofer.login()).status, 429);
  assert.equal((await new Browser(main, { ip: victim }).login()).status, 303, 'victim is not blocked');
});

test('CSRF: missing or bad token gives 403 on login and logout', async () => {
  const b = new Browser(main, { ip: '203.0.113.40' });
  const token = await b.loginForm();
  for (const form of [{ password: TEST_PASSWORD }, { _csrf: 'forged', password: TEST_PASSWORD }, { _csrf: `${token}x`, password: TEST_PASSWORD }]) {
    const res = await b.post('/admin/login', { form });
    assert.equal(res.status, 403);
    assertAdminHeaders(res, 'login CSRF 403');
  }
  const other = new Browser(main, { ip: '203.0.113.41' });
  const res = await other.post('/admin/login', { form: { _csrf: token, password: TEST_PASSWORD } });
  assert.equal(res.status, 403, 'a token without its admin.pre cookie is refused');

  assert.equal((await b.login()).status, 303);
  for (const form of [{}, { _csrf: 'forged' }, { _csrf: token }]) {
    assert.equal((await b.post('/admin/logout', { form })).status, 403);
  }
  assert.equal((await b.get('/admin/stock')).status, 200, 'still logged in after refused logouts');
});

test('Origin: missing, foreign, null or wrong-scheme Origin gives 403', async () => {
  const b = new Browser(main, { ip: '203.0.113.42' });
  const token = await b.loginForm();
  const bad = [undefined, 'https://evil.example', 'null', `http://${main.host}`];
  for (const origin of bad) {
    const headers = origin === undefined ? { origin: '' } : { origin };
    const res = await b.request('POST', '/admin/login', {
      form: { _csrf: token, password: TEST_PASSWORD },
      headers: origin === undefined ? {} : headers
    });
    assert.equal(res.status, 403, `origin ${origin}`);
  }
  assert.equal((await b.login()).status, 303);
  const home = await b.get('/admin/stock');
  const logoutToken = home.text.match(/name="_csrf" value="([^"]+)"/)[1];
  seenSecrets.add(logoutToken);
  const res = await b.post('/admin/logout', { form: { _csrf: logoutToken }, headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
  assert.equal((await b.get('/admin/stock')).status, 200);
});

// The Origin a browser puts on a same-origin form POST, by the page's Referrer-Policy.
// A model of the Fetch spec step "append a request Origin header" for this one case (not a
// real browser): no-referrer turns the Origin into "null" for any POST; same-origin and the
// other policies keep it for a same-origin, same-scheme request.
function browserOriginForSameOriginPost(referrerPolicy, pageOrigin) {
  return referrerPolicy === 'no-referrer' ? 'null' : pageOrigin;
}

test('Referrer-Policy is same-origin on admin responses, so browsers keep the real Origin on login', async () => {
  const b = new Browser(main, { ip: '203.0.113.49' });
  const page = await b.get('/admin/login');
  const policy = page.headers.get('referrer-policy');
  assert.notEqual(policy, 'no-referrer', 'no-referrer makes browsers send Origin: null on form POSTs');
  assert.equal(policy, 'same-origin');
  for (const p of ['/admin', '/admin/nope']) {
    assert.equal((await b.get(p)).headers.get('referrer-policy'), 'same-origin', p);
  }

  // Post the login the way a browser would under this page's policy: it must succeed.
  const token = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  seenSecrets.add(token);
  const origin = browserOriginForSameOriginPost(policy, b.origin);
  const res = await b.post('/admin/login', { form: { _csrf: token, password: TEST_PASSWORD }, headers: { origin } });
  assert.equal(res.status, 303, 'login works with the Origin a browser would send');

  // And the old policy really did break it: Origin null is refused.
  const old = new Browser(main, { ip: '203.0.113.50' });
  const oldToken = await old.loginForm();
  const nullOrigin = browserOriginForSameOriginPost('no-referrer', old.origin);
  const refused = await old.post('/admin/login', {
    form: { _csrf: oldToken, password: TEST_PASSWORD },
    headers: { origin: nullOrigin }
  });
  assert.equal(refused.status, 403);
});

test('session id changes at login, and the old id stops working', async () => {
  const b = new Browser(main, { ip: '203.0.113.43' });
  assert.equal((await b.login()).status, 303);
  const first = b.sid();

  // Log in again while presenting the old id: a new id must be issued.
  const fresh = new Browser(main, { ip: '203.0.113.43' });
  const token = await fresh.loginForm();
  fresh.jar.set('admin.sid', { value: first, path: '/admin' });
  const res = await fresh.post('/admin/login', { form: { _csrf: token, password: TEST_PASSWORD } });
  assert.equal(res.status, 303);
  const second = fresh.sid();
  assert.ok(second && second !== first, 'new session id');
  assert.equal((await b.get('/admin/stock')).status, 303, 'old id is dead');
  assert.equal((await fresh.get('/admin/stock')).status, 200);

  // A planted id that the server never issued is also replaced.
  const planted = new Browser(main, { ip: '203.0.113.44' });
  const t2 = await planted.loginForm();
  planted.jar.set('admin.sid', { value: 's%3Aplanted.abc', path: '/admin' });
  await planted.post('/admin/login', { form: { _csrf: t2, password: TEST_PASSWORD } });
  assert.notEqual(planted.sid(), 's%3Aplanted.abc');
});

test('logout destroys the session and replaying the old cookie lands on the login page', async () => {
  const b = new Browser(main, { ip: '203.0.113.45' });
  assert.equal((await b.login()).status, 303);
  const sid = b.sid();
  const home = await b.get('/admin/stock');
  const token = home.text.match(/name="_csrf" value="([^"]+)"/)[1];
  seenSecrets.add(token);
  const out = await b.post('/admin/logout', { form: { _csrf: token } });
  assert.equal(out.status, 303);
  assert.equal(out.headers.get('location'), '/admin/login');
  const cleared = out.setCookies.find((c) => c.name === 'admin.sid');
  assert.ok(cleared && cleared.attrs.path === '/admin', 'cookie cleared on /admin');

  const replay = await b.get('/admin/stock', { cookie: `admin.sid=${sid}` });
  assert.equal(replay.status, 303);
  assert.equal(replay.headers.get('location'), '/admin/login');
  const replayLogout = await b.post('/admin/logout', { form: { _csrf: token }, cookie: `admin.sid=${sid}` });
  assert.equal(replayLogout.status, 403);
});

test('a customer cookie grants nothing under /admin', async () => {
  const b = new Browser(main, { ip: '203.0.113.46' });
  const chat = await b.post('/chat', { json: { message: 'hello' } });
  assert.equal(chat.status, 200);
  const customer = b.jar.get('connect.sid');
  assert.ok(customer, 'customer cookie issued by /chat');
  assert.equal(customer.path, '/');

  // The browser sends connect.sid (Path=/) to /admin too: it must not count as a login.
  const res = await b.get('/admin/stock');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/admin/login');
  assert.ok(!res.setCookies.some((c) => c.name === 'connect.sid'), 'customer session middleware skipped');
  assert.equal((await b.post('/admin/logout', { form: {} })).status, 403);

  // The same value presented as an admin cookie is not valid either (different secret).
  const replay = await b.get('/admin/stock', { cookie: `admin.sid=${customer.value}` });
  assert.equal(replay.status, 303);
});

test('the admin cookie is scoped to /admin and is not accepted on customer routes', async () => {
  const b = new Browser(main, { ip: '203.0.113.47' });
  const login = await b.login();
  assert.equal(login.setCookies.find((c) => c.name === 'admin.sid').attrs.path, '/admin');
  const sid = b.sid();
  assert.equal(b.cookieHeader('/chat'), '', 'a browser would not send it to customer routes');

  // Sent anyway, under either cookie name, customer routes ignore it and admin is unharmed.
  const asAdmin = await b.post('/chat', { json: { message: 'hello' }, cookie: `admin.sid=${sid}` });
  assert.equal(asAdmin.status, 200);
  const newCustomer = asAdmin.setCookies.find((c) => c.name === 'connect.sid');
  assert.ok(newCustomer, 'a fresh customer session, not the admin one');
  const asCustomer = await b.post('/chat', { json: { message: 'hello' }, cookie: `connect.sid=${sid}` });
  const issued = asCustomer.setCookies.find((c) => c.name === 'connect.sid');
  assert.ok(issued && issued.value !== sid, 'admin id is not a valid customer session');
  await b.post('/reset', { cookie: `connect.sid=${sid}` });
  assert.equal((await b.get('/admin/stock')).status, 200, 'admin session survives customer routes');
});

test('customer routes are unchanged: no admin headers on /, /menu, /api/menu', async () => {
  const b = new Browser(main, { ip: '203.0.113.48' });
  for (const p of ['/', '/menu', '/api/menu']) {
    const res = await b.get(p);
    assert.equal(res.status, 200, p);
    assert.equal(res.headers.get('x-robots-tag'), null, p);
  }
});

test('development mode: cookies are not Secure, everything else the same', async () => {
  const dev = await startServer({ env: adminEnv({ NODE_ENV: 'development', SESSION_SECRET: '' }) });
  try {
    const b = new Browser(dev, { ip: '203.0.113.60', https: false });
    const res = await b.login();
    assert.equal(res.status, 303);
    const sid = res.setCookies.find((c) => c.name === 'admin.sid');
    assert.equal(sid.attrs.secure, undefined);
    assert.equal(sid.attrs.httponly, true);
    assert.equal(sid.attrs.samesite, 'Strict');
    assert.equal(sid.attrs.path, '/admin');
    b.sid();
    assert.ok(!dev.output().includes(TEST_PASSWORD) && !dev.output().includes(TEST_HASH));
  } finally {
    dev.stop();
  }
});

// ------------------------------------------------------------------------------------
// Clock-driven checks: the router in this process with a fake clock
// ------------------------------------------------------------------------------------

async function startInProcess() {
  const clock = { t: Date.now() };
  const logs = [];
  const log = {
    log: (...a) => logs.push(a.join(' ')),
    warn: (...a) => logs.push(a.join(' ')),
    error: (...a) => logs.push(a.join(' '))
  };
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.urlencoded({ extended: false }));
  const config = admin.loadAdminConfig(adminEnv());
  app.use('/admin', admin.createAdminRouter(config, { isDev: false, now: () => clock.t, log }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    clock,
    logs,
    base: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    stop: () => {
      server.closeAllConnections();
      server.close();
    }
  };
}

test('idle expiry: 60 minutes without a request ends the session', async () => {
  const s = await startInProcess();
  try {
    const b = new Browser(s, { ip: '203.0.113.70' });
    assert.equal((await b.login()).status, 303);
    s.clock.t += 59 * 60 * 1000;
    assert.equal((await b.get('/admin/stock')).status, 200, 'still in at 59 minutes');
    s.clock.t += 60 * 60 * 1000;
    assert.equal((await b.get('/admin/stock')).status, 303, 'out after 60 idle minutes');
    assert.equal((await b.get('/admin/stock')).status, 303, 'and the session is gone');
  } finally {
    s.stop();
  }
});

test('absolute expiry: 8 hours after login ends the session even while active', async () => {
  const s = await startInProcess();
  try {
    const b = new Browser(s, { ip: '203.0.113.71' });
    assert.equal((await b.login()).status, 303);
    for (let i = 1; i <= 8; i += 1) {
      s.clock.t += 59 * 60 * 1000;
      assert.equal((await b.get('/admin/stock')).status, 200, `active at ${i * 59} minutes`);
    }
    s.clock.t += 59 * 60 * 1000;
    assert.equal((await b.get('/admin/stock')).status, 303, 'out at 531 minutes');
  } finally {
    s.stop();
  }
});

test('login form tokens expire after 15 minutes', async () => {
  const s = await startInProcess();
  try {
    const b = new Browser(s, { ip: '203.0.113.72' });
    const token = await b.loginForm();
    s.clock.t += 16 * 60 * 1000;
    assert.equal((await b.post('/admin/login', { form: { _csrf: token, password: TEST_PASSWORD } })).status, 403);
  } finally {
    s.stop();
  }
});

test('global alert: 20 failures in an hour across IPs logs a warning but blocks nobody', async () => {
  const s = await startInProcess();
  try {
    const alerts = () => s.logs.filter((l) => l.includes('WARNING')).length;
    for (let ip = 1; ip <= 4; ip += 1) {
      const b = new Browser(s, { ip: `198.51.100.${ip}` });
      for (let i = 0; i < 5; i += 1) {
        assert.equal((await b.login('wrong-password-guess')).status, 401);
        if (ip === 4 && i === 3) assert.equal(alerts(), 0, 'no alert at 19');
      }
    }
    assert.equal(alerts(), 1, 'alert at 20');
    assert.match(s.logs.find((l) => l.includes('WARNING')), /20 failed admin logins in the last hour across all IPs/);

    const owner = new Browser(s, { ip: '192.0.2.10' });
    assert.equal((await owner.login()).status, 303, 'owner still logs in');

    // More failures within 15 minutes do not repeat the alert; after 15 minutes they do.
    const more = new Browser(s, { ip: '198.51.100.5' });
    await more.login('wrong-password-guess');
    assert.equal(alerts(), 1);
    s.clock.t += 16 * 60 * 1000;
    await more.login('wrong-password-guess');
    assert.equal(alerts(), 2);

    // Failures older than an hour drop out of the count.
    s.clock.t += 61 * 60 * 1000;
    const later = new Browser(s, { ip: '198.51.100.6' });
    await later.login('wrong-password-guess');
    assert.equal(alerts(), 2);

    for (const line of s.logs) {
      for (const secret of seenSecrets) assert.ok(!line.includes(secret), 'log line leaks a secret');
    }
  } finally {
    s.stop();
  }
});

// ------------------------------------------------------------------------------------
// Logs never contain the password, the hash, CSRF tokens or session ids
// ------------------------------------------------------------------------------------

test('server log never contains passwords, hashes, tokens or session ids', () => {
  const output = main.output();
  assert.match(output, /\[admin\] login succeeded/);
  assert.match(output, /\[admin\] login failed/);
  for (const secret of seenSecrets) {
    assert.ok(secret.length > 8);
    assert.ok(!output.includes(secret), 'server output leaks a secret');
  }
  assert.ok(!output.includes(TEST_SECRET));
});
