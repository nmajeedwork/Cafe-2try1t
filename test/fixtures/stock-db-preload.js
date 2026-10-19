// Loaded with `node --require` into the server child processes started by
// test/d5-stock-dashboard.test.js. It first loads voice-preload.js (outbound network is
// loopback only, ElevenLabs is unavailable), then replaces its db.js stub with a fake
// database kept in a JSON file, so stock state survives a server restart:
//
//   FAKE_DB_FILE              path of the JSON file: { "<item name>": true | false }
//   <FAKE_DB_FILE>.down       if this file exists, every call fails. Its content picks the
//                             error: "permanent" (like a wrong password: no retries) or
//                             anything else (like a refused connection: retried).
//   <FAKE_DB_FILE>.writes     every setStock call that succeeded, one JSON line each.
//   FAKE_DB_SET_DELAYS        optional comma separated delays in ms, used by setStock calls
//                             in order (the first call waits the first delay, and so on).
//
// Holds no secrets and never opens a socket. The child's environment is built by the test.

require('./voice-preload');

const fs = require('node:fs');
const path = require('node:path');

const dbPath = path.join(__dirname, '..', '..', 'db.js');
const file = process.env.FAKE_DB_FILE;
const delays = String(process.env.FAKE_DB_SET_DELAYS || '')
  .split(',')
  .filter(Boolean)
  .map(Number);
let setCalls = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function failIfDown() {
  // Like the real db.js: with DATABASE_URL unset every call is a permanent error.
  if (!process.env.DATABASE_URL) {
    const err = new Error('DATABASE_URL is not set');
    err.name = 'DbError';
    err.code = 'NO_DATABASE_URL';
    err.permanent = true;
    throw err;
  }
  const marker = `${file}.down`;
  if (!fs.existsSync(marker)) return;
  const permanent = fs.readFileSync(marker, 'utf8').trim() === 'permanent';
  const err = new Error(permanent ? 'fake database: password authentication failed' : 'fake database: connection refused');
  err.name = 'DbError';
  err.code = permanent ? '28P01' : 'ECONNREFUSED';
  err.permanent = permanent;
  throw err;
}

const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});

require.cache[dbPath].exports = {
  async loadStock() {
    failIfDown();
    return Object.entries(read()).map(([item_name, in_stock]) => ({ item_name, in_stock }));
  },
  async setStock(itemName, inStock) {
    const delay = delays[setCalls] || 0;
    setCalls += 1;
    if (delay) await sleep(delay);
    failIfDown();
    const state = read();
    state[itemName] = inStock;
    fs.writeFileSync(file, JSON.stringify(state));
    fs.appendFileSync(`${file}.writes`, `${JSON.stringify({ itemName, inStock })}\n`);
  },
  async deleteStock(itemName) {
    failIfDown();
    const state = read();
    const had = itemName in state;
    delete state[itemName];
    fs.writeFileSync(file, JSON.stringify(state));
    return had ? 1 : 0;
  }
};
