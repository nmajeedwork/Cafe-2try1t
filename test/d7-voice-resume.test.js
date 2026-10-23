// D7 tests: a saved voice order is only resumed if it is unconfirmed and well formed
// (see docs/inventory-plan.md, D7, and voice-order-recovery.js).
//
// Run with:  node --test test/d7-voice-resume.test.js
//
// Calls findResumableOrder directly on files written into data/in-progress-orders, using
// fictional +1555019xxxx numbers that are deleted afterwards. The end-to-end checks
// (a real call to /voice/incoming, and the save guard after a confirmed order) are in
// test/d3-voice.test.js. No network, no database, nothing spent.
const test = require('node:test');
const { after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { findResumableOrder } = require('../voice-order-recovery');

const ORDERS_DIR = path.join(__dirname, '..', 'data', 'in-progress-orders');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let numberSeq = 0;
const testNumber = () => `+1555019${String(1000 + numberSeq++).slice(-4)}`;
const orderFile = (from) => path.join(ORDERS_DIR, `${String(from).replace(/[^a-zA-Z0-9+]/g, '_')}.json`);

const CART = [{ name: 'Caffe Latte', quantity: 1, size: 'Medium', customizations: [], price: 4.75 }];
const ORDER = {
  type: 'pickup',
  deliveryAddress: null,
  customerName: 'Sam',
  pickupTime: 'ASAP',
  confirmed: false,
  confirmedAt: null,
  orderId: null
};

function writeRaw(from, value) {
  fs.mkdirSync(ORDERS_DIR, { recursive: true });
  fs.writeFileSync(orderFile(from), JSON.stringify(value));
}

function writeRecord(from, fields = {}) {
  writeRaw(from, { from, callSid: 'CAold', cart: CART, order: ORDER, updatedAt: new Date().toISOString(), ...fields });
}

// The file is deleted with fs.unlink (async), so wait briefly for it to go.
async function waitUntilGone(file) {
  for (let i = 0; i < 40 && fs.existsSync(file); i += 1) await sleep(25);
  return !fs.existsSync(file);
}

// Captures console.warn while fn runs.
async function captureWarn(fn) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    return { result: await fn(), lines };
  } finally {
    console.warn = original;
  }
}

afterEach(() => {
  for (const file of fs.existsSync(ORDERS_DIR) ? fs.readdirSync(ORDERS_DIR) : []) {
    if (file.startsWith('+1555019')) fs.unlinkSync(path.join(ORDERS_DIR, file));
  }
});
after(() => {
  for (const file of fs.existsSync(ORDERS_DIR) ? fs.readdirSync(ORDERS_DIR) : []) {
    if (file.startsWith('+1555019')) fs.unlinkSync(path.join(ORDERS_DIR, file));
  }
});

test('a confirmed order inside the 15 minute window is ignored and its file is deleted', async () => {
  const from = testNumber();
  writeRecord(from, {
    order: { ...ORDER, confirmed: true, confirmedAt: new Date().toISOString(), orderId: '2TRY1T-TEST' },
    updatedAt: new Date(Date.now() - 60 * 1000).toISOString()
  });

  const { result, lines } = await captureWarn(() => findResumableOrder(from));
  assert.equal(result, null);
  assert.ok(await waitUntilGone(orderFile(from)), 'the confirmed file is deleted');
  assert.deepEqual(lines, ['[voice resume] ignored a saved order (order already confirmed), file deleted.']);
  // The log line never carries the phone number, in any form.
  assert.ok(!lines.join('\n').includes('555019'));
});

test('an unconfirmed order inside the window still resumes exactly as before', async () => {
  const from = testNumber();
  writeRecord(from);
  const saved = JSON.parse(fs.readFileSync(orderFile(from), 'utf8'));

  const { result, lines } = await captureWarn(() => findResumableOrder(from));
  assert.deepEqual(result, saved);
  assert.equal(result.order.confirmed, false);
  assert.deepEqual(lines, []);
  await sleep(100);
  assert.ok(fs.existsSync(orderFile(from)), 'a resumable file is kept');
});

