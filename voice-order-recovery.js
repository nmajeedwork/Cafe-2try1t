const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data', 'in-progress-orders');
fs.mkdirSync(DATA_DIR, { recursive: true });

// How long a saved partial order stays eligible for callback resume before it's treated
// as abandoned for good - long enough to cover someone calling right back after a dropped
// call, short enough that a much-later, unrelated call from the same number doesn't get
// an old cart sprung on it.
const RESUME_WINDOW_MS = 15 * 60 * 1000;

function fileForNumber(fromNumber) {
  const safe = String(fromNumber).replace(/[^a-zA-Z0-9+]/g, '_');
  return path.join(DATA_DIR, `${safe}.json`);
}

// Called after every voice turn, not just on hangup - there's no Twilio status-callback
// webhook wired up to tell this app when a call actually drops, so writing the cart
// through on every turn is what guarantees a mid-call disconnect never loses more than
// the current exchange, instead of trying to catch the exact moment of disconnect.
function saveInProgressOrder({ from, callSid, cart, order }) {
  if (!from || !cart || cart.length === 0) {
    return;
  }
  const record = { from, callSid, cart, order, updatedAt: new Date().toISOString() };
  fs.writeFileSync(fileForNumber(from), JSON.stringify(record, null, 2));
}

// Called once an order is confirmed, or a call ends with nothing left in progress - the
// saved copy would otherwise incorrectly offer to "resume" a finished or abandoned order
// on the caller's next call.
function clearInProgressOrder(from) {
  if (!from) {
    return;
  }
  fs.unlink(fileForNumber(from), () => {});
}

// A saved record is only usable if it has the shape saveInProgressOrder writes: an order
// object, a cart array and an updatedAt that parses to a real date. Without a valid date
// the age check below would compare NaN and never expire the record.
function hasResumableShape(record) {
  return (
    !!record &&
    typeof record === 'object' &&
    !!record.order &&
    typeof record.order === 'object' &&
    !Array.isArray(record.order) &&
    Array.isArray(record.cart) &&
    typeof record.updatedAt === 'string' &&
    !Number.isNaN(new Date(record.updatedAt).getTime())
  );
}

// Looks up a still-fresh partial order for this caller number, so a new call from the
// same number can pick up where a dropped call left off. Returns null if there's nothing
// saved, or it's older than RESUME_WINDOW_MS (treated as abandoned by then).
//
// D7 defense in depth: the save paths in server.js never write a confirmed order, but a
// file left behind anyway (a crash between confirm and clear, an old file, a hand edit)
// must never bring a finished order back into a new call. A record with the wrong shape
// or with order.confirmed true is deleted and ignored. The log line names the reason
// only, never the phone number.
function findResumableOrder(from) {
  if (!from) {
    return null;
  }
  const file = fileForNumber(from);
  if (!fs.existsSync(file)) {
    return null;
  }

  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }

  if (!hasResumableShape(record) || record.order.confirmed === true) {
    const reason = hasResumableShape(record) ? 'order already confirmed' : 'invalid shape';
    console.warn(`[voice resume] ignored a saved order (${reason}), file deleted.`);
    fs.unlink(file, () => {});
    return null;
  }

  const age = Date.now() - new Date(record.updatedAt).getTime();
  if (age > RESUME_WINDOW_MS) {
    fs.unlink(file, () => {});
    return null;
  }
  return record;
}

module.exports = { saveInProgressOrder, clearInProgressOrder, findResumableOrder };
