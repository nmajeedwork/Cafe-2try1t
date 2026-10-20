// Runs the real page code of the public site in Node, on the fake DOM:
//   page 'menu'  runs public/menu.js (the Menu page)
//   page 'home'  runs the inline script of public/index.html (Home's featured cards)
// with a fake fetch, so tests can control /api/menu and /api/availability exactly.
//
// Options:
//   menu          the array /api/menu returns (default: the menu snapshot in d6-golden-dom.json)
//   availability  what /api/availability does:
//                   { mode: 'ok', names: [...] }       200 with { unavailable: names }
//                   { mode: 'body', body: <any> }      200 with this JSON body
//                   { mode: 'http', status: 500 }      non-OK status
//                   { mode: 'network' }                fetch rejects
//                   { mode: 'badjson' }                200 but the body is not JSON
//                   { mode: 'hang' }                   never answers until aborted
//                   { mode: 'deferred' }               answers when resolveAvailability(names) is called
//   helper        load public/availability.js into the page first (default true)
//   hash          window.location.hash (default '')
// Returns { tree, doc, window, settle, resolveAvailability, fireTimers }.
// Timers are fake: they only run when a test calls fireTimers().

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createFakeDocument, serialize } = require('./fake-dom');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const golden = require('./d6-golden-dom.json');

const read = (file) => fs.readFileSync(path.join(PUBLIC, file), 'utf8');

// The inline script of index.html that builds the featured cards.
function homeScript() {
  const html = read('index.html');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const found = scripts.find((s) => s.includes('featured-grid'));
  if (!found) throw new Error('could not find the featured cards script in index.html');
  return found;
}

function makeFetch(menu, availability, state) {
  const respond = (body) => ({ ok: true, status: 200, json: async () => body });
  return function fakeFetch(url, init) {
    if (url === '/api/menu') return Promise.resolve(respond(menu));
    if (url !== '/api/availability') return Promise.reject(new Error(`unexpected fetch ${url}`));
    state.availabilityRequests += 1;
    switch (availability.mode) {
      case 'ok':
        return Promise.resolve(respond({ unavailable: availability.names }));
      case 'body':
        return Promise.resolve(respond(availability.body));
      case 'http':
        return Promise.resolve({ ok: false, status: availability.status, json: async () => ({}) });
      case 'network':
        return Promise.reject(new TypeError('Failed to fetch'));
      case 'badjson':
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token < in JSON');
          }
        });
      case 'hang':
        return new Promise((resolve, reject) => {
          if (init && init.signal) init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      case 'deferred':
        return new Promise((resolve) => {
          state.resolveAvailability = (names) => resolve(respond({ unavailable: names }));
        });
      default:
        throw new Error(`unknown availability mode ${availability.mode}`);
    }
  };
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function runPage(page, options = {}) {
  const {
    menu = golden.menu,
    availability = { mode: 'ok', names: [] },
    helper = true,
    hash = ''
  } = options;
  const doc = createFakeDocument();
  const timers = [];
  const state = { availabilityRequests: 0, resolveAvailability: null };
  const rootId = page === 'menu' ? 'menu-content' : 'featured-grid';
  const root = doc.addRoot(rootId);

  const sandbox = {
    document: doc,
    fetch: makeFetch(menu, availability, state),
    console: { log() {}, warn() {}, error() {} },
    AbortController,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => {},
    decodeURIComponent,
    location: { hash }
  };
  // In a browser window is the global object itself.
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.scrollY = 0;
  doc.window = sandbox;
  vm.createContext(sandbox);

  if (helper) vm.runInContext(read('availability.js'), sandbox, { filename: 'availability.js' });
  const source = page === 'menu' ? read('menu.js') : homeScript();
  vm.runInContext(source, sandbox, { filename: page === 'menu' ? 'menu.js' : 'index.html' });
  await settle();

  return {
    doc,
    window: sandbox,
    root,
    get tree() {
      return serialize(root);
    },
    settle,
    resolveAvailability: (names) => state.resolveAvailability(names),
    fireTimers: () => timers.splice(0).forEach((t) => t.fn()),
    availabilityRequests: () => state.availabilityRequests
  };
}

module.exports = { runPage, settle, golden };
