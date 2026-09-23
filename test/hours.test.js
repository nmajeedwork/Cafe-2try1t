// Regression tests for the Winnipeg-timezone hours fix (see getCafeNow in server.js).
//
// Root cause being guarded against: server.js used to read the SERVER process's local
// clock (new Date().getHours()/.getMinutes()/.getDay()) and treat it as the café's local
// time. Render runs that process in UTC, so every hours check was silently off by 5-6
// hours (CDT/CST) from real Winnipeg time — a real customer calling at 9:00 PM Winnipeg
// time was told the café was closed, because the server's raw clock read 2:00 AM.
//
// Uses Node's built-in test runner (node --test), so no new dependency is needed.
// Requires NODE_ENV=development so server.js's production startup guards (which refuse
// to start without a real SESSION_SECRET) don't fire for this local .env.
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { getCafeNow, validateOrderTiming, buildSystemBlocks } = require(path.join(__dirname, '..', 'server.js'));

// ------------------------------------------------------------------------------------
// getCafeNow(): the raw UTC-instant -> Winnipeg-local conversion
// ------------------------------------------------------------------------------------

test('getCafeNow: a normal midday moment converts to the correct Winnipeg local time', () => {
  // 2026-09-22T17:00:00Z is Tuesday 12:00 PM in Winnipeg (CDT, UTC-5, in effect in September).
  const result = getCafeNow(new Date('2026-09-22T17:00:00Z'));
  assert.deepEqual(result, { dayOfWeek: 2, hour: 12, minute: 0 });
});

test('getCafeNow: winter instant uses CST (UTC-6) automatically, not a hardcoded UTC-5 offset', () => {
  // 2026-01-15T18:00:00Z is Thursday 12:00 PM in Winnipeg under CST (UTC-6) — same local
  // wall-clock target as the summer case above, different UTC offset. This is the DST
  // check: Intl/IANA must pick the right offset for the date, not a fixed number.
  const result = getCafeNow(new Date('2026-01-15T18:00:00Z'));
  assert.deepEqual(result, { dayOfWeek: 4, hour: 12, minute: 0 });
});

test('getCafeNow: reconstructs the exact reported live-call failure instant (real Winnipeg 9:00 PM)', () => {
  // 2026-09-23T02:00:00Z is the instant a real customer called at 9:00 PM Winnipeg time.
  // Under the old bug, server.js would have read this as raw UTC 2:00 AM and treated
  // THAT as café-local time. getCafeNow must resolve it to Tuesday 9:00 PM instead.
  const result = getCafeNow(new Date('2026-09-23T02:00:00Z'));
  assert.deepEqual(result, { dayOfWeek: 2, hour: 21, minute: 0 });
});

// ------------------------------------------------------------------------------------
// validateOrderTiming(): the actual open/closed business behavior (5:00 AM-2:00 AM,
// 30-minute closing buffer, unchanged by this fix — only how "now" is computed changed)
// ------------------------------------------------------------------------------------

test('validateOrderTiming: the reported bug case (real Winnipeg 9:00 PM) is now correctly OPEN', () => {
  const instant = new Date('2026-09-23T02:00:00Z'); // real Winnipeg 9:00 PM
  const result = validateOrderTiming('delivery', null, instant);
  assert.deepEqual(result, { ok: true });
});

test('sanity check: the bug-case instant really would have been misread as 2:00 AM UTC', () => {
  // Confirms the test above is actually exercising the reported failure, not some
  // unrelated moment: the raw UTC clock reading for this instant is exactly 2:00 AM,
  // which is what the pre-fix code would have used as if it were café-local time.
  const instant = new Date('2026-09-23T02:00:00Z');
  assert.equal(instant.getUTCHours(), 2);
  assert.equal(instant.getUTCMinutes(), 0);
});

test('validateOrderTiming: just before the 1:30 AM closing-buffer cutoff is OPEN', () => {
  const instant = new Date('2026-09-22T06:29:00Z'); // Winnipeg 1:29 AM
  const result = validateOrderTiming('delivery', null, instant);
  assert.deepEqual(result, { ok: true });
});

test('validateOrderTiming: just after the 1:30 AM closing-buffer cutoff is CLOSED', () => {
  const instant = new Date('2026-09-22T06:31:00Z'); // Winnipeg 1:31 AM
  const result = validateOrderTiming('delivery', null, instant);
  assert.match(result.error, /closed or about to close/);
});

test('validateOrderTiming: just after the actual 2:00 AM close is CLOSED', () => {
  const instant = new Date('2026-09-22T07:01:00Z'); // Winnipeg 2:01 AM
  const result = validateOrderTiming('pickup', null, instant);
  assert.match(result.error, /closed or about to close/);
});

test('validateOrderTiming: before opening (3:00 AM Winnipeg) is CLOSED', () => {
  const instant = new Date('2026-09-22T08:00:00Z'); // Winnipeg 3:00 AM
  const result = validateOrderTiming('pickup', null, instant);
  assert.match(result.error, /closed or about to close/);
});

test('validateOrderTiming: pickup with an explicit in-hours time is accepted', () => {
  const instant = new Date('2026-09-22T17:00:00Z'); // Winnipeg noon
  const result = validateOrderTiming('pickup', '6:15 PM', instant);
  assert.deepEqual(result, { ok: true });
});

test('validateOrderTiming: pickup with an explicit time inside the closing buffer is rejected', () => {
  const instant = new Date('2026-09-22T17:00:00Z'); // Winnipeg noon
  const result = validateOrderTiming('pickup', '1:45 AM', instant); // 15 min before 2 AM close
  assert.match(result.error, /outside our hours or too close to closing/);
});

test('validateOrderTiming: DISABLE_HOURS_CHECK dev override still bypasses hours entirely', () => {
  process.env.DISABLE_HOURS_CHECK = 'true';
  try {
    const instant = new Date('2026-09-22T08:00:00Z'); // 3 AM Winnipeg, normally closed
    const result = validateOrderTiming('pickup', null, instant);
    assert.deepEqual(result, { ok: true });
  } finally {
    delete process.env.DISABLE_HOURS_CHECK;
  }
});

test('validateOrderTiming: FORCE_HOURS_CLOSED dev override still forces closed', () => {
  process.env.FORCE_HOURS_CLOSED = 'true';
  try {
    const instant = new Date('2026-09-22T17:00:00Z'); // Winnipeg noon, normally open
    const result = validateOrderTiming('pickup', null, instant);
    assert.match(result.error, /testing override/);
  } finally {
    delete process.env.FORCE_HOURS_CLOSED;
  }
});

// ------------------------------------------------------------------------------------
// buildSystemBlocks(): the "Current Date & Time" text injected into CafeBot's prompt
// ------------------------------------------------------------------------------------

test('buildSystemBlocks: injects Winnipeg-local day/time, not raw server/UTC time', () => {
  const instant = new Date('2026-09-23T02:00:00Z'); // Winnipeg Tue 9:00 PM / raw UTC Wed 2:00 AM
  const blocks = buildSystemBlocks('stable-text-placeholder', {}, instant);
  const volatileBlock = blocks[1].text;
  assert.match(volatileBlock, /Tuesday, 9:00 PM/);
  assert.doesNotMatch(volatileBlock, /Wednesday/);
  assert.doesNotMatch(volatileBlock, /2:00 AM/);
});
