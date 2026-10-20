// D6 public sold-out display tests: GET /api/availability, public/availability.js, and how
// the Menu page (public/menu.js) and Home's featured cards (the inline script of
// public/index.html) use it.
//
// Run with:  node --test test/d6-availability.test.js
//
// Zero spend. Endpoint tests run a real `node server.js` child process with a clean
// environment, a working directory with no .env, and test/fixtures/stock-db-preload.js
// (network blocked, db.js replaced by a fake database in a temp JSON file that logs every
// call). Page tests run the REAL page code on a small fake DOM (test/fixtures/fake-dom.js,
// page-runner.js) and compare with trees captured from the pre-D6 pages
// (test/fixtures/d6-golden-dom.json). A fake DOM is not a browser: real rendering, layout,
// colours and focus are only proven in a real browser.
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

const avail = require('../public/availability.js');
const admin = require('../admin');
const { runPage, golden } = require('./fixtures/page-runner');
const fixture = require('./fixtures/d2-snapshot.json');

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(__dirname, 'fixtures', 'stock-db-preload.js');
const PUBLIC = path.join(ROOT, 'public');
const menuNames = require('../menu.json').map((item) => item.name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const copy = (value) => JSON.parse(JSON.stringify(value));

const MUFFIN = 'Blueberry Muffin';
const TURKEY = 'Turkey & Swiss Sandwich';
const ESPRESSO = 'Espresso';
const FEATURED = ['Iced Matcha Latte', 'Blueberry Muffin', 'Avocado Toast'];

// ------------------------------------------------------------------------------------
// public/availability.js
// ------------------------------------------------------------------------------------

test('parseUnavailable accepts exactly { unavailable: [strings] } and nothing else', () => {
  assert.deepEqual(avail.parseUnavailable({ unavailable: [] }), []);
  const input = { unavailable: [MUFFIN, TURKEY] };
  const out = avail.parseUnavailable(input);
  assert.deepEqual(out, [MUFFIN, TURKEY]);
  assert.notEqual(out, input.unavailable, 'a copy, not the same array');

  const inherited = Object.create({ unavailable: [MUFFIN] });
  const protoKey = JSON.parse('{"__proto__": {"unavailable": ["Blueberry Muffin"]}}');
  const bad = [
    undefined,
    null,
    42,
    'Blueberry Muffin',
    true,
    [],
    [MUFFIN],
    {},
    { unavailable: null },
    { unavailable: MUFFIN },
    { unavailable: { 0: MUFFIN, length: 1 } },
    { unavailable: [MUFFIN, 1] },
    { unavailable: [MUFFIN, null] },
    { unavailable: [[MUFFIN]] },
    { unavailable: [{ name: MUFFIN }] },
    { unavailable: new Array(201).fill(MUFFIN) },
    { other: [MUFFIN] },
    inherited,
    protoKey
  ];
  for (const body of bad) assert.deepEqual(avail.parseUnavailable(body), [], JSON.stringify(body));
});

const okResponse = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });

test('fetchUnavailable returns the names for a good answer and asks for /api/availability', async () => {
  const calls = [];
  const names = await avail.fetchUnavailable((url, init) => {
    calls.push({ url, hasSignal: Boolean(init && init.signal) });
    return okResponse({ unavailable: [MUFFIN] });
  });
  assert.deepEqual(names, [MUFFIN]);
  assert.deepEqual(calls, [{ url: '/api/availability', hasSignal: true }]);
});

test('fetchUnavailable gives [] and never rejects or throws on any failure', async () => {
  const failures = {
    'network error': () => Promise.reject(new TypeError('Failed to fetch')),
    'http 500': () => Promise.resolve({ ok: false, status: 500, json: async () => ({ unavailable: [MUFFIN] }) }),
    'http 404': () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }),
    'invalid json': () => Promise.resolve({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }),
    'json is not an object': () => okResponse('<html>'),
    'wrong shape': () => okResponse({ unavailable: 'Blueberry Muffin' }),
    'mixed types': () => okResponse({ unavailable: [MUFFIN, 7] }),
    'undefined response': () => Promise.resolve(undefined),
    'throws at once': () => { throw new Error('boom'); },
    'returns a non promise': () => 'not a promise'
  };
  for (const [label, fetchFn] of Object.entries(failures)) {
    assert.deepEqual(await avail.fetchUnavailable(fetchFn), [], label);
  }
});

