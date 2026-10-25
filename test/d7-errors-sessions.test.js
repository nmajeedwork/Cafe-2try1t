// D7 tests: the final error handler (M1), customer session expiry and the chat history cap
// (M2), and the /chat timeout (M3). See docs/inventory-plan.md.
//
// Run with:  node --test test/d7-errors-sessions.test.js     (about 70 seconds: one check
//            runs the real 30 second request timeout and 60 second turn deadline)
//
// Zero spend. Server checks run a real `node server.js` child process with a clean
// environment, a working directory with no .env, test/fixtures/voice-preload.js (outbound
// network is loopback only, the database is stubbed), and a fake Anthropic API on
// 127.0.0.1 reached through ANTHROPIC_BASE_URL, so the real SDK, its timeout and retry
// handling, and the real tool loop all run. The fake model follows the customer's text:
//   "TOOL <name> <json>"  calls that tool, then answers "ack: <tool results>"
//   "HANG"                never answers
//   "SLOWONCE <ms> ..."   the first request with this text answers after <ms>, later ones at once
//   "SLOWTOOLS <ms>"      every request answers after <ms> with another view_cart tool call
//   "FAIL400"             answers with an HTTP 400 API error
// Anything else gets "OK: <text>".
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

const { trimHistory, isPlainUserMessage, HISTORY_MAX_MESSAGES, HISTORY_TRIM_TARGET } = require('../chat-history');
const { createCustomerSession, CUSTOMER_SESSION_MAX_AGE_MS } = require('../customer-session');
const { hashPassword } = require('../admin');

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(__dirname, 'fixtures', 'voice-preload.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TIMEOUT_TEXT = 'CafeBot is taking too long to answer right now. Please try again in a moment.';
const ERROR_TEXT = 'Something went wrong talking to CafeBot. Please try again.';

// ------------------------------------------------------------------------------------
// History builders for the trimHistory unit tests
// ------------------------------------------------------------------------------------

let toolSeq = 0;
const userText = (text) => ({ role: 'user', content: text });
const replyText = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
function toolRound(count = 1) {
  const ids = Array.from({ length: count }, () => `toolu_${(toolSeq += 1)}`);
  return [
    { role: 'assistant', content: ids.map((id) => ({ type: 'tool_use', id, name: 'view_cart', input: {} })) },
    { role: 'user', content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: '{}' })) }
  ];
}
// One /chat turn: the customer's message, `rounds` tool rounds, then the reply.
const turn = (label, rounds = 0) => [userText(label), ...Array.from({ length: rounds }, () => toolRound()).flat(), replyText(`re ${label}`)];

// Every tool_result answers a tool_use in the assistant message right before it.
function assertPairsIntact(messages, label = '') {
  messages.forEach((message, i) => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return;
    for (const block of message.content.filter((b) => b.type === 'tool_result')) {
      const previous = messages[i - 1];
      assert.ok(previous && previous.role === 'assistant', `${label} tool_result at ${i} has no assistant message before it`);
      const ids = (Array.isArray(previous.content) ? previous.content : []).filter((b) => b.type === 'tool_use').map((b) => b.id);
      assert.ok(ids.includes(block.tool_use_id), `${label} tool_result ${block.tool_use_id} at ${i} lost its tool_use`);
    }
  });
}

// A small seeded generator, so the random histories are the same on every run.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// ------------------------------------------------------------------------------------
// M2: trimHistory
// ------------------------------------------------------------------------------------

test('trimHistory: at or under 60 messages the history is returned unchanged', () => {
  assert.equal(HISTORY_MAX_MESSAGES, 60);
  assert.equal(HISTORY_TRIM_TARGET, 40);
  for (const size of [0, 1, 30, 60]) {
    const history = Array.from({ length: size }, (_, i) => (i % 2 ? replyText(`r${i}`) : userText(`u${i}`)));
    assert.equal(trimHistory(history), history, `size ${size} is the same array`);
  }
  assert.equal(trimHistory(undefined), undefined);
});

