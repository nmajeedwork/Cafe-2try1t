// D5 admin Stock section tests.
//
// Run with:  node --test test/d5-stock-dashboard.test.js
//
// Zero spend. Server checks run a real `node server.js` child process with a clean
// environment, a working directory with no .env, and test/fixtures/stock-db-preload.js:
// outbound network is loopback only, and db.js is replaced by a fake database kept in a temp
// JSON file (so it survives a restart, and can be switched "down"). /chat calls go to a fake
// Anthropic API on 127.0.0.1. The admin password is a made-up test value, hashed at test time.
//
// One test uses the real database. It only runs when DATABASE_URL is set AND
// STOCK_TEST_DEV_DB=yes, because it writes a real menu item's row: point it at the Neon DEV
// branch only, never production. It puts the row back the way it found it.
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

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

const admin = require('../admin');

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(__dirname, 'fixtures', 'stock-db-preload.js');
const TEST_PASSWORD = 'test-only-admin-password-not-real';
const TEST_SECRET = 'test-only-admin-session-secret-0123456789abcdef';
const MUFFIN = 'Blueberry Muffin';
const LATTE = 'Caffe Latte';
const TURKEY = 'Turkey & Swiss Sandwich';
const EXPECTED_CSP = "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let TEST_HASH;

// ------------------------------------------------------------------------------------
// Fake Anthropic API: "TOOL <name> <json>" calls a tool; after a tool round it replies
// "ack: <tool results>". Every request is recorded, so tests can read the system blocks
// and the tool results the real server sent.
// ------------------------------------------------------------------------------------

const fake = { requests: [], server: null, port: null };

function message(content, stopReason) {
  return {
    id: `msg_${crypto.randomBytes(6).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model: 'fake',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 }
  };
}

before(async () => {
  TEST_HASH = await admin.hashPassword(TEST_PASSWORD);
  fake.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw);
      fake.requests.push(body);
      const last = body.messages[body.messages.length - 1];
      const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
      const results = blocks.filter((b) => b.type === 'tool_result');
      let reply;
      if (results.length) {
        reply = message([{ type: 'text', text: `ack: ${results.map((r) => r.content).join(' | ')}` }], 'end_turn');
      } else {
        const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
        const tool = text.match(/^TOOL (\w+)\s*(.*)$/s);
        reply = tool
          ? message([{ type: 'tool_use', id: `toolu_${crypto.randomBytes(6).toString('hex')}`, name: tool[1], input: JSON.parse(tool[2] || '{}') }], 'tool_use')
          : message([{ type: 'text', text: `OK: ${text}` }], 'end_turn');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
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
// Server child processes and a fake database per test
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

function newFakeDb(initial = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd5-db-'));
  const file = path.join(dir, 'stock.json');
  fs.writeFileSync(file, JSON.stringify(initial));
  return {
    file,
    state: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    set: (state) => fs.writeFileSync(file, JSON.stringify(state)),
    writes: () =>
      fs.existsSync(`${file}.writes`)
        ? fs.readFileSync(`${file}.writes`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
        : [],
    down: (kind = 'transient') => fs.writeFileSync(`${file}.down`, kind),
    up: () => fs.rmSync(`${file}.down`, { force: true })
  };
}

const children = new Set();
after(() => {
  for (const child of children) child.kill();
});

async function startServer({ fakeDb, env = {}, preload = PRELOAD } = {}) {
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'd5-srv-'));
  const args = preload ? ['--require', preload, path.join(ROOT, 'server.js')] : [path.join(ROOT, 'server.js')];
  const child = spawn(process.execPath, args, {
    cwd,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'development',
      PORT: String(port),
      ANTHROPIC_API_KEY: 'test-anthropic-key-not-real',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${fake.port}`,
      ADMIN_PASSWORD_HASH: TEST_HASH,
      ADMIN_SESSION_SECRET: TEST_SECRET,
      DATABASE_URL: 'postgres://fake-database-from-stock-db-preload',
      FAKE_DB_FILE: fakeDb ? fakeDb.file : '',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.add(child);
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
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
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill();
        children.delete(child);
      })
  };
}

// ------------------------------------------------------------------------------------
// A logged-in admin
// ------------------------------------------------------------------------------------

