// D3 voice harness: the H5 voice checks rerun after D3, plus the D3 voice stock checks.
//
// Run with:  node --test test/d3-voice.test.js     (takes about two minutes)
//
// Zero spend. Every check runs a real `node server.js` child process with:
//   - a fake Anthropic API on 127.0.0.1, reached through ANTHROPIC_BASE_URL, so the real
//     SDK and the real tool loop run. The fake model follows commands in the caller's
//     speech: "TOOL <name> <json>" calls a tool, "HANG" never answers, "SLOW <ms> ..."
//     answers late. After a tool round it replies "ack: <tool results>".
//   - test/fixtures/voice-preload.js, which blocks every non-loopback request, makes
//     ElevenLabs unavailable (so replies fall back to Twilio <Say>), and stubs db.js so
//     stock state comes from FAKE_SOLD_OUT instead of a database.
//   - Twilio webhooks signed with Twilio's own signing function and a made-up auth token.
//   - a clean environment built from scratch, and a working directory with no .env, so a
//     developer's real keys are never loaded.
// Saved orders use fictional 555-01xx numbers and are deleted afterwards.
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
const twilio = require('twilio');

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(__dirname, 'fixtures', 'voice-preload.js');
const ORDERS_DIR = path.join(ROOT, 'data', 'in-progress-orders');
const fixture = require('./fixtures/d2-snapshot.json');

const AUTH_TOKEN = 'test-twilio-auth-token-not-real';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const decode = (xml) =>
  xml.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Same estimate server.js uses to decide whether speech arrived while a prompt was still
// playing. Waiting this long makes low-confidence speech count as garbled, not barge-in.
const promptMs = (text) => Math.max(900, Math.round((text.length / 13) * 1000)) + 150;
const GREETING = "Thanks for calling To Try It, you're speaking with our AI ordering assistant. What can I get started for you?";
const GARBLED_REPROMPT = "Sorry, I didn't quite catch that \u2014 go ahead.";
const SILENCE_REPROMPTS = ['Still there? Take your time.', "Just checking you're still with me \u2014 whenever you're ready."];

// ------------------------------------------------------------------------------------
// Fake Anthropic API
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

function respondTo(text) {
  const tool = text.match(/^TOOL (\w+)\s*(.*)$/s);
  if (tool) {
    const input = tool[2] ? JSON.parse(tool[2]) : {};
    const id = `toolu_${crypto.randomBytes(6).toString('hex')}`;
    return message([{ type: 'tool_use', id, name: tool[1], input }], 'tool_use');
  }
  return message([{ type: 'text', text: `OK: ${text}` }], 'end_turn');
}

before(async () => {
  fake.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', async () => {
      const body = JSON.parse(raw);
      const record = { body, aborted: false };
      fake.requests.push(record);
      req.on('close', () => {
        if (!res.writableEnded) record.aborted = true;
      });
      res.on('close', () => {
        if (!res.writableEnded) record.aborted = true;
      });

      const last = body.messages[body.messages.length - 1];
      const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
      const results = blocks.filter((b) => b.type === 'tool_result');
      let reply;
      if (results.length) {
        reply = message([{ type: 'text', text: `ack: ${results.map((r) => r.content).join(' | ')}` }], 'end_turn');
      } else {
        let text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
        if (text === 'HANG') return; // never answers
        const slow = text.match(/^SLOW (\d+) (.*)$/s);
        if (slow) {
          await sleep(Number(slow[1]));
          text = slow[2];
        }
        reply = respondTo(text);
      }
      if (!res.destroyed) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply));
      }
    });
  });
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  fake.port = fake.server.address().port;
});

