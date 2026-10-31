# Before Going Public Checklist

Run through this before ever sharing the live link with anyone (recruiter, interviewer, portfolio visitor).

- [ ] Render free tier: either upgrade to a paid instance temporarily, or set up a keep-alive ping, so the first request doesn't sit through a 30-50+ second cold-start delay. (Skipped for now while this is private/testing-only. Revisit before sharing.)
- [ ] Confirm Twilio account is active (not suspended) and has a real balance.
- [ ] Confirm ElevenLabs plan is active with enough credits remaining.
- [ ] Confirm NODE_ENV=production and all real environment variables are correctly set in Render (not leftover dev/placeholder values). The full list is under "Settings only you can check" below.
- [ ] Confirm no MAX_CALL_* test values (MAX_CALL_TURNS, MAX_CALL_MINUTES, MAX_GARBLED_IN_ROW) are left set in Render's environment. A lowered value from a cap test would cut real callers off early. Unset means the H5 defaults (30 turns, 12 minutes, 4 garbled replies in a row).
- [x] Place one real test call end to end, and send one real chat message end to end, on the actual live URL (not localhost). Confirm both work before sharing. Owner-confirmed: one chat order and one phone order worked on the live service (date not recorded; see also the NODE_VERSION note below).
- [ ] Check [docs/project-instructions.md](project-instructions.md)'s "Known issues / deferred" section and confirm nothing there has gotten worse since it was written.
- [ ] Replace placeholder image slots with real photos, if that's been done by this point (optional, not a functional blocker, but affects how polished it looks to a visitor).

## D7 items (security pass and deploy readiness)

