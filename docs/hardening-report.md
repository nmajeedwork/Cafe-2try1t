# 2try1t CafeBot Hardening Report (H1-H5)

Permanent record of the security hardening passes applied to the CafeBot server.
H1-H4 followed the Step 16 security audit; H5 followed a later investigation into
what an automated or spam caller could do to the phone line. Each pass was developed on its own
branch, verified with an automated test harness plus a real-world test, reviewed
as a pull request, and merged to `main` only after the user personally confirmed
the one scenario most likely to break real usage.

- **Report written:** 2026-09-09.
- **Starting point:** `main` at commit `4186b35`, the state of the server after
  the redesign work and the Step 16 audit, before any hardening.
- **End state:** `main` at commit `c8e1e68`, all four passes merged. H5 was added
  on 2026-10-04 and merged as `50a439d`.
- **Scope:** `server.js` throughout, plus `elevenlabs-tts.js` (H4, H5) and
  `package.json` / `package-lock.json` (H1, one new dependency). No changes to
  `voice-order-recovery.js`, the Anthropic tool-use logic, the prompts, the
  menu/deal data, or the static site pages.

| Pass | Branch | Feature commit | PR | Merge commit | Date |
|---|---|---|---|---|---|
| H1 | `harden-rate-limiting`     | `595a9b2` | [#5](https://github.com/nmajeedwork/Cafe-2try1t/pull/5) | `e850752` | 2026-09-05 |
| H2 | `harden-env-gating`        | `316e806` | [#6](https://github.com/nmajeedwork/Cafe-2try1t/pull/6) | `cdf102b` | 2026-09-05 |
| H3 | `harden-session-cookie`    | `2049cce` | [#7](https://github.com/nmajeedwork/Cafe-2try1t/pull/7) | `871099f` | 2026-09-09 |
| H4 | `harden-audio-signed-urls` | `60d5843` | [#8](https://github.com/nmajeedwork/Cafe-2try1t/pull/8) | `c8e1e68` | 2026-09-09 |
| H5 | `harden-voice-limits`      | `5a2276a` | [#15](https://github.com/nmajeedwork/Cafe-2try1t/pull/15) | `50a439d` | 2026-10-04 |

A safe-by-default principle runs through H1-H4: anything that is not
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

## H5 - Voice-call abuse limits and voice robustness

**PR [#15](https://github.com/nmajeedwork/Cafe-2try1t/pull/15), feature commit `5a2276a`, merged as `50a439d`.**
Files: `server.js`, `elevenlabs-tts.js`.

### Audit finding

A read-only investigation asked what happens when a robocall, a silent call, or
a recording playing on a loop dials the café's Twilio number. It found:

- **Nothing bounded a single call.** There was no cap on Claude turns or call
  length, and Claude itself cannot end a call. A clearly spoken recording became
  a billed Claude turn plus a fresh ElevenLabs generation on every pass, for as
  long as the caller stayed on the line. Estimated worst case: about $0.25 to
  $0.75 per minute per call across Twilio, Anthropic, and ElevenLabs.
- **A noisy line looped forever.** Speech below the 0.28 confidence guard got a
  cached "didn't quite catch that" reprompt with no limit. Worse, it reset the
  silence counter first, so a line full of hum or music could never reach the
  silence limit either.
- **No timeouts.** The ElevenLabs request had no timeout, and the voice Claude
  turn used the SDK default (10 minutes, retried). Either one hanging could hold
  a webhook past Twilio's 15-second deadline, which drops the call with Twilio's
  generic "application error" message.
- **Withheld numbers shared one saved order.** The in-progress order file is
  keyed on the caller's number, so every caller who withheld theirs mapped to the
  same file, and one could be offered another's abandoned cart.
- **Sessions leaked on hangup.** A call's in-memory state was only deleted when
  it ended through one of the app's own paths. A caller who just hung up left
  theirs, conversation history included, in memory until the next restart.
- The voice routes have no rate limiting and nothing is keyed on the caller's
  number. That was confirmed, and left as a separate future decision (see
  "Not in this pass" below).

### Implemented

- **Per-call hard caps**, tracked on each call's own state and configurable via
  environment variables. A missing, non-numeric, zero, or negative value falls
  back to the default.
  - `MAX_CALL_TURNS`: 30 Claude turns per call. Checked before a turn starts, so
    nothing is spent past the cap. A full real order is around 15 turns.
  - `MAX_CALL_MINUTES`: 12 minutes, measured from the first `/voice/incoming`
    webhook for that call. Checked first on every webhook.
  - `MAX_GARBLED_IN_ROW`: 4 garbled-speech reprompts in a row. Only understood
    speech resets the count, so silence and barge-in noise in between can't
    reset it.
- **Ending a call on a cap.** A polite cached goodbye, then `<Hangup/>`, then the
  call's state is cleared. If an unconfirmed order is in the cart, it is saved
  synchronously before the reply is sent, and the goodbye says the caller can call
  back within 15 minutes to pick it up. Saving also restarts the 15-minute resume
  window. A withheld caller has nothing saved, so they hear a plain goodbye
  instead of a promise that couldn't be kept.
- **Silence-counter fix.** The silence and garbled counters now reset only after
  speech passes the noise and confidence checks, so garbled speech no longer
  resets the silence counter.
- **Timeouts, kept inside Twilio's 15-second webhook deadline.**
  - ElevenLabs requests abort after 8 seconds (`AbortController`, covering the
    body download too) and fall back to Twilio `<Say>`.
  - A voice Claude turn is raced against a 10-second deadline (every tool round
    and SDK retry included), and its in-flight requests are aborted. A timeout
    takes the existing "having trouble right now" path and the call continues.
  - `/voice/continue`, which waits for Claude and then voices the reply inside
    one webhook, has a 13-second budget. The reply's ElevenLabs request gets only
    what is left of it. Worst case answers in about 13 seconds.
  - `/chat` is unchanged.
- **Withheld-number handling.** No saved order is read or written when the
  caller's number is missing, isn't valid E.164, or is one of Twilio's
  keypad-spelled placeholders for a withheld caller ID (`+266696687` spells
  ANONYMOUS, plus RESTRICTED, BLOCKED, and UNAVAILABLE). Twilio sends the
  placeholder, not the word, which is why an E.164 check alone wasn't enough.
- **Idle-session sweep.** An unref'd timer runs every 5 minutes and removes call
  state idle for more than 30 minutes. A live call is never swept, since every
  `<Gather>` calls back within 10 seconds and the 12-minute cap ends calls well
  before 30. No Twilio console setting is needed.

### Verification

Automated harness, zero Anthropic, ElevenLabs, or Twilio spend: signed Twilio
webhooks (generated with Twilio's own signing function), a fake Anthropic API
reached through `ANTHROPIC_BASE_URL` so the real SDK ran, a fake ElevenLabs
endpoint, and child servers started from a directory with no `.env`. **52 of 52
checks passed**, plus the 14 hours regression tests.

| Area | Result |
|---|---|
| turn cap (lowered to 3) | 4th utterance ended with the goodbye and `<Hangup/>`; 0 Claude requests past the cap; state cleared |
| duration cap (lowered to 3 seconds) | next webhook ended the call, checked before silence handling |
| garbled cap (lowered to 2) | 3rd garbled result in a row ended the call |
| order in progress at a cap | order file on disk before the hangup reply; calling back resumed it |
| default values | confirmed exactly 30 turns, 12 minutes, 4 garbled; invalid env values fall back to them |
| silence-counter fix | silence, garbled, silence, garbled, silence now ends via the silence limit; understood speech still resets it |
| continuous noise arriving mid-prompt | still ended via the garbled cap |
| withheld numbers (6 forms, including `+266696687` and a missing number) | no resume offered, nothing saved; normal callers unchanged |
| ElevenLabs hang | fell back to `<Say>` in about 8 seconds and the call continued, on both cached and per-call audio |
| Claude hang | "having trouble right now" at about 10 seconds; the in-flight request was aborted; the next turn worked |
| worst case (Claude at 9.5 seconds plus ElevenLabs hang) | answered in 13.0 seconds |
| normal 15-turn order, default limits | confirmed order, no cap hit, ended with the normal farewell |
| idle sweep | session idle 29 minutes kept, 31 minutes removed |
| H1-H4 regression | voice signature checks (403 on bad or missing), `/chat` limit and cookie flags, signed audio 404 on tamper, production start-up guards: all unchanged |

- **Real phone calls:** the user verified the deployed build with live calls: a
  normal order, a call from a hidden number, and a cap test.

### Not in this pass

Per-caller rate limiting and blocking of repeat callers were identified as
options but not built. Neither limits a single call, and both need a policy for
withheld numbers and storage that survives Render deploys.

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
| `MAX_CALL_TURNS` | H5 | `30` | Claude turns per phone call before it ends with the goodbye |
| `MAX_CALL_MINUTES` | H5 | `12` | phone call length from the first webhook; decimals allowed |
| `MAX_GARBLED_IN_ROW` | H5 | `4` | garbled-speech reprompts in a row before the call ends |

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
6. Leave `MAX_CALL_TURNS`, `MAX_CALL_MINUTES`, and `MAX_GARBLED_IN_ROW` unset to
   use the defaults, and remove any lowered values left over from testing.
