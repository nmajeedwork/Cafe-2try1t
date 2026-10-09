// All database access for CafeBot lives in this file, and it is the only file that imports
// pg. Everything else (stock.js, server.js) works with plain rows and plain errors, so
// swapping the database vendor later means changing this file and DATABASE_URL, nothing else.
//
// Vendor: Neon Postgres (see docs/inventory-plan.md). Two things about Neon shape this file:
//
//   1. Compute hours. Neon's free plan has 100 compute-hours a month, and a compute scales
//      to zero after 5 minutes with no activity. Neon's docs say a compute will not suspend
//      while it has active connections, and they do not say whether a plain idle connection
//      counts. So this file assumes it might, and never keeps a connection open: a tiny pool
//      (max 2) whose idle connections close after 1 second. Between the boot load and an
//      admin toggle, nothing is connected and Neon is free to sleep.
//
//   2. The pooled connection string goes through PgBouncer in transaction mode. That rules
//      out SET statements, session state, and named prepared statements. Every query here is
//      a plain parameterized statement, which is fine. statement_timeout is deliberately NOT
//      set: pg would send it as a startup parameter, which the pooler rejects. The client
//      side query_timeout below does the same job.
//
// Secrets: the connection string (and the user, password and host inside it) must never
// reach a log. Every error leaves this file through toDbError(), which strips all of them
// out of the message first, and nothing here ever logs the raw error object or its stack.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');

// What an error from this file looks like to callers: a message that is safe to log, a
// short code, and whether retrying could ever help. permanent means a person has to fix
// something (wrong password, no such database, no permission, no DATABASE_URL), so
// retrying in the background would only wake the database for nothing.
class DbError extends Error {
  constructor(message, { code, permanent }) {
    super(message);
    this.name = 'DbError';
    this.code = code;
    this.permanent = permanent;
  }
}

// Postgres SQLSTATE class 28 is "invalid authorization"; 3D000 is "no such database";
// 42501 is "permission denied".
function isPermanentCode(code) {
  return code === 'NO_DATABASE_URL' || code === '3D000' || code === '42501' || code.startsWith('28');
}

// Everything in the connection string that must never be logged: the whole string, plus the
// user, password and host on their own (error messages from the driver and the network
// layer quote those individually, e.g. 'password authentication failed for user "x"' or
// 'getaddrinfo ENOTFOUND host'), in both raw and percent-decoded form.
function secretsFrom(connectionString) {
  const secrets = new Set();
  if (!connectionString) {
    return [];
  }
  secrets.add(connectionString);
  try {
    const url = new URL(connectionString);
    const parts = [url.username, url.password, url.hostname, url.hostname.replace(/^\[|\]$/g, '')];
    for (const part of parts) {
      if (!part) continue;
      secrets.add(part);
      try {
        secrets.add(decodeURIComponent(part));
      } catch {
        // not valid percent-encoding, the raw form is already in the set
      }
    }
  } catch {
    // Not parseable as a URL. The whole string is still redacted above.
  }
  // Longest first, so the whole string is replaced before any piece of it.
  return [...secrets].filter(Boolean).sort((a, b) => b.length - a.length);
}