test('trimHistory: over 60 it cuts to at most 40 messages at a turn start, newest turn kept', () => {
  // 31 plain turns of 2 messages = 62 messages.
  const history = Array.from({ length: 31 }, (_, i) => turn(`t${i}`)).flat();
  const trimmed = trimHistory(history);
  assert.equal(trimmed.length, 40);
  assert.ok(isPlainUserMessage(trimmed[0]));
  assert.deepEqual(trimmed[0], userText('t11'));
  assert.deepEqual(trimmed.at(-1), replyText('re t30'));
  assert.equal(history.length, 62, 'the input array is not changed');
});

test('trimHistory: a tool call and its result are never separated', () => {
  // Turns of 4, 6 and 2 messages so cut points fall in different places.
  const history = [];
  for (let i = 0; history.length <= 60; i += 1) history.push(...turn(`t${i}`, i % 3));
  const trimmed = trimHistory(history);
  assert.ok(trimmed.length <= 40);
  assert.ok(isPlainUserMessage(trimmed[0]));
  assertPairsIntact(trimmed);
  // The kept part is exactly the tail of the original.
  assert.deepEqual(trimmed, history.slice(history.length - trimmed.length));
});

test('trimHistory: 500 random histories keep whole turns, pairs, a plain first message and the newest turn', () => {
  const random = seeded(20261025);
  for (let n = 0; n < 500; n += 1) {
    const history = [];
    const turns = 1 + Math.floor(random() * 40);
    for (let t = 0; t < turns; t += 1) {
      // Up to 6 tool rounds (MAX_TOOL_ROUNDS), some with two tool calls at once.
      const rounds = Math.floor(random() * 7);
      history.push(userText(`n${n} t${t}`));
      for (let r = 0; r < rounds; r += 1) history.push(...toolRound(random() < 0.2 ? 2 : 1));
      // Some turns failed partway (a timeout) and have no final reply.
      if (random() < 0.9) history.push(replyText(`n${n} r${t}`));
    }
    const trimmed = trimHistory(history);
    const label = `history ${n} (${history.length} messages)`;
    if (history.length <= 60) {
      assert.equal(trimmed, history, label);
      continue;
    }
    const lastStart = history.map(isPlainUserMessage).lastIndexOf(true);
    const newestTurn = history.length - lastStart;
    assert.ok(trimmed.length <= Math.max(40, newestTurn), label);
    assert.ok(isPlainUserMessage(trimmed[0]), label);
    assert.deepEqual(trimmed, history.slice(history.length - trimmed.length), label);
    assert.ok(trimmed.length >= newestTurn, `${label}: newest turn kept`);
    assertPairsIntact(trimmed, label);
    // Shortest whole-turn tail that fits: one more turn back would not fit in 40.
    if (trimmed.length < history.length && trimmed.length <= 40) {
      const before = history.slice(0, history.length - trimmed.length);
      const previousStart = before.map(isPlainUserMessage).lastIndexOf(true);
      if (previousStart !== -1) assert.ok(history.length - previousStart > 40, `${label}: cut no earlier than needed`);
    }
  }
});

test('trimHistory: the fallback reply and a string reply count as part of their turn', () => {
  const history = [];
  for (let i = 0; i < 31; i += 1) history.push(userText(`t${i}`), { role: 'assistant', content: "Sorry, I'm having trouble" });
  const trimmed = trimHistory(history);
  assert.equal(trimmed.length, 40);
  assert.equal(trimmed[0].content, 't11');
  // A user message holding only text blocks is a plain message too; tool_result is not.
  assert.ok(isPlainUserMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }] }));
  assert.ok(!isPlainUserMessage({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '{}' }] }));
  assert.ok(!isPlainUserMessage({ role: 'assistant', content: 'hi' }));
});

// ------------------------------------------------------------------------------------
// M2: customer session expiry and pruning (in process, loopback only)
// ------------------------------------------------------------------------------------

