// D2 tests: database module, in-memory stock state, boot behavior (see docs/inventory-plan.md).
//
// Run with:  node --test test/stock.test.js
//
// Most of this runs with no database at all (injected loaders, local fake TCP servers, and
// real `node server.js` child processes). The "dev branch" group at the bottom talks to the
// database in DATABASE_URL and skips itself if that is not set. POINT IT AT THE NEON DEV
// BRANCH ONLY: it creates the stock table if missing and inserts, then deletes, rows with
// made-up names. It never touches a real menu item's row.
//
// Every server child runs with a dummy Anthropic key and makes no outbound calls, so none
// of this spends anything. Failure messages mask the connection string's user, password and
// host, so even a failing leak check cannot print them.
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

require('dotenv').config();

const ROOT = path.join(__dirname, '..');
const fixture = require('./fixtures/d2-snapshot.json');
const menu = JSON.parse(fs.readFileSync(path.join(ROOT, 'menu.json'), 'utf8'));
const MENU_NAMES = menu.map((item) => item.name);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// ------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------

// The real connection string's sensitive parts, if one is configured. Used only to MASK
// output and to assert nothing leaked. Never printed.
function realSecrets() {
  const url = process.env.DATABASE_URL;
  if (!url) return [];
  const secrets = [url];
  try {
    const parsed = new URL(url);
    for (const part of [parsed.username, parsed.password, parsed.hostname]) {
      if (part) secrets.push(part, decodeURIComponent(part));
    }
  } catch {
    // unparseable, the whole string is still masked
  }
  return secrets.sort((a, b) => b.length - a.length);
}

function mask(text) {
  let out = String(text);
  for (const secret of realSecrets()) out = out.split(secret).join('***');
  return out;
}

function assertNoLeak(output, secrets, what) {
  for (const secret of secrets) {
    // The message deliberately does not include the secret.
    assert.ok(!output.includes(secret), `${what}: a connection string value appeared in the output`);
  }
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Starts the real server (`node server.js`) as a child process and waits until it says it
// is listening. env overrides go on top of a safe base. DATABASE_URL must always be passed
// explicitly by the caller so a developer's own .env value can never leak into a test.
async function startServer(env) {
  assert.ok('DATABASE_URL' in env, 'startServer needs an explicit DATABASE_URL');
  const port = await freePort();
  const startedAt = Date.now();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      ANTHROPIC_API_KEY: 'unused-test-key',
      ...env,
      PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));

  while (!/listening on/.test(output)) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}:\n${mask(output)}`);
    }
    if (Date.now() - startedAt > 30000) {
      child.kill();
      throw new Error(`server did not start within 30s:\n${mask(output)}`);
    }
    await sleep(50);
  }
  return {
    port,
    listenedAfterMs: Date.now() - startedAt,
    output: () => output,
    stop: () => child.kill()
  };
}

// A throwaway TCP server standing in for a database. onConnection(socket) decides what it
// does with each connection.
async function fakeDbServer(onConnection) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    onConnection(socket);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    }
  };
}

// Runs a one-liner against db.js in a fresh process, so db.js reads the env given here
// instead of whatever this test process has cached.
function runDbScript(code, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', code], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', () => resolve(output));
  });
}

// A console-shaped logger that records everything.
function recorder() {
  const lines = [];
  const add = (level) => (message) => lines.push(`${level} ${message}`);
  return { log: add('LOG'), warn: add('WARN'), error: add('ERROR'), lines, text: () => lines.join('\n') };
}

const { afterEach } = require('node:test');
const stock = require('../stock');
afterEach(() => stock.stopStock());

// A permanent-failure error shaped like the ones db.js produces.
function permanentError() {
  return Object.assign(new Error('password authentication failed for user "[redacted]"'), {
    code: '28P01',
    permanent: true
  });
}
function transientError(message = 'connection refused') {
  return Object.assign(new Error(message), { code: 'ECONNREFUSED', permanent: false });
}

// ------------------------------------------------------------------------------------
// Unchanged behavior: /api/menu and the stable prompt blocks
// ------------------------------------------------------------------------------------

test('/api/menu response bytes match the snapshot taken before D2', async () => {
  const server = await startServer({ DATABASE_URL: '' });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/menu`);
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(res.status, fixture.apiMenu.status);
    assert.equal(res.headers.get('content-type'), fixture.apiMenu.contentType);
    assert.equal(body.length, fixture.apiMenu.bytes);
    assert.equal(sha256(body), fixture.apiMenu.sha256);
  } finally {
    server.stop();
  }
});