test('fetchUnavailable gives up after the timeout, aborting the request', async () => {
  let aborted = false;
  const names = await avail.fetchUnavailable((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      aborted = true;
      reject(new Error('aborted'));
    });
  }), 30);
  assert.deepEqual(names, []);
  assert.equal(aborted, true);
});

test('applySoldOut matches exact names only, once each, and returns how many it marked', () => {
  const rows = new Map(menuNames.map((name) => [name, { name }]));
  const marked = [];
  const count = avail.applySoldOut(
    rows,
    [MUFFIN, MUFFIN, 'blueberry muffin', ` ${ESPRESSO}`, `${ESPRESSO} `, '__proto__', 'constructor', 'toString', 'hasOwnProperty', '', TURKEY, 'Not on the menu', 7, null],
    (row, name) => marked.push([row.name, name])
  );
  assert.equal(count, 2);
  assert.deepEqual(marked, [[MUFFIN, MUFFIN], [TURKEY, TURKEY]]);
});

// ------------------------------------------------------------------------------------
// The pages, with the real page code on a fake DOM
// ------------------------------------------------------------------------------------

const PAGES = [
  { page: 'menu', golden: () => golden.menuDom },
  { page: 'home', golden: () => golden.homeDom }
];

const findAll = (node, predicate, found = []) => {
  if (typeof node === 'string') return found;
  if (predicate(node)) found.push(node);
  for (const child of node.children || []) findAll(child, predicate, found);
  return found;
};
const text = (node) => (typeof node === 'string' ? node : (node.children || []).map(text).join(''));
const isLabel = (node) => node.props && (node.props.className === 'sold-out-label' || node.props.className === 'sold-out-badge');

// The tree without anything the sold-out display added.
function withoutSoldOut(node) {
  if (typeof node === 'string') return node;
  const out = { ...node };
  if (out.attrs) {
    const { 'data-sold-out': dropped, ...rest } = out.attrs;
    if (Object.keys(rest).length) out.attrs = rest;
    else delete out.attrs;
  }
  if (out.children) {
    const kids = [];
    for (const child of out.children) {
      if (typeof child !== 'string' && isLabel(child)) {
        if (kids[kids.length - 1] === ' ') kids.pop();
        continue;
      }
      kids.push(withoutSoldOut(child));
    }
    out.children = kids;
  }
  return out;
}

test('the stored trees are the pre-D6 pages: 16 menu rows, 3 featured cards, no labels', () => {
  assert.equal(findAll(golden.menuDom, (n) => n.props && n.props.className === 'menu-item').length, golden.menu.length);
  assert.equal(findAll(golden.homeDom, (n) => n.props && n.props.className === 'featured__card').length, 3);
  assert.equal(findAll(golden.menuDom, isLabel).length + findAll(golden.homeDom, isLabel).length, 0);
  assert.deepEqual(golden.menu, require('../menu.json'), 'the stored menu is still menu.json');
});