async function sessionApp(options) {
  const customer = createCustomerSession({ isDev: true, secret: crypto.randomBytes(24).toString('hex'), ...options });
  const app = express();
  app.use(customer.middleware);
  app.post('/touch', (req, res) => {
    req.session.visits = (req.session.visits || 0) + 1;
    res.json({ visits: req.session.visits });
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    customer,
    base,
    post: (cookie) => fetch(`${base}/touch`, { method: 'POST', headers: cookie ? { cookie } : {} }),
    close: () => {
      customer.stop();
      server.close();
    }
  };
}
const sessionCount = (store) => new Promise((resolve) => store.length((err, n) => resolve(n)));
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

test('customer session: the cookie expires 2 hours ahead and keeps the H3 flags', async () => {
  assert.equal(CUSTOMER_SESSION_MAX_AGE_MS, 2 * 60 * 60 * 1000);
  const app = await sessionApp({});
  try {
    const startedAt = Date.now();
    const res = await app.post();
    const header = res.headers.get('set-cookie');
    assert.match(header, /^connect\.sid=/);
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Lax/);
    const expires = Date.parse(header.match(/Expires=([^;]+)/)[1]);
    const ahead = expires - startedAt;
    assert.ok(ahead > 2 * 60 * 60 * 1000 - 5000 && ahead <= 2 * 60 * 60 * 1000 + 1000, `expires ${ahead} ms ahead`);
  } finally {
    app.close();
  }
});

test('customer session: an expired session is pruned from the store, and the timer is unref\'d', async () => {
  const app = await sessionApp({ maxAgeMs: 300, pruneIntervalMs: 60 * 60 * 1000 });
  try {
    assert.equal(app.customer.timer.hasRef(), false, 'the prune timer never keeps the process alive');
    const first = await app.post();
    const cookie = cookieOf(first);
    assert.deepEqual(await first.json(), { visits: 1 });
    const second = await app.post(cookie);
    assert.deepEqual(await second.json(), { visits: 2 });
    assert.equal(await sessionCount(app.customer.store), 1);

    await sleep(450);
    app.customer.prune();
    assert.equal(await sessionCount(app.customer.store), 0, 'pruned after expiry');

    // The old cookie now starts a fresh, empty session.
    const third = await app.post(cookie);
    assert.deepEqual(await third.json(), { visits: 1 });
    assert.notEqual(cookieOf(third), cookie);
  } finally {
    app.close();
  }
});

test('customer session: the prune timer runs on its own', async () => {
  const app = await sessionApp({ maxAgeMs: 200, pruneIntervalMs: 100 });
  try {
    await app.post();
    assert.equal(await sessionCount(app.customer.store), 1);
    await sleep(600);
    assert.equal(await sessionCount(app.customer.store), 0);
  } finally {
    app.close();
  }
});

// ------------------------------------------------------------------------------------
// Fake Anthropic API
// ------------------------------------------------------------------------------------

const fake = { requests: [], server: null, port: null, slowOnceSeen: new Set() };

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
const toolUse = (name, input = {}) =>
  message([{ type: 'tool_use', id: `toolu_${crypto.randomBytes(6).toString('hex')}`, name, input }], 'tool_use');

before(async () => {
  fake.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', async () => {
      const body = JSON.parse(raw);
      const record = { body, at: Date.now() };
      fake.requests.push(record);
      const send = (status, payload) => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      const all = JSON.stringify(body.messages);
      const slowTools = all.match(/SLOWTOOLS (\d+)/);
      if (slowTools) {
        await sleep(Number(slowTools[1]));
        return send(200, toolUse('view_cart'));
      }

      const last = body.messages[body.messages.length - 1];
      const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
      const results = blocks.filter((b) => b.type === 'tool_result');
      if (results.length) {
        return send(200, message([{ type: 'text', text: `ack: ${results.map((r) => r.content).join(' | ')}` }], 'end_turn'));
      }
      let text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
      if (text === 'HANG') return undefined;
      if (text === 'FAIL400') {
        return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'fake bad request' } });
      }
      const slowOnce = text.match(/^SLOWONCE (\d+) (.*)$/s);
      if (slowOnce) {
        if (!fake.slowOnceSeen.has(text)) {
          fake.slowOnceSeen.add(text);
          await sleep(Number(slowOnce[1]));
        }
        text = slowOnce[2];
      }
      const tool = text.match(/^TOOL (\w+)\s*(.*)$/s);
      if (tool) return send(200, toolUse(tool[1], tool[2] ? JSON.parse(tool[2]) : {}));
      return send(200, message([{ type: 'text', text: `OK: ${text}` }], 'end_turn'));
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

let adminHash;
const ADMIN_SECRET = crypto.randomBytes(32).toString('hex');

