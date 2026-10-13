// D3 tests: stock enforcement in the cart tools and the prompt (see docs/inventory-plan.md).
//
// Run with:  node --test test/d3-stock.test.js
//
// Stock is stubbed by handing stock.initStock() a fake loader, so no database is involved,
// and the cart tools are driven directly through executeTool, so no Anthropic call is made.
// Nothing here spends anything.
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const test = require('node:test');
const { afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const stock = require('../stock');
const server = require('../server.js');
const fixture = require('./fixtures/d2-snapshot.json');

const { executeTool, initSessionState, buildSystemBlocks, STABLE_SYSTEM_TEXT, STABLE_SYSTEM_TEXT_VOICE } = server;
const menu = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'menu.json'), 'utf8'));
const MENU_NAMES = menu.map((item) => item.name);
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const lf = (text) => text.replace(/\r\n/g, '\n');
const quietLog = { log() {}, warn() {}, error() {} };

// Replaces the in-memory stock state with exactly these sold-out names. An empty list
// leaves the Map empty, which is the same state as "stock unknown".
async function setSoldOut(names) {
  await stock.initStock({
    menuNames: MENU_NAMES,
    loadFn: async () => names.map((name) => ({ item_name: name, in_stock: false })),
    log: quietLog,
    timing: { reloadDelayMs: 60 * 60 * 1000 }
  });
  stock.stopStock();
}

function freshSession() {
  const state = {};
  initSessionState(state);
  return state;
}

function readyPickup(state) {
  state.order.type = 'pickup';
  state.order.customerName = 'Sam';
  state.order.pickupTime = 'ASAP';
}

afterEach(async () => {
  await setSoldOut([]);
});

// ------------------------------------------------------------------------------------
// stock.outOfStockNames
// ------------------------------------------------------------------------------------

test('outOfStockNames lists only out-of-stock names and is empty when stock is unknown', async () => {
  assert.deepEqual(stock.outOfStockNames(), []);
  await stock.initStock({
    menuNames: MENU_NAMES,
    loadFn: async () => [
      { item_name: 'Cold Brew', in_stock: false },
      { item_name: 'Espresso', in_stock: true }
    ],
    log: quietLog,
    timing: { reloadDelayMs: 60 * 60 * 1000 }
  });
  stock.stopStock();
  assert.deepEqual(stock.outOfStockNames(), ['Cold Brew']);
});

// ------------------------------------------------------------------------------------
// add_to_cart
// ------------------------------------------------------------------------------------

test('add_to_cart refuses a sold-out item with up to 2 same-category in-stock alternatives', async () => {
  await setSoldOut(['Blueberry Muffin']);
  const state = freshSession();
  const result = executeTool('add_to_cart', { item_name: 'blueberry muffin', quantity: 2 }, state);
  assert.deepEqual(result, {
    error: 'Blueberry Muffin is sold out right now.',
    alternatives: ['Butter Croissant', 'Chocolate Chip Cookie']
  });
  assert.equal(state.cart.length, 0);
});

test('add_to_cart alternatives skip other sold-out items, cap at 2, and can be empty', async () => {
  await setSoldOut(['Espresso', 'Cappuccino', 'Chai Latte']);
  const coffee = executeTool('add_to_cart', { item_name: 'Espresso', quantity: 1 }, freshSession());
  assert.deepEqual(coffee.alternatives, ['Caffe Latte', 'Cold Brew']);
  const tea = executeTool('add_to_cart', { item_name: 'Chai Latte', quantity: 1 }, freshSession());
  assert.deepEqual(tea, { error: 'Chai Latte is sold out right now.', alternatives: [] });
});

test('add_to_cart for an in-stock item is unchanged while other items are sold out', async () => {
  await setSoldOut(['Blueberry Muffin']);
  const state = freshSession();
  const result = executeTool('add_to_cart', { item_name: 'Butter Croissant', quantity: 1 }, state);
  assert.equal(result.success, true);
  assert.equal(result.added.name, 'Butter Croissant');
  assert.ok(!('unavailableItems' in result));
  assert.equal(state.cart.length, 1);
});

test('stock unknown (empty Map): every item can be added and confirmed as before D3', async () => {
  await setSoldOut([]);
  const state = freshSession();
  for (const name of MENU_NAMES) {
    assert.equal(executeTool('add_to_cart', { item_name: name, quantity: 1 }, state).success, true, name);
  }
  assert.ok(!('unavailableItems' in executeTool('view_cart', {}, state)));
  readyPickup(state);
  assert.equal(executeTool('confirm_order', {}, state).success, true);
  const [, uncached] = buildSystemBlocks(STABLE_SYSTEM_TEXT, {}, new Date('2026-09-22T17:00:00Z'));
  assert.ok(!uncached.text.includes('Currently Unavailable'));
});

