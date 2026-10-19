// D5 in-memory stock tests: setInMemory, getStockStatus, reloadStock, and the confirmed
// order. In process, no server, no database, no network.
//
// Run with:  node --test test/d5-stock-memory.test.js
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const test = require('node:test');
const assert = require('node:assert/strict');

const stock = require('../stock');
const MENU_NAMES = require('../menu.json').map((item) => item.name);
const quietLog = { log() {}, warn() {}, error() {} };
const MUFFIN = 'Blueberry Muffin';
const LATTE = 'Caffe Latte';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('setInMemory sets one item in memory only and rejects bad arguments', async () => {
  await stock.initStock({ menuNames: MENU_NAMES, loadFn: async () => [], log: quietLog, timing: { reloadDelayMs: 3600000 } });
  stock.stopStock();
  stock.setInMemory(MUFFIN, false);
  assert.equal(stock.isInStock(MUFFIN), false);
  assert.deepEqual(stock.outOfStockNames(), [MUFFIN]);
  stock.setInMemory(MUFFIN, true);
  assert.equal(stock.isInStock(MUFFIN), true);
  assert.throws(() => stock.setInMemory('', false), TypeError);
  assert.throws(() => stock.setInMemory(MUFFIN, 'false'), TypeError);
});

test('getStockStatus: off, unavailable after a failed boot, and the retry loop flips it to ok', async () => {
  stock.markTrackingOff();
  assert.equal(stock.getStockStatus().state, 'off');

  let calls = 0;
  const loadFn = async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED', permanent: false });
    return [{ item_name: LATTE, in_stock: false }];
  };
  await stock.initStock({ menuNames: MENU_NAMES, loadFn, log: quietLog, timing: { retryBaseMs: 20, reloadDelayMs: 3600000 } });
  assert.equal(stock.getStockStatus().state, 'unavailable', 'boot failed, nothing loaded yet');
  assert.equal(stock.getStockStatus().lastLoadedAt, null);
  for (let i = 0; i < 100 && stock.getStockStatus().state !== 'ok'; i += 1) await sleep(10);
  stock.stopStock();
  assert.equal(stock.getStockStatus().state, 'ok', 'the background retry succeeded and flipped the status');
  assert.ok(stock.getStockStatus().lastLoadedAt > 0);
  assert.equal(stock.isInStock(LATTE), false);
});

test('a permanent boot failure stays unavailable (no retries)', async () => {
  const loadFn = async () => {
    throw Object.assign(new Error('password authentication failed'), { code: '28P01', permanent: true });
  };
  await stock.initStock({ menuNames: MENU_NAMES, loadFn, log: quietLog, timing: { retryBaseMs: 20, reloadDelayMs: 3600000 } });
  await sleep(100);
  stock.stopStock();
  assert.equal(stock.getStockStatus().state, 'unavailable');
});

test('reloadStock: a failure leaves memory unchanged; a load started before a toggle never undoes it', async () => {
  await stock.initStock({
    menuNames: MENU_NAMES,
    loadFn: async () => [{ item_name: LATTE, in_stock: false }],
    log: quietLog,
    timing: { reloadDelayMs: 3600000 }
  });
  stock.stopStock();

  const failed = await stock.reloadStock({
    menuNames: MENU_NAMES,
    loadFn: async () => {
      throw new Error('database down');
    }
  });
  assert.equal(failed.ok, false);
  assert.equal(stock.isInStock(LATTE), false, 'unchanged after a failed reload');

  // The load reads the database (Muffin still in stock), then the owner marks Muffin sold
  // out, then the load finishes with its older rows.
  let finishLoad;
  const pending = stock.reloadStock({
    menuNames: MENU_NAMES,
    loadFn: () => new Promise((resolve) => (finishLoad = resolve))
  });
  stock.setInMemory(MUFFIN, false);
  finishLoad([{ item_name: MUFFIN, in_stock: true }]);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(stock.isInStock(MUFFIN), false, 'the newer toggle wins over the older rows');
  assert.equal(stock.isInStock(LATTE), true, 'the rest comes from the load');
});

test('a toggle never changes a confirmed order', async () => {
  const server = require('../server.js');
  const { executeTool, initSessionState } = server;
  await stock.initStock({ menuNames: MENU_NAMES, loadFn: async () => [], log: quietLog, timing: { reloadDelayMs: 3600000 } });
  stock.stopStock();
  const state = {};
  initSessionState(state);
  executeTool('add_to_cart', { item_name: MUFFIN, quantity: 1 }, state);
  Object.assign(state.order, { type: 'pickup', customerName: 'Sam', pickupTime: 'ASAP' });
  assert.equal(executeTool('confirm_order', {}, state).success, true);
  const order = structuredClone(state.order);
  const cart = structuredClone(state.cart);
  const view = executeTool('view_cart', {}, state);

  stock.setInMemory(MUFFIN, false);
  assert.deepEqual(state.order, order);
  assert.deepEqual(state.cart, cart);
  assert.deepEqual(executeTool('view_cart', {}, state), view);
  stock.setInMemory(MUFFIN, true);
  assert.deepEqual(state.order, order);
});