test('unchanged: an unconfirmed order older than 15 minutes is not resumed and is deleted', async () => {
  const from = testNumber();
  writeRecord(from, { updatedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString() });
  const { result, lines } = await captureWarn(() => findResumableOrder(from));
  assert.equal(result, null);
  assert.deepEqual(lines, []);
  assert.ok(await waitUntilGone(orderFile(from)));
});

test('unchanged: no file, no number, or unreadable JSON gives null', async () => {
  assert.equal(findResumableOrder(testNumber()), null);
  assert.equal(findResumableOrder(''), null);
  assert.equal(findResumableOrder(undefined), null);
  const from = testNumber();
  fs.mkdirSync(ORDERS_DIR, { recursive: true });
  fs.writeFileSync(orderFile(from), '{ not json');
  assert.equal(findResumableOrder(from), null);
});

test('malformed shapes are ignored and deleted: no order object or no cart array', async () => {
  const now = new Date().toISOString();
  const shapes = [
    ['the record is null', null],
    ['the record is a number', 42],
    ['the record is a string', 'hello'],
    ['the record is an array', [CART, ORDER]],
    ['order is missing', { cart: CART, updatedAt: now }],
    ['order is null', { cart: CART, order: null, updatedAt: now }],
    ['order is a string', { cart: CART, order: 'pickup', updatedAt: now }],
    ['order is an array', { cart: CART, order: [ORDER], updatedAt: now }],
    ['cart is missing', { order: ORDER, updatedAt: now }],
    ['cart is null', { cart: null, order: ORDER, updatedAt: now }],
    ['cart is an object', { cart: { 0: CART[0] }, order: ORDER, updatedAt: now }],
    ['cart is a string', { cart: 'Caffe Latte', order: ORDER, updatedAt: now }]
  ];
  for (const [label, value] of shapes) {
    const from = testNumber();
    writeRaw(from, value);
    const { result, lines } = await captureWarn(() => findResumableOrder(from));
    assert.equal(result, null, label);
    assert.deepEqual(lines, ['[voice resume] ignored a saved order (invalid shape), file deleted.'], label);
    assert.ok(await waitUntilGone(orderFile(from)), `${label}: file deleted`);
  }
});

test('a missing or unparseable updatedAt is an invalid shape: ignored and deleted', async () => {
  // Before D7 these resumed forever: the age came out as NaN, which never exceeds the window.
  const cases = [
    ['updatedAt is missing', undefined],
    ['updatedAt is null', null],
    ['updatedAt is an empty string', ''],
    ['updatedAt is not a date', 'yesterday-ish'],
    ['updatedAt is a number', Date.now()],
    ['updatedAt is an object', {}]
  ];
  for (const [label, updatedAt] of cases) {
    const from = testNumber();
    writeRaw(from, { from, callSid: 'CAold', cart: CART, order: ORDER, updatedAt });
    const { result, lines } = await captureWarn(() => findResumableOrder(from));
    assert.equal(result, null, label);
    assert.deepEqual(lines, ['[voice resume] ignored a saved order (invalid shape), file deleted.'], label);
    assert.ok(await waitUntilGone(orderFile(from)), `${label}: file deleted`);
  }
});

test('only a strict true counts as confirmed; other values still resume', async () => {
  // saveInProgressOrder only ever writes the boolean, so anything else is the normal
  // unconfirmed state (false, or null and missing on older files).
  for (const confirmed of [false, null, undefined, 'true', 1]) {
    const from = testNumber();
    writeRecord(from, { order: { ...ORDER, confirmed } });
    const { result } = await captureWarn(() => findResumableOrder(from));
    assert.ok(result, `confirmed=${JSON.stringify(confirmed)} resumes`);
  }
});