for (const { page, golden: expected } of PAGES) {
  test(`${page}: whenever there is nothing to show, the page equals the pre-D6 page exactly`, async () => {
    const same = async (label, options) => {
      const run = await runPage(page, options);
      assert.equal(JSON.stringify(run.tree), JSON.stringify(expected()), label);
      return run;
    };
    await same('nothing sold out', { availability: { mode: 'ok', names: [] } });
    await same('http 500', { availability: { mode: 'http', status: 500 } });
    await same('http 404', { availability: { mode: 'http', status: 404 } });
    await same('network error', { availability: { mode: 'network' } });
    await same('invalid json', { availability: { mode: 'badjson' } });
    await same('helper script missing', { helper: false });
    for (const [label, body] of Object.entries({
      null: null,
      array: [],
      string: 'x',
      'no key': {},
      'not an array': { unavailable: 'Blueberry Muffin' },
      'non strings': { unavailable: [1, 2] },
      mixed: { unavailable: [MUFFIN, 3] },
      'only unknown names': { unavailable: ['Not on the menu'] }
    })) {
      await same(`shape: ${label}`, { availability: { mode: 'body', body } });
    }
    const hung = await same('request still pending', { availability: { mode: 'hang' } });
    hung.fireTimers();
    await hung.settle();
    assert.equal(JSON.stringify(hung.tree), JSON.stringify(expected()), 'after the timeout');
    const pending = await same('answer not here yet', { availability: { mode: 'deferred' } });
    assert.equal(pending.availabilityRequests(), 1);
  });

  test(`${page}: names that are not exact matches change nothing`, async () => {
    const run = await runPage(page, {
      availability: {
        mode: 'ok',
        names: ['blueberry muffin', ' Blueberry Muffin', 'Blueberry Muffin ', 'BLUEBERRY MUFFIN', 'Blueberry  Muffin', '__proto__', 'constructor', 'toString', '<img src=x onerror=alert(1)>', '']
      }
    });
    assert.equal(JSON.stringify(run.tree), JSON.stringify(golden[page === 'menu' ? 'menuDom' : 'homeDom']));
  });

  test(`${page}: asks for /api/availability once, and not at all without the helper`, async () => {
    assert.equal((await runPage(page)).availabilityRequests(), 1);
    assert.equal((await runPage(page, { helper: false })).availabilityRequests(), 0);
  });

  test(`${page}: an error while marking items never changes the page`, async () => {
    const run = await runPage(page, { availability: { mode: 'deferred' } });
    run.window.CafeAvailability.applySoldOut = () => {
      throw new Error('boom');
    };
    run.resolveAvailability([MUFFIN]);
    await run.settle();
    assert.equal(JSON.stringify(run.tree), JSON.stringify(golden[page === 'menu' ? 'menuDom' : 'homeDom']));
  });
}

test('menu: sold-out rows get exactly one "Sold out" label each, and nothing else changes', async () => {
  const names = [MUFFIN, TURKEY, ESPRESSO];
  const run = await runPage('menu', { availability: { mode: 'ok', names } });
  const labels = findAll(run.tree, isLabel);
  assert.equal(labels.length, 3);
  for (const label of labels) {
    assert.equal(label.props.className, 'sold-out-label');
    assert.equal(text(label), 'Sold out');
  }
  const rows = findAll(run.tree, (n) => n.props && n.props.className === 'menu-item');
  const soldRows = rows.filter((row) => row.attrs && row.attrs['data-sold-out'] === 'true');
  assert.equal(soldRows.length, 3);
  for (const row of rows) {
    const nameEl = findAll(row, (n) => n.props && n.props.className === 'menu-item-name')[0];
    const itemName = nameEl.children[0];
    const sold = names.includes(itemName);
    assert.equal(Boolean(row.attrs && row.attrs['data-sold-out']), sold, itemName);
    const own = findAll(nameEl, isLabel);
    assert.equal(own.length, sold ? 1 : 0, itemName);
    if (sold) {
      // name text, then a plain space (keeps the words apart for screen readers), then the label
      assert.equal(nameEl.children[1], ' ');
      assert.equal(nameEl.children[2], own[0]);
      assert.equal(text(nameEl), `${itemName} Sold out`);
    }
  }
  assert.equal(JSON.stringify(withoutSoldOut(run.tree)), JSON.stringify(golden.menuDom));
  // a repeated answer would not double up
  assert.equal(findAll(run.tree, isLabel).length, 3);
});

