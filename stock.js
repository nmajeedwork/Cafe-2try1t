// In-memory stock state for the inventory dashboard (see docs/inventory-plan.md).
//
// This file has no database code and no pg import. It holds a Map of item name to
// in-stock yes/no, answers isInStock() from memory, and runs the boot sequence that fills
// the Map from whatever loader it is given (server.js passes db.loadStock). Because every
// check is a plain memory lookup, nothing on the chat or voice path ever waits on the
// database, and a slow or dead database cannot hurt call latency.
//
// The rule that makes failure safe: an item with no entry counts as in stock. An empty Map
// (no database configured, the database down at boot, nothing ever toggled) therefore
// behaves exactly like the café had no inventory tracking at all.
//
// D2 only builds and fills this state. Nothing consults isInStock() until D3.

const DEFAULT_TIMING = {
  // The boot load is allowed this long before the server starts without it. Render's own
  // cold start takes far longer than this, so waiting costs nothing noticeable.
  bootTimeoutMs: 3000,
  // Background retries and the follow-up reload get longer, since nobody is waiting on them.
  attemptTimeoutMs: 10000,
  // One extra load this long after boot, to catch a toggle that landed on the old server
  // instance during the deploy overlap, after the new instance had already read the table.
  reloadDelayMs: 60 * 1000,
  // Retry delays double from the base up to the cap.
  retryBaseMs: 5 * 1000,
  retryMaxMs: 15 * 60 * 1000
};

let stockMap = new Map();

// Pass the item's name exactly as it appears in menu.json (menuItem.name). Anything not in
// the Map, including a name that is not on the menu at all, counts as in stock.
function isInStock(itemName) {
  const state = stockMap.get(itemName);
  return state === undefined ? true : state;
}

// Replaces the whole Map in one swap, so a reader never sees a half-filled one. Rows for
// names that are not on the menu are orphans (an item renamed or removed in menu.json): they
// are reported, never stored, so they cannot affect anything.
function applyRows(rows, menuNames) {
  const known = new Set(menuNames);
  const next = new Map();
  const orphans = [];
  for (const row of rows) {
    if (!known.has(row.item_name)) {
      orphans.push(row.item_name);
      continue;
    }
    next.set(row.item_name, row.in_stock !== false);
  }
  stockMap = next;
  const outOfStock = [...next].filter(([, inStock]) => !inStock).map(([name]) => name);
  return { rows: rows.length, outOfStock, orphans };
}

class StockTimeoutError extends Error {
  constructor(ms) {
    super(`stock load did not finish within ${ms}ms`);
    this.name = 'StockTimeoutError';
    this.code = 'STOCK_LOAD_TIMEOUT';
    this.permanent = false;
  }
}

// Races a promise against a timer. The losing promise is simply abandoned: if a timed-out
// load finishes later, its result is ignored. Promise.race keeps a handler attached to it,
// so a late failure cannot become an unhandled rejection.
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new StockTimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const timers = new Set();
let retryActive = false;

// Bumped every time everything is cancelled. A load that is already in flight when that
// happens cannot be aborted, so when it finishes it compares its own generation to this one
// and, if they differ, quietly does nothing: it must not overwrite newer state, flip
// retryActive, or schedule another retry on behalf of a boot sequence that no longer exists.
let generation = 0;

// Background timers never keep the process alive on their own.
function later(fn, ms) {
  const timer = setTimeout(fn, ms);
  timer.unref();
  timers.add(timer);
  return timer;
}

// Cancels every pending retry and reload, and orphans any load still in flight. Used by
// tests, and when initStock runs again. The running server never calls it.
function stopStock() {
  for (const timer of timers) {
    clearTimeout(timer);
  }
  timers.clear();
  retryActive = false;
  generation += 1;
}

function describeError(err) {
  const code = err && err.code ? `[${err.code}] ` : '';
  return `${code}${(err && err.message) || 'unknown error'}`;
}