test('stable system blocks (chat and voice) are byte-identical to the pre-D2 snapshot', () => {
  const { STABLE_SYSTEM_TEXT, STABLE_SYSTEM_TEXT_VOICE } = require('../server.js');
  // LF-normalised so the hash is the same on a Windows checkout (CRLF) and on Render (LF).
  const lf = (text) => text.replace(/\r\n/g, '\n');
  assert.equal(sha256(lf(STABLE_SYSTEM_TEXT)), fixture.stableChatSha256);
  assert.equal(sha256(lf(STABLE_SYSTEM_TEXT_VOICE)), fixture.stableVoiceSha256);
});

test('pg is imported by db.js and by no other source file', () => {
  const skipDirs = new Set(['node_modules', '.git', '.claude', 'test', 'public', 'data']);
  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith('.js') && /require\(\s*['"]pg['"]\s*\)/.test(fs.readFileSync(path.join(dir, entry.name), 'utf8'))) {
        offenders.push(path.relative(ROOT, path.join(dir, entry.name)));
      }
    }
  })(ROOT);
  assert.deepEqual(offenders, ['db.js']);
});

// ------------------------------------------------------------------------------------
// stock.js: the in-memory state and the boot sequence (injected loaders, no database)
// ------------------------------------------------------------------------------------

const FAST = { bootTimeoutMs: 200, attemptTimeoutMs: 200, reloadDelayMs: 60000, retryBaseMs: 20, retryMaxMs: 80 };

test('a name missing from the Map counts as in stock, and out-of-stock rows count as out', async () => {
  const log = recorder();
  await stock.initStock({
    menuNames: MENU_NAMES,
    loadFn: async () => [{ item_name: 'Cold Brew', in_stock: false }, { item_name: 'Espresso', in_stock: true }],
    log,
    timing: FAST
  });
  assert.equal(stock.isInStock('Cold Brew'), false);
  assert.equal(stock.isInStock('Espresso'), true);
  assert.equal(stock.isInStock('Cappuccino'), true); // on the menu, no row
  assert.equal(stock.isInStock('Not On The Menu'), true); // not on the menu at all
  assert.match(log.text(), /boot: loaded 2 rows in \d+ms \(1 out of stock: Cold Brew\)/);
});

test('orphan rows (not in menu.json) are reported and ignored', async () => {
  const log = recorder();
  await stock.initStock({
    menuNames: MENU_NAMES,
    loadFn: async () => [{ item_name: 'Retired Special', in_stock: false }, { item_name: 'Drip Coffee', in_stock: false }],
    log,
    timing: FAST
  });
  assert.match(log.text(), /orphan row, not in menu\.json: "Retired Special"/);
  assert.doesNotMatch(log.text(), /orphan row.*Drip Coffee/);
  assert.equal(stock.isInStock('Retired Special'), true); // ignored, not stored as out of stock
  assert.equal(stock.isInStock('Drip Coffee'), false);
});