// nodeEnv: 'development', 'production', or null for unset.
async function startServer({ nodeEnv = 'development', env = {} } = {}) {
  if (!adminHash) adminHash = await hashPassword('d7-test-password-not-real');
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'd7-srv-'));
  const childEnv = {
    PATH: process.env.PATH,
    PORT: String(port),
    ANTHROPIC_API_KEY: 'test-anthropic-key-not-real',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${fake.port}`,
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    ADMIN_PASSWORD_HASH: adminHash,
    ADMIN_SESSION_SECRET: ADMIN_SECRET,
    DATABASE_URL: 'postgres://stubbed-by-voice-preload',
    FAKE_SOLD_OUT: '[]',
    ...env
  };
  if (nodeEnv) childEnv.NODE_ENV = nodeEnv;
  const child = spawn(process.execPath, ['--require', PRELOAD, path.join(ROOT, 'server.js')], {
    cwd,
    env: childEnv,
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
  return {
    base: `http://127.0.0.1:${port}`,
    output: () => output,
    stop: () => {
      child.kill();
      children.delete(child);
    }
  };
}

// One browser: keeps the customer cookie between /chat requests.
class Browser {
  constructor(server) {
    this.server = server;
    this.cookie = null;
    this.setCookies = [];
  }

  async chat(text) {
    const headers = { 'content-type': 'application/json' };
    if (this.cookie) headers.cookie = this.cookie;
    const startedAt = Date.now();
    const res = await fetch(`${this.server.base}/chat`, { method: 'POST', headers, body: JSON.stringify({ message: text }) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      this.setCookies.push(setCookie);
      this.cookie = setCookie.split(';')[0];
    }
    return { status: res.status, body: await res.json(), ms: Date.now() - startedAt };
  }
}

// Raw requests, so a test controls the exact bytes and headers.
function rawRequest(base, { method = 'POST', path: urlPath, headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const req = http.request(url, { method, headers: { 'content-length': Buffer.byteLength(body), ...headers } }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Nothing in an error reply may point at the code: no stack frames, paths, error class names
// or echoes of what was sent.
function assertNoLeak(text, sent = '') {
  for (const needle of ['at ', '/home', 'node_modules', 'server.js', 'SyntaxError', 'Error:', 'stack', '.js:']) {
    assert.ok(!text.includes(needle), `reply must not contain ${JSON.stringify(needle)}: ${text.slice(0, 300)}`);
  }
  if (sent) assert.ok(!text.includes(sent), 'reply must not echo the request body');
}

// ------------------------------------------------------------------------------------
// M1: final error handler
// ------------------------------------------------------------------------------------

for (const nodeEnv of ['development', 'production', null]) {
  const label = nodeEnv || 'NODE_ENV unset';
  test(`M1 (${label}): rejected bodies get a fixed message with no stack or paths`, async () => {
    const server = await startServer({ nodeEnv });
    try {
      const bad = '{"message": "hi", oops';
      const json = await rawRequest(server.base, { path: '/chat', headers: { 'content-type': 'application/json' }, body: bad });
      assert.equal(json.status, 400);
      assert.match(json.headers['content-type'], /application\/json/);
      assert.equal(json.headers['x-content-type-options'], 'nosniff');
      assert.deepEqual(JSON.parse(json.body), { error: 'Bad request.' });
      assertNoLeak(json.body, 'oops');

      const big = JSON.stringify({ message: 'x'.repeat(200 * 1024) });
      const tooLarge = await rawRequest(server.base, { path: '/chat', headers: { 'content-type': 'application/json' }, body: big });
      assert.equal(tooLarge.status, 413);
      assert.deepEqual(JSON.parse(tooLarge.body), { error: 'Request too large.' });

      const charset = await rawRequest(server.base, {
        path: '/chat',
        headers: { 'content-type': 'application/json; charset=klingon' },
        body: '{"message":"hi"}'
      });
      assert.equal(charset.status, 415);
      assert.deepEqual(JSON.parse(charset.body), { error: 'Unsupported request.' });

      // A form post to admin with too many fields is rejected by the shared form parser
      // before the admin router runs; the reply is plain text, never cached.
      const fields = Array.from({ length: 1001 }, (_, i) => `f${i}=secret${i}`).join('&');
      const admin = await rawRequest(server.base, {
        path: '/admin/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: fields
      });
      assert.equal(admin.status, 413);
      assert.match(admin.headers['content-type'], /text\/plain/);
      assert.equal(admin.headers['cache-control'], 'no-store');
      assert.equal(admin.body, 'Request too large.');
      assertNoLeak(admin.body, 'secret1');

      // One log line per error, with no body and no stack.
      const out = server.output();
      assert.match(out, /\[error\] 400 POST \/chat: entity\.parse\.failed/);
      assert.match(out, /\[error\] 413 POST \/chat: entity\.too\.large/);
      assert.match(out, /\[error\] 415 POST \/chat: charset\.unsupported/);
      assert.match(out, /\[error\] 413 POST \/admin\/login: parameters\.too\.many/);
      assert.ok(!out.includes('oops') && !out.includes('secret1'), 'request bodies are not logged');
      assert.ok(!/\n\s+at /.test(out), 'no stack trace in the log');

      // Admin still answers normally afterwards, with its own headers.
      const login = await fetch(`${server.base}/admin/login`);
      assert.equal(login.status, 200);
      assert.match(login.headers.get('content-security-policy'), /default-src 'none'/);
      // So does /chat.
      const ok = await new Browser(server).chat('hello');
      assert.equal(ok.status, 200);
      assert.equal(ok.body.reply, 'OK: hello');
    } finally {
      server.stop();
    }
  });
}

// ------------------------------------------------------------------------------------
// M2: the history cap on a real /chat conversation
// ------------------------------------------------------------------------------------

test('M2: a long chat stays capped in whole turns, and the order started early still works', async () => {
  // 28 chat turns in a few seconds: raise the H1 per-IP limit (20 a minute) for this server.
  const server = await startServer({ env: { DISABLE_HOURS_CHECK: 'true', RATE_LIMIT_MAX: '200', RATE_LIMIT_GLOBAL_MAX: '200' } });
  try {
    const browser = new Browser(server);
    const add = await browser.chat(`TOOL add_to_cart ${JSON.stringify({ item_name: 'Caffe Latte', quantity: 2 })}`);
    assert.equal(add.status, 200);
    const mark = fake.requests.length;

    // A view_cart turn stores 4 messages (the text, the tool_use, the tool_result, the
    // reply) and a plain turn 2. With every fourth turn plain, a trim that ignored turn
    // boundaries would cut between a tool_use and its tool_result (checked by mutation).
    for (let i = 0; i < 32; i += 1) {
      const res = await browser.chat(i % 4 === 3 ? `hello ${i}` : 'TOOL view_cart');
      assert.equal(res.status, 200, `turn ${i}`);
    }
    const sent = fake.requests.slice(mark).map((r) => r.body.messages);
    const lengths = sent.map((m) => m.length);
    // Stored history is at most 60 between turns, so a request carries at most 60 plus
    // this turn's user message, tool_use and tool_result.
    assert.ok(Math.max(...lengths) <= 63, `longest request ${Math.max(...lengths)}`);
    assert.ok(lengths.some((n, i) => i > 0 && n < lengths[i - 1] - 4), 'a trim happened');
    for (const messages of sent) {
      assert.equal(messages[0].role, 'user');
      assert.equal(typeof messages[0].content === 'string' || !messages[0].content.some((b) => b.type === 'tool_result'), true);
      assertPairsIntact(messages, 'request');
    }
    // After the trim the first add_to_cart turn is gone from what the model sees...
    assert.ok(!JSON.stringify(sent.at(-1)).includes('add_to_cart'));

    // ...but the cart and order are untouched, and the order goes through.
    const view = await browser.chat('TOOL view_cart');
    assert.deepEqual(view.body.cart.items.map((line) => [line.name, line.quantity]), [['Caffe Latte', 2]]);
    const pickup = await browser.chat(`TOOL set_order_type ${JSON.stringify({ order_type: 'pickup', customer_name: 'Sam', pickup_time: 'ASAP' })}`);
    assert.equal(pickup.status, 200);
    const confirmed = await browser.chat('TOOL confirm_order');
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.order.confirmed, true);
    assert.match(confirmed.body.order.orderId, /^2TRY1T-/);

    // The /chat cookie carries the 2 hour expiry.
    const expires = Date.parse(browser.setCookies.at(-1).match(/Expires=([^;]+)/)[1]);
    assert.ok(Math.abs(expires - Date.now() - 2 * 60 * 60 * 1000) < 60 * 1000);
  } finally {
    server.stop();
  }
});

// ------------------------------------------------------------------------------------
// M3: /chat timeout
// ------------------------------------------------------------------------------------

test('M3 real values: a model that never answers gets the 503 after about 60 seconds, 2 attempts', async () => {
  const server = await startServer();
  try {
    const mark = fake.requests.length;
    const res = await new Browser(server).chat('HANG');
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { error: TIMEOUT_TEXT });
    // 30 s, then one retry: the 60 s turn deadline ends the second attempt.
    assert.ok(res.ms >= 59000 && res.ms < 66000, `took ${res.ms} ms`);
    assert.equal(fake.requests.length - mark, 2, 'first attempt plus exactly one retry');
    assert.ok(fake.requests[mark + 1].at - fake.requests[mark].at >= 29500, 'the retry came after the 30 s timeout');
  } finally {
    server.stop();
  }
});

test('M3 short values: request timeout, retry that succeeds, turn deadline across tool rounds, other errors', async () => {
  // Development only test values: 300 ms per request, 5 s per turn.
  const server = await startServer({ env: { CHAT_TEST_REQUEST_TIMEOUT_MS: '300', CHAT_TEST_TURN_DEADLINE_MS: '5000' } });
  try {
    // A request that never answers times out twice (the retry) and gives the 503.
    let mark = fake.requests.length;
    const hang = await new Browser(server).chat('HANG');
    assert.equal(hang.status, 503);
    assert.deepEqual(hang.body, { error: TIMEOUT_TEXT });
    assert.equal(fake.requests.length - mark, 2);
    assert.ok(hang.ms < 4000, `the request timeout ended it, not the deadline (${hang.ms} ms)`);
    assert.match(server.output(), /Anthropic API timeout \(chat\): request timeout reached\./);

    // A first attempt that is too slow is retried once, and the retry's answer is used.
    mark = fake.requests.length;
    const retried = await new Browser(server).chat('SLOWONCE 800 hello');
    assert.equal(retried.status, 200);
    assert.equal(retried.body.reply, 'OK: hello');
    assert.equal(fake.requests.length - mark, 2);

    // Any other API error keeps the old message, and a 400 is not retried.
    mark = fake.requests.length;
    const failed = await new Browser(server).chat('FAIL400');
    assert.equal(failed.status, 500);
    assert.deepEqual(failed.body, { error: ERROR_TEXT });
    assert.equal(fake.requests.length - mark, 1);
  } finally {
    server.stop();
  }

  // The turn deadline covers all tool rounds together: every round answers within the
  // per request timeout, but the turn as a whole runs out.
  const slow = await startServer({ env: { CHAT_TEST_REQUEST_TIMEOUT_MS: '3000', CHAT_TEST_TURN_DEADLINE_MS: '1000' } });
  try {
    const mark = fake.requests.length;
    const res = await new Browser(slow).chat('SLOWTOOLS 300');
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { error: TIMEOUT_TEXT });
    assert.ok(res.ms >= 950 && res.ms < 2500, `took ${res.ms} ms`);
    assert.ok(fake.requests.length - mark >= 3, 'several tool rounds ran before the deadline');
    assert.match(slow.output(), /Anthropic API timeout \(chat\): turn deadline reached\./);
  } finally {
    slow.stop();
  }
});

test('M3: the CHAT_TEST_* values are ignored outside development', async () => {
  const server = await startServer({
    nodeEnv: 'production',
    env: { CHAT_TEST_REQUEST_TIMEOUT_MS: '1', CHAT_TEST_TURN_DEADLINE_MS: '1' }
  });
  try {
    // With the test values honoured, this would be a 503 after a few milliseconds.
    const res = await new Browser(server).chat('SLOWONCE 300 production');
    assert.equal(res.status, 200);
    assert.equal(res.body.reply, 'OK: production');
  } finally {
    server.stop();
  }
});