test('home: a sold-out featured card gets a badge inside the link, still links, and nothing else changes', async () => {
  const run = await runPage('home', { availability: { mode: 'ok', names: [MUFFIN, TURKEY] } });
  const cards = findAll(run.tree, (n) => n.props && n.props.className === 'featured__card');
  assert.equal(cards.length, 3);
  const goldenCards = findAll(golden.homeDom, (n) => n.props && n.props.className === 'featured__card');
  cards.forEach((card, i) => {
    assert.equal(card.tag, 'a', 'the card is still the link');
    assert.equal(card.props.href, goldenCards[i].props.href, 'href unchanged');
  });
  const muffin = cards.find((c) => c.props.href === '/menu#item-blueberry-muffin');
  assert.equal(muffin.attrs['data-sold-out'], 'true');
  // photo, heading, badge, description: read as part of the card, right after the name
  assert.deepEqual(muffin.children.map((c) => (c.props && c.props.className) || c.tag), ['featured__photo', 'featured__name', 'sold-out-badge', 'featured__desc']);
  assert.equal(text(muffin.children[2]), 'Sold out');
  assert.equal(findAll(run.tree, isLabel).length, 1, 'Turkey is not a featured item, so no second badge');
  assert.equal(JSON.stringify(withoutSoldOut(run.tree)), JSON.stringify(golden.homeDom));

  const all = await runPage('home', { availability: { mode: 'ok', names: FEATURED } });
  assert.equal(findAll(all.tree, isLabel).length, 3);
  assert.equal(JSON.stringify(withoutSoldOut(all.tree)), JSON.stringify(golden.homeDom));
});

