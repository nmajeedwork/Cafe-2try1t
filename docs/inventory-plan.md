# Inventory Dashboard Plan (D1)

Approved plan for adding stock tracking to CafeBot. D1 (planning) is complete. Nothing in this plan is implemented yet. Each milestone below is planned, approved, built, and verified on its own, following the usual working conventions in [project-instructions.md](project-instructions.md).

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

* New `GET /api/availability` returns `{ "unavailable": [...] }`, read from memory.
* `/api/menu` stays byte-for-byte unchanged.

## Failure behavior (Option A)

* After a successful load, the in-memory state is used indefinitely. The database only matters again at the next toggle.
* If the boot load fails or takes longer than 3 seconds, the server starts anyway, treats everything as in stock (today's behavior), logs loudly, and retries in the background: 5 seconds, doubling up to a 15 minute cap, stopping on the first success. A permanent error (wrong password, no such database, no permission, no `DATABASE_URL`) turns retries off, since retrying would only wake the database for nothing. Once the dashboard exists it shows a banner while stock is unavailable.
* A toggle while the database is down returns an error and leaves memory unchanged.
* Tradeoff accepted: during an outage that overlaps a restart, a sold-out item could be ordered.

## Admin auth (direction, finalized in D4)

* Single password plus session cookie. No new dependency: Node's built-in `crypto.scrypt` for hashing, plus the existing `express-session` and `express-rate-limit`.
* Only the scrypt hash with its salt is stored, in `ADMIN_PASSWORD_HASH`. Comparison is constant-time.
* Login rate limiting. The lockout design is decided at D4 planning.
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

## Known issues

* `CLAUDE.md` tells Claude Code to use a `/browse` skill for all web browsing, but that skill does not exist in this environment. D1 vendor research used web fetch and web search instead.
* App-created worktrees conflict with the primary-folder rule. [project-instructions.md](project-instructions.md) says to work in the project folder and never use worktrees, but the Claude desktop app creates a worktree for each session (D2 ran in `.claude/worktrees/sweet-heyrovsky-9221b2`). Git allows a branch in only one checkout at a time, so a branch created in a session worktree is stuck there until the worktree is detached. Workaround used for D2: commit in the worktree, detach it with `git switch --detach`, then check the branch out in the primary folder. Still to decide: whether to stop the app from creating worktrees, or to relax the rule.
* Stale worktree: `.claude/worktrees/cafebot-session-complete-d9abda` (created 2026-09-24, detached at `fbc7d16`) is still registered and has not been reviewed or removed. Leave it alone until someone checks it for anything unmerged.
* `npm audit --omit=dev` (run during D2) reports 6 vulnerabilities in existing production dependencies, none of them from `pg`. Not triaged or fixed, and not touched by D2. Triage them in the D7 security pass.
  * `proxy-addr` (critical): IP spoofing via an IPv4-mapped IPv6 trust subnet, brought in by `express`. This app sets `trust proxy` to a hop count of 1 rather than a subnet list, so it may not apply, but that is unconfirmed.
  * `axios` (high): prototype pollution gadgets, brought in by `twilio`.
  * `qs` (moderate): array-limit bypass and a denial of service, brought in by `express` and `body-parser`. `express` and `body-parser` are flagged because of it.
  * `ip-address` (moderate): address-family comparison flaw, brought in by `express-rate-limit`.
  * `npm audit` says a fix is available for all of them.

## Sources (checked during D1)

* Neon: [pricing](https://neon.com/pricing), [regions](https://neon.com/docs/introduction/regions), [scale to zero](https://neon.com/docs/introduction/scale-to-zero), [connecting](https://neon.com/docs/connect/connect-from-any-app), [free tier FAQ](https://neon.com/faqs/managed-postgres-databases-free-tier)
* Supabase: [pricing](https://supabase.com/pricing), [regions](https://supabase.com/docs/guides/platform/regions), [connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres)
* Turso: [pricing](https://turso.tech/pricing), [locations](https://docs.turso.tech/api-reference/locations), [Developer plan post](https://turso.tech/blog/turso-cloud-debuts-the-new-developer-plan)
* Render: [free tier](https://render.com/docs/free)
