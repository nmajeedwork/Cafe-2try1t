// The customer (browser chat) session: cookie options, an explicit in-memory store, and D7
// expiry and pruning (see docs/inventory-plan.md). The admin session is separate (admin.js)
// and phone calls use their own CallSid sessions in server.js; neither goes through here.
//
// Before D7 the cookie had no maxAge, so a session lasted until the browser closed but the
// store kept it forever, and every visitor who ever chatted stayed in memory until a
// restart. Now:
//   - cookie.maxAge is 2 hours. With resave false the expiry moves forward every time the
//     session changes (every /chat turn), so a session ends 2 hours after the last change.
//   - the store is an explicit express-session MemoryStore. MemoryStore deletes an expired
//     session when it reads it, and store.all() reads every session, so calling it on a
//     timer is the prune. The timer is unref'd, so it never keeps the process alive.
//
// express-session still prints its "MemoryStore is not designed for a production
// environment" warning in production: it checks for this store class, whoever created it.
// The leak it warns about is what the expiry and prune fix; one app instance keeping
// short-lived sessions in memory is accepted (a database store would be a new dependency).

const session = require('express-session');

const CUSTOMER_SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const CUSTOMER_SESSION_PRUNE_INTERVAL_MS = 10 * 60 * 1000;

function createCustomerSession({
  isDev,
  secret,
  maxAgeMs = CUSTOMER_SESSION_MAX_AGE_MS,
  pruneIntervalMs = CUSTOMER_SESSION_PRUNE_INTERVAL_MS
}) {
  const store = new session.MemoryStore();
  const middleware = session({
    secret,
    store,
    resave: false,
    // H3 hardening (security audit follow-up): only issue a session cookie once
    // something has actually been written to req.session (first cart action or chat
    // message). Someone who only browses Home/Menu/About never gets a cookie.
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      // secure requires HTTPS, which plain localhost dev doesn't have; drop it only
      // for explicit NODE_ENV=development. Anywhere else (unset, production, a typo)
      // is assumed to sit behind TLS terminated at the proxy in front of this app.
      secure: !isDev,
      // Same-origin app (widget + site on one domain); Twilio webhooks are
      // signature-authenticated, not cookie-based. 'lax' is the correct default.
      sameSite: 'lax',
      maxAge: maxAgeMs
    }
  });

  const prune = () => store.all(() => {});
  const timer = setInterval(prune, pruneIntervalMs);
  timer.unref();

  return { middleware, store, prune, timer, stop: () => clearInterval(timer) };
}

module.exports = { createCustomerSession, CUSTOMER_SESSION_MAX_AGE_MS, CUSTOMER_SESSION_PRUNE_INTERVAL_MS };