test('hash links: every featured link points at a Menu row, sold out or not', async () => {
  const menu = await runPage('menu', { availability: { mode: 'ok', names: FEATURED } });
  const rowIds = new Set(findAll(menu.tree, (n) => n.props && n.props.className === 'menu-item').map((n) => n.props.id));
  const home = await runPage('home', { availability: { mode: 'ok', names: FEATURED } });
  const hrefs = findAll(home.tree, (n) => n.props && n.props.className === 'featured__card').map((n) => n.props.href);
  assert.equal(hrefs.length, 3);
  for (const href of hrefs) {
    assert.match(href, /^\/menu#item-[a-z0-9-]+$/);
    assert.ok(rowIds.has(href.slice('/menu#'.length)), `${href} has a row on the Menu page`);
  }
});

test('menu: a hash jump is repeated after labels land, but not if the visitor has scrolled', async () => {
  const jumps = (run) => run.doc.log.filter((entry) => entry.scrollIntoView === 'item-blueberry-muffin').length;

  const untouched = await runPage('menu', { hash: '#item-blueberry-muffin', availability: { mode: 'ok', names: [MUFFIN] } });
  assert.equal(jumps(untouched), 2, 'jump after rendering, and again after the label');

  const nothing = await runPage('menu', { hash: '#item-blueberry-muffin', availability: { mode: 'ok', names: [] } });
  assert.equal(jumps(nothing), 1, 'no labels, no second jump');

  const scrolled = await runPage('menu', { hash: '#item-blueberry-muffin', availability: { mode: 'deferred' } });
  assert.equal(jumps(scrolled), 1);
  scrolled.window.scrollY = 250; // the visitor scrolled while the answer was on its way
  scrolled.resolveAvailability([MUFFIN]);
  await scrolled.settle();
  assert.equal(jumps(scrolled), 1, 'left where the visitor put it');
  assert.equal(findAll(scrolled.tree, isLabel).length, 1, 'but the label is there');

  const noHash = await runPage('menu', { availability: { mode: 'ok', names: [MUFFIN] } });
  assert.equal(noHash.doc.log.filter((e) => 'scrollIntoView' in e).length, 0, 'no hash, no jumps');
});

test('names are only ever text: a hostile item name is never put into markup', async () => {
  const hostile = '<img src=x onerror=alert(1)> & "q" </div><script>alert(2)</script>';
  const menu = copy(golden.menu);
  menu[0].name = hostile;
  const run = await runPage('menu', { menu, availability: { mode: 'ok', names: [hostile] } });
  const nameEl = findAll(run.tree, (n) => n.props && n.props.className === 'menu-item-name')[0];
  assert.equal(nameEl.children[0], hostile, 'stored as plain text');
  assert.equal(findAll(nameEl, isLabel).length, 1, 'and it is labelled (exact match)');
  assert.equal(JSON.stringify(run.tree).includes('"html"'), false, 'no element was given markup');
  assert.deepEqual(run.doc.log.filter((entry) => 'innerHTML' in entry), [], 'innerHTML was never used with the page content');
});

test('the page code never builds markup from item names', () => {
  const sources = {
    'menu.js': fs.readFileSync(path.join(PUBLIC, 'menu.js'), 'utf8'),
    'index.html': fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
  };
  for (const [file, source] of Object.entries(sources)) {
    for (const match of source.matchAll(/innerHTML\s*=\s*([^;]*);/g)) {
      const withoutLiterals = match[1].replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '').replace(/[\s+]/g, '');
      assert.equal(withoutLiterals, '', `${file}: innerHTML is only ever set to a fixed string: ${match[0]}`);
    }
  }
  const helper = fs.readFileSync(path.join(PUBLIC, 'availability.js'), 'utf8');
  assert.doesNotMatch(helper, /innerHTML|document\.|eval\(|new Function/, 'availability.js touches no markup and no DOM');
});

test('both pages load availability.js before the code that uses it', () => {
  const menuHtml = fs.readFileSync(path.join(PUBLIC, 'menu.html'), 'utf8');
  assert.ok(menuHtml.indexOf('src="availability.js"') > -1);
  assert.ok(menuHtml.indexOf('src="availability.js"') < menuHtml.indexOf('src="menu.js"'));
  const home = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.ok(home.indexOf('src="availability.js"') > -1);
  assert.ok(home.indexOf('src="availability.js"') < home.indexOf("getElementById('featured-grid')"));
});

// ------------------------------------------------------------------------------------
// Readability: the label colours, computed from the CSS and the design tokens
// ------------------------------------------------------------------------------------

function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('the sold-out label and badge are readable (at least 7:1) and have a border (not colour alone)', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'site.css'), 'utf8');
  const tokens = fs.readFileSync(path.join(PUBLIC, 'tokens.css'), 'utf8');
  const token = (name) => tokens.match(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`))[1];
  const resolve = (value) => {
    const v = value.trim();
    const m = v.match(/^var\((--[a-z0-9-]+)\)$/);
    return m ? token(m[1]) : v;
  };
  for (const selector of ['.page--menu .sold-out-label', '.home .sold-out-badge']) {
    const rule = css.match(new RegExp(`${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`))[1];
    const prop = (name) => (rule.match(new RegExp(`(?:^|[;\\s])${name}:\\s*([^;]+);`)) || [])[1];
    const ratio = contrast(resolve(prop('color')), resolve(prop('background')));
    assert.ok(ratio >= 7, `${selector} contrast ${ratio.toFixed(2)}`);
    assert.match(prop('border'), /^1px solid /, `${selector} has a border`);
  }
});

// ------------------------------------------------------------------------------------
// GET /api/availability on a real server
// ------------------------------------------------------------------------------------

const TEST_PASSWORD = 'test-only-admin-password-not-real';
const TEST_SECRET = 'test-only-admin-session-secret-0123456789abcdef';
let TEST_HASH;
before(async () => {
  TEST_HASH = await admin.hashPassword(TEST_PASSWORD);
});

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

function newFakeDb(initial = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd6-db-'));
  const file = path.join(dir, 'stock.json');
  fs.writeFileSync(file, JSON.stringify(initial));
  return {
    file,
    calls: () => (fs.existsSync(`${file}.calls`) ? fs.readFileSync(`${file}.calls`, 'utf8').trim().split('\n').filter(Boolean).length : 0),
    down: (kind = 'transient') => fs.writeFileSync(`${file}.down`, kind)
  };
}

async function startServer({ fakeDb, env = {} } = {}) {
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'd6-srv-'));
  const child = spawn(process.execPath, ['--require', PRELOAD, path.join(ROOT, 'server.js')], {
    cwd,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'development',
      PORT: String(port),
      ANTHROPIC_API_KEY: 'test-anthropic-key-not-real',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
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
  return {
    base: `http://127.0.0.1:${port}`,
    output: () => output,
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill();
        children.delete(child);
      })
  };
}

