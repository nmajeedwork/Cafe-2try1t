// D7: captures the response headers of the admin pages and the Twilio voice webhook from a
// running server, so test/d7-public-headers.test.js can prove the public security headers
// left them unchanged. The baseline (d7-header-baseline.json) was captured with this helper
// from main before public-headers.js existed:
//
//   node test/fixtures/d7-header-capture.js
//
// Values that differ per request (Date, ETag, cookies, lengths) are left out. Starts its own
// server child process with test/fixtures/voice-preload.js: loopback only, no database, no
// ElevenLabs, made-up Twilio and admin secrets. Nothing is spent.
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const twilio = require('twilio');

const ROOT = path.join(__dirname, '..', '..');
const PRELOAD = path.join(__dirname, 'voice-preload.js');
const AUTH_TOKEN = 'test-twilio-auth-token-not-real';
const ADMIN_PASSWORD = 'd7-header-capture-password';
const PER_REQUEST = new Set(['date', 'etag', 'set-cookie', 'content-length', 'last-modified', 'connection', 'keep-alive']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startServer(env = {}) {
  const { hashPassword } = require(path.join(ROOT, 'admin.js'));
  const port = await freePort();
  const child = spawn(process.execPath, ['--require', PRELOAD, path.join(ROOT, 'server.js')], {
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'd7-hdr-')),
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'development',
      PORT: String(port),
      ANTHROPIC_API_KEY: 'test-anthropic-key-not-real',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      TWILIO_ACCOUNT_SID: 'ACtest-not-real',
      TWILIO_AUTH_TOKEN: AUTH_TOKEN,
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      ADMIN_PASSWORD_HASH: await hashPassword(ADMIN_PASSWORD),
      ADMIN_SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      DATABASE_URL: 'postgres://stubbed-by-voice-preload',
      FAKE_SOLD_OUT: '[]',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const startedAt = Date.now();
  while (!/listening on/.test(output)) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${output}`);
    if (Date.now() - startedAt > 30000) throw new Error(`server did not start:\n${output}`);
    await sleep(25);
  }
  return { base: `http://127.0.0.1:${port}`, output: () => output, stop: () => child.kill() };
}

function stable(headers) {
  const out = {};
  for (const [name, value] of [...headers.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!PER_REQUEST.has(name)) out[name] = value;
  }
  return out;
}

const cookiesOf = (res) => (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map((c) => c.split(';')[0]);

// The header sets compared by the test, keyed by a short label.
async function captureHeaderSets(base) {
  const sets = {};
  const get = (urlPath, headers = {}) => fetch(`${base}${urlPath}`, { headers, redirect: 'manual' });

  const login = await get('/admin/login');
  sets['GET /admin/login'] = { status: login.status, headers: stable(login.headers) };
  const loginHtml = await login.text();
  const preCookies = cookiesOf(login);

  const css = await get('/admin/assets/admin.css');
  sets['GET /admin/assets/admin.css'] = { status: css.status, headers: stable(css.headers) };

  const loggedOut = await get('/admin/stock');
  sets['GET /admin/stock (logged out)'] = { status: loggedOut.status, headers: stable(loggedOut.headers) };

  const token = loginHtml.match(/name="_csrf" value="([^"]+)"/)[1];
  const posted = await fetch(`${base}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, cookie: preCookies.join('; ') },
    body: new URLSearchParams({ _csrf: token, password: ADMIN_PASSWORD })
  });
  sets['POST /admin/login (right password)'] = { status: posted.status, headers: stable(posted.headers) };
  const adminCookies = cookiesOf(posted);

  const stock = await get('/admin/stock', { cookie: adminCookies.join('; ') });
  sets['GET /admin/stock (logged in)'] = { status: stock.status, headers: stable(stock.headers) };

  const voiceUrl = `${base}/voice/incoming`;
  const params = { CallSid: `CA${crypto.randomBytes(16).toString('hex')}`, From: '+15550199001' };
  const voiceHeaders = { 'content-type': 'application/x-www-form-urlencoded' };
  const signed = await fetch(voiceUrl, {
    method: 'POST',
    headers: { ...voiceHeaders, 'x-twilio-signature': twilio.getExpectedTwilioSignature(AUTH_TOKEN, voiceUrl, params) },
    body: new URLSearchParams(params)
  });
  sets['POST /voice/incoming (signed)'] = { status: signed.status, headers: stable(signed.headers) };
  const unsigned = await fetch(voiceUrl, { method: 'POST', headers: voiceHeaders, body: new URLSearchParams(params) });
  sets['POST /voice/incoming (bad signature)'] = { status: unsigned.status, headers: stable(unsigned.headers) };

  return sets;
}

module.exports = { startServer, captureHeaderSets, stable, AUTH_TOKEN };

if (require.main === module) {
  (async () => {
    const server = await startServer();
    try {
      const sets = await captureHeaderSets(server.base);
      const file = path.join(__dirname, 'd7-header-baseline.json');
      fs.writeFileSync(file, `${JSON.stringify(sets, null, 2)}\n`);
      console.log(`wrote ${file}`);
    } finally {
      server.stop();
    }
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