// Fills the Map from loadFn and starts the retry and reload timers. Always resolves and
// never throws, so a database problem can never stop the server from starting. Resolves to
// { ok } where ok says whether the boot load itself worked.
//
//   menuNames  the item names in menu.json, used to spot orphan rows
//   loadFn     async () => [{ item_name, in_stock }]
//   log        console-shaped logger (tests pass a recorder)
//   timing     overrides for DEFAULT_TIMING (tests pass tiny values)
async function initStock({ menuNames, loadFn, log = console, timing = {} }) {
  const t = { ...DEFAULT_TIMING, ...timing };
  stopStock();
  const myGeneration = generation;
  const isStale = () => myGeneration !== generation;

  // Resolves to { stale: true } if this boot sequence was cancelled while the load was in
  // flight, otherwise to { ok, ms, ... }. Callers must check stale before doing anything.
  async function attempt(timeoutMs) {
    const started = Date.now();
    try {
      const rows = await withTimeout(loadFn(), timeoutMs);
      if (isStale()) {
        return { stale: true };
      }
      const applied = applyRows(rows, menuNames);
      return { ok: true, ms: Date.now() - started, ...applied };
    } catch (err) {
      if (isStale()) {
        return { stale: true };
      }
      return { ok: false, ms: Date.now() - started, error: err };
    }
  }

  function reportLoaded(label, result) {
    const outOfStock = result.outOfStock.length
      ? ` (${result.outOfStock.length} out of stock: ${result.outOfStock.join(', ')})`
      : ' (nothing out of stock)';
    log.log(`[stock] ${label}: loaded ${result.rows} rows in ${result.ms}ms${outOfStock}`);
    for (const name of result.orphans) {
      log.warn(
        `[stock] orphan row, not in menu.json: "${name}" (ignored; if the item was renamed, ` +
        'its stock state did not move with it)'
      );
    }
  }

  function reportFailed(label, result) {
    log.error(`[stock] ${label} FAILED after ${result.ms}ms: ${describeError(result.error)}`);
  }

  function scheduleRetry(failures) {
    const delay = Math.min(t.retryMaxMs, t.retryBaseMs * 2 ** (failures - 1));
    retryActive = true;
    log.warn(`[stock] retrying in ${Math.round(delay / 1000)}s (retry ${failures})`);
    later(async () => {
      const result = await attempt(t.attemptTimeoutMs);
      if (result.stale) {
        return;
      }
      if (result.ok) {
        retryActive = false;
        reportLoaded(`retry ${failures}`, result);
        return;
      }
      reportFailed(`retry ${failures}`, result);
      if (result.error.permanent) {
        retryActive = false;
        log.error('[stock] this error will not fix itself, so background retries are now OFF');
        return;
      }
      scheduleRetry(failures + 1);
    }, delay);
  }

  const boot = await attempt(t.bootTimeoutMs);
  if (boot.stale) {
    return { ok: false };
  }
  let giveUp = false;
  if (boot.ok) {
    reportLoaded('boot', boot);
  } else {
    reportFailed('boot load', boot);
    log.error(
      '[stock] starting WITHOUT stock data: every item is being treated as in stock until a load succeeds'
    );
    if (boot.error.permanent) {
      giveUp = true;
      log.error(
        '[stock] this error will not fix itself (check DATABASE_URL and the database), so ' +
        'background retries are OFF. Fix it and restart the server.'
      );
    } else {
      scheduleRetry(1);
    }
  }

  // The one extra reload for the deploy overlap window. Skipped while the retry loop is
  // still running (it is already trying) and after a permanent failure (it would only fail
  // the same way). If it fails, the last known state simply stays in place.
  if (!giveUp) {
    later(async () => {
      if (retryActive) {
        log.log('[stock] follow-up reload skipped: boot retries are still running');
        return;
      }
      const result = await attempt(t.attemptTimeoutMs);
      if (result.stale) {
        return;
      }
      if (result.ok) {
        reportLoaded('follow-up reload', result);
      } else {
        reportFailed('follow-up reload', result);
        log.warn('[stock] keeping the last known stock state');
      }
    }, t.reloadDelayMs);
  }

  return { ok: boot.ok };
}

module.exports = { isInStock, initStock, stopStock };
