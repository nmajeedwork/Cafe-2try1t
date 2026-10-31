# 2try1t CafeBot Hardening Report (H1-H5, then D2 to D7)

Permanent record of the security hardening passes applied to the CafeBot server.
H1-H4 followed the Step 16 security audit; H5 followed a later investigation into
what an automated or spam caller could do to the phone line. The stock database,
the admin login and the final D7 security pass came later and are recorded in
"D2 to D7 changes" after H5. Each pass was developed on its own
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
  unaffected. (Superseded later: the hop count became the `TRUST_PROXY_HOPS`
  setting, which is 3 on Render. See "D2 to D7 changes".)

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

## D2 to D7 changes

After H5 the project added stock tracking (D2 to D6, designed in
[inventory-plan.md](inventory-plan.md)) and then ran a final security pass over all of it
(D7). This section records what shipped, what the D7 review found, and what is still open.
Line numbers are for `main` at `8c3b4a2`.

### Pull requests

| Milestone | Branch | PR | Merge commit | Merged |
|---|---|---|---|---|
| D2 stock database | `d2-stock-db` | [#17](https://github.com/nmajeedwork/Cafe-2try1t/pull/17) | `19261b6` | 2026-10-08 |
| D3 stock enforcement | `d3-stock-enforcement` | [#18](https://github.com/nmajeedwork/Cafe-2try1t/pull/18) | `cfa64b0` | 2026-10-12 |
| D3 follow-up (voice example) | `d3-fix-voice-example` | [#19](https://github.com/nmajeedwork/Cafe-2try1t/pull/19) | `72fb0bb` | 2026-10-12 |
| D4 admin login | `d4-admin-auth` | [#20](https://github.com/nmajeedwork/Cafe-2try1t/pull/20) | `6b33e02` | 2026-10-14 |
| D4 follow-up (proxy hop count) | `d4-trust-proxy-hops` | [#21](https://github.com/nmajeedwork/Cafe-2try1t/pull/21) | `24d87cf` | 2026-10-17 |
| D4 follow-up (remove IP debug) | `d4-remove-ip-debug` | [#22](https://github.com/nmajeedwork/Cafe-2try1t/pull/22) | `c76fc3a` | 2026-10-17 |
| D5 stock dashboard | `d5-stock-dashboard` | [#23](https://github.com/nmajeedwork/Cafe-2try1t/pull/23) | `adc5736` | 2026-10-18 |
| D6 public sold-out labels | `d6-public-availability` | [#24](https://github.com/nmajeedwork/Cafe-2try1t/pull/24) | `ffa35e1` | 2026-10-19 |
| D7 dependency bumps | `d7-deps` | [#25](https://github.com/nmajeedwork/Cafe-2try1t/pull/25) | `924c1a0` | 2026-10-22 |
| D7 voice resume | `d7-voice-resume` | [#26](https://github.com/nmajeedwork/Cafe-2try1t/pull/26) | `4eaca44` | 2026-10-22 |
| D7 errors, sessions, chat timeout | `d7-errors-sessions` | [#27](https://github.com/nmajeedwork/Cafe-2try1t/pull/27) | `582aa5d` | 2026-10-24 |
| D7 public security headers | `d7-public-headers` | [#28](https://github.com/nmajeedwork/Cafe-2try1t/pull/28) | `8c3b4a2` | 2026-10-24 |
| D7 docs | `d7-docs` | [#29](https://github.com/nmajeedwork/Cafe-2try1t/pull/29) | `642d063` | 2026-10-25 |
| D7 close-out docs | `d7-closeout` | this PR | pending | |

### What shipped

- **Stock database (D2).** Neon Postgres through `pg`, all access in `db.js`. One table,
  created on boot. Stock is loaded into an in-memory Map at boot (3 second timeout, then
  background retries), plus one follow-up reload about 60 seconds later. SSL is always on with
  certificate verification (`db.js:133`), the pool holds at most 2 connections that close 1
  second after use (`db.js:136-138`), queries are parameterized, and the connection string is
  redacted from every error before it can be logged (`db.js:77-99`).
- **Stock enforcement (D3).** `add_to_cart`, `confirm_order` and `view_cart` check the
  in-memory state, so the bot cannot sell a sold-out item, and a confirmed order is never
  changed by a later toggle. A "Currently Unavailable" line lives in the uncached system
  block, so the cached prompt blocks stay byte-identical (snapshot tests).
- **Admin login (D4).** One password, stored only as an scrypt hash (N 32768, r 8, p 1, 64
  byte key, 16 byte salt, `admin.js:39`) compared in constant time (`admin.js:90`). A separate
  admin session and cookie, 8 hours absolute and 60 minutes idle (`admin.js:138-139`), the id
  regenerated at login (`admin.js:340`), a per-session CSRF token plus a strict Origin check on
  every POST, and 5 wrong passwords per IP per 15 minutes (`admin.js:141-142`). Both admin
  environment variables unset means admin is off and every `/admin` path is a 404; only one set
  or a weak secret refuses to start. The admin pages send their own strict CSP
  (`default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`).
- **Proxy hop count (D4 follow-ups, PRs #21 and #22).** The original `trust proxy` count of 1
  made every Render visitor share one rate-limit bucket. The count is now the
  `TRUST_PROXY_HOPS` setting (default 1, accepted range 1 to 5, anything else refuses to
  start), and a guard warns when Cloudflare's client IP header disagrees with `req.ip`
  (`client-ip.js`). [inventory-plan.md](inventory-plan.md) records the value for Render as 3
  (client, Cloudflare, Render internal) and a phone then laptop lockout test passing with 3;
  that was the owner's check on Render, not repeated in D7. The temporary `IP_DEBUG` logging
  was removed in #22.
- **Stock dashboard (D5).** `POST /admin/api/stock` writes the database first and memory
  second. An unknown item name or a non-boolean value is a 400
  (`admin/sections/stock.js:134-139`); a database failure is a 503 with memory unchanged
  (`admin/sections/stock.js:150, 179`). A "Reload from database" button reloads everything on demand.
- **Availability endpoint (D6).** `GET /api/availability` returns only the sold-out item
  names, read from memory: no database call, no session or cookie, `Cache-Control: no-cache`,
  not rate limited. The Menu page and Home's featured cards show "Sold out" from it, and look
  exactly as before if the request fails. `/api/menu` is byte-for-byte unchanged.
- **Dependency bumps (D7, #25).** Lockfile only, inside the existing `package.json` ranges.
  `npm audit` went from 7 findings (1 critical, 2 high, 4 moderate) to 0, checked on a local
  install and on a clean `npm ci`.
- **Voice resume (D7, #26).** `findResumableOrder` now deletes and ignores a saved record that
  has `order.confirmed === true`, or that lacks an `order` object, a `cart` array, or an
  `updatedAt` that parses to a real date. It logs one line with the reason and never the phone
  number. `server.js` is unchanged.
- **Error handler, sessions, chat timeout (D7, #27).**
  - A final error handler sends a fixed message by status (400 "Bad request.", 413 "Request
    too large.", 415 "Unsupported request.", otherwise "Something went wrong."): JSON, or
    plain text under `/admin`. It never sends a stack, an error message or the request body,
    whatever `NODE_ENV` is.
  - The customer session cookie expires 2 hours ahead, renewed each time the session changes.
    It uses an explicit `MemoryStore` pruned every 10 minutes by an unref'd timer
    (`customer-session.js`). Admin sessions and phone call sessions are separate and unchanged.
  - Stored `/chat` history is trimmed once it goes over 60 messages, down to at most 40, in
    whole turns only, so a tool call is never separated from its result and the history always
    starts on a plain user message (`chat-history.js`). The cart and order are untouched. After a
    trim, the next request writes the shorter history to the prompt cache once; tools and the
    system blocks keep hitting the cache.
  - `/chat` Anthropic requests have a 30 second timeout with one retry, and the whole turn has a
    60 second deadline. A timeout returns 503 "CafeBot is taking too long to answer right now.
    Please try again in a moment." Other errors keep the old 500 text. Voice keeps its own H5
    limits.
- **Public security headers (D7, #28).** `public-headers.js` hashes every inline script in
  `public/*.html` at boot (2 today) and builds the CSP: `default-src 'self'`; `script-src 'self'`
  plus those hashes; `style-src 'self' https://fonts.googleapis.com`; `font-src
  https://fonts.gstatic.com`; `img-src 'self' data:`; `connect-src 'self'`; `object-src 'none'`;
  `base-uri 'none'`; `form-action 'self'`; `frame-ancestors 'none'`. Also sent: `nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`,
  `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`, and `Strict-Transport-Security:
  max-age=604800` (7 days, no `includeSubDomains`, no `preload`) whenever `NODE_ENV` is not
  `development`. `/admin` gets none of this (its own headers stay byte-identical, proven against
  a baseline captured before the change), `/voice/*` gets `nosniff` only, and `X-Powered-By` is
  removed from every response. The CSP is sent in report-only mode by default
  (`PUBLIC_CSP_MODE`). The owner reports that the live service went report-only on 2026-10-24
  and was switched to `enforce` on 2026-10-30 (see "D7 live checks").

### D7 review findings

Reviewed: the D2 to D6 code (admin login, session and CSRF, rate limits and
`TRUST_PROXY_HOPS`, `db.js`, the stock toggle route, `/api/availability`, the stock Map, error
messages and logs) and the dependency audit.

| ID | Severity | Finding | Evidence | Status |
|---|---|---|---|---|
| M1 | Medium | Stack traces and file paths in error replies when `NODE_ENV` is not `production` | At the start of D7 a malformed JSON body to `/chat` returned Express's default error page containing `err.stack`. The JSON and form parsers run for every path, `/admin` included, before any router, so the admin router's own handler never saw those errors | Fixed in #27, tested in development, production and with `NODE_ENV` unset |
| M2 | Medium | Customer sessions never expired, and chat history grew without limit | `express-session` used the default store with no `maxAge`, so entries stayed in memory until a restart, and every turn appended to the history with no cap | Fixed in #27 |
| M3 | Medium | No timeout on `/chat` | The Anthropic client used the SDK defaults, 10 minutes per request and 2 retries (`node_modules/@anthropic-ai/sdk/core.js:124`), so one slow upstream could hold a request for about half an hour | Fixed in #27 |
| L1 | Low | `X-Powered-By: Express` on every response | Seen in the header baseline captured before #28 | Fixed in #28 |
| L2 | Low | This report's deploy checklist said `trust proxy: 1`, and its environment table lacked every variable added since H5 | Read in this file before this change | Fixed in this docs change |
| L3 | Low | Voice resume checked only the age of a saved order. A confirmed order, a file containing `null` (which made `findResumableOrder` throw), or a record with no valid `updatedAt` (its age was NaN, so it never expired) could be resumed or break the call | Read in `voice-order-recovery.js`; reproduced by the new tests, which fail without the fix | Fixed in #26 |
| L4 | Low | Server logs record what callers say and what CafeBot answers | `server.js:1587` (`[speech]` transcript), `server.js:1636-1640` (barge-in cutoff, transcript and the replayed prompt), `server.js:1658` (low confidence speech) and `server.js:1768` (`[reply]`) print the text, which can contain a name or a delivery address. Reading every `console` call in `server.js`, `elevenlabs-tts.js` and `voice-order-recovery.js` found no line that prints the caller's phone number | **Open, not changed in D7.** Owner decision: keep the logging for now. Follow-ups: the owner verifies Render's log retention, and "stop logging caller speech or shorten it" is on the Later List. Note: this corrects an earlier planning note that said phone numbers were redacted in voice logs; they are not logged at all, but the speech is |

Dependency audit, 7 findings. Reachability is an assessment from reading the code, not a
proof:

| Package | Severity | Reached by this app? | Fix |
|---|---|---|---|
| `proxy-addr` 2.0.7 | critical | No: `trust proxy` is a hop count, which Express turns into a counting function that never uses the subnet matcher | 2.0.8 |
| `axios` 1.19.0, `follow-redirects` 1.16.0 | high | No: `twilio` is used only for `validateRequest` and TwiML, never its REST client | 1.20.0, 1.16.1 |
| `qs` 6.15.3, `body-parser` 1.20.6, `express` 4.22.2 | moderate | Partly: form and query parsing goes through `qs` with default options, so the comma option is not used, but the denial of service needs only crafted input | 6.16.1, 1.20.9, 4.22.3 |
| `ip-address` 10.7.0 | moderate | Low: used by `express-rate-limit` for IPv6 keys | 10.7.4 |

Checked and left unchanged:

| Area | Evidence |
|---|---|
| Admin password hashing | scrypt with a minimum cost (`admin.js:39-41`), constant-time compare (`admin.js:90`), a full scrypt even for unusable input (comment at `admin.js:11-12`) |
| Admin session and CSRF | own store; 8 hour and 60 minute limits (`admin.js:138-139`, `305`); id regenerated at login (`admin.js:340`); Origin check (`admin.js:222`); token compared in constant time on login, logout and section POSTs (`admin.js:166`, `355`, `376`) |
| Admin login limit | 5 failures per IP per 15 minutes (`admin.js:141-142`, `264`) |
| Rate limits and proxy count | `TRUST_PROXY_HOPS` validated at boot; mismatch guard (`client-ip.js:45-56`); tests in `test/client-ip.test.js` pass, including a spoofed `X-Forwarded-For` being ignored and the H1 limit being per real client at 3 hops |
| `db.js` | parameterized queries only (`db.js:187, 202-204, 217`); verified SSL (`db.js:133`); redaction (`db.js:77-99`); the only log line prints a redacted message (`db.js:149`) |
| Stock toggle route | login, Origin and CSRF required; the name must be in `menu.json`; value must be a boolean; failure is a 503 with memory unchanged (`admin/sections/stock.js:134-139, 150, 179`) |
| `/api/availability` and the stock Map | memory read through `currentlyUnavailable()`; keys are menu names only; no database call, session or cookie; tests in `test/d6-availability.test.js` |
| Twilio signature validation | unchanged; the header baseline test still gets 403 for a bad signature and 200 for a valid one |

### D7 regression record

Automated, local, against fake services only (a fake Anthropic API on loopback, signed fake
Twilio requests, ElevenLabs blocked, a stubbed database): the full suite was 153 tests
before D7 and **191 tests, 187 pass, 0 fail, 4 skipped** at `555cec2`, the tip of the #28
branch that `main` (`8c3b4a2`) merges. The 4 skipped tests need the real Neon dev branch.
Every D7 guard was also checked by a mutation test (the code was broken on purpose and the
named tests failed). For #28, real Chromium against local servers loaded Home, Menu, About,
Order and the admin login in both CSP modes with 0 violations and 0 console errors, and an
extra unknown inline script was blocked in enforce mode and ran, with a report, in report-only
mode. In that run the Google Fonts files were fetched with curl and handed to the page through
a route, because the container's browser cannot reach outside hosts directly, so the first
fully live font fetch is the owner's Chrome check.

Claude has no access to Render, Neon, Twilio, ElevenLabs, Anthropic or the live site, so it
verified none of the live checks. The next section records what the owner reported.

### D7 live checks (owner-confirmed)

Recorded on 2026-10-30 from the owner's report. These are the owner's statements, not
something Claude checked. Dates are given only where the owner gave one.

- **Public CSP.** `PUBLIC_CSP_MODE=enforce` went live on 2026-10-30. The CSP had been in
  report-only mode since 2026-10-24. The owner checked Home, Menu, About and Order in Chrome
  with the Console open and saw no CSP errors.
- **Node version.** `NODE_VERSION=24.22.1` was set on Render on 2026-10-27, following Render's
  eMudhra advisory. The service redeployed, and live chat and phone orders worked afterwards.
- **Orders and voice resume.** One chat order and one phone order worked on the live service.
  Resume after a dropped call worked, and a confirmed order was not resumed on the next call.
- **Vendor settings and spend limits.** The owner checked them. Which individual values were
  seen is not recorded here.
- **Render logs.** The Render log viewer range is 7 days, and no log stream is configured.

Not reported to Claude, so not recorded as done:

- reading the live response headers (before or after the CSP switch), the framing test, the
  admin pages check on the live site, and the admin stock toggle on the live site;
- the Network tab, scroll and New Order checks on the public pages (only the Console result was
  reported);
- the customer cookie expiry, and the real cost of the chat order and the phone calls;
- re-running `npm audit` just before sharing the link;
- the optional certificate rejection test after the Node version change, and reading the Node
  version back from a build log, so this report does not confirm which version the build
  actually used;
- the individual vendor values behind "vendor settings and spend limits", and who can read the
  Render logs.

The D7 automated tests ran locally on Node 22.22.0. They were not re-run on 24.22.1. The repo
does not pin a Node version (no `engines` field, `.nvmrc` or `.node-version`), so the Render
setting is the only pin.

### Open items

- **D7 is done** as of the close-out change of 2026-10-30. The items below are what stays open.
- **DONE: switch `PUBLIC_CSP_MODE` to `enforce`.** Live since 2026-10-30 (owner-confirmed). To
  roll back, set it to `report-only` in Render and restart; no code deploy is needed.
- **Node version.** `NODE_VERSION=24.22.1` is set on Render (owner-confirmed, 2026-10-27).
  The certificate rejection test was not run and the version was not read back from a build
  log. See "D7 live checks".
- **L4:** speech and replies stay in the server log for now (owner decision). The owner
  verifies Render's log retention (see the checklist), and "stop logging caller speech or
  shorten it" is on the Later List in [inventory-plan.md](inventory-plan.md).
- **Past pickup times** pass the server check. The hours logic was frozen during D7.
- **No per-number voice rate limit or blocklist.** Deferred in D7.
- **MemoryStore warning** stays in the production log. Customer sessions are short-lived and
  pruned; a database-backed store would be a new dependency.
- **A customer idle for more than 2 hours** loses their cart.

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
| `DATABASE_URL` | D2 | unset | Neon pooled connection string. On Render use the "production" branch's; locally use the "dev" branch's. Unset means stock tracking is off, the server still starts, and every item counts as in stock. Never commit it or log it |
| `ADMIN_PASSWORD_HASH` | D4 | unset | scrypt hash in the form `scrypt:N:r:p:salt:hash`, made with `scripts/hash-admin-password.js`. Both admin variables unset means admin is off (every `/admin` path is a 404). Only one set, a malformed hash or a weak secret refuses to start |
| `ADMIN_SESSION_SECRET` | D4 | unset | long random secret for the admin session, separate from `SESSION_SECRET` (generate with `node scripts/hash-admin-password.js --new-secret`). A weak value refuses to start |
| `TRUST_PROXY_HOPS` | D4 follow-up (#21) | `1` | how many proxies sit in front of the app, a whole number from 1 to 5, anything else refuses to start. **3 on Render** (client, Cloudflare, Render internal). Decides which address the per-IP rate limits see |
| `PUBLIC_CSP_MODE` | D7 (#28) | `report-only` | `report-only` sends the public Content Security Policy as a report only, `enforce` makes browsers block violations, anything else refuses to start. On the live service it is `enforce` since 2026-10-30 (owner-confirmed). The other public security headers are always on |
| `NODE_VERSION` | D7 close-out | unset | a Render setting that picks the Node.js version; the app code does not read it. Set to `24.22.1` on 2026-10-27 following Render's eMudhra advisory (owner-confirmed). The repo does not pin a Node version |
| `CHAT_TEST_REQUEST_TIMEOUT_MS`, `CHAT_TEST_TURN_DEADLINE_MS` | D7 (#27) | unset | test only: shorten the `/chat` timeouts (30000 and 60000 ms). Read only when `NODE_ENV=development`; ignored everywhere else, but do not set them on Render |

## Deploying to production: checklist

1. Set `NODE_ENV=production` (or anything that is not `development`).
2. Set `SESSION_SECRET` to a real random secret. The server will refuse to start
   without it.
3. Do not set `DISABLE_HOURS_CHECK` or `FORCE_HOURS_CLOSED`. The server will
   refuse to start if either is `true`.
4. Set `TRUST_PROXY_HOPS` to the number of proxies in front of the app. On Render that
   is 3 (client, Cloudflare, Render internal). With the default of 1, every visitor
   shares one rate-limit bucket. The setting counts hops; `req.protocol` and the Twilio
   signature check only need at least one trusted hop. The start-up log shows
   `[client-ip] trust proxy hops: <n>`, and a warning appears if Cloudflare's client IP
   header disagrees with the address the app sees.
5. Optionally tune `RATE_LIMIT_MAX` and `RATE_LIMIT_GLOBAL_MAX` for expected
   traffic.
6. Leave `MAX_CALL_TURNS`, `MAX_CALL_MINUTES`, and `MAX_GARBLED_IN_ROW` unset to
   use the defaults, and remove any lowered values left over from testing.
7. Set `DATABASE_URL` to the Neon "production" branch's pooled connection string. The
   stock table creates itself on the first boot. Without it the server still starts, with
   stock tracking off.
8. Set `ADMIN_PASSWORD_HASH` and `ADMIN_SESSION_SECRET` together to turn admin on, or
   leave both unset to keep it off. Setting only one stops the server from starting.
9. Leave `PUBLIC_CSP_MODE` unset (report-only) for the first deploy, check the live site
   (see [before-going-public-checklist.md](before-going-public-checklist.md)), and only then
   set it to `enforce`.
10. Check the start-up log: `[client-ip] trust proxy hops: 3`, `[headers] public CSP mode:
    <report-only or enforce>, 2 inline script hashes` (enforce on the live service since
    2026-10-30), and no `FATAL` line. The log will also show
    express-session's MemoryStore warning, which is expected (see "Open items").