async function request(server, method, urlPath, { form, json, cookie, origin } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (origin !== undefined) headers.origin = origin;
  let body;
  if (form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = typeof form === 'string' ? form : new URLSearchParams(form).toString();
  } else if (json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetch(`${server.base}${urlPath}`, { method, headers, body, redirect: 'manual' });
  return { status: res.status, headers: res.headers, text: await res.text(), setCookies: res.headers.getSetCookie() };
}

async function login(server) {
  const page = await request(server, 'GET', '/admin/login');
  const token = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const pre = page.setCookies.find((c) => c.startsWith('admin.pre=')).split(';')[0];
  const res = await request(server, 'POST', '/admin/login', {
    form: { _csrf: token, password: TEST_PASSWORD },
    cookie: pre,
    origin: server.origin
  });
  assert.equal(res.status, 303, 'login works');
  const cookie = res.setCookies.find((c) => c.startsWith('admin.sid=')).split(';')[0];
  return {
    cookie,
    loginToken: token,
    async page() {
      const r = await request(server, 'GET', '/admin/stock', { cookie });
      assert.equal(r.status, 200, 'stock page loads');
      return { ...r, csrf: r.text.match(/name="_csrf" value="([^"]+)"/)[1] };
    },
    async toggle(name, inStock, extra = {}) {
      const { csrf } = await this.page();
      return request(server, 'POST', '/admin/api/stock', {
        form: { _csrf: csrf, name, in_stock: String(inStock) },
        cookie,
        origin: server.origin,
        ...extra
      });
    },
    async reload() {
      const { csrf } = await this.page();
      return request(server, 'POST', '/admin/api/stock/reload', { form: { _csrf: csrf }, cookie, origin: server.origin });
    }
  };
}

// The state shown on the page for one item: "In stock" or "Sold out".
function shownState(html, name) {
  const escaped = admin.escapeHtml(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = html.match(new RegExp(`<span class="name">${escaped}</span><span class="state">([^<]+)</span>`));
  assert.ok(m, `item ${name} is on the page`);
  return m[1];
}

// One chat turn where the fake model calls add_to_cart for this item. Returns the tool
// result the real server produced and the system blocks it sent.
async function botAdds(server, name) {
  const before = fake.requests.length;
  const res = await request(server, 'POST', '/chat', {
    json: { message: `TOOL add_to_cart ${JSON.stringify({ item_name: name, quantity: 1 })}` }
  });
  assert.equal(res.status, 200);
  const turn = fake.requests.slice(before);
  const toolRound = turn.find((r) => {
    const last = r.messages[r.messages.length - 1];
    return Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
  });
  const last = toolRound.messages[toolRound.messages.length - 1];
  const result = JSON.parse(last.content.find((b) => b.type === 'tool_result').content);
  const systemText = turn[0].system.map((b) => b.text).join('\n');
  return { result, systemText };
}

const MENU_NAMES = require('../menu.json').map((item) => item.name);

// ------------------------------------------------------------------------------------
// Real server, fake database
// ------------------------------------------------------------------------------------

test('logged out: the page redirects to login, both actions are 403, nothing is written', async () => {
  const db = newFakeDb();
  const server = await startServer({ fakeDb: db });
  try {
    const page = await request(server, 'GET', '/admin/stock');
    assert.equal(page.status, 303);
    assert.equal(page.headers.get('location'), '/admin/login');
    const home = await request(server, 'GET', '/admin');
    assert.equal(home.headers.get('location'), '/admin/login');
    for (const p of ['/admin/api/stock', '/admin/api/stock/reload']) {
      const res = await request(server, 'POST', p, { form: { name: MUFFIN, in_stock: 'false' }, origin: server.origin });
      assert.equal(res.status, 403, p);
      assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
    }
    assert.deepEqual(db.writes(), []);
    assert.deepEqual(db.state(), {});
  } finally {
    await server.stop();
  }
});

test('CSRF and Origin: missing, wrong, login-page or other-session tokens and bad Origins give 403', async () => {
  const db = newFakeDb();
  const server = await startServer({ fakeDb: db });
  try {
    const a = await login(server);
    const b = await login(server);
    const otherToken = (await b.page()).csrf;
    const own = (await a.page()).csrf;
    const form = (csrf) => ({ ...(csrf === undefined ? {} : { _csrf: csrf }), name: MUFFIN, in_stock: 'false' });
    for (const csrf of [undefined, '', 'forged', `${own}x`, a.loginToken, otherToken]) {
      const res = await request(server, 'POST', '/admin/api/stock', { form: form(csrf), cookie: a.cookie, origin: server.origin });
      assert.equal(res.status, 403, `token ${String(csrf).slice(0, 8)}`);
    }
    for (const origin of [undefined, 'null', 'http://evil.example', server.origin.replace('http:', 'https:')]) {
      for (const p of ['/admin/api/stock', '/admin/api/stock/reload']) {
        const res = await request(server, 'POST', p, { form: form(own), cookie: a.cookie, origin });
        assert.equal(res.status, 403, `origin ${origin} on ${p}`);
      }
    }
    assert.deepEqual(db.writes(), []);
    assert.equal(shownState((await a.page()).text, MUFFIN), 'In stock');
  } finally {
    await server.stop();
  }
});

test('unknown item names and non-boolean values give 400 and change nothing', async () => {
  const db = newFakeDb();
  const server = await startServer({ fakeDb: db });
  try {
    const a = await login(server);
    const { csrf } = await a.page();
    const enc = encodeURIComponent;
    const bodies = [
      ...['caffe latte', `${LATTE} `, ` ${LATTE}`, '__proto__', 'constructor', '', 'Latte'].map(
        (name) => `_csrf=${enc(csrf)}&name=${enc(name)}&in_stock=false`
      ),
      `_csrf=${enc(csrf)}&in_stock=false`,
      `_csrf=${enc(csrf)}&name=${enc(LATTE)}&name=${enc(LATTE)}&in_stock=false`,
      ...['yes', '1', '0', '', 'TRUE', 'False'].map((v) => `_csrf=${enc(csrf)}&name=${enc(LATTE)}&in_stock=${enc(v)}`),
      `_csrf=${enc(csrf)}&name=${enc(LATTE)}`,
      `_csrf=${enc(csrf)}&name=${enc(LATTE)}&in_stock=false&in_stock=false`
    ];
    for (const body of bodies) {
      const res = await request(server, 'POST', '/admin/api/stock', { form: body, cookie: a.cookie, origin: server.origin });
      assert.equal(res.status, 400, body.replace(/_csrf=[^&]+/, '_csrf=X'));
      assert.match(res.text, /Nothing was changed\./);
    }
    const json = await request(server, 'POST', '/admin/api/stock', {
      json: { _csrf: csrf, name: LATTE, in_stock: 'nope' },
      cookie: a.cookie,
      origin: server.origin
    });
    assert.equal(json.status, 400);
    assert.deepEqual(db.writes(), []);
    assert.equal(shownState((await a.page()).text, LATTE), 'In stock');
  } finally {
    await server.stop();
  }
});

test('database down: 503 with a clear message, memory unchanged, the bot still sells the item', async () => {
  const db = newFakeDb();
  const server = await startServer({ fakeDb: db });
  try {
    const a = await login(server);
    db.down();
    const res = await a.toggle(MUFFIN, false);
    assert.equal(res.status, 503);
    assert.match(res.text, /Could not save: the database is not reachable right now\. Nothing was changed\./);
    assert.equal(shownState(res.text, MUFFIN), 'In stock');
    assert.deepEqual(db.writes(), []);
    const bot = await botAdds(server, MUFFIN);
    assert.equal(bot.result.success, true, 'memory still says in stock');
    assert.doesNotMatch(bot.systemText, /## Currently Unavailable\n/);

    const reload = await a.reload();
    assert.equal(reload.status, 503);
    assert.match(reload.text, /Could not reload/);
  } finally {
    db.up();
    await server.stop();
  }
});

test('success: database then memory, flash shown once, the bot refuses on its next turn, restock works', async () => {
  const db = newFakeDb();
  const server = await startServer({ fakeDb: db });
  try {
    const a = await login(server);
    const res = await a.toggle(MUFFIN, false);
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location'), /^\/admin\/stock#item-\d+$/);
    assert.deepEqual(db.state(), { [MUFFIN]: false });
    assert.deepEqual(db.writes(), [{ itemName: MUFFIN, inStock: false }]);

    const page = await a.page();
    assert.equal(shownState(page.text, MUFFIN), 'Sold out');
    assert.match(page.text, /Blueberry Muffin is now sold out\./);
    assert.doesNotMatch((await a.page()).text, /is now sold out/, 'flash shown once');
    assert.match(server.output(), /\[admin\] stock: "Blueberry Muffin" set to sold out/);

    const refused = await botAdds(server, MUFFIN);
    assert.match(refused.result.error, /Blueberry Muffin is sold out right now\./);
    assert.match(refused.systemText, /## Currently Unavailable\nSold out right now, cannot be ordered: Blueberry Muffin/);

    assert.equal((await a.toggle(MUFFIN, true)).status, 303);
    assert.deepEqual(db.state(), { [MUFFIN]: true });
    assert.equal(shownState((await a.page()).text, MUFFIN), 'In stock');
    const restocked = await botAdds(server, MUFFIN);
    assert.equal(restocked.result.success, true);
    assert.doesNotMatch(restocked.systemText, /## Currently Unavailable\n/);

    const json = await request(server, 'POST', '/admin/api/stock', {
      json: { _csrf: (await a.page()).csrf, name: TURKEY, in_stock: false },
      cookie: a.cookie,
      origin: server.origin
    });
    assert.equal(json.status, 303, 'a JSON boolean works too');
    assert.equal(db.state()[TURKEY], false);
  } finally {
    await server.stop();
  }
});

test('a toggle survives a restart', async () => {
  const db = newFakeDb();
  const first = await startServer({ fakeDb: db });
  try {
    const a = await login(first);
    assert.equal((await a.toggle(LATTE, false)).status, 303);
  } finally {
    await first.stop();
  }
  const second = await startServer({ fakeDb: db });
  try {
    assert.match(second.output(), /\[stock\] boot: loaded 1 rows/);
    const a = await login(second);
    assert.equal(shownState((await a.page()).text, LATTE), 'Sold out');
    assert.match((await botAdds(second, LATTE)).result.error, /sold out/);
  } finally {
    await second.stop();
  }
});

test('Reload picks up a change made directly in the database', async () => {
  const db = newFakeDb();
  const server = await startServer({ fakeDb: db });
  try {
    const a = await login(server);
    db.set({ [LATTE]: false });
    assert.equal(shownState((await a.page()).text, LATTE), 'In stock', 'not seen until reloaded');
    const res = await a.reload();
    assert.equal(res.status, 303);
    const page = await a.page();
    assert.equal(shownState(page.text, LATTE), 'Sold out');
    assert.match(page.text, /Stock reloaded from the database\./);
  } finally {
    await server.stop();
  }
});

test('banner while stock is unavailable; Reload with the database back clears it', async () => {
  const db = newFakeDb({ [LATTE]: false });
  db.down();
  const server = await startServer({ fakeDb: db });
  try {
    const a = await login(server);
    let page = await a.page();
    assert.match(page.text, /Stock data could not be loaded from the database\./);
    assert.match(page.text, /Last loaded from the database: never/);
    assert.equal(shownState(page.text, LATTE), 'In stock', 'unknown means in stock');
    db.up();
    assert.equal((await a.reload()).status, 303);
    page = await a.page();
    assert.doesNotMatch(page.text, /could not be loaded/);
    assert.equal(shownState(page.text, LATTE), 'Sold out');
  } finally {
    await server.stop();
  }
});

test('a successful toggle while stock is unavailable also reloads everything from the database', async () => {
  const db = newFakeDb({ [LATTE]: false });
  db.down('permanent'); // no background retries, so only the toggle can bring the data in
  const server = await startServer({ fakeDb: db });
  try {
    assert.match(server.output(), /background retries are OFF/);
    const a = await login(server);
    assert.equal(shownState((await a.page()).text, LATTE), 'In stock');
    db.up();
    assert.equal((await a.toggle(MUFFIN, false)).status, 303);
    const page = await a.page();
    assert.doesNotMatch(page.text, /could not be loaded/, 'banner gone');
    assert.match(page.text, /Blueberry Muffin is now sold out\. Stock data was also reloaded from the database\./);
    assert.equal(shownState(page.text, MUFFIN), 'Sold out');
    assert.equal(shownState(page.text, LATTE), 'Sold out', 'the other row came in with the reload');
    assert.match((await botAdds(server, LATTE)).result.error, /sold out/);
  } finally {
    await server.stop();
  }
});

test('stock tracking off (no DATABASE_URL): banner, and a toggle is a 503', async () => {
  const db = newFakeDb();
  const server = await startServer({ fakeDb: db, env: { DATABASE_URL: '' } });
  try {
    const a = await login(server);
    assert.match((await a.page()).text, /Stock tracking is off \(DATABASE_URL is not set\)/);
    assert.equal((await a.toggle(MUFFIN, false)).status, 503);
  } finally {
    await server.stop();
  }
});

test('two quick toggles of one item: the last one pressed wins, in the database and in memory', async () => {
  const db = newFakeDb();
  // The first write is slow, the second fast: without one-at-a-time handling the first
  // request would finish last and undo the second.
  const server = await startServer({ fakeDb: db, env: { FAKE_DB_SET_DELAYS: '400,0' } });
  try {
    const a = await login(server);
    const { csrf } = await a.page();
    const post = (inStock) =>
      request(server, 'POST', '/admin/api/stock', {
        form: { _csrf: csrf, name: MUFFIN, in_stock: String(inStock) },
        cookie: a.cookie,
        origin: server.origin
      });
    const first = post(false);
    await sleep(50);
    const second = post(true);
    assert.deepEqual((await Promise.all([first, second])).map((r) => r.status), [303, 303]);
    assert.deepEqual(db.writes(), [
      { itemName: MUFFIN, inStock: false },
      { itemName: MUFFIN, inStock: true }
    ]);
    assert.equal(db.state()[MUFFIN], true);
    assert.equal(shownState((await a.page()).text, MUFFIN), 'In stock');
  } finally {
    await server.stop();
  }
});

test('headers and CSP: no script, no inline styles, names escaped, login still works with the stylesheet', async () => {
  const db = newFakeDb();
  const server = await startServer({ fakeDb: db });
  try {
    const loginPage = await request(server, 'GET', '/admin/login');
    assert.equal(loginPage.headers.get('content-security-policy'), EXPECTED_CSP);
    assert.match(loginPage.text, /<link rel="stylesheet" href="\/admin\/assets\/admin\.css">/);
    assert.doesNotMatch(loginPage.text, /<style|style=|<script/);

    const css = await request(server, 'GET', '/admin/assets/admin.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /^text\/css/);
    assert.equal(css.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.ok(!css.setCookies.some((c) => c.startsWith('admin.sid=')), 'the stylesheet needs no session');

    const a = await login(server);
    const home = await request(server, 'GET', '/admin', { cookie: a.cookie });
    assert.equal(home.status, 303);
    assert.equal(home.headers.get('location'), '/admin/stock');

    const page = await a.page();
    for (const [name, value] of Object.entries({
      'content-security-policy': EXPECTED_CSP,
      'x-robots-tag': 'noindex, nofollow',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'referrer-policy': 'same-origin'
    })) {
      assert.equal(page.headers.get(name), value, name);
    }
    assert.doesNotMatch(page.headers.get('content-security-policy'), /script-src|unsafe-inline/);
    assert.doesNotMatch(page.text, /<style|style=|<script|\son\w+=/);
    assert.match(page.text, /<span class="name">Turkey &amp; Swiss Sandwich<\/span>/);
    assert.match(page.text, /name="name" value="Turkey &amp; Swiss Sandwich"/);
    assert.doesNotMatch(page.text, /Turkey & Swiss/);
    for (const category of ['Coffee', 'Tea', 'Cold Drinks', 'Pastries', 'Sandwiches']) {
      assert.match(page.text, new RegExp(`<h2>${category}</h2>`));
    }
    assert.equal((page.text.match(/<li class="stock-item /g) || []).length, MENU_NAMES.length);
    assert.match(page.text, /<a href="\/admin\/stock" aria-current="page">Stock<\/a>/);
  } finally {
    await server.stop();
  }
});

// ------------------------------------------------------------------------------------
// Real database (Neon DEV branch only, opt-in)
// ------------------------------------------------------------------------------------

const DEV_DB = Boolean(process.env.DATABASE_URL) && process.env.STOCK_TEST_DEV_DB === 'yes';
const skipDevDb = DEV_DB ? false : 'needs DATABASE_URL (Neon dev branch) and STOCK_TEST_DEV_DB=yes';

test('dev database: a toggle is written to the database and survives a restart', { skip: skipDevDb }, async () => {
  const db = require('../db');
  const item = MUFFIN;
  const before = (await db.loadStock()).find((r) => r.item_name === item);
  const env = { DATABASE_URL: process.env.DATABASE_URL, FAKE_DB_FILE: '' };
  try {
    const first = await startServer({ env, preload: null });
    try {
      const a = await login(first);
      assert.equal((await a.toggle(item, false)).status, 303);
    } finally {
      await first.stop();
    }
    const row = (await db.loadStock()).find((r) => r.item_name === item);
    assert.deepEqual(row, { item_name: item, in_stock: false });
    const second = await startServer({ env, preload: null });
    try {
      const a = await login(second);
      assert.equal(shownState((await a.page()).text, item), 'Sold out');
      assert.ok(!second.output().includes(process.env.DATABASE_URL), 'connection string never logged');
    } finally {
      await second.stop();
    }
  } finally {
    if (before) await db.setStock(item, before.in_stock);
    else await db.deleteStock(item);
  }
  const after = (await db.loadStock()).find((r) => r.item_name === item);
  assert.deepEqual(after, before, 'the row is back the way it was');
});