function redact(text, connectionString = process.env.DATABASE_URL) {
  let out = String(text);
  for (const secret of secretsFrom(connectionString)) {
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

function toDbError(err) {
  if (err instanceof DbError) {
    return err;
  }
  const code = err && err.code ? String(err.code) : 'UNKNOWN';
  let message = (err && err.message) || '';
  // Node's connect errors can arrive as an AggregateError with an empty message (it tried
  // both ::1 and 127.0.0.1, say). The useful text is on the inner errors.
  if (!message && err && Array.isArray(err.errors)) {
    message = err.errors.map((inner) => inner && inner.message).filter(Boolean).join('; ');
  }
  if (!message) {
    message = code;
  }
  return new DbError(redact(message), { code, permanent: isPermanentCode(code) });
}

// SSL is always on and the certificate is always verified, whatever the URL says. pg lets
// an sslmode in the URL override the ssl option below (sslmode=disable would silently turn
// TLS off, and sslmode=require makes pg print a security warning), so those parameters are
// dropped from the URL and the explicit option is the only SSL setting in play.
function withoutSslParams(connectionString) {
  const queryStart = connectionString.indexOf('?');
  if (queryStart === -1) {
    return connectionString;
  }
  const kept = connectionString
    .slice(queryStart + 1)
    .split('&')
    .filter((pair) => !/^(sslmode|ssl|uselibpqcompat)(=|$)/i.test(pair));
  const base = connectionString.slice(0, queryStart);
  return kept.length ? `${base}?${kept.join('&')}` : base;
}

// Built on first use, not at require time, so requiring this file (tests, or a boot with
// DATABASE_URL unset) never touches the network or throws.
let pool = null;

function getPool() {
  if (pool) {
    return pool;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new DbError('DATABASE_URL is not set', { code: 'NO_DATABASE_URL', permanent: true });
  }
  pool = new Pool({
    connectionString: withoutSslParams(connectionString),
    ssl: { rejectUnauthorized: true },
    // Boot load and an occasional admin toggle never need more than one connection at a
    // time. A second covers an overlap, and a hard cap protects Neon's connection limits.
    max: 2,
    // The compute-hours setting: an idle connection is closed 1 second after use.
    idleTimeoutMillis: 1000,
    // Bounds on a dead or slow database. Both are inside the 3 second boot budget (see
    // stock.js), and no voice or chat request ever waits on this file.
    connectionTimeoutMillis: 3000,
    query_timeout: 3000,
    // Never let an idle pool keep the process alive on its own.
    allowExitOnIdle: true
  });
  // Without a listener, a connection that dies while idle (Neon closing it as the compute
  // scales to zero, say) emits an 'error' event that crashes the whole server.
  pool.on('error', (err) => {
    console.warn(`[db] idle connection error (ignored): ${toDbError(err).message}`);
  });
  return pool;
}

let schemaReady = false;

// Creates the table if it is missing. This is what makes a production seed step
// unnecessary: the first boot against an empty database builds the table, and rows only
// ever appear when someone toggles an item. If two server instances boot at the same moment
// (the deploy overlap) the second CREATE can lose a race and fail once, and the boot retry
// or the follow-up reload simply tries again.
async function ensureSchema(db) {
  if (schemaReady) {
    return;
  }
  await db.query(SCHEMA_SQL);
  schemaReady = true;
}

async function run(work) {
  try {
    return await work(getPool());
  } catch (err) {
    // 42P01 is "table does not exist": it was dropped behind our back, so build it again
    // the next time instead of trusting the cached flag.
    if (err && err.code === '42P01') {
      schemaReady = false;
    }
    throw toDbError(err);
  }
}

// Returns every stock row as [{ item_name, in_stock }]. Items with no row are not
// returned, and callers treat them as in stock.
function loadStock() {
  return run(async (db) => {
    await ensureSchema(db);
    const { rows } = await db.query('SELECT item_name, in_stock FROM stock');
    return rows.map((row) => ({ item_name: row.item_name, in_stock: row.in_stock }));
  });
}

// Upsert: works whether or not the item has a row yet, so nothing has to be seeded.
async function setStock(itemName, inStock) {
  if (typeof itemName !== 'string' || itemName.length === 0) {
    throw new TypeError('setStock: itemName must be a non-empty string');
  }
  if (typeof inStock !== 'boolean') {
    throw new TypeError('setStock: inStock must be a boolean');
  }
  await run(async (db) => {
    await ensureSchema(db);
    await db.query(
      `INSERT INTO stock (item_name, in_stock, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (item_name)
       DO UPDATE SET in_stock = EXCLUDED.in_stock, updated_at = now()`,
      [itemName, inStock]
    );
  });
}

// Removes a row, which puts the item back to the default (in stock). Returns how many rows
// were deleted. Used to clean up orphan rows and by the tests.
function deleteStock(itemName) {
  return run(async (db) => {
    await ensureSchema(db);
    const result = await db.query('DELETE FROM stock WHERE item_name = $1', [itemName]);
    return result.rowCount;
  });
}

module.exports = {
  loadStock,
  setStock,
  deleteStock,
  // Exported only so the tests can exercise the redaction and the SSL handling directly.
  // Nothing in the app uses these.
  __test: { redact, withoutSslParams }
};