// ------------------------------------------------------------------------------------
// A cart that already holds an item which then goes out of stock
// ------------------------------------------------------------------------------------

test('view_cart adds unavailableItems only when the cart holds a sold-out item', async () => {
  const state = freshSession();
  executeTool('add_to_cart', { item_name: 'Blueberry Muffin', quantity: 1 }, state);
  executeTool('add_to_cart', { item_name: 'Caffe Latte', quantity: 1 }, state);
  const before = executeTool('view_cart', {}, state);
  assert.ok(!('unavailableItems' in before));

  await setSoldOut(['Blueberry Muffin', 'Cold Brew']);
  const after = executeTool('view_cart', {}, state);
  assert.deepEqual(after.unavailableItems, ['Blueberry Muffin']);
  // Everything else in the result is exactly what it was.
  const { unavailableItems, ...rest } = after;
  assert.deepEqual(rest, before);
});

test('confirm_order refuses a sold-out line, lists it once, and removes nothing', async () => {
  const state = freshSession();
  executeTool('add_to_cart', { item_name: 'Blueberry Muffin', quantity: 1 }, state);
  executeTool('add_to_cart', { item_name: 'Blueberry Muffin', quantity: 2 }, state);
  executeTool('add_to_cart', { item_name: 'Drip Coffee', quantity: 1 }, state);
  readyPickup(state);
  const cartBefore = structuredClone(state.cart);

  await setSoldOut(['Blueberry Muffin']);
  const result = executeTool('confirm_order', {}, state);
  assert.deepEqual(result, {
    error: "Can't confirm: these items are sold out right now: Blueberry Muffin. Ask the customer to remove or swap them.",
    soldOutItems: ['Blueberry Muffin']
  });
  assert.deepEqual(state.cart, cartBefore);
  assert.equal(state.order.confirmed, false);
  assert.equal(state.order.orderId, null);
});

test('a sold-out line can still be customized and removed, then the order confirms', async () => {
  const state = freshSession();
  executeTool('add_to_cart', { item_name: 'Blueberry Muffin', quantity: 1 }, state);
  executeTool('add_to_cart', { item_name: 'Drip Coffee', quantity: 1 }, state);
  readyPickup(state);
  await setSoldOut(['Blueberry Muffin']);

  const updated = executeTool('update_customization', { item_name: 'Blueberry Muffin', customizations: ['Warmed'] }, state);
  assert.equal(updated.success, true);
  assert.deepEqual(updated.updated.customizations, ['Warmed']);
  assert.deepEqual(updated.unavailableItems, ['Blueberry Muffin']);

  const otherUpdate = freshSession();
  executeTool('add_to_cart', { item_name: 'Drip Coffee', quantity: 1 }, otherUpdate);
  assert.ok(!('unavailableItems' in executeTool('update_customization', { item_name: 'Drip Coffee', customizations: [] }, otherUpdate)));

  const removed = executeTool('remove_from_cart', { item_name: 'blueberry muffin' }, state);
  assert.equal(removed.success, true);
  assert.equal(state.cart.length, 1);

  const confirmed = executeTool('confirm_order', {}, state);
  assert.equal(confirmed.success, true);
  assert.match(confirmed.order.orderId, /^2TRY1T-/);
});

test('a cart restored from a dropped voice call is checked by canonical name', async () => {
  // Same shape /voice/incoming restores from voice-order-recovery.js, with the item name
  // in different casing to prove the check uses the menu name, not the stored wording.
  const state = freshSession();
  state.cart = [
    { name: 'blueberry MUFFIN', quantity: 1, size: null, customizations: [], price: 3.25 },
    { name: 'Caffe Latte', quantity: 1, size: 'Medium', customizations: [], price: 4.75 }
  ];
  state.order = { ...state.order, type: 'pickup', customerName: 'Sam', pickupTime: 'ASAP' };
  await setSoldOut(['Blueberry Muffin']);

  assert.deepEqual(executeTool('view_cart', {}, state).unavailableItems, ['Blueberry Muffin']);
  const result = executeTool('confirm_order', {}, state);
  assert.deepEqual(result.soldOutItems, ['Blueberry Muffin']);
  assert.equal(state.order.confirmed, false);
  assert.equal(state.cart.length, 2);
});

