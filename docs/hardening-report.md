# 2try1t CafeBot Hardening Report (H1-H4)

Permanent record of the four security hardening passes applied to the CafeBot
server after the Step 16 security audit. Each pass was developed on its own
branch, verified with an automated test harness plus a real-world test, reviewed
as a pull request, and merged to `main` only after the user personally confirmed
the one scenario most likely to break real usage.

- **Report written:** 2026-09-09.
- **Starting point:** `main` at commit `4186b35`, the state of the server after
  the redesign work and the Step 16 audit, before any hardening.
- **End state:** `main` at commit `c8e1e68`, all four passes merged.
- **Scope:** `server.js` throughout, plus `elevenlabs-tts.js` (H4) and
  `package.json` / `package-lock.json` (H1, one new dependency). No changes to
  `voice-order-recovery.js`, the Anthropic tool-use logic, the menu/deal data,
  or the static site pages.

| Pass | Branch | Feature commit | PR | Merge commit | Date |
|---|---|---|---|---|---|
| H1 | `harden-rate-limiting`     | `595a9b2` | [#5](https://github.com/nmajeedwork/Cafe-2try1t/pull/5) | `e850752` | 2026-09-05 |
| H2 | `harden-env-gating`        | `316e806` | [#6](https://github.com/nmajeedwork/Cafe-2try1t/pull/6) | `cdf102b` | 2026-09-05 |
| H3 | `harden-session-cookie`    | `2049cce` | [#7](https://github.com/nmajeedwork/Cafe-2try1t/pull/7) | `871099f` | 2026-09-09 |
| H4 | `harden-audio-signed-urls` | `60d5843` | [#8](https://github.com/nmajeedwork/Cafe-2try1t/pull/8) | `c8e1e68` | 2026-09-09 |

A safe-by-default principle runs through all four: anything that is not
explicitly `NODE_ENV=development` (unset, `production`, a typo) is treated as
production and locked down. The permissive state is never the default.

---

## H1 - Rate limiting on the token-spending endpoints

**PR [#5](https://github.com/nmajeedwork/Cafe-2try1t/pull/5), feature commit `595a9b2`, merged as `e850752`.**
Files: `server.js`, `package.json`, `package-lock.json`. New dependency:
`express-rate-limit` `^8.7.0`.

### Audit finding

`POST /chat` (browser widget) and `POST /dev/voice-chat` (voice-prompt tester)
are unauthenticated and call the Anthropic API on every request. Neither had any
rate limiting, so a scripted flood against either endpoint could run up an
unbounded Anthropic bill. A secondary finding: `app.set('trust proxy', true)`
trusted the entire `X-Forwarded-For` chain, letting any client spoof `req.ip`
and defeat a per-IP limiter.

### Implemented

- **Per-IP limiter:** 20 requests per minute per IP (`RATE_LIMIT_MAX` /
  `RATE_LIMIT_WINDOW_MS`, defaults 20 and 60000), shared across both endpoints so
  a caller cannot bypass it by alternating between them. On exceed, HTTP 429 with
  a fixed JSON body: `{ "error": "Too many requests, please slow down and try again shortly." }`.
- **Global limiter:** a second layer, 100 requests per minute across both
  endpoints combined regardless of IP (`RATE_LIMIT_GLOBAL_MAX`, default 100),
  using a single fixed bucket key so a distributed flood from many IPs still
  cannot drive unbounded spend. Per-IP runs first, so one abusive client is cut
  off before it eats the shared budget.
- **Scope held tight:** only the two cost endpoints are limited. `GET /`,
  `/menu`, `/order`, `/about`, `/api/menu` and every `/voice/*` webhook are
  untouched.
- **Trust proxy narrowed** from `true` to `1` (`server.js:836`): trust exactly
  one proxy hop (the ngrok edge in dev, a single load balancer in prod).
  `req.ip` is now the real client address; `req.protocol` still resolves from the
  one trusted hop's `X-Forwarded-Proto`, so Twilio signature validation is
  unaffected.

### Verification

- **Flood test (automated):** 25 rapid requests to `/chat` against a running dev
  server. First 20 returned normally, requests 21 to 25 returned 429 with the
  exact custom body. Boundary confirmed: request 20 passed, request 21 was the
  first 429.
- **Normal-use test (automated):** requests at a human pace stayed well under the
  limit and were unaffected. A separate check confirmed `GET /`, `/menu`,
  `/order`, `/about`, `/api/menu` and the Twilio voice routes are never limited.
- **Global-layer test (automated):** combined traffic across both endpoints from
  varied IPs tripped the 100-per-minute global bucket as designed.
- **Boot regression:** the first boot after adding the limiter threw
  `ERR_ERL_PERMISSIVE_TRUST_PROXY` (a warning, not fatal) because of
  `trust proxy: true`. Fixed by narrowing to `1`; re-verified across three clean
  boots with no warning.
- **Twilio path (simulated):** 8 of 8 checks passed using raw `http.request` to
  reproduce the Twilio to ngrok forwarding, including a genuine signature
  computed against the public HTTPS URL and a multi-hop `X-Forwarded-For` spoof
  that still validated.
- **Real phone call:** the user placed a live call through ngrok while the server
  log was watched. Every `/voice/*` webhook was accepted and signature-validated,
  0 rejections, confirming the narrowed trust setting did not break the real
  Twilio path.
- **User's own test:** before merging, the user ran their own normal browser-chat
  session to confirm a misconfigured limiter was not silently breaking real use.

---

## H2 - Environment gating for dev-only affordances

**PR [#6](https://github.com/nmajeedwork/Cafe-2try1t/pull/6), feature commit `316e806`, merged as `cdf102b`.**
File: `server.js`.

### Audit finding

The dev-only affordances in `server.js` had no `NODE_ENV` gating at all:

1. `POST /dev/voice-chat` answered in every environment, including production.
2. The `DISABLE_HOURS_CHECK` and `FORCE_HOURS_CLOSED` overrides (which switch off
   real operating-hours enforcement, or force every check to report closed) took
   effect in every environment. The only guard was a startup `console.warn` that
   let the server run anyway, so a misconfigured deploy could put a live cafe
   into taking orders 24/7 or refusing every order.

### Implemented

- **`/dev/voice-chat` gated at registration time.** The route is wrapped in
  `if (IS_DEV) { ... }`, where `IS_DEV` is `process.env.NODE_ENV === 'development'`.
  Anywhere else, the path is simply unknown to Express and returns its normal
  404, as if the route were never written. The H1 rate-limiter middleware is not
  wired onto it outside development either.
- **Hard startup failure on misconfigured overrides.** Before Express is
  configured and long before `app.listen`, the server checks: if
  `DISABLE_HOURS_CHECK === 'true'` or `FORCE_HOURS_CLOSED === 'true'` and
  `NODE_ENV` is not `development`, it prints
  `FATAL: DISABLE_HOURS_CHECK/FORCE_HOURS_CLOSED must not be set outside development. Refusing to start.`
  and calls `process.exit(1)`. No request is ever served.
- Both guards carry a comment referencing this Step 16 finding. The old
  `console.warn` blocks were left in place; they now only ever run in
  development, since any non-dev process with those vars set has already exited.

### Verification

Six scenarios, all via an automated harness. The "NODE_ENV unset" cases run the
child server from a working directory with a `NODE_ENV`-stripped `.env` copy,
because the project `.env` pins `NODE_ENV=development` and dotenv will not unset
an already-set value.

| # | Scenario | Result |
|---|---|---|
| a | `NODE_ENV=development` | `/dev/voice-chat` registered (empty body returns 400, not 404); `DISABLE_HOURS_CHECK` / `FORCE_HOURS_CLOSED` allowed, server starts |
| b | `NODE_ENV` unset entirely | `/dev/voice-chat` returns 404; `/chat` still works; `GET /api/menu` returns 200 |
| c | `NODE_ENV=production`, no override vars | server starts; `/dev/voice-chat` returns 404 |
| d | `NODE_ENV=production` + `DISABLE_HOURS_CHECK=true` | process exits code 1 with the exact FATAL message; port never opens |
| e | `NODE_ENV=production` + `FORCE_HOURS_CLOSED=true` | same refusal, exit 1, port never opens |
| f | `NODE_ENV=production`, normal | `/chat`, the Twilio routes and the H1 rate limiter all still work (20 pass then 5 return 429) |

- **Real phone call:** the user placed a live call on the H2 branch. The full
  voice order flow worked end to end, confirming the gating did not affect the
  real Twilio voice path (which was never dev-gated).
- **User's own test:** the user verified scenario (a) on their own machine, since
  that is the one that has to keep working for local development.

---

## H3 - Session cookie and secret hardening

**PR [#7](https://github.com/nmajeedwork/Cafe-2try1t/pull/7), feature commit `2049cce`, merged as `871099f`.**
File: `server.js`.

### Audit finding

The `express-session` configuration had three weaknesses:

1. A hardcoded fallback secret, `process.env.SESSION_SECRET || 'dev-secret'`,
   that would silently be used in production if `SESSION_SECRET` was never set,
   making session cookies forgeable by anyone who read the source.
2. The cookie set only `httpOnly: true`. No `secure` flag (so the session cookie
   could travel over plain HTTP) and no `sameSite` attribute.
3. `saveUninitialized: true`, so a session cookie was issued on every page load,
   including to visitors who only browse Home, Menu or About and never start an
   order.

### Implemented

- **Weak-secret startup guard.** Same location and pattern as the H2 hours guard:
  if `SESSION_SECRET` is unset or equals the literal `dev-secret` and
  `NODE_ENV` is not `development`, the server prints
  `FATAL: SESSION_SECRET must be set to a real secret outside development (not unset, not "dev-secret"). Refusing to start.`
  and exits code 1 before listening. Gated on `!IS_DEV` so unset or mistyped
  `NODE_ENV` also triggers it.
- **Cookie flags:**
  - `secure: !IS_DEV`. HTTPS-only outside explicit development. Localhost dev,
    which has no TLS, still works.
  - `sameSite: 'lax'`. This is a same-origin app and Twilio's requests are
    signature-authenticated, not cookie-based, so `lax` is the correct standard
    choice.
  - `httpOnly: true` unchanged.
- **`saveUninitialized: false`.** A session cookie is now issued only once
  something is written to `req.session` (the first cart action or chat message).
  Browsing the static pages sets no cookie.

### Verification

Ten scenarios via an automated harness. Anthropic was stubbed with a
deterministic module replacement, so the real cart and order logic ran on zero
tokens. Each child server was spawned with an explicit environment and a
`.env`-free working directory so dotenv could not smuggle in the real secret.

| # | Scenario | Result |
|---|---|---|
| a | `NODE_ENV=development`, `SESSION_SECRET` unset | starts, `dev-secret` fallback allowed |
| b | `NODE_ENV=production`, `SESSION_SECRET` unset | exits code 1, exact FATAL message, port never binds |
| c | `NODE_ENV=production`, `SESSION_SECRET='dev-secret'` | same refusal |
| d | `NODE_ENV=production`, real `SESSION_SECRET` | starts normally |
| e | browse `/`, `/menu`, `/about`, `/api/menu` | all 200, no `Set-Cookie` on any |
| f | start a conversation on `/chat` | first `/chat` sets the cookie; second request with it sees the persisted cart; a cookie-less request gets its own fresh cart |
| g | inspect the `Set-Cookie` header directly | dev: `Path=/; HttpOnly; SameSite=Lax` (no `Secure`); production over `X-Forwarded-Proto: https`: adds `Secure`; production over plain HTTP: no cookie sent |
| h | full order flow: add item, set pickup type, confirm | item added, type persisted across requests, `confirm_order` returned `confirmed: true` with an order ID, cart intact, post-confirm mutation correctly rejected |
| i | `NODE_ENV` unset entirely, `SESSION_SECRET` unset | now refuses to start (the earlier production-only draft would have started silently) |
| j | `NODE_ENV` unset, request over `X-Forwarded-Proto: https` | cookie now includes `Secure` (the earlier draft would have omitted it) |

Scenarios (i) and (j) were added after the user caught that the first
implementation keyed off `=== 'production'` rather than `!== 'development'`, which
would have left an unset `NODE_ENV` in the permissive state. Both guards were
changed to the safe-by-default `!IS_DEV` pattern.

- **User's own test:** the user ran a real order flow through the browser widget
  before merging, since scenario (h) is the one change with genuine behavioral
  risk under `saveUninitialized: false`.

---

## H4 - Signed, expiring URLs for per-call TTS audio

**PR [#8](https://github.com/nmajeedwork/Cafe-2try1t/pull/8), feature commit `60d5843`, merged as `c8e1e68`.**
Files: `elevenlabs-tts.js`, `server.js`.

### Audit finding

`public/audio/dynamic/` holds CafeBot's freshly generated spoken replies, which
can contain caller PII: name, delivery address, pickup time, order total. These
files were served by the blanket `express.static` mount as plain, unauthenticated
HTTP GETs, fetchable for the file's whole lifetime (then 5 minutes) by anyone who
obtained the URL from Twilio's debugger logs, the ngrok request inspector, or a
network capture. The filename included the Twilio CallSid and 32 bits of
randomness, which defeats guessing but does nothing against a leaked URL.

An investigation pass confirmed the surrounding facts before any fix:

- Twilio fetches `<Play>` media with an unauthenticated GET and does not sign its
  own outbound media requests, so a login cannot be required.
- Files are already cleaned up: a per-file `setTimeout` unlink, plus a full sweep
  of the directory on every process start. `voice-order-recovery.js` never reads
  an audio file; each dynamic file is genuinely single-use.
- `public/audio/cache/` holds only generic, reusable phrases (greeting,
  farewells, filler) with no caller data, and does not need to change.

### Implemented

- **HMAC-signed expiry token.** `getDynamicAudioUrl` now appends
  `?exp=<epoch-ms>&sig=<hmac>` to the returned URL. The signature is
  `HMAC-SHA256("<filename>:<expiresAt>", SESSION_SECRET)`, binding the token to
  one file and one expiry instant. Expiry is 120 seconds from generation, which
  is generous given Twilio fetches within a few seconds. `SESSION_SECRET` is a
  safe signing key here because H3 guarantees it is strong outside development.
- **Guarded route replaces static serving for that subtree.**
  `app.get('/audio/dynamic/:filename', ...)` is registered before
  `express.static` and never calls `next()`, so static never sees these paths. It
  validates the filename shape, recomputes and constant-time-compares the HMAC,
  checks the expiry, then streams the file.
- **Uniform generic 404.** Every failure mode (expired, bad signature, missing
  params, mis-shaped or unknown filename, file already deleted, path traversal
  attempt) returns the identical `404 Not found`, so a probe cannot learn whether
  a URL was ever valid.
- **TTL shortened** from 5 minutes to 2 minutes (`DYNAMIC_FILE_TTL_MS`), matching
  the token lifetime, so a leaked URL fails twice over: expired signature and
  missing file. The per-file `setTimeout` unlink and the startup sweep are
  otherwise unchanged.
- **`cache/` untouched.** Cached phrases are still served unsigned by
  `express.static` exactly as before.

### Verification

Automated harness, zero Anthropic or ElevenLabs spend (the ElevenLabs `fetch`
was stubbed in-process to exercise the real signing path; known bytes were
written straight into the dynamic directory for the route tests).

| Case | Result |
|---|---|
| valid, unexpired signed URL | 200, response body byte-identical to the file, `Content-Type: audio/mpeg` |
| signature modified | 404 `Not found` (also tested a wrong but correct-length signature) |
| correct signature, expiry in the past | 404 `Not found` |
| no query string at all | 404 (proves `express.static` no longer serves this subtree) |
| `exp` without `sig`, or `sig` without `exp` | 404 |
| signature minted for a different filename | 404 |
| valid signature, file absent from disk | 404 (via the `sendFile` error callback) |
| `..%2f..%2fserver.js` traversal | 404 |
| all failure responses | byte-identical `Not found` body |
| cache file fetched with no signature | 200, exact bytes, still served by `express.static` |
| `POST /chat` empty body | 400 `Message is required.` (browser path unaffected) |
| `GET /`, `/menu`, `/api/menu` | 200 |
| cross-process check | a URL signed by the real function in a separate process was accepted by the running server and served the file, confirming sign and verify agree |

- **Real phone call:** the user placed a live call through ngrok. A full 15-turn
  order completed (2 chocolate chip cookies plus one small orange juice, pickup
  7 PM under the name Alex, total 9 dollars 50, confirmation `2TRY1T-NDIAS9`),
  and the post-confirm "can I add one more" was correctly rejected as locked. The
  ngrok request inspector showed:
  - `POST /voice/incoming` and all 31 following `/voice/*` webhooks: 200.
  - **16 of 16** `GET /audio/dynamic/...?exp=...&sig=...` requests: **200**. Every
    signed URL was fetched successfully by Twilio. Zero 404s, zero ElevenLabs
    `<Say>` fallbacks.
  - `GET /audio/cache/...` requests: 200 or 304, unsigned, unchanged.
  - A sampled request confirmed `exp - file_creation_timestamp` was about
    120,600 ms, the expected 120-second window.

---

## Environment variables introduced or newly load-bearing

| Variable | Introduced / affected by | Default | Behavior |
|---|---|---|---|
| `RATE_LIMIT_WINDOW_MS` | H1 | `60000` | sliding window for both rate-limit layers |
| `RATE_LIMIT_MAX` | H1 | `20` | per-IP requests per window |
| `RATE_LIMIT_GLOBAL_MAX` | H1 | `100` | combined requests per window across all IPs |
| `NODE_ENV` | H2, H3, H4 | unset (treated as production) | `development` unlocks `/dev/voice-chat`, the hours overrides, the `dev-secret` fallback, and disables the `secure` cookie flag |
| `DISABLE_HOURS_CHECK` | H2 | unset | `true` outside development refuses startup |
| `FORCE_HOURS_CLOSED` | H2 | unset | `true` outside development refuses startup |
| `SESSION_SECRET` | H3, reused by H4 | `dev-secret` fallback, dev only | must be a real secret outside development or the server refuses to start; also the HMAC key for signed audio URLs |

## Deploying to production: checklist

1. Set `NODE_ENV=production` (or anything that is not `development`).
2. Set `SESSION_SECRET` to a real random secret. The server will refuse to start
   without it.
3. Do not set `DISABLE_HOURS_CHECK` or `FORCE_HOURS_CLOSED`. The server will
   refuse to start if either is `true`.
4. Ensure exactly one trusted proxy hop terminates TLS in front of the app, so
   `trust proxy: 1` resolves `req.ip` and `req.protocol` correctly.
5. Optionally tune `RATE_LIMIT_MAX` and `RATE_LIMIT_GLOBAL_MAX` for expected
   traffic.