test('boot timeout: a database that never answers does not block boot, everything stays in stock', async () => {
  const log = recorder();
  await stock.initStock({ menuNames: MENU_NAMES, loadFn: async () => [], log, timing: FAST }); // reset the Map
  let lateResolve;
  const started = Date.now();
  const result = await stock.initStock({
    menuNames: MENU_NAMES,
    // Never answers in time. Only the FIRST attempt's resolver is kept: later retries get
    // their own promises, and this test is about the abandoned boot attempt.
    loadFn: () => new Promise((resolve) => { if (!lateResolve) lateResolve = resolve; }),
    log,
    timing: { ...FAST, bootTimeoutMs: 100 }
  });
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.ok(elapsed >= 90 && elapsed < 1000, `boot returned after ${elapsed}ms, expected about 100ms`);
  assert.match(log.text(), /boot load FAILED after \d+ms: \[STOCK_LOAD_TIMEOUT\] stock load did not finish within 100ms/);
  assert.match(log.text(), /starting WITHOUT stock data: every item is being treated as in stock/);
  assert.match(log.text(), /retrying in/);
  assert.equal(stock.isInStock('Cold Brew'), true);
  // A late answer from the abandoned attempt is ignored.
  lateResolve([{ item_name: 'Cold Brew', in_stock: false }]);
  await sleep(20);
  assert.equal(stock.isInStock('Cold Brew'), true);
});

test('failed boot retries in the background and stops retrying once a load succeeds', async () => {
  const log = recorder();
  let calls = 0;
  const result = await stock.initStock({
    menuNames: MENU_NAMES,
    loadFn: async () => {
      calls += 1;
      if (calls < 3) throw transientError();
      return [{ item_name: 'Chai Latte', in_stock: false }];
    },
    log,
    timing: FAST
  });
  assert.equal(result.ok, false);
  assert.equal(stock.isInStock('Chai Latte'), true); // not loaded yet
  await sleep(400);
  assert.equal(calls, 3); // boot, retry 1 (failed), retry 2 (worked)
  assert.equal(stock.isInStock('Chai Latte'), false);
  assert.match(log.text(), /retry 2: loaded 1 rows/);
  await sleep(300);
  assert.equal(calls, 3, 'kept retrying after a success');
});

test('retry delays double and are capped', async () => {
  const log = recorder();
  const callTimes = [];
  await stock.initStock({
    menuNames: MENU_NAMES,
    loadFn: async () => {
      callTimes.push(Date.now());
      throw transientError();
    },
    log,
    timing: { ...FAST, retryBaseMs: 40, retryMaxMs: 160 }
  });
  await sleep(900);
  stock.stopStock();
  const gaps = callTimes.slice(1).map((time, i) => time - callTimes[i]);
  assert.ok(gaps.length >= 5, `only ${gaps.length} gaps recorded`);
  assert.ok(gaps[0] < gaps[2], `delays should grow: ${gaps.join(', ')}`); // 40 then 80 then 160
  const capped = gaps.slice(2);
  assert.ok(Math.max(...capped) < 160 * 2.5, `a delay exceeded the cap: ${gaps.join(', ')}`);
  assert.ok(Math.min(...capped) >= 120, `capped delays should sit near 160ms: ${gaps.join(', ')}`);
});

test('a permanent error (bad credentials) is logged once and never retried', async () => {
  const log = recorder();
  let calls = 0;
  const result = await stock.initStock({
    menuNames: MENU_NAMES,
    loadFn: async () => {
      calls += 1;
      throw permanentError();
    },
    log,
    timing: { ...FAST, reloadDelayMs: 50 }
  });
  await sleep(300);
  assert.equal(result.ok, false);
  assert.equal(calls, 1, 'retried or reloaded after a permanent error');
  assert.match(log.text(), /background retries are OFF/);
});

test('follow-up reload picks up a change made during the deploy overlap window', async () => {
  const log = recorder();
  let calls = 0;
  await stock.initStock({
    menuNames: MENU_NAMES,
    loadFn: async () => {
      calls += 1;
      return calls === 1 ? [] : [{ item_name: 'Butter Croissant', in_stock: false }];
    },
    log,
    timing: { ...FAST, reloadDelayMs: 60 }
  });
  assert.equal(stock.isInStock('Butter Croissant'), true);
  await sleep(250);
  assert.equal(calls, 2, 'expected exactly one extra reload');
  assert.equal(stock.isInStock('Butter Croissant'), false);
  assert.match(log.text(), /follow-up reload: loaded 1 rows/);
});

