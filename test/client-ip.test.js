// Client IP hop count tests (TRUST_PROXY_HOPS and the mismatch guard).
//
// Run with:  node --test test/client-ip.test.js
//
// Zero spend. Server checks run a real `node server.js` child process with a clean
// environment, a working directory with no .env, and test/fixtures/voice-preload.js, which
// blocks every non-loopback request. /chat calls go to a fake Anthropic API on 127.0.0.1.
// The test client stands in for the proxy chain by sending X-Forwarded-For itself. The
// simulated Render chain is "client, Cloudflare, Render internal", the chain confirmed on
// Render.
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const clientIp = require('../client-ip');
const admin = require('../admin');

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(__dirname, 'fixtures', 'voice-preload.js');
const TEST_PASSWORD = 'test-only-admin-password-not-real';
const TEST_SECRET = 'test-only-admin-session-secret-0123456789abcdef';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Documentation and private ranges only, never real addresses.
const CLOUDFLARE_HOP = '172.71.0.9';
const RENDER_HOP = '10.0.0.5';
const renderChain = (client, spoofed) => [spoofed, client, CLOUDFLARE_HOP, RENDER_HOP].filter(Boolean).join(', ');

let TEST_HASH;
const fake = { server: null, port: null };
before(async () => {
  TEST_HASH = await admin.hashPassword(TEST_PASSWORD);
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
});
after(() => {
  fake.server.closeAllConnections();
  fake.server.close();
});

// ------------------------------------------------------------------------------------
// Unit
// ------------------------------------------------------------------------------------

test('TRUST_PROXY_HOPS: unset or empty is 1; 1 to 5 accepted; anything else is an error', () => {
  assert.deepEqual(clientIp.parseTrustProxyHops({}), { hops: 1 });
  assert.deepEqual(clientIp.parseTrustProxyHops({ TRUST_PROXY_HOPS: '' }), { hops: 1 });
  for (const n of ['1', '3', '5']) assert.deepEqual(clientIp.parseTrustProxyHops({ TRUST_PROXY_HOPS: n }), { hops: Number(n) });
  for (const bad of ['0', '6', '10', 'true', 'abc', '1.5', ' 3', '-1', '03']) {
    assert.match(clientIp.parseTrustProxyHops({ TRUST_PROXY_HOPS: bad }).error || '', /from 1 to 5/, bad);
  }
});

test('keyed hashes: stable within one key, different across keys, never the address', () => {
  const h1 = clientIp.createHasher();
  const h2 = clientIp.createHasher();
  assert.equal(h1('198.51.100.20'), h1('::ffff:198.51.100.20'));
  assert.notEqual(h1('198.51.100.20'), h2('198.51.100.20'));
  assert.match(h1('198.51.100.20'), /^[0-9a-f]{8}$/);
  assert.equal(h1(null), 'none');
});

function captureLog() {
  const lines = [];
  return { lines, log: { log: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) } };
}

test('mismatch guard: warns at most every 15 minutes, only on a real mismatch, hashes only', () => {
  const { lines, log } = captureLog();
  let t = 0;
  const guard = clientIp.createMismatchGuard({ hops: 1, now: () => t, log });
  const run = (headers, ip) => {
    let called = false;
    guard({ headers, ip }, {}, () => (called = true));
    assert.equal(called, true, 'always calls next');
  };
  run({}, '10.0.0.5');
  run({ 'true-client-ip': '198.51.100.20' }, '198.51.100.20');
  run({ 'cf-connecting-ip': '198.51.100.20' }, '::ffff:198.51.100.20');
  assert.equal(lines.length, 0, 'no header or a match: silent');

  run({ 'true-client-ip': '198.51.100.20' }, RENDER_HOP);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /WARNING: req\.ip \([0-9a-f]{8}\) does not match .* \([0-9a-f]{8}\) with TRUST_PROXY_HOPS=1/);
  assert.ok(!lines[0].includes('198.51.100.20') && !lines[0].includes(RENDER_HOP), 'no raw IPs');
  t += 14 * 60 * 1000;
  run({ 'true-client-ip': '198.51.100.21' }, RENDER_HOP);
  assert.equal(lines.length, 1, 'throttled');
  t += 2 * 60 * 1000;
  run({ 'true-client-ip': '198.51.100.21' }, RENDER_HOP);
  assert.equal(lines.length, 2, 'again after 15 minutes');
});

// ------------------------------------------------------------------------------------
// Real server
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
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'client-ip-'));
  const child = spawn(process.execPath, ['--require', PRELOAD, path.join(ROOT, 'server.js')], {
    cwd,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'development',
      PORT: String(port),
      ANTHROPIC_API_KEY: 'test-anthropic-key-not-real',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${fake.port}`,
      ADMIN_PASSWORD_HASH: TEST_HASH,
      ADMIN_SESSION_SECRET: TEST_SECRET,
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
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    origin: base,
    output: () => output,
    stop: () => {
      child.kill();
      children.delete(child);
    }
  };
}

// One admin login attempt from a client behind the simulated chain.
async function loginAttempt(server, xff, password, extraHeaders = {}) {
  const headers = { 'x-forwarded-for': xff, ...extraHeaders };
  const page = await fetch(`${server.base}/admin/login`, { headers, redirect: 'manual' });
  const html = await page.text();
  const token = html.match(/name="_csrf" value="([^"]+)"/)[1];
  const pre = page.headers.getSetCookie().find((c) => c.startsWith('admin.pre=')).split(';')[0];
  const res = await fetch(`${server.base}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...headers, origin: server.origin, cookie: pre, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: token, password }).toString()
  });
  await res.text();
  return res.status;
}