test('promotions are unchanged by stock: a sold-out line still counts until removed', async () => {
  const state = freshSession();
  executeTool('add_to_cart', { item_name: 'Caffe Latte', quantity: 1 }, state);
  executeTool('add_to_cart', { item_name: 'Butter Croissant', quantity: 1 }, state);
  const before = executeTool('view_cart', {}, state).promotions;
  await setSoldOut(['Butter Croissant']);
  const after = executeTool('view_cart', {}, state);
  assert.deepEqual(after.promotions, before);
  readyPickup(state);
  assert.ok(executeTool('confirm_order', {}, state).error);
});

// ------------------------------------------------------------------------------------
// Confirmed orders are frozen
// ------------------------------------------------------------------------------------

test('toggling stock never changes a confirmed order', async () => {
  const state = freshSession();
  executeTool('add_to_cart', { item_name: 'Blueberry Muffin', quantity: 1 }, state);
  executeTool('add_to_cart', { item_name: 'Caffe Latte', quantity: 1 }, state);
  readyPickup(state);
  const confirmed = executeTool('confirm_order', {}, state);
  assert.equal(confirmed.success, true);
  const cartSnapshot = structuredClone(state.cart);
  const orderSnapshot = structuredClone(state.order);
  const viewSnapshot = executeTool('view_cart', {}, state);

  await setSoldOut(['Blueberry Muffin', 'Caffe Latte']);
  assert.deepEqual(state.cart, cartSnapshot);
  assert.deepEqual(state.order, orderSnapshot);
  assert.deepEqual(executeTool('view_cart', {}, state), viewSnapshot);
  const again = executeTool('confirm_order', {}, state);
  assert.match(again.error, /already placed/);
  assert.ok(!('soldOutItems' in again));

  await setSoldOut([]);
  assert.deepEqual(state.order, orderSnapshot);
});

// ------------------------------------------------------------------------------------
// System prompt blocks
// ------------------------------------------------------------------------------------

test('stable blocks are byte-identical whatever the stock state, and match the snapshot', async () => {
  const instant = new Date('2026-09-22T17:00:00Z');
  const states = [[], ['Blueberry Muffin'], ['Espresso', 'Cold Brew', 'Avocado Toast'], []];
  for (const stableText of [STABLE_SYSTEM_TEXT, STABLE_SYSTEM_TEXT_VOICE]) {
    const hashes = new Set();
    for (const soldOut of states) {
      await setSoldOut(soldOut);
      const [stable] = buildSystemBlocks(stableText, {}, instant);
      assert.equal(stable.text, stableText);
      assert.deepEqual(stable.cache_control, { type: 'ephemeral' });
      hashes.add(sha256(lf(stable.text)));
    }
    assert.equal(hashes.size, 1);
  }
  assert.equal(sha256(lf(STABLE_SYSTEM_TEXT)), fixture.stableChatSha256);
  assert.equal(sha256(lf(STABLE_SYSTEM_TEXT_VOICE)), fixture.stableVoiceSha256);
});

test('the uncached block lists sold-out items in menu order, only when there are any', async () => {
  const instant = new Date('2026-09-22T17:00:00Z');
  await setSoldOut(['Avocado Toast', 'Espresso']);
  const [, uncached] = buildSystemBlocks(STABLE_SYSTEM_TEXT, {}, instant);
  assert.ok(!('cache_control' in uncached));
  assert.ok(uncached.text.endsWith(
    '\n\n## Currently Unavailable\nSold out right now, cannot be ordered: Espresso, Avocado Toast.'
  ));

  await setSoldOut([]);
  const [, empty] = buildSystemBlocks(STABLE_SYSTEM_TEXT, {}, instant);
  assert.ok(!empty.text.includes('Currently Unavailable'));
});

test('the sold-out rule is in both prompts and adds no em or en dashes', () => {
  for (const file of ['system-prompt.md', 'system-prompt-voice.md']) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const start = text.indexOf('## Sold-Out Items');
    assert.ok(start > 0, file);
    const section = text.slice(start, text.indexOf('\n## ', start + 1));
    assert.ok(!/[\u2013\u2014]/.test(section), file);
  }
});

// D3 follow-up: a live call with nothing sold out said the blueberry muffin was sold out,
// because the voice prompt's example sentence named real items and the model took it as
// fact. The Sold-Out Items sections must only use placeholders, never menu item names.
test('the Sold-Out Items section of either prompt names no menu item', () => {
  for (const file of ['system-prompt.md', 'system-prompt-voice.md']) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const start = text.indexOf('## Sold-Out Items');
    assert.ok(start > 0, file);
    const section = text.slice(start, text.indexOf('\n## ', start + 1)).toLowerCase();
    const named = MENU_NAMES.filter((name) => section.includes(name.toLowerCase()));
    assert.deepEqual(named, [], `${file} names menu items in its Sold-Out Items section`);
  }
});
