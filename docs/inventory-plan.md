# Inventory Dashboard Plan (D1)

Approved plan for adding stock tracking to CafeBot. D1 (planning) is complete, and D2 to D6 are built and merged. D7, the security pass and deploy checks, is done: its code is merged and the owner reported the live checks (see "Milestone status" below). Each milestone below is planned, approved, built, and verified on its own, following the usual working conventions in [project-instructions.md](project-instructions.md).

## Scope for v1

* Inventory is an in-stock / out-of-stock toggle per menu item. No quantity counts.
* One admin user (Nmajeed). No staff accounts.
* The dashboard does the stock toggle only. Item and price editing and order viewing are out of v1, but nothing in this design may block adding them later.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Menu page and sold-out items | Show sold-out items, with a "Sold out" label. |
| 2 | Featured Home card whose item is sold out | Show a small "Sold out" badge on the card. |
| 3 | Deals that include a sold-out item | Not applicable. The `promotions` field only reports deals the cart already qualifies for and never suggests adding an item (see Findings below). A sold-out item can't be added or confirmed, so no deal can be built on one. |
| 4 | Bot wording for an unavailable item | "Sold out right now", plus up to two in-stock alternatives from the same category. |
| 5 | An item in the cart goes out of stock mid-order | The bot mentions it at the next natural point in the conversation. `confirm_order` is the hard guarantee. |
| 6 | Back in stock | Manual toggle only in v1. Automatic reset is on the Later List. |
| 7 | Customer browses a category | The bot briefly says which items in that category are sold out. |
| 8 | Change log | `updated_at` only. |
| 9 | Database slow or down | Option A: fail open from the last known state (see Failure behavior). |

## Rules

* Stock is enforced in server code at the tool level, never by the prompt alone.
* All database access lives in one small module, `db.js`, so the vendor can be swapped later.
* The `/api/menu` response shape and field names do not change. Home, the Menu page, and the featured-item links depend on it.
* Item names are the stable keys. Featured cards link by slugified item name and photos are mapped by name.
* The stable system block (prompt plus menu JSON) stays byte-identical across requests. Anything that changes at runtime goes in the uncached block after the cache breakpoint.
* Database calls never sit on the chat or voice request path.
* Toggling stock never changes a confirmed order. This needs a test.
* If `/api/availability` fails, the Menu page renders exactly as it does today.
* Admin env vars (`ADMIN_PASSWORD_HASH` and `ADMIN_SESSION_SECRET`):
  * Both unset: admin is off and every `/admin` path returns 404.
  * Only one set, or a weak secret: the server refuses to start.
* The admin login meets the same bar as H1-H5.
* Cart, promotions, hours (including the timezone fix), H1-H5 behavior, and Twilio signature validation are unaffected.
* New dependency approved for D2: `pg`. Any other new npm dependency needs approval first.

## Database

Neon Postgres, region AWS US West (Oregon), `aws-us-west-2`, accessed through `pg`.