const chat = async (server, xff) =>
  (
    await fetch(`${server.base}/chat`, {
      method: 'POST',
      headers: { 'x-forwarded-for': xff, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' })
    })
  ).status;

test('server: invalid TRUST_PROXY_HOPS refuses to start', async () => {
  for (const bad of ['0', 'true', '7']) {
    const { code, output } = await startServer({ env: { TRUST_PROXY_HOPS: bad }, expectExit: true });
    assert.equal(code, 1, bad);
    assert.match(output, /FATAL: TRUST_PROXY_HOPS must be a whole number from 1 to 5\. Refusing to start\./);
  }
});

test('server, default (1 hop) behind a Render-like chain: every client shares one bucket (the bug, unchanged by default)', async () => {
  const server = await startServer();
  try {
    assert.match(server.output(), /\[client-ip\] trust proxy hops: 1/);
    for (let i = 0; i < 5; i += 1) assert.equal(await loginAttempt(server, renderChain('198.51.100.20'), 'wrong-password-guess'), 401);
    assert.equal(await loginAttempt(server, renderChain('192.0.2.40'), TEST_PASSWORD), 429, 'another client is blocked too');
  } finally {
    server.stop();
  }
});

test('server, TRUST_PROXY_HOPS=3 behind a Render-like chain: admin login limit is per real client and spoofing is ignored', async () => {
  const server = await startServer({ env: { TRUST_PROXY_HOPS: '3' } });
  try {
    assert.match(server.output(), /\[client-ip\] trust proxy hops: 3/);
    for (let i = 0; i < 5; i += 1) assert.equal(await loginAttempt(server, renderChain('198.51.100.20'), 'wrong-password-guess'), 401);
    assert.equal(await loginAttempt(server, renderChain('198.51.100.20'), TEST_PASSWORD), 429, 'that client is blocked');
    assert.equal(
      await loginAttempt(server, renderChain('198.51.100.20', '192.0.2.99'), TEST_PASSWORD),
      429,
      'a spoofed leftmost entry does not get the blocked client a fresh bucket'
    );
    assert.equal(await loginAttempt(server, renderChain('192.0.2.40'), TEST_PASSWORD), 303, 'a different client logs in');
  } finally {
    server.stop();
  }
});

test('server, TRUST_PROXY_HOPS=3: the H1 /chat per-IP limit is per real client', async () => {
  const server = await startServer({ env: { TRUST_PROXY_HOPS: '3', RATE_LIMIT_MAX: '2' } });
  try {
    assert.equal(await chat(server, renderChain('198.51.100.30')), 200);
    assert.equal(await chat(server, renderChain('198.51.100.30')), 200);
    assert.equal(await chat(server, renderChain('198.51.100.30', '192.0.2.98')), 429, 'third from the same client, even spoofed');
    assert.equal(await chat(server, renderChain('192.0.2.41')), 200, 'a different client is not affected');
  } finally {
    server.stop();
  }
});

test('server: the mismatch guard logs hashes only, and is silent once the hop count matches', async () => {
  const headers = { 'x-forwarded-for': renderChain('198.51.100.50', '203.0.113.77'), 'true-client-ip': '198.51.100.50' };

  const wrong = await startServer();
  try {
    const res = await fetch(`${wrong.base}/admin/login`, { headers });
    assert.equal(res.status, 200, 'the login page is unaffected');
    await sleep(100);
    const out = wrong.output();
    assert.match(out, /\[client-ip\] WARNING: req\.ip \([0-9a-f]{8}\) does not match .* \([0-9a-f]{8}\) with TRUST_PROXY_HOPS=1/);
    for (const raw of ['198.51.100.50', '203.0.113.77', CLOUDFLARE_HOP, RENDER_HOP, '127.0.0.1']) {
      assert.ok(!out.includes(raw), `raw address ${raw} must never be logged`);
    }
  } finally {
    wrong.stop();
  }

  // IP_DEBUG was removed: setting it must not log anything extra.
  const right = await startServer({ env: { TRUST_PROXY_HOPS: '3', IP_DEBUG: 'true' } });
  try {
    assert.equal((await fetch(`${right.base}/admin/login`, { headers })).status, 200);
    await sleep(100);
    assert.doesNotMatch(right.output(), /\[client-ip\] WARNING/, 'no warning when req.ip matches the edge');
    assert.doesNotMatch(right.output(), /\[ip-debug\]/, 'the IP_DEBUG log is gone');
  } finally {
    right.stop();
  }
});