test('a failed follow-up reload keeps the last known state', async () => {
  const log = recorder();
  let calls = 0;
  await stock.initStock({
    menuNames: MENU_NAMES,
    loadFn: async () => {
      calls += 1;
      if (calls === 1) return [{ item_name: 'Cold Brew', in_stock: false }];
      throw transientError();
    },
    log,
    timing: { ...FAST, reloadDelayMs: 50 }
  });
  await sleep(250);
  assert.equal(calls, 2);
  assert.equal(stock.isInStock('Cold Brew'), false);
  assert.match(log.text(), /follow-up reload FAILED/);
  assert.match(log.text(), /keeping the last known stock state/);
});

test('the follow-up reload is skipped while boot retries are still running', async () => {
  const log = recorder();
  let calls = 0;
  await stock.initStock({
    menuNames: MENU_NAMES,
    loadFn: async () => {
      calls += 1;
      throw transientError();
    },
    log,
    timing: { ...FAST, reloadDelayMs: 30, retryBaseMs: 500, retryMaxMs: 500 }
  });
  await sleep(150);
  assert.equal(calls, 1);
  assert.match(log.text(), /follow-up reload skipped: boot retries are still running/);
});

test('stopStock also orphans loads already in flight: no zombie retries, no blocked reloads', async () => {
  // Regression: a retry attempt still hanging when stopStock() ran used to finish later,
  // set retryActive, and reschedule itself, which made the NEXT boot's follow-up reload
  // skip itself ("retries still running") for no reason.
  let oldCalls = 0;
  await stock.initStock({
    menuNames: MENU_NAMES,
    loadFn: () => {
      oldCalls += 1;
      return new Promise(() => {}); // hangs forever
    },
    log: recorder(),
    timing: { ...FAST, bootTimeoutMs: 30, attemptTimeoutMs: 150, retryBaseMs: 10, retryMaxMs: 10 }
  });
  await sleep(60); // boot timed out at 30ms, retry 1 started at about 40ms and is now hanging
  assert.equal(oldCalls, 2);
  stock.stopStock();

  let newCalls = 0;
  const log = recorder();
  await stock.initStock({
    menuNames: MENU_NAMES,
    loadFn: async () => {
      newCalls += 1;
      return newCalls === 1 ? [] : [{ item_name: 'Cold Brew', in_stock: false }];
    },
    log,
    timing: { ...FAST, reloadDelayMs: 250 }
  });
  await sleep(400); // the old hanging attempt times out at about 190ms, before the reload at about 340ms
  assert.equal(oldCalls, 2, 'the cancelled boot sequence kept retrying');
  assert.equal(newCalls, 2, 'the new boot sequence reload never ran');
  assert.equal(stock.isInStock('Cold Brew'), false);
  assert.doesNotMatch(log.text(), /skipped/);
});

// ------------------------------------------------------------------------------------
// db.js: secrets and SSL (no real database needed)
// ------------------------------------------------------------------------------------

const db = require('../db');

test('db.redact strips the whole URL, user, password and host from a message', () => {
  const url = 'postgresql://alice:s3cr%40t@db.example.com:5432/shop?sslmode=require';
  const message =
    'password authentication failed for user "alice" (password s3cr@t / s3cr%40t) at db.example.com, ' +
    `url was ${url}`;
  const cleaned = db.__test.redact(message, url);
  for (const secret of ['alice', 's3cr@t', 's3cr%40t', 'db.example.com', url]) {
    assert.ok(!cleaned.includes(secret), 'a secret survived redaction');
  }
  assert.match(cleaned, /\[redacted\]/);
  assert.match(cleaned, /password authentication failed/); // the useful text is kept
});

test('db.redact handles IPv6 hosts and strings that are not valid URLs', () => {
  const v6 = 'postgresql://bob:pw12345@[::1]:5432/db';
  assert.ok(!db.__test.redact('connect ECONNREFUSED ::1:5432', v6).includes('::1'));
  const junk = 'not a url but hunter2 is inside';
  assert.ok(!db.__test.redact(`oops: ${junk}`, junk).includes('hunter2'));
});