* Free plan, no credit card required, permanent (not a trial).
* 0.5 GB storage per project, 100 compute-hours per month, compute scales to zero after 5 minutes idle and restarts in a few hundred milliseconds. (Neon's pricing page showed 1 GB per project during D1 research and a Neon FAQ said 0.5 GB. This plan uses the lower figure. Either is far more than needed.)
* Connection strings live only in `.env` (local, gitignored) and Render's environment settings. Never in the repo.
* Neon's default branch is named "production". Local work and tests use the "dev" branch, and Render gets the "production" branch's connection string at deploy.
* Nothing may poll the database. Frequent queries would keep the compute awake and burn through the 100 free compute-hours.
* Neon's docs say a compute does not suspend while it has active connections, and do not say whether a plain idle connection counts. So `db.js` never holds one open: a pool of at most 2 connections whose idle connections close 1 second after use. Measured in D2: the connection closed about 1.06 seconds after the query finished.
* SSL is always on with certificate verification, whatever the connection string's `sslmode` says. The pooled connection string goes through PgBouncer in transaction mode, so `db.js` uses only plain parameterized queries (no `SET`, no session state) and does not set `statement_timeout`, which the pooler rejects as a startup parameter.
* The connection string, and its user, password and host, are never logged. Every database error is redacted before it can reach a log.

Why not the others:

* Render Postgres: free databases expire 30 days after creation and are deleted after a 14-day grace period.
* Supabase: free projects pause after 1 week of inactivity, and unpausing is manual. Stock state would silently go stale.
* Turso: viable, but SQLite rather than Postgres, and whether free databases are still archived after inactivity could not be confirmed.

## Schema and table creation

One table, stock only. `menu.json` stays the source of menu content, in git.

| Column | Type | Notes |
|---|---|---|
| `item_name` | text, primary key | Exactly the item's `name` in `menu.json` |
| `in_stock` | boolean, not null, default true | |
| `updated_at` | timestamptz, not null, default now() | The only change record in v1 |

* There is no seed step and no script to run against production. On boot, `db.js` runs `db/schema.sql` (`CREATE TABLE IF NOT EXISTS`, safe to repeat), and `setStock` is an upsert, so the first toggle of an item creates its row. A `deleteStock` function removes a row, which puts the item back to the default.
* Boot logs orphans: rows whose names are no longer in `menu.json` (for example after a rename). They are ignored.
* At runtime, a name missing from the table counts as in stock, so an empty table behaves exactly like today.
* `menu.json` itself is unchanged. The cached prompt block and `/api/menu` still come from it, so both stay byte-identical by construction.
* Later item and price editing can add a full `menu_items` table keyed by the same `item_name`, with `menu.json` becoming the seed.

## How stock reaches the agent

### In memory

* At boot, stock rows load into an in-memory Map, with a 3 second timeout, before the server starts listening.
* One extra reload runs about 60 seconds after boot to cover the Render deploy overlap window, when the old instance can still accept a toggle after the new one has loaded. It is skipped while boot retries are still running, and after a permanent error such as a wrong password.
* An admin toggle writes the database first, then updates the Map.
* Every tool check is a memory lookup. No database call on the chat or voice path.

### Enforcement in the tools

* `add_to_cart` refuses a sold-out item with a short error ("Blueberry Muffin is sold out right now.") and up to two in-stock alternatives from the same category.
* `confirm_order` re-checks every cart line and refuses to confirm if any item is sold out, listing them. It does not silently remove them. The model asks the customer to remove or swap. This also covers carts restored from a dropped voice call.
* `view_cart` adds an `unavailableItems` field when the cart holds an item that has since gone out, so the bot can mention it at the next natural point.

### What the agent sees

* A "Currently Unavailable" line in the uncached second system block, present only when the list is not empty. The cached block is untouched.
* A one-time rule in `system-prompt.md` and `system-prompt-voice.md`: listed items can't be ordered, say so briefly, offer alternatives, and when browsing a category mention which of its items are sold out. Changing these files changes the cached block once, after which it stays byte-identical across requests.

### Voice

One short sentence plus up to two alternatives, for example: "Sorry, the blueberry muffin is sold out right now. I can do a butter croissant or a chocolate chip cookie instead."

### Public site

* New `GET /api/availability` returns `{ "unavailable": [...] }`: item names from `menu.json` only, in menu order, read from memory (`stock.outOfStockNames` through `currentlyUnavailable` in `server.js`). No database call, no login, no session or cookie. With stock tracking off, or the boot load failed and nothing has loaded since, it returns an empty list, the same as "everything in stock". It sends `Cache-Control: no-cache` (a browser must revalidate before every use, so a visitor never sees an older answer than the server's; revalidation is a tiny 304) and `X-Content-Type-Options: nosniff`.
* Not rate limited, on purpose: it is a memory read of at most a few hundred bytes with the same exposure as `/api/menu`, and a 429 would silently hide the labels. It reveals only which items are sold out, which the labels show anyway.
* `/api/menu` stays byte-for-byte unchanged.
* `public/availability.js` (shared by both pages) fetches the list. Anything unexpected (network error, timeout after 4 seconds, non-OK status, any shape other than `{ unavailable: [strings] }`) means no labels and no error: the pages look exactly as they did before. Names are matched by exact string only and are never put into markup; the label text is the constant "Sold out".
* Menu page: each sold-out row gets a "Sold out" pill after the item name (ink text on sand, 12.1:1, with a border so it is not colour alone). Home: each sold-out featured card gets a "Sold out" badge over the photo corner (cream on ink, 14.5:1), inside the card's link, so the card still links to `/menu#item-<slug>`. Both are real text placed right after the item name, so a screen reader announces it with the name (checked in Chromium: the featured card is still one link, named "Blueberry Muffin Sold out Moist muffin ..."). If the page was opened at a `#item-...` link and the visitor has not scrolled, the jump is repeated after the labels land.
* A visitor's open page does not refresh its labels (no polling in v1). The server still enforces stock, so a stale page cannot add a sold-out item to an order.

## Failure behavior (Option A)

* After a successful load, the in-memory state is used indefinitely. The database only matters again at the next toggle.
* If the boot load fails or takes longer than 3 seconds, the server starts anyway, treats everything as in stock (today's behavior), logs loudly, and retries in the background: 5 seconds, doubling up to a 15 minute cap, stopping on the first success. A permanent error (wrong password, no such database, no permission, no `DATABASE_URL`) turns retries off, since retrying would only wake the database for nothing. Once the dashboard exists it shows a banner while stock is unavailable.
* A toggle while the database is down returns an error and leaves memory unchanged.
* Tradeoff accepted: during an outage that overlaps a restart, a sold-out item could be ordered.
* As built in D5: the Stock page shows a banner while stock is unavailable (the boot load failed and nothing has loaded since) or tracking is off (no `DATABASE_URL`). A background retry that succeeds clears it. A "Reload from database" button loads everything on demand, which also covers a change made by hand in Neon and a toggle that landed on the old instance during a deploy overlap after the 60 second follow-up reload. A toggle that succeeds while stock is unavailable also reloads everything, since the database is evidently reachable again. A load that started before a toggle never overwrites it: toggles made during a load are put back on top of its rows.

## Admin auth (direction, finalized in D4)

* Single password plus session cookie. No new dependency: Node's built-in `crypto.scrypt` for hashing, plus the existing `express-session` and `express-rate-limit`.
* Only the scrypt hash with its salt is stored, in `ADMIN_PASSWORD_HASH`. Comparison is constant-time.
* Login rate limiting, decided at D4: per IP, 5 wrong passwords in 15 minutes, then that IP gets 429 (a successful login does not count). Separately, 20 or more failures in an hour across all IPs writes a loud warning to the log but blocks nobody, so other people's attempts can never lock the owner out.
* Per-IP limiting uses `req.ip` with `trust proxy` set to a hop count. With a hop count Express only counts entries and never runs the `proxy-addr` subnet matching, so the IPv4-mapped IPv6 audit finding does not apply. A client's own `X-Forwarded-For` entries are ignored. Deploy check: after 5 wrong attempts from a phone on mobile data, a laptop on wifi must still get the normal wrong-password page.
* Found in production after D4: that deploy check failed on Render with the original count of 1. Render puts more than one proxy in front of the app (observed by others as Cloudflare, then a Render internal hop), so `req.ip` was a proxy address shared by every visitor, for both the admin login limit and the H1 `/chat` limit. The count is now `TRUST_PROXY_HOPS` (default 1, see `client-ip.js`). A guard logs a warning when Cloudflare's client IP header disagrees with `req.ip`.
* Confirmed on Render with the temporary `IP_DEBUG` log: the chain ahead of the app is client, Cloudflare, Render internal, so Render runs with `TRUST_PROXY_HOPS=3`. With 3, the phone then laptop lockout test passed: 5 wrong passwords from a phone on mobile data no longer block a laptop on wifi. The `IP_DEBUG` code was then removed; only the hop count setting and the mismatch guard remain.
* Sessions: 8 hours absolute from login, and 60 minutes idle. Both live in memory, so a restart means logging in again. The login form's CSRF token is stateless (a signed `admin.pre` cookie), so anonymous visitors never create session entries.
* Every admin response also carries anti-framing headers: `X-Frame-Options: DENY`, a `Content-Security-Policy` with `frame-ancestors 'none'`, and `Referrer-Policy: same-origin` (not `no-referrer`, which makes browsers send `Origin: null` on form POSTs and would break the Origin check).
* D5 tightened the CSP to `default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`: no scripts at all, and no inline styles (the admin pages share `admin/admin.css`, served at `/admin/assets/admin.css`). The Stock page is plain HTML forms, one per item, each sending the state it wants rather than a flip. If a page ever needs JavaScript, serve it as a file from the admin router and add `script-src 'self'` to that page's response only.
* Admin sections: each one is a file in `admin/sections/` with its own routes, using shared helpers in `admin.js` (login check, Origin and CSRF check, page layout from `admin/layout.html`). `/admin` redirects to the first section. Orders, charts or item editing later are new section files, not changes to the Stock page.
* A separate admin session with its own secret and cookie: `Path=/admin`, `HttpOnly`, `Secure`, `SameSite=Strict`, 8 hour lifetime. The session id is regenerated at login.
* CSRF: a per-session token on every admin POST, plus an `Origin` check.
* Kept apart from customer sessions: a customer cookie grants nothing under `/admin`, and the admin cookie is never sent to customer routes.
* Not linked or indexed: no nav link, `X-Robots-Tag: noindex, nofollow`, `Cache-Control: no-store`, not listed in robots.txt, and admin HTML served from outside `public/`.
* Forgotten password: run the local hash script, paste the new hash into Render's environment settings, and redeploy. This also invalidates old sessions.

## Milestones

| | Scope | Files likely touched | Tests | Rollback | Model |
|---|---|---|---|---|---|
| D2 | `db.js` (all database access), stock table created on boot (no seed script), in-memory stock module, boot load into the Map (3 second timeout) with background retries, one extra reload about 60 seconds after boot, orphan report in the boot log | new `db.js`, `stock.js`, `db/schema.sql`, `test/stock.test.js`; `server.js` (boot and test exports only); `package.json` (`pg`); `.env.example` | `/api/menu` bytes and both stable prompt blocks match a snapshot; server boots with `DATABASE_URL` unset, wrong, unreachable, and slow; timeout, retry and reload paths; secrets never logged; SSL always on; round trip and orphan detection on the dev branch; existing 14/14 hours tests pass | Revert the PR, or unset `DATABASE_URL` | Sonnet |
| D3 | Server-side enforcement in `add_to_cart`, `confirm_order`, `view_cart`; Currently Unavailable line in the uncached block; one-time rule in both system prompts | `server.js`, `system-prompt.md`, `system-prompt-voice.md`, new test file | Unit tests with stubbed stock; toggling stock never changes a confirmed order; stable block hash unchanged when stock flips; uncached block lists sold-out items; H5 harness rerun at zero spend, including the voice refusal; a few real chat and voice checks | Revert the PR | Sonnet |
| D4 | Admin auth: login and logout, separate session, CSRF, login rate limiting and lockout, hash script, env var startup rules | new `admin.js` router, `admin/login.html`, `scripts/hash-admin-password.js`; `server.js`; `.env.example` | Both env vars unset gives 404; one set or a weak secret refuses to start; wrong password; rate limit; lockout; missing or bad CSRF token gives 403; cookie flags; customer cookie can't reach admin; noindex header; session id changes at login | Revert, or unset both env vars | Opus |
| D5 | Stock dashboard toggle; `POST /admin/api/stock` writes the database, then memory | `admin/dashboard.html`, `admin/dashboard.js`, `admin.js`, `db.js` | Toggle survives a restart; unknown name or non-boolean gives 400; database down gives 503 with memory unchanged; bot reflects the change on its next turn | Revert; stock rows stay valid | Sonnet |
| D6 | `/api/availability`; "Sold out" label on the Menu page and badge on featured cards; docs | `server.js`, `public/menu.js`, `public/index.html`, `public/site.css`, `docs/*` | `/api/menu` bytes identical; Menu page renders exactly as today if `/api/availability` fails; hash links, keyboard, and direct-URL checks; no visible change when everything is in stock | Revert | Sonnet |
| D7 | Security pass, full chat and voice regression, deploy | Whatever the pass finds; `docs/hardening-report.md`; `docs/before-going-public-checklist.md` | Security review of D2-D6; full chat and voice regression, including cart, promotions, hours, H1-H5, and Twilio signature validation; live checks after deploy | Revert the offending PR; unset admin env vars to switch admin off | Opus for the security pass |

## Milestone status

As of 2026-10-30. "Merged" means the PR is on `main` with its automated tests passing. It does not mean it has been checked on Render.

| | Status | PRs |
|---|---|---|
| D2 | Merged | [#17](https://github.com/nmajeedwork/Cafe-2try1t/pull/17) |
| D3 | Merged, with one follow-up | [#18](https://github.com/nmajeedwork/Cafe-2try1t/pull/18), [#19](https://github.com/nmajeedwork/Cafe-2try1t/pull/19) |
| D4 | Merged, with two follow-ups (proxy hop count, IP debug removal) | [#20](https://github.com/nmajeedwork/Cafe-2try1t/pull/20), [#21](https://github.com/nmajeedwork/Cafe-2try1t/pull/21), [#22](https://github.com/nmajeedwork/Cafe-2try1t/pull/22) |
| D5 | Merged | [#23](https://github.com/nmajeedwork/Cafe-2try1t/pull/23) |
| D6 | Merged | [#24](https://github.com/nmajeedwork/Cafe-2try1t/pull/24) |
| D7 | **Done** (marked in the close-out change of 2026-10-30). Security review written up in [hardening-report.md](hardening-report.md). Merged: dependency bumps ([#25](https://github.com/nmajeedwork/Cafe-2try1t/pull/25)), voice resume ([#26](https://github.com/nmajeedwork/Cafe-2try1t/pull/26)), error handler, session expiry, history cap and chat timeout ([#27](https://github.com/nmajeedwork/Cafe-2try1t/pull/27)), public security headers ([#28](https://github.com/nmajeedwork/Cafe-2try1t/pull/28)), docs ([#29](https://github.com/nmajeedwork/Cafe-2try1t/pull/29)), and the close-out docs (the PR carrying this text). Owner-confirmed on the live service: `PUBLIC_CSP_MODE=enforce` since 2026-10-30 (report-only since 2026-10-24, no CSP errors seen in Chrome on Home, Menu, About and Order), `NODE_VERSION=24.22.1` set on Render on 2026-10-27, one chat order, one phone order, voice resume after a dropped call, no resume after a confirmed order, vendor settings and spend limits checked, and the Render log viewer range at 7 days with no log stream. Claude verified none of the live checks. Not reported, so not recorded as done: the certificate rejection test and a build log read-back of the Node version, and the checklist items listed as unreported in [hardening-report.md](hardening-report.md), "D7 live checks". See [before-going-public-checklist.md](before-going-public-checklist.md). | |

## Vendor setup order

Nmajeed does these. Claude creates no accounts.

1. Before D2: create a Neon account, a project in AWS US West (Oregon), and a `dev` branch next to the default "production" branch. Put the `dev` branch's pooled connection string in `.env` locally.
2. At the D2 deploy: set `DATABASE_URL` in Render to the "production" branch's pooled connection string. Nothing else to run: the table creates itself on the first boot.
3. At the D4 deploy: set `ADMIN_PASSWORD_HASH` and `ADMIN_SESSION_SECRET` in Render.

## Findings from D1 checks

* Promotions (decision 3): `checkPromotions` in `server.js` returns `cartSubtotal`, `eligibleDeals`, `appliedDeal`, and `discountedTotal`. `eligibleDeals` only includes deals whose discount is already above zero for the current cart, so a tool result never suggests adding an item to qualify. Decision 3 is not applicable. Separately, both prompts tell the bot to "suggest complementary items naturally". That is a model behavior, not a tool field, and it is covered by the Currently Unavailable line plus the `add_to_cart` check.
* Prompt cache: Anthropic renders tools, then system, then messages, and caching is a prefix match. The second system block holds the current time to the minute, and it sits ahead of the conversation history. When the minute changes between two turns, the history breakpoint misses and is written again. Only the tools plus the stable system block are read from cache. Tool rounds inside one turn reuse the same system blocks, so they still hit. The resumed-call note in the same block has the same effect between a resumed call's first and second turns. Not part of any milestone (see Later List).

## Risks

* Neon compute-hours: exhausting the 100 free hours suspends the database. Under Option A that means fail open, but no feature may poll.
* Free plan terms can change. All access is in `db.js` and uses plain Postgres, so moving vendors means a new connection string. The table creates itself, and only the sold-out toggles would need setting again.
* Name drift: renaming an item in `menu.json` orphans its stock row and the new name counts as in stock. The orphan report in the boot log catches it, and the item has to be toggled again under its new name.
* Price snapshot: cart lines store the price at add time while deals read the live menu price. Harmless today, but it matters once price editing exists.
* More than one Render instance would make the in-memory state inconsistent. Only relevant if the app moves off the free plan.
* Admin sessions live in memory, so a restart means logging in again. Acceptable for v1.

## Later List

* Automatic back-in-stock reset (for example at opening).
* Voice cost tuning: move the per-minute time label (and the resumed-call note) out of the second system block, for example into the conversation itself, so the conversation-history cache survives across turns.
* Item and price editing, and order viewing, in the dashboard.
* TOTP two-factor for the admin login.
* Past pickup times pass the server check. `validateOrderTiming` checks that a pickup time is inside opening hours but not that it has already passed today, so the model alone decides, inconsistently (see Known issues in [project-instructions.md](project-instructions.md)). The hours logic was frozen during D7, so this needs its own change with its own tests.
* Per-number voice rate limit and blocklist. H5 bounds a single call but nothing limits repeat callers. Sketch from the D7 plan: an environment list of blocked numbers that get a short hangup, plus an in-memory limit of calls per number per hour. It needs a policy for withheld numbers, and state that survives Render deploys if it should outlast a restart. Decide before advertising the phone number.
* Admin dashboard v2. Scope not defined yet. Item and price editing, order viewing and TOTP above are candidates; a new feature is a new file in `admin/sections/`.
* Quantity-based stock. v1 is an in-stock / out-of-stock toggle with no counts (see Scope). Counts would need a quantity column, decrementing on confirmed orders, and a rule for carts that hold more than what is left.
* Stop logging caller speech, or shorten it. The server log records caller speech and CafeBot replies (`[speech]`, `[reply]` and two warning lines in `server.js`), which can include names and addresses (finding L4 in [hardening-report.md](hardening-report.md)). Decided in D7 to keep the logging for now. Until this is done, the owner verifies Render's log retention (see [before-going-public-checklist.md](before-going-public-checklist.md)).
* A database-backed customer session store. It would remove the production MemoryStore warning, and is a new dependency, so it needs approval first.

## Known issues

* Public pages and `/api/*` used to send no `Content-Security-Policy` or other security headers (only `X-Powered-By`). Done in D7 ([#28](https://github.com/nmajeedwork/Cafe-2try1t/pull/28)): the inline scripts are hashed at boot, the headers are sent on public responses, `/admin` keeps its own, and `X-Powered-By` is gone. The CSP was report-only from 2026-10-24, and the owner reports `PUBLIC_CSP_MODE=enforce` went live on 2026-10-30 (see Milestone status). The admin pages already had a strict CSP (D4, D5).
* `CLAUDE.md` tells Claude Code to use a `/browse` skill for all web browsing, but that skill does not exist in this environment. D1 vendor research used web fetch and web search instead.
* App-created worktrees conflict with the primary-folder rule. [project-instructions.md](project-instructions.md) says to work in the project folder and never use worktrees, but the Claude desktop app creates a worktree for each session (D2 ran in `.claude/worktrees/sweet-heyrovsky-9221b2`). Git allows a branch in only one checkout at a time, so a branch created in a session worktree is stuck there until the worktree is detached. Workaround used for D2: commit in the worktree, detach it with `git switch --detach`, then check the branch out in the primary folder. Still to decide: whether to stop the app from creating worktrees, or to relax the rule.
* Stale worktree: `.claude/worktrees/cafebot-session-complete-d9abda` (created 2026-09-24, detached at `fbc7d16`) is still registered and has not been reviewed or removed. Leave it alone until someone checks it for anything unmerged.
* `npm audit --omit=dev` (run during D2) reported 6 vulnerabilities in existing production dependencies, none of them from `pg`. Done in D7 ([#25](https://github.com/nmajeedwork/Cafe-2try1t/pull/25)): triaged, and fixed with lockfile-only bumps inside the existing `package.json` ranges. Re-run during D7 it reported 7 findings (1 critical, 2 high, 4 moderate; `follow-redirects` was one more), and 0 after the bumps. Advisories change over time, so run `npm audit` again before going public. See [hardening-report.md](hardening-report.md) for the reachability assessment.
  * `proxy-addr` (critical): IP spoofing via an IPv4-mapped IPv6 trust subnet, brought in by `express`. Assessed as not reachable, because `trust proxy` is a hop count and Express never uses the subnet matcher for a count. Fixed anyway.
  * `axios` and `follow-redirects` (high): brought in by `twilio`, which this app uses only for `validateRequest` and TwiML. Assessed as not reachable. Fixed anyway.
  * `qs` (moderate): array-limit bypass and a denial of service, brought in by `express` and `body-parser`, which are flagged because of it.
  * `ip-address` (moderate): address-family comparison flaw, brought in by `express-rate-limit`.

## Sources (checked during D1)

* Neon: [pricing](https://neon.com/pricing), [regions](https://neon.com/docs/introduction/regions), [scale to zero](https://neon.com/docs/introduction/scale-to-zero), [connecting](https://neon.com/docs/connect/connect-from-any-app), [free tier FAQ](https://neon.com/faqs/managed-postgres-databases-free-tier)
* Supabase: [pricing](https://supabase.com/pricing), [regions](https://supabase.com/docs/guides/platform/regions), [connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres)
* Turso: [pricing](https://turso.tech/pricing), [locations](https://docs.turso.tech/api-reference/locations), [Developer plan post](https://turso.tech/blog/turso-cloud-debuts-the-new-developer-plan)
* Render: [free tier](https://render.com/docs/free)