const availability = (server, init) => fetch(`${server.base}/api/availability`, init);

// A plain GET without fetch(): fetch() adds "Cache-Control: no-cache" to any request that
// carries If-None-Match, which a browser's own revalidation does not.
function rawGet(server, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get(`${server.base}${urlPath}`, { headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      })
      .on('error', reject);
  });
}
const menuOrder = (names) => menuNames.filter((n) => names.includes(n));

// A logged-in admin, only to toggle stock through the real D5 route.
async function adminToggle(server, name, inStock) {
  const login = await fetch(`${server.base}/admin/login`);
  const html = await login.text();
  const token = html.match(/name="_csrf" value="([^"]+)"/)[1];
  const pre = login.headers.getSetCookie().find((c) => c.startsWith('admin.pre=')).split(';')[0];
  const done = await fetch(`${server.base}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.base, cookie: pre, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: token, password: TEST_PASSWORD }).toString()
  });
  assert.equal(done.status, 303);
  const cookie = done.headers.getSetCookie().find((c) => c.startsWith('admin.sid=')).split(';')[0];
  const page = await (await fetch(`${server.base}/admin/stock`, { headers: { cookie } })).text();
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const res = await fetch(`${server.base}/admin/api/stock`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.base, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, name, in_stock: String(inStock) }).toString()
  });
  assert.equal(res.status, 303);
}

test('endpoint: only item names from menu.json, in menu order, whatever order they were marked', async () => {
  // marked in reverse menu order, plus a row for an item that is not on the menu
  const db = newFakeDb({ [TURKEY]: false, [MUFFIN]: false, [ESPRESSO]: false, 'Caffe Latte': true, 'Retired Item': false });
  const server = await startServer({ fakeDb: db });
  try {
    const res = await availability(server);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^application\/json/);
    const body = await res.json();
    assert.deepEqual(Object.keys(body), ['unavailable'], 'nothing but the list');
    assert.deepEqual(body.unavailable, menuOrder([ESPRESSO, MUFFIN, TURKEY]));
    assert.deepEqual(body.unavailable, [ESPRESSO, MUFFIN, TURKEY].sort((a, b) => menuNames.indexOf(a) - menuNames.indexOf(b)));
    for (const name of body.unavailable) assert.ok(menuNames.includes(name));
    assert.ok(!JSON.stringify(body).includes('Retired Item'));
  } finally {
    await server.stop();
  }
});

test('endpoint: an empty list when nothing is sold out, when tracking is off, and when the database never loaded', async () => {
  const cases = [
    ['nothing sold out', { fakeDb: newFakeDb({ [MUFFIN]: true }) }],
    ['no DATABASE_URL (tracking off)', { fakeDb: newFakeDb({ [MUFFIN]: false }), env: { DATABASE_URL: '' } }],
    ['database down at boot (transient)', (() => { const db = newFakeDb({ [MUFFIN]: false }); db.down(); return { fakeDb: db }; })()],
    ['database down at boot (permanent)', (() => { const db = newFakeDb({ [MUFFIN]: false }); db.down('permanent'); return { fakeDb: db }; })()]
  ];
  for (const [label, options] of cases) {
    const server = await startServer(options);
    try {
      const res = await availability(server);
      assert.equal(res.status, 200, label);
      assert.deepEqual(await res.json(), { unavailable: [] }, label);
    } finally {
      await server.stop();
    }
  }
});

test('endpoint: no database call, however often it is asked', async () => {
  const db = newFakeDb({ [MUFFIN]: false });
  const server = await startServer({ fakeDb: db });
  try {
    const before = db.calls();
    assert.ok(before >= 1, 'the boot load happened');
    for (let i = 0; i < 30; i += 1) assert.equal((await availability(server)).status, 200);
    assert.equal((await availability(server, { method: 'HEAD' })).status, 200);
    await sleep(100);
    assert.equal(db.calls(), before, 'not one more call to the database');
  } finally {
    await server.stop();
  }
});

test('endpoint: a toggle in the admin page shows on the next request, and restocking clears it', async () => {
  const db = newFakeDb();
  const server = await startServer({ fakeDb: db });
  try {
    assert.deepEqual(await (await availability(server)).json(), { unavailable: [] });
    await adminToggle(server, MUFFIN, false);
    assert.deepEqual(await (await availability(server)).json(), { unavailable: [MUFFIN] });
    await adminToggle(server, TURKEY, false);
    assert.deepEqual(await (await availability(server)).json(), { unavailable: [MUFFIN, TURKEY] });
    await adminToggle(server, MUFFIN, true);
    assert.deepEqual(await (await availability(server)).json(), { unavailable: [TURKEY] });
  } finally {
    await server.stop();
  }
});

test('endpoint: headers, revalidation, no cookie, no CORS, and a name with & stays plain JSON text', async () => {
  const server = await startServer({ fakeDb: newFakeDb({ [TURKEY]: false }) });
  try {
    const res = await availability(server, { headers: { cookie: 'connect.sid=junk; admin.sid=junk' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(res.headers.getSetCookie(), [], 'no session, so no cookie');
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'no CORS');
    assert.equal(res.headers.get('x-robots-tag'), null, 'not an admin response');
    const raw = await res.text();
    assert.equal(raw, JSON.stringify({ unavailable: [TURKEY] }));
    assert.ok(raw.includes('Turkey & Swiss Sandwich'));

    const etag = res.headers.get('etag');
    assert.ok(etag, 'has an ETag, so revalidation is a 304');
    const again = await rawGet(server, '/api/availability', { 'if-none-match': etag });
    assert.equal(again.status, 304);
    await adminToggle(server, MUFFIN, false);
    const changed = await rawGet(server, '/api/availability', { 'if-none-match': etag });
    assert.equal(changed.status, 200, 'a changed answer is never answered with 304');
    assert.deepEqual(JSON.parse(changed.body).unavailable, [MUFFIN, TURKEY]);
  } finally {
    await server.stop();
  }
});

test('endpoint: read only (POST is 404) and no login is needed', async () => {
  const server = await startServer({ fakeDb: newFakeDb() });
  try {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await availability(server, { method, body: method === 'DELETE' ? undefined : '{}', headers: { 'content-type': 'application/json' } });
      assert.equal(res.status, 404, method);
    }
    assert.equal((await availability(server)).status, 200, 'no cookie, no login');
  } finally {
    await server.stop();
  }
});

test('endpoint: not rate limited, even when the chat limit is used up', async () => {
  const server = await startServer({ fakeDb: newFakeDb(), env: { RATE_LIMIT_MAX: '2', RATE_LIMIT_GLOBAL_MAX: '3' } });
  try {
    const chat = () => fetch(`${server.base}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '' }) });
    assert.equal((await chat()).status, 400);
    assert.equal((await chat()).status, 400);
    assert.equal((await chat()).status, 429, 'the chat limiter is working');
    for (let i = 0; i < 40; i += 1) assert.equal((await availability(server)).status, 200, `request ${i + 1}`);
  } finally {
    await server.stop();
  }
});

test('/api/menu bytes still match the snapshot while items are sold out, and availability.js is served', async () => {
  const server = await startServer({ fakeDb: newFakeDb({ [MUFFIN]: false, [TURKEY]: false }) });
  try {
    const menu = await fetch(`${server.base}/api/menu`);
    const body = Buffer.from(await menu.arrayBuffer());
    assert.equal(menu.status, fixture.apiMenu.status);
    assert.equal(menu.headers.get('content-type'), fixture.apiMenu.contentType);
    assert.equal(body.length, fixture.apiMenu.bytes);
    assert.equal(sha256(body), fixture.apiMenu.sha256);

    const script = await fetch(`${server.base}/availability.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
    assert.equal(Buffer.from(await script.arrayBuffer()).toString('utf8'), fs.readFileSync(path.join(PUBLIC, 'availability.js'), 'utf8'));
  } finally {
    await server.stop();
  }
});