test('db.withoutSslParams drops sslmode and friends and keeps everything else', () => {
  const w = db.__test.withoutSslParams;
  assert.equal(w('postgresql://u:p@h/db?sslmode=require'), 'postgresql://u:p@h/db');
  assert.equal(w('postgresql://u:p@h/db?sslmode=disable&channel_binding=require'), 'postgresql://u:p@h/db?channel_binding=require');
  assert.equal(w('postgresql://u:p@h/db?channel_binding=require&SSLMODE=require&application_name=x'), 'postgresql://u:p@h/db?channel_binding=require&application_name=x');
  assert.equal(w('postgresql://u:p@h/db'), 'postgresql://u:p@h/db');
  assert.equal(w('postgresql://u:p@h/db?uselibpqcompat=true&sslmode=require'), 'postgresql://u:p@h/db');
});

test('setStock rejects bad arguments before touching the database', async () => {
  await assert.rejects(() => db.setStock('', true), TypeError);
  await assert.rejects(() => db.setStock('Espresso', 'no'), TypeError);
  await assert.rejects(() => db.setStock(42, false), TypeError);
});

test('DATABASE_URL unset: db.js reports a clear permanent error and does not crash', async () => {
  const output = await runDbScript(
    "require('./db').loadStock().catch((e) => console.log(`${e.name} ${e.code} permanent=${e.permanent} ${e.message}`))",
    { DATABASE_URL: '' }
  );
  assert.match(output, /DbError NO_DATABASE_URL permanent=true DATABASE_URL is not set/);
});

test('SSL is forced even when the URL says sslmode=disable, and the error leaks nothing', async () => {
  let firstBytes = null;
  const fake = await fakeDbServer((socket) => {
    socket.once('data', (data) => {
      firstBytes = data;
      socket.write('N'); // "I do not support SSL"
    });
  });
  try {
    const url = `postgresql://secretuser:secretpass@127.0.0.1:${fake.port}/db?sslmode=disable`;
    const output = await runDbScript(
      "require('./db').loadStock().catch((e) => console.log(`${e.code} ${e.message}`))",
      { DATABASE_URL: url }
    );
    assert.ok(firstBytes, 'the fake database never received a connection');
    // An SSLRequest packet: length 8, then the magic request code 80877103.
    assert.equal(firstBytes.length, 8);
    assert.equal(firstBytes.readInt32BE(0), 8);
    assert.equal(firstBytes.readInt32BE(4), 80877103);
    assertNoLeak(output, ['secretuser', 'secretpass', url], 'db error output');
  } finally {
    fake.close();
  }
});

// ------------------------------------------------------------------------------------
// Boot: the real server must start and log in every failure mode
// ------------------------------------------------------------------------------------