**D7 status: done.** Marked done in the close-out change of 2026-10-30. All the D7 code is merged (PRs #25 to #29), and the owner reported the live checks listed below.

How to read the status notes: "Merged and tested" means the code is on `main` and covered by the automated tests, which run locally against fake services (no real Anthropic, Twilio, ElevenLabs or database). It does not mean it has been seen working on Render. Claude has no access to the live site or any vendor dashboard, so it verified none of the live checks. A box is ticked only where the owner reported that check as done ("owner-confirmed"), with the limits of what was reported written next to it. A box left unticked was not reported to Claude, so it is not recorded as done. See [docs/hardening-report.md](hardening-report.md), section "D2 to D7 changes", for what changed and the evidence.

Owner-confirmed live results, as reported to Claude (dates only where the owner gave one):
- `PUBLIC_CSP_MODE=enforce` went live on 2026-10-30, after report-only since 2026-10-24. The owner checked Home, Menu, About and Order in Chrome with the Console open and saw no CSP errors.
- `NODE_VERSION=24.22.1` was set on Render on 2026-10-27 (see the Render section for what was and was not checked).
- One chat order and one phone order worked, a call resumed after a dropped call, and a confirmed order was not resumed on the next call.
- Vendor settings and spend limits were checked. Which individual values were seen is not recorded here.
- The Render log viewer range is 7 days, and no log stream is configured.

- [ ] **npm audit is at 0.** Merged and tested: PR #25 raised seven packages in `package-lock.json` only, and `npm audit` went from 7 findings to 0 on a local install. Advisories change over time, so run `npm audit` again just before sharing the link. Expect 0. If it is not 0, triage it the way D7 did (is it reachable, is the fix a major version) before running `npm audit fix`.
- [ ] **NODE_ENV is exactly `production` on Render.** With it unset the server still treats itself as production, but set it explicitly so nobody has to rely on that. Since D7 an unhandled error never sends a stack trace whatever NODE_ENV is (PR #27).
- [ ] **Public security headers are present on the live site.** Merged and tested: PR #28. Open DevTools, Network tab, tick "Disable cache", load `/`, and click the first row (the page itself), then Headers, then Response Headers. Look for:
  - `content-security-policy` (it was `content-security-policy-report-only` until the switch to enforce on 2026-10-30, see below)
  - `x-content-type-options: nosniff`
  - `referrer-policy: strict-origin-when-cross-origin`
  - `x-frame-options: DENY`
  - `permissions-policy` and `cross-origin-opener-policy: same-origin`
  - `strict-transport-security: max-age=604800`
  - no `x-powered-by` header at all
- [x] **The Console is clean on every public page.** On `/`, `/menu`, `/about` and `/order`, open the Console tab and filter on `Content Security Policy`. You want no lines, and in particular no `[Report Only]` lines. Also confirm in the Network tab that every request is 200 or 304 (no red rows), including the Google Fonts CSS and font files, `hero.webp`, the three featured photos, and `/api/menu`. Scroll Home to see the sections fade in. On `/order`, send one message and press New Order. Owner-confirmed: Home, Menu, About and Order were checked in Chrome with the Console open and showed no CSP errors. The Network tab checks, the scroll check and the New Order check were not reported.
- [ ] **Framing is refused.** Open `https://example.com`, and in its Console run `document.body.innerHTML = '<iframe src="https://YOUR-RENDER-URL/" width=600 height=400></iframe>'`. The frame should stay blank, and the Console should say the page refused to be framed.
- [ ] **The admin pages are unchanged.** `/admin/login` still shows `content-security-policy: default-src 'none'; ...` and `referrer-policy: same-origin`, and no `x-powered-by`. Log in and out once.
- [x] **DONE: switch the public CSP from report-only to enforcing.** Owner-confirmed: `PUBLIC_CSP_MODE=enforce` went live on 2026-10-30. The CSP had been in report-only mode (the default) since 2026-10-24. The other headers were enforced from the start. The header name is now `content-security-policy`; reading the live response headers after the switch was not reported. If anything breaks, set `PUBLIC_CSP_MODE=report-only` in Render and restart. That is an environment change, not a code deploy.
- [x] **Voice resume works, and a confirmed order is never resumed.** Merged and tested: PR #26 (the tests use a fake model and signed fake Twilio requests). Live check, two real calls plus one more, which cost Twilio minutes, ElevenLabs characters and Claude tokens (check the per-minute rates on your dashboards): (a) call, add an item, hang up before confirming, call back within 15 minutes and expect the "Welcome back" greeting with the item still there; (b) finish and confirm an order, hang up, call back and expect the normal greeting with an empty cart. Owner-confirmed: (a) resume after a dropped call worked, and (b) a confirmed order was not resumed. Dates and call costs were not reported.
- [x] **One real chat order on the live URL** (menu question, add an item, pickup details, confirm). It is a real Anthropic call. As a rough estimate at the Sonnet 5 prices used during D7 planning ($2 per million input tokens, $10 per million output tokens), a short order of about 8 turns is roughly $0.10 to $0.30. Check the real figure in the Anthropic console afterwards. Confirm the customer cookie (`connect.sid`, DevTools, Application, Cookies) expires about 2 hours ahead. Owner-confirmed: one chat order worked on the live service. The real cost and the cookie expiry were not reported.
- [ ] **Admin stock toggle works on Render, and the public label follows.** Log in, mark one item sold out, check the "Sold out" label on `/menu` and the featured card on `/` (reload the page, labels do not refresh by themselves), then mark it back in stock.
- [ ] **Know the behaviours D7 added.** A chat session ends 2 hours after its last activity, so a customer who leaves a half-finished order for more than 2 hours starts again with an empty cart. A /chat reply that takes longer than 60 seconds ends with "CafeBot is taking too long to answer right now. Please try again in a moment." (this cannot be triggered reliably on the live site, so it is covered by the automated tests only). The Render log shows express-session's "MemoryStore is not designed for a production environment" warning, which is expected and accepted: sessions are short-lived and pruned, and the alternative is a database-backed store, which would be a new dependency.
- [ ] **Decide about voice abuse limits before advertising the phone number.** There is still no per-number rate limit or blocklist (deferred, see the Later List in [docs/inventory-plan.md](inventory-plan.md)). Each call costs Twilio, ElevenLabs and Anthropic money. The per-call caps from H5 bound a single call, not repeat callers.
- [x] **Verify Render's log retention.** Owner-confirmed: the Render log viewer range is 7 days, and no log stream is configured. Who can read the logs, and whether the retention can be shortened, were not reported. The server log records what callers say and what CafeBot answers (`[speech]` and `[reply]` lines), which can include a name or a delivery address. It does not print the caller's phone number. Decision for now: keep the logging, and D7 did not change it (finding L4 in the hardening report; "stop logging caller speech or shorten it" is on the Later List in [docs/inventory-plan.md](inventory-plan.md)). Open Render's log settings, note how long logs are kept and who can read them, and shorten the retention if the dashboard allows it.
- [ ] **Known issue still open: past pickup times.** A pickup time that is earlier today but inside opening hours passes the server check (the hours logic was frozen during D7). See [docs/project-instructions.md](project-instructions.md), Known issues.

## Settings only you can check

Claude cannot see Render, Neon, Twilio, ElevenLabs or Anthropic, so Claude verified nothing here. The owner reported that vendor settings and spend limits were checked, but which individual values were seen is not recorded, so the boxes below are left as they were except where a specific item was reported. Tick each one after looking at the dashboard.

### Render
- [ ] Environment variables that must be set:
  - `NODE_ENV=production`
  - `SESSION_SECRET` (a real random value, not `dev-secret`)
  - `ANTHROPIC_API_KEY`
  - `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`
  - `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`
  - `DATABASE_URL`, the Neon "production" branch's pooled connection string
  - `ADMIN_PASSWORD_HASH` and `ADMIN_SESSION_SECRET` (set both, or the server refuses to start with only one)
  - `TRUST_PROXY_HOPS=3`
- [x] `PUBLIC_CSP_MODE` is `enforce`. Owner-confirmed: set on 2026-10-30. It was report-only before that, since 2026-10-24.
- [x] `NODE_VERSION=24.22.1`. Owner-confirmed: set on Render on 2026-10-27, following Render's eMudhra advisory. The service redeployed, and live chat and phone orders worked afterwards. **Not done:** the optional certificate rejection test was not run, and the Node version was not read back from a build log, so this file does not confirm which version the build actually used. The repo does not pin a Node version (no `engines` field, `.nvmrc` or `.node-version`), so this Render setting is the only pin. The D7 automated tests ran locally on Node 22.22.0 and were not re-run on 24.22.1.
- [ ] Environment variables that must NOT be set: `DISABLE_HOURS_CHECK`, `FORCE_HOURS_CLOSED` (the server refuses to start with either), `MAX_CALL_TURNS`, `MAX_CALL_MINUTES`, `MAX_GARBLED_IN_ROW` (unless you chose the value on purpose), `RATE_LIMIT_MAX`, `RATE_LIMIT_GLOBAL_MAX`, `RATE_LIMIT_WINDOW_MS` (unless you chose the value on purpose), `CHAT_TEST_REQUEST_TIMEOUT_MS`, `CHAT_TEST_TURN_DEADLINE_MS` (test only), and `IP_DEBUG` (removed from the code).
- [ ] The `DATABASE_URL` points at the production branch, not the dev branch.
- [ ] Instance type is what you intend (free tier with its cold start, or paid), and there are no paid add-ons you did not choose.
- [ ] Auto-deploy is from `main` only.
- [ ] Log retention: how long Render keeps logs, and who can read them (see "Verify Render's log retention" above).
- [ ] The latest deploy log shows a clean start: `[client-ip] trust proxy hops: 3`, `[headers] public CSP mode: enforce, 2 inline script hashes`, and no `FATAL` line.

### Neon (database)
- [ ] The project is on the Free plan with no credit card on file, and no paid plan or overage setting is turned on.
- [ ] Compute hours used this month are well under the 100 free hours. Nothing in the app polls the database, so the compute should be suspended most of the time (it scales to zero after 5 minutes idle).
- [ ] Storage used is far below the free limit (the stock table is a few rows).
- [ ] The connection string in Render is the pooled one for the "production" branch, and the "dev" branch string is only in your local `.env`.

### Twilio
- [ ] Account is active, with a real balance.
- [ ] Auto-recharge is off, or set to an amount you chose on purpose.
- [ ] A low-balance alert is on, if your account offers one.
- [ ] The phone number's voice webhook points at the live Render URL (`/voice/incoming`, HTTP POST).

### ElevenLabs
- [ ] The plan is active with enough credits for the expected calls.
- [ ] No automatic upgrade or pay-as-you-go overage is switched on that you did not choose.

### Anthropic
- [ ] A monthly spend limit is set on the workspace or organization that owns the API key in Render.
- [ ] Credit auto-reload (auto top-up) is off, or capped at an amount you chose.
- [ ] The key in Render is the one you intend, and no other copy of it exists in a place you do not control.

See [docs/hardening-report.md](hardening-report.md) for the security hardening passes already completed, and [docs/project-instructions.md](project-instructions.md) for the full project reference.