after(() => {
  fake.server.closeAllConnections();
  fake.server.close();
  for (const file of fs.existsSync(ORDERS_DIR) ? fs.readdirSync(ORDERS_DIR) : []) {
    if (file.startsWith('+1555010')) fs.unlinkSync(path.join(ORDERS_DIR, file));
  }
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

// Starts server.js with a clean environment. soldOut sets the stub stock state.
async function startServer({ env = {}, soldOut = [], expectExit = false } = {}) {
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'd3-voice-'));
  const child = spawn(process.execPath, ['--require', PRELOAD, path.join(ROOT, 'server.js')], {
    cwd,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'development',
      PORT: String(port),
      ANTHROPIC_API_KEY: 'test-anthropic-key-not-real',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${fake.port}`,
      TWILIO_ACCOUNT_SID: 'ACtest-not-real',
      TWILIO_AUTH_TOKEN: AUTH_TOKEN,
      DATABASE_URL: 'postgres://stubbed-by-voice-preload',
      FAKE_SOLD_OUT: JSON.stringify(soldOut),
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
    const code = await exited;
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
    output: () => output,
    stop: () => {
      child.kill();
      children.delete(child);
    }
  };
}

// A phone call against one server: signs every webhook the way Twilio does.
class Call {
  constructor(server, from) {
    this.server = server;
    this.from = from;
    this.sid = `CA${crypto.randomBytes(16).toString('hex')}`;
  }

  async post(route, params = {}, { signature } = {}) {
    const url = `${this.server.base}${route}`;
    const body = { CallSid: this.sid, ...params };
    if (this.from !== undefined) body.From = this.from;
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };
    const sig = signature === undefined ? twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, body) : signature;
    if (sig !== null) headers['x-twilio-signature'] = sig;
    const res = await fetch(url, { method: 'POST', headers, body: new URLSearchParams(body) });
    return { status: res.status, text: decode(await res.text()) };
  }

  async incoming() {
    return (await this.post('/voice/incoming')).text;
  }

  // One caller utterance. Follows the filler redirect to /voice/continue like Twilio does.
  // Waits past the barge-in grace window first, unless told how long to wait.
  async say(speech, { confidence = 0.92, waitMs = 600 } = {}) {
    await sleep(waitMs);
    const params = speech === null ? {} : { SpeechResult: speech, Confidence: String(confidence) };
    const first = await this.post('/voice/process-speech', params);
    if (!first.text.includes('/voice/continue')) return first.text;
    return (await this.post('/voice/continue')).text;
  }

  async sayTimed(speech) {
    await sleep(600);
    const first = await this.post('/voice/process-speech', { SpeechResult: speech, Confidence: '0.92' });
    assert.match(first.text, /voice\/continue/);
    const startedAt = Date.now();
    const second = await this.post('/voice/continue');
    return { text: second.text, ms: Date.now() - startedAt };
  }
}

let numberSeq = 0;
const testNumber = () => `+1555010${String(1000 + numberSeq++).slice(-4)}`;
const orderFile = (from) => path.join(ORDERS_DIR, `${String(from).replace(/[^a-zA-Z0-9+]/g, '_')}.json`);

function writeSavedOrder(from, cart, order) {
  fs.mkdirSync(ORDERS_DIR, { recursive: true });
  fs.writeFileSync(orderFile(from), JSON.stringify({ from, callSid: 'CAold', cart, order, updatedAt: new Date().toISOString() }));
}

const toolResultsIn = (records) =>
  records.flatMap((r) => r.body.messages)
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b.type === 'tool_result')
    .map((b) => JSON.parse(b.content));
// The newest tool result the fake model was sent (each request carries the whole history).
const lastToolResult = () => toolResultsIn(fake.requests.slice(-1)).at(-1);

const ADD = (name, quantity = 1) => `TOOL add_to_cart ${JSON.stringify({ item_name: name, quantity })}`;

// ------------------------------------------------------------------------------------
// D3: stock on the voice path
// ------------------------------------------------------------------------------------

test('D3 voice refusal: a sold-out item is refused on a call, the call carries on', async () => {
  const server = await startServer({ soldOut: ['Blueberry Muffin'] });
  try {
    const from = testNumber();
    const call = new Call(server, from);
    assert.match(await call.incoming(), /AI ordering assistant/);

    const mark = fake.requests.length;
    const reply = await call.say(ADD('Blueberry Muffin'));
    assert.match(reply, /Blueberry Muffin is sold out right now\./);
    assert.match(reply, /<Gather/); // the call keeps going
    const result = lastToolResult();
    assert.deepEqual(result, {
      error: 'Blueberry Muffin is sold out right now.',
      alternatives: ['Butter Croissant', 'Chocolate Chip Cookie']
    });
    // The uncached block told the model, the cached one is the snapshot, untouched.
    const system = fake.requests[mark].body.system;
    assert.equal(sha256(system[0].text), fixture.stableVoiceSha256);
    assert.ok(system[0].cache_control);
    assert.match(system[1].text, /## Currently Unavailable\nSold out right now, cannot be ordered: Blueberry Muffin\./);
    // Nothing was added, so nothing was saved for callback.
    assert.ok(!fs.existsSync(orderFile(from)));

    // An in-stock alternative still goes in, and is saved for callback as before.
    const added = await call.say(ADD('Butter Croissant'));
    assert.match(added, /"success":true/);
    assert.ok(fs.existsSync(orderFile(from)));
  } finally {
    server.stop();
  }
});

test('D3 resumed call: a restored sold-out line is flagged, blocks confirm, and can be removed', async () => {
  const server = await startServer({ soldOut: ['Blueberry Muffin'] });
  try {
    const from = testNumber();
    writeSavedOrder(
      from,
      [
        { name: 'Blueberry Muffin', quantity: 1, size: null, customizations: [], price: 3.25 },
        { name: 'Drip Coffee', quantity: 1, size: 'Medium', customizations: [], price: 2.75 }
      ],
      { type: 'pickup', deliveryAddress: null, customerName: 'Sam', pickupTime: 'ASAP', confirmed: false, confirmedAt: null, orderId: null }
    );
    const call = new Call(server, from);
    assert.match(await call.incoming(), /Welcome back/);

    const mark = fake.requests.length;
    await call.say('TOOL view_cart');
    assert.match(fake.requests[mark].body.system[1].text, /Resumed call/);
    assert.deepEqual(lastToolResult().unavailableItems, ['Blueberry Muffin']);

    const refused = await call.say('TOOL confirm_order');
    assert.match(refused, /sold out right now: Blueberry Muffin/);
    assert.deepEqual(lastToolResult().soldOutItems, ['Blueberry Muffin']);
    // Still unconfirmed, still saved for callback, nothing removed.
    const saved = JSON.parse(fs.readFileSync(orderFile(from), 'utf8'));
    assert.equal(saved.cart.length, 2);
    assert.equal(saved.order.confirmed, false);

    assert.match(await call.say(`TOOL remove_from_cart ${JSON.stringify({ item_name: 'Blueberry Muffin' })}`), /"success":true/);
    const confirmed = await call.say('TOOL confirm_order');
    assert.match(confirmed, /"confirmed":true/);
    await sleep(100);
    assert.ok(!fs.existsSync(orderFile(from)), 'confirmed order clears the saved copy');

    const bye = await call.say('bye');
    assert.match(bye, /Thanks for calling To Try It, goodbye!/);
  } finally {
    server.stop();
  }
});

test('D3: with stock unknown (empty), voice ordering works exactly as before', async () => {
  const server = await startServer({ soldOut: [] });
  try {
    const call = new Call(server, testNumber());
    await call.incoming();
    const mark = fake.requests.length;
    assert.match(await call.say(ADD('Blueberry Muffin')), /"success":true/);
    assert.ok(!fake.requests[mark].body.system[1].text.includes('Currently Unavailable'));
  } finally {
    server.stop();
  }
});

// ------------------------------------------------------------------------------------
// H5 rerun
// ------------------------------------------------------------------------------------

test('H5 turn cap (3): the 4th utterance ends the call with no Claude request, order saved', async () => {
  const server = await startServer({ env: { MAX_CALL_TURNS: '3' } });
  try {
    const from = testNumber();
    const call = new Call(server, from);
    await call.incoming();
    await call.say(ADD('Caffe Latte'));
    await call.say('hello');
    await call.say('still here');
    const mark = fake.requests.length;
    const ended = await call.say('one more');
    assert.match(ended, /Your order is saved, so call back within 15 minutes/);
    assert.match(ended, /<Hangup\/>/);
    assert.equal(fake.requests.length, mark);
    assert.ok(fs.existsSync(orderFile(from)), 'order on disk before the hangup reply');

    const callback = new Call(server, from);
    assert.match(await callback.incoming(), /Welcome back/);
  } finally {
    server.stop();
  }
});

test('H5 duration cap (3 seconds): the next webhook ends the call before silence handling', async () => {
  const server = await startServer({ env: { MAX_CALL_MINUTES: '0.05' } });
  try {
    const call = new Call(server, testNumber());
    await call.incoming();
    const ended = await call.say(null, { waitMs: 3200 });
    assert.match(ended, /I have to end the call here/);
    assert.match(ended, /<Hangup\/>/);
  } finally {
    server.stop();
  }
});

test('H5 garbled cap (2): the 3rd garbled result in a row ends the call', async () => {
  const server = await startServer({ env: { MAX_GARBLED_IN_ROW: '2' } });
  try {
    const call = new Call(server, testNumber());
    await call.incoming();
    const mark = fake.requests.length;
    assert.match(await call.say('mumble', { confidence: 0.1, waitMs: promptMs(GREETING) }), /didn't quite catch that/);
    assert.match(await call.say('mumble', { confidence: 0.1, waitMs: promptMs(GARBLED_REPROMPT) }), /didn't quite catch that/);
    const ended = await call.say('mumble', { confidence: 0.1, waitMs: promptMs(GARBLED_REPROMPT) });
    assert.match(ended, /<Hangup\/>/);
    assert.equal(fake.requests.length, mark);
  } finally {
    server.stop();
  }
});

test('H5 continuous noise arriving mid-prompt still ends via the garbled cap', async () => {
  const server = await startServer({ env: { MAX_GARBLED_IN_ROW: '2' } });
  try {
    const call = new Call(server, testNumber());
    await call.incoming();
    let reply = '';
    let utterances = 0;
    while (!reply.includes('<Hangup/>') && utterances < 20) {
      reply = await call.say('static', { confidence: 0.1 });
      utterances += 1;
    }
    assert.match(reply, /<Hangup\/>/);
    assert.ok(utterances <= 12, `ended after ${utterances} noisy utterances`);
  } finally {
    server.stop();
  }
});

test('H5 default limits: exactly 30 turns, then the goodbye; 4 garbled in a row allowed', async () => {
  const server = await startServer({ env: { MAX_CALL_TURNS: 'abc', MAX_GARBLED_IN_ROW: '-1' } });
  try {
    const call = new Call(server, testNumber());
    await call.incoming();
    const mark = fake.requests.length;
    for (let i = 1; i <= 30; i += 1) {
      assert.match(await call.say(`turn ${i}`), new RegExp(`OK: turn ${i}`));
    }
    assert.equal(fake.requests.length - mark, 30);
    assert.match(await call.say('turn 31'), /<Hangup\/>/);

    const noisy = new Call(server, testNumber());
    await noisy.incoming();
    let wait = promptMs(GREETING);
    for (let i = 1; i <= 4; i += 1) {
      assert.match(await noisy.say('mumble', { confidence: 0.1, waitMs: wait }), /didn't quite catch that/);
      wait = promptMs(GARBLED_REPROMPT);
    }
    assert.match(await noisy.say('mumble', { confidence: 0.1, waitMs: wait }), /<Hangup\/>/);
  } finally {
    server.stop();
  }
});

test('H5 silence-counter fix: silence, garbled, silence, garbled, silence ends via the silence limit', async () => {
  const server = await startServer();
  try {
    const call = new Call(server, testNumber());
    await call.incoming();
    assert.match(await call.say(null), /Still there\?/);
    assert.match(await call.say('mumble', { confidence: 0.1, waitMs: promptMs(SILENCE_REPROMPTS[0]) }), /didn't quite catch/);
    assert.match(await call.say(null), /Just checking/);
    assert.match(await call.say('mumble', { confidence: 0.1, waitMs: promptMs(SILENCE_REPROMPTS[1]) }), /didn't quite catch/);
    const ended = await call.say(null);
    assert.match(ended, /I haven't heard back/);
  } finally {
    server.stop();
  }
});

test('H5 withheld numbers: no resume offered and nothing saved; a normal caller still is', async () => {
  const server = await startServer();
  try {
    for (const from of ['+266696687', '+7378742833', '+2562533', '+86282452253', 'anonymous', undefined]) {
      if (from) writeSavedOrder(from, [{ name: 'Espresso', quantity: 1, size: null, customizations: [], price: 3 }], { confirmed: false });
      const call = new Call(server, from);
      assert.doesNotMatch(await call.incoming(), /Welcome back/, String(from));
      if (from) fs.unlinkSync(orderFile(from));
      await call.say(ADD('Espresso'));
      if (from) assert.ok(!fs.existsSync(orderFile(from)), `nothing saved for ${from}`);
    }
    const normal = testNumber();
    const call = new Call(server, normal);
    await call.incoming();
    await call.say(ADD('Espresso'));
    assert.ok(fs.existsSync(orderFile(normal)));
  } finally {
    server.stop();
  }
});

test('H5 ElevenLabs hang: the reply falls back to <Say> in about 8 seconds and the call continues', async () => {
  const server = await startServer({
    env: { ELEVENLABS_API_KEY: 'test-elevenlabs-key-not-real', ELEVENLABS_VOICE_ID: 'test-voice', FAKE_TTS: 'hang-replies' }
  });
  try {
    const call = new Call(server, testNumber());
    await call.incoming();
    const { text, ms } = await call.sayTimed('hello');
    assert.match(text, /<Say>OK: hello<\/Say>/);
    assert.ok(ms >= 7500 && ms < 13500, `answered in ${ms}ms`);
    assert.match(await call.say('next'), /OK: next/);
  } finally {
    server.stop();
  }
});

test('H5 Claude hang: "having trouble" at about 10 seconds, request aborted, next turn works', async () => {
  const server = await startServer();
  try {
    const call = new Call(server, testNumber());
    await call.incoming();
    const mark = fake.requests.length;
    const { text, ms } = await call.sayTimed('HANG');
    assert.match(text, /having trouble right now/);
    assert.ok(ms >= 9000 && ms < 13500, `answered in ${ms}ms`);
    await sleep(200);
    assert.ok(fake.requests[mark].aborted, 'in-flight Anthropic request was aborted');
    assert.match(await call.say('hello again'), /OK: hello again/);
  } finally {
    server.stop();
  }
});

test('H5 worst case: Claude at 9.5 seconds plus an ElevenLabs hang still answers within 13.5 seconds', async () => {
  const server = await startServer({
    env: { ELEVENLABS_API_KEY: 'test-elevenlabs-key-not-real', ELEVENLABS_VOICE_ID: 'test-voice', FAKE_TTS: 'hang-replies' }
  });
  try {
    const call = new Call(server, testNumber());
    await call.incoming();
    const { text, ms } = await call.sayTimed('SLOW 9500 late reply');
    assert.match(text, /OK: late reply/);
    assert.ok(ms < 13500, `answered in ${ms}ms`);
  } finally {
    server.stop();
  }
});

test('H5 idle sweep: a session idle 29 minutes is kept, 31 minutes is removed', () => {
  const { voiceSessions, sweepIdleVoiceSessions } = require('../server.js');
  const now = Date.now();
  voiceSessions.set('CAkept', { lastActivityAt: now - 29 * 60 * 1000 });
  voiceSessions.set('CAswept', { lastActivityAt: now - 31 * 60 * 1000 });
  sweepIdleVoiceSessions(now);
  assert.ok(voiceSessions.has('CAkept'));
  assert.ok(!voiceSessions.has('CAswept'));
  voiceSessions.clear();
});

// ------------------------------------------------------------------------------------
// H1 to H4 regression
// ------------------------------------------------------------------------------------

test('Twilio signature validation: bad or missing signature gets 403 on every voice route', async () => {
  const server = await startServer();
  try {
    const call = new Call(server, testNumber());
    for (const route of ['/voice/incoming', '/voice/process-speech', '/voice/continue']) {
      assert.equal((await call.post(route, {}, { signature: 'not-a-real-signature' })).status, 403, route);
      assert.equal((await call.post(route, {}, { signature: null })).status, 403, route);
    }
    assert.equal((await call.post('/voice/incoming')).status, 200);
  } finally {
    server.stop();
  }
});

test('H1 and H4: /chat per-IP limit, signed audio 404 on tamper', async () => {
  const server = await startServer({ env: { RATE_LIMIT_MAX: '2' } });
  try {
    const chat = () =>
      fetch(`${server.base}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hi' }) });
    assert.equal((await chat()).status, 200);
    assert.equal((await chat()).status, 200);
    assert.equal((await chat()).status, 429);
    const audio = await fetch(`${server.base}/audio/dynamic/CAx-1-abcd.mp3?exp=${Date.now() + 60000}&sig=deadbeef`);
    assert.equal(audio.status, 404);
  } finally {
    server.stop();
  }
});

test('H2 and H3: production start-up guards and cookie flags are unchanged', async () => {
  const noSecret = await startServer({ env: { NODE_ENV: 'production' }, expectExit: true });
  assert.equal(noSecret.code, 1);
  assert.match(noSecret.output, /SESSION_SECRET must be set/);

  const secret = crypto.randomBytes(32).toString('hex');
  const hours = await startServer({ env: { NODE_ENV: 'production', SESSION_SECRET: secret, DISABLE_HOURS_CHECK: 'true' }, expectExit: true });
  assert.equal(hours.code, 1);
  assert.match(hours.output, /must not be set outside development/);

  const server = await startServer({ env: { NODE_ENV: 'production', SESSION_SECRET: secret } });
  try {
    const res = await fetch(`${server.base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ message: 'hi' })
    });
    const cookie = res.headers.get('set-cookie') || '';
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    assert.equal((await fetch(`${server.base}/dev/voice-chat`, { method: 'POST' })).status, 404);
  } finally {
    server.stop();
  }
});