test('boot with DATABASE_URL unset: starts, warns clearly, tracking is off', async () => {
  const server = await startServer({ DATABASE_URL: '' });
  try {
    assert.match(server.output(), /\[stock\] DATABASE_URL is not set: stock tracking is OFF and every item counts as in stock/);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/menu`);
    assert.equal(res.status, 200);
  } finally {
    server.stop();
  }
});

test('boot with an unreachable database (connection refused): starts, logs, retries, leaks nothing', async () => {
  const closedPort = await freePort();
  const url = `postgresql://secretuser:secretpass@127.0.0.1:${closedPort}/db`;
  const server = await startServer({ DATABASE_URL: url });
  try {
    const out = server.output();
    assert.match(out, /\[stock\] boot load FAILED after \d+ms: \[ECONNREFUSED\]/);
    assert.match(out, /starting WITHOUT stock data: every item is being treated as in stock/);
    assert.match(out, /retrying in 5s/);
    assertNoLeak(out, ['secretuser', 'secretpass', url, '127.0.0.1'], 'server log');
    const res = await fetch(`http://127.0.0.1:${server.port}/api/menu`);
    assert.equal(res.status, 200);
  } finally {
    server.stop();
  }
});

test('boot with a database that accepts connections and never answers: 3s limit, starts anyway', async (t) => {
  const fake = await fakeDbServer(() => {}); // accept, then say nothing
  try {
    const url = `postgresql://secretuser:secretpass@127.0.0.1:${fake.port}/db`;
    const server = await startServer({ DATABASE_URL: url });
    try {
      const out = server.output();
      t.diagnostic(`server was listening ${server.listenedAfterMs}ms after spawn (includes about 1s of Node and module startup)`);
      assert.match(out, /\[stock\] boot load FAILED after (\d+)ms: .*(timeout|did not finish)/i);
      const ms = Number(/boot load FAILED after (\d+)ms/.exec(out)[1]);
      assert.ok(ms >= 2500 && ms < 5000, `boot load was cut off after ${ms}ms, expected about 3000ms`);
      assert.match(out, /starting WITHOUT stock data/);
      assertNoLeak(out, ['secretuser', 'secretpass', url], 'server log');
      const res = await fetch(`http://127.0.0.1:${server.port}/api/menu`);
      assert.equal(res.status, 200);
    } finally {
      server.stop();
    }
  } finally {
    fake.close();
  }
});

// ------------------------------------------------------------------------------------
// Dev branch (needs DATABASE_URL pointing at the Neon DEV branch; skipped otherwise)
// ------------------------------------------------------------------------------------

const HAS_DB = Boolean(process.env.DATABASE_URL);
const skipNoDb = HAS_DB ? false : 'DATABASE_URL is not set';
const fakeName = () => `__d2_test_${crypto.randomBytes(4).toString('hex')}__`;

test('dev branch: setStock then loadStock round trip, upsert, and deleteStock', { skip: skipNoDb }, async () => {
  const name = fakeName();
  try {
    await db.setStock(name, false);
    let row = (await db.loadStock()).find((r) => r.item_name === name);
    assert.deepEqual(row, { item_name: name, in_stock: false });

    await db.setStock(name, true); // second call is an update, not a duplicate-key error
    row = (await db.loadStock()).find((r) => r.item_name === name);
    assert.deepEqual(row, { item_name: name, in_stock: true });
    assert.equal((await db.loadStock()).filter((r) => r.item_name === name).length, 1);
  } finally {
    assert.equal(await db.deleteStock(name), 1);
  }
  assert.equal((await db.loadStock()).some((r) => r.item_name === name), false);
});

test('dev branch: boot loads stock, reports orphans, and the orphan is cleaned up after', { skip: skipNoDb }, async (t) => {
  const orphan = fakeName();
  await db.setStock(orphan, false);
  try {
    const server = await startServer({ DATABASE_URL: process.env.DATABASE_URL });
    try {
      const out = server.output();
      const loaded = /\[stock\] boot: loaded (\d+) rows in (\d+)ms/.exec(out);
      assert.ok(loaded, `no boot load line in the log:\n${mask(out)}`);
      t.diagnostic(`boot load took ${loaded[2]}ms (${loaded[1]} rows)`);
      assert.ok(out.includes(`orphan row, not in menu.json: "${orphan}"`), 'orphan was not reported');
      assertNoLeak(out, realSecrets(), 'server log');
      const res = await fetch(`http://127.0.0.1:${server.port}/api/menu`);
      assert.equal(res.status, 200);
    } finally {
      server.stop();
    }
  } finally {
    assert.equal(await db.deleteStock(orphan), 1);
  }
  assert.equal((await db.loadStock()).some((r) => r.item_name === orphan), false);
});

test('dev branch: boot with the wrong password starts, logs a redacted error, and stops retrying', { skip: skipNoDb }, async () => {
  const url = new URL(process.env.DATABASE_URL);
  url.password = `wrong-${crypto.randomBytes(6).toString('hex')}`;
  const server = await startServer({ DATABASE_URL: url.toString() });
  try {
    const out = server.output();
    assert.match(out, /\[stock\] boot load FAILED after \d+ms: \[28P01\] password authentication failed/);
    assert.match(out, /starting WITHOUT stock data/);
    assert.match(out, /background retries are OFF/);
    assert.doesNotMatch(out, /retrying in/);
    assertNoLeak(out, [...realSecrets(), url.password, url.toString()], 'server log');
    const res = await fetch(`http://127.0.0.1:${server.port}/api/menu`);
    assert.equal(res.status, 200);
  } finally {
    server.stop();
  }
});
