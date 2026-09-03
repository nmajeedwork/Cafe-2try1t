# 2try1t Site Redesign - Closing Report

Permanent record of the "premium redesign" effort for the 2try1t public site
(Home, Menu, Order, About). Covers everything from the pre-redesign baseline
through the final QA pass.

- **Baseline:** git tag `pre-redesign-checkpoint` (commit `fe46767`), the state
  of the site before any redesign work began.
- **End state:** commit `e5868f8` on branch `nmajeedwork/phase5-touch-targets`.
- **Report written:** 2026-09-02.
- **Scope:** the four static pages under `public/` and their CSS/JS. The
  CafeBot server, the Anthropic tool-use logic, and the menu/deal data were
  out of scope and were not changed by the redesign (see "Files left
  untouched").

The redesign ran in phases:

| Phase | Commit | What it did |
|---|---|---|
| 3     | `b030c0e` | Home page rebuilt: token layer, framed hero, marketing sections |
| 3b    | `19b45bc` | Shared header/nav unified across all four pages |
| 3c-1  | `4957746` | Menu and About page bodies rebuilt on the token layer |
| 3c-2  | `c3a0842` | Order page outer chrome and chat-widget skin restyled |
| 4     | `4fc5f61` | Motion pass: hover feedback and scroll-reveal |
| 5     | `eb3e65e` | Touch-target sizing, Order-page breakpoint alignment |
| 6     | `b472fd6` | Phone ordering surfaced on Home; solid pill buttons lightened |
| QA    | `e5868f8` | Final visual-QA fixes (see "Regression and QA results") |

A separate, independently reviewed workstream (em dash / en dash removal from
CafeBot output) landed commits in the same window; it is noted below where it
touched files but was not part of the redesign.

---

## 1. Files changed

Diff of `pre-redesign-checkpoint..e5868f8`: 13 files, +1492 / -261 lines.

### New files

| File | Purpose |
|---|---|
| `public/tokens.css` | Design-token layer: colour variables (cream / tan / ink palette) and the Fraunces (display) + Inter (body) font stacks. Loaded first on all four pages. |
| `public/nav.js` | Mobile hamburger toggle for the shared nav. Progressive enhancement: if it does not run, every nav link is still reachable. ~19 lines, no network calls. |
| `public/reveal.js` | Scroll-reveal via IntersectionObserver: fades section blocks up as they enter the viewport. Only ever adds CSS classes; multiple fallbacks so content is never left hidden if the script fails or is blocked. ~67 lines, no network calls. |

### Modified files (redesign)

| File | What changed |
|---|---|
| `public/index.html` | Full Home rebuild: shared navbar markup, framed hero, Featured Items grid (data fetched live from `/api/menu`), Brand Story section, AI Ordering Preview, Phone Ordering section, Visit / Hours section, footer, and the small inline scroll-reveal head script. |
| `public/menu.html` | Shared navbar; `body.page page--menu`; new light page-header ("The Menu" / "Everything we make"); scroll-reveal head script. The `menu.js` DOM hooks were not changed. |
| `public/about.html` | Shared navbar; `body.page page--about`; page-header; three-column Visit / Hours / Contact grid; scroll-reveal head script. |
| `public/order.html` | Shared navbar added above the chat widget; `body.order-page` class. In the QA pass, a skip-link and a `<main id="main">` wrapper were added around the widget. The `.app` / `.layout` / `.cart-panel` / `.chat-panel` skeleton and every `app.js` DOM hook are unchanged. |
| `public/site.css` | The bulk of the redesign (+953 lines): the shared `.navbar` and `.btn` pill system, the entire Home page (hero, featured, story, preview, phone-ordering, visit, footer), the `.page` shell for Menu and About, the interior page-header, menu-list and about-grid styling, the Phase 4 hover tints and scroll-reveal motion block, Phase 5 touch-target padding, Phase 6 lightened `.btn--solid`, and the QA fixes (nav width reconciliation on Menu/About, featured-card grid gap, Order-page skip-link scoping). |
| `public/style.css` | Order-page widget reskinned onto the token layer (cream page, tan cart panel, sharp corners, token-coloured chat bubbles and input), a reduced-motion guard added for the typing indicator, Phase 4 button hover motion, Phase 5 input/button padding raised to a ~44px touch target and the stacking breakpoint moved from 700px to 760px to match the nav, and the QA pass recoloured the Send and New Order buttons to the lightened tan pill. No structural or DOM changes. |

### Modified files (not redesign; noted for completeness)

| File | Change | Origin |
|---|---|---|
| `server.js` | +31 / -1: the `plainDashes()` backstop that normalises em/en dashes out of CafeBot's outgoing reply text, plus one call site. | Separate dash-removal workstream (`27fb5e2`, `0723f38`), reviewed and merged on its own. |
| `system-prompt.md` | +1 line: "Do not use em dashes or en dashes." | Same workstream (`11c6879`, `d47c84f`). |
| `system-prompt-voice.md` | +1 line: the same instruction for the voice prompt. | Same workstream. |
| `docs/project-instructions.md` | +1 line: a working-convention note ("work directly in the project folder, no worktrees"). | Process note (`88fea3a`), unrelated to the redesign. |

---

## 2. Files intentionally left untouched

Every file below is **byte-identical** to `pre-redesign-checkpoint`. This was
verified by comparing git blob hashes at `pre-redesign-checkpoint` and `e5868f8`.

| File | Status |
|---|---|
| `public/app.js` | Identical. The Order-page chat client was not modified. |
| `public/menu.js` | Identical. |
| `menu.json` | Identical. |
| `deals.json` | Identical. |
| `package.json` | Identical. |
| `package-lock.json` | Identical. |
| `.gitignore` | Identical. |
| `system-prompt-milestone2.md` ... `system-prompt-milestone5.md` | Identical (all four). |
| `elevenlabs-tts.js` | Identical (voice/TTS work, predates the baseline). |
| `voice-order-recovery.js` | Identical (voice work, predates the baseline). |

**Exceptions:** `server.js`, `system-prompt.md`, and `system-prompt-voice.md`
were changed, but only by the separate em dash / en dash workstream described
in section 1, not by the redesign. Those three changes were reviewed on their
own. `.env` is gitignored and was never touched.

---

## 3. UI components created

| Component | Selector(s) | Used on |
|---|---|---|
| Shared navbar | `.navbar`, `.navbar__inner`, `.navbar__brand`, `.navbar__menu`, `.navbar__toggle`, `.navbar__call`, `.navbar__cta` | All four pages. Includes the mobile hamburger, an `aria-current="page"` marker per page, a phone-number link, and a "Start an Order" CTA. |
| Pill button system | `.btn`, `.btn--solid`, `.btn--outline`, `.btn-row` | Home content plus the nav CTA on all four pages. Pills are the only rounded element in the design. |
| Interior page-header | `.page-header`, `.page-header__eyebrow`, `.page-header__title`, `.page-header__lede` | Menu, About. |
| Featured Items section | `.featured`, `.featured__grid`, `.featured__card`, `.featured__photo`, `.featured__name`, `.featured__desc`, `.featured__status` | Home. Three cards, data pulled live from `/api/menu` and matched by item name. |
| Brand Story section | `.story`, `.story__grid`, `.story__photo`, `.story__text` | Home. Tan band, two-column text-plus-image. |
| AI Ordering Preview section | `.preview`, `.preview__wrap`, `.preview__chat`, `.bubble`, `.bubble--in`, `.bubble--out`, `.preview__note` | Home. A static chat-bubble mockup, not the live widget. |
| Phone / Voice Ordering section | `.call-order`, `.call-order__wrap`, `.call-order__text`, `.call-order__btn`, `.call-order__icon` | Home (added in Phase 6). The nav phone link appears on all four pages. |
| Visit / Hours section | `.visit`, `.visit__grid`, `.visit__col`, `.visit__line`, `.visit__hours` | Home. |
| About details grid | `.about-grid`, `.about-block`, `.about-block__label`, `.about-line`, `.about-line--strong` | About. The interior-page equivalent of Home's Visit section (Visit / Hours / Contact). |
| Shared footers | `.home-footer` / `.page-footer` | Home / (Menu, About). Full-bleed background with a contained inner text block. |
| Placeholder image blocks | `.hero__photo`, `.featured__photo`, `.story__photo` | Home. Diagonal two-tone tan stripes standing in for real photography, which is not sourced yet. |

---

## 4. Animations added (Phase 4)

All motion was added in a single pass and is fully guarded for
`prefers-reduced-motion`.

### Hover feedback

- **Always on (colour only, not motion):** menu rows tint on hover
  (`rgba(201,184,154,0.16)`); featured cards tint on hover
  (`rgba(201,184,154,0.12)`).
- **Motion-gated:** pill buttons lift `translateY(-1px)` on hover and release
  on `:active`; featured cards lift `translateY(-3px)`; nav links grow a
  `--color-tan` underline. All transition at 0.18s to 0.2s ease. The
  Order-page Send and New Order buttons get the same 1px lift.

### Scroll-reveal

Home's Featured / Story / Preview / Visit sections, the Menu list, and the
About grid fade up from `opacity: 0; translateY(16px)` over 0.4s ease as they
scroll into view (IntersectionObserver, threshold 0.12). The hero and interior
page-headers are deliberately excluded.

### Reduced-motion coverage

**Complete.** Every transition and the reveal entrance sit inside
`@media (prefers-reduced-motion: no-preference)`. The reveal's dimmed start
state is additionally gated behind the JS-set `.js-reveal` class, and
`reveal.js` has fallbacks (no IntersectionObserver, script error, script
blocked) that leave every section visible. The one pre-existing animation, the
chat typing-indicator dots, was brought into coverage in Phase 3c-2 with an
`animation: none` rule under `@media (prefers-reduced-motion: reduce)`.

Note: the Phase 4 work uses the opt-in `no-preference` convention; the older
typing-indicator guard uses the opt-out `reduce` convention. Both are correct;
the mix is cosmetic.

---

## 5. Dependencies added

**None.**

`package.json` and `package-lock.json` are byte-identical to
`pre-redesign-checkpoint`. The entire redesign is vanilla CSS and vanilla
JavaScript: `nav.js`, `reveal.js`, and small inline scripts. The only external
assets are the Google Fonts stylesheet (Fraunces + Inter) loaded via `<link>`,
which was already the project's pattern.

---

## 6. Regression and QA results

### Phase 6 - full CafeBot regression pass

A 14-item regression test was run across both transports (browser chat and
voice), since they share `runCafeBotTurn` but have separate prompts and UI.

**Result: 14 / 14 items tested. 12 passed on the first pass. The 2 that were
left open are both resolved:**

- **Past-pickup-time validation.** `validateOrderTiming` (in `server.js`)
  checks whether a requested pickup time falls within operating hours but does
  not check whether that time has already passed earlier today. A
  stale-but-in-hours time (for example, asking for pickup at 6 PM when it is
  already 7:30 PM) passes the server guard, so handling falls to the model
  alone and is inconsistent turn to turn. **Resolved as: documented known
  issue, deferred** (low severity). Recorded in the "Known issues / deferred"
  section of `docs/project-instructions.md`.
- **Real Twilio voice call (item 11).** Could not be tested without physically
  placing a call. **Resolved as: confirmed working via a real call.** The full
  flow was verified end to end: `/voice/incoming` to `/voice/process-speech`
  to `/voice/continue`, tool use, business-hours check, ElevenLabs TTS with no
  fallback to Twilio `<Say>`, the speech-confidence guard, the misheard-speech
  re-prompt, and farewell detection. Two rough edges were noted and recorded
  as known issues (deferred, low severity): the name-spelling confirmation is
  too aggressive and can degrade a high-confidence name, and the farewell exit
  is clumsy when unconfirmed items are still in the cart.

### Step 14 - final visual QA

Reviewing all four pages together at 375px, 768px, 1024px, and 1440px surfaced
five issues. All five were fixed in commit `e5868f8`.

| # | Issue | Root cause | Fix |
|---|---|---|---|
| 1 | On Menu and About, the navbar overhung the page body by ~100px on each side at desktop widths. | The shared `.navbar__inner` is `max-width: 1100px`; the Menu/About content column (`.page__main`) is `max-width: 900px`. Home aligned (both 1100), the Order page had an explicit fix, but Menu and About were never reconciled. | Added `body.page .navbar { width: 100%; max-width: 900px; margin-inline: auto; }`, mirroring the Order page. Nav and content edges now align at every width. |
| 2 | On Home, the middle Featured Items card's photo was ~20px shorter than the other two, so the three item names did not line up. | `.featured__card` had `padding: 0 28px`, but `:first-child` removed the left padding and `:last-child` the right, making the middle card's content box 28px narrower. With `aspect-ratio: 4 / 3` on the photo, a narrower column produced a shorter photo. | Removed the card padding; spacing between cards is now a grid `column-gap: 56px`, so all three cards are an equal `1fr`. The divider between cards moved to a centred gutter pseudo-element (`::after`) that cannot affect card width. On mobile (stacked) the divider stays a bottom border. |
| 3 | The hours string "5:00 AM - 2:00 AM" rendered with a literal en dash on Home and About. | Hard-coded en dash in static markup, outside the reach of the server-side `plainDashes()` backstop. | Replaced with a plain hyphen in `index.html` and `about.html`. A scan confirms no em or en dashes remain in any file under `public/`. |
| 4 | The Order page's Send and New Order buttons kept the old dark-brown treatment after Phase 6 lightened `.btn--solid` site-wide. | Phase 6 changed `.btn--solid` in `site.css` but the Order widget's bespoke buttons in `style.css` were not updated. | Both buttons now use the tan fill, dark ink text, and darker-on-hover pattern from `.btn--solid`. Pill shape and focus rings were left unchanged. |
| 5 | The Order page was missing the skip-link that Home, Menu, and About all have. | The Order page (`body.order-page`) was not part of the redesign's `.page` shell and no skip-link was added when the shared nav landed. | Added `<a class="skip-link" href="#main">Skip to content</a>` before the navbar and wrapped the widget in `<main id="main">`. `.order-page` was added to the skip-link CSS selectors, and a `body.order-page main` rule preserves the widget's flex layout. Nothing inside the `.app` widget skeleton was changed (6 lines added to `order.html`, 0 removed). |

---

## 7. API efficiency and leakage findings (Step 16)

A read-only audit of cost and data-exposure surfaces, run after the redesign
and QA fixes landed. The redesign changed no server code, so items 2 to 4
below describe pre-existing behaviour that the redesign did not alter; items 1
and 5 cover the new front-end surface.

### 7.1 No secrets client-side - confirmed clean

The server hands the browser only the contents of `public/` (via
`express.static` plus three `sendFile` routes). A scan of every file under
`public/` for `ANTHROPIC_API_KEY`, `TWILIO_*`, `ELEVENLABS_*`,
`SESSION_SECRET`, and key-shaped strings found nothing. No client file
references `process.env`. The two new scripts (`nav.js`, `reveal.js`) touch
only the DOM. `public/audio/` holds ElevenLabs-rendered audio of CafeBot's
spoken replies, served for Twilio playback; it contains no credentials,
though as un-authenticated static audio it belongs in the public-hardening
review.

### 7.2 Unprotected cost surfaces - confirmed, unchanged

**Severity: low while reachable only via a local dev server, high once
publicly reachable.**

`/chat` and `/dev/voice-chat` have no rate limiting, no authentication, no
CAPTCHA, and no per-session cap. `express-session` runs with
`saveUninitialized: true`, so a caller does not even need an existing cookie.
Each accepted request runs `runCafeBotTurn`, which makes 1 to 7
`claude-sonnet-5` calls (one initial call plus up to `MAX_TOOL_ROUNDS` = 6
tool-round continuations).

Hitting `/chat` in a tight loop: nothing prevents or throttles it. Express
handles requests concurrently, so N parallel connections produce up to 7N
model calls in flight. The only backpressure is the Anthropic account's own
rate limit; calls that have already dispatched are billed regardless. Prompt
caching reduces the re-send cost of a long session but does not cap request
volume.

This is unchanged by the redesign. It belongs in the separate
"harden for public deployment" work: per-IP and global rate limiting, a hard
request cap, and a check that the request carries the session cookie or a
token.

### 7.3 Dev-only endpoints in production - confirmed not gated

**Severity: low while dev-only, medium once publicly reachable.**

`NODE_ENV` is referenced nowhere in the codebase.

- `/dev/voice-chat` is registered unconditionally. Its only "dev" markers are
  the URL path and a code comment. In production it works identically and is
  a second unauthenticated model-cost endpoint.
- `DISABLE_HOURS_CHECK` and `FORCE_HOURS_CLOSED` are plain
  `process.env.X === 'true'` checks with no `NODE_ENV` guard. If either is set
  in a production environment it takes full effect there (disabling or forcing
  the operating-hours rule), with nothing louder than a `console.warn` at
  startup. They are safe today only because `.env` is gitignored and these are
  not set in production; there is no code-level guardrail.

Hardening pass: gate `/dev/voice-chat` behind `NODE_ENV !== 'production'` (or
remove or authenticate it), and make the two overrides refuse to apply, or
fail loudly, when `NODE_ENV === 'production'`.

### 7.4 Prompt caching - confirmed intact

The caching structure is unchanged and correct:

- The stable system text (base prompt plus menu JSON) is built once at module
  load, so it is byte-identical on every request.
- `buildSystemBlocks` places `cache_control: { type: 'ephemeral' }` on the
  stable block and puts the volatile per-minute "current time" block after it,
  so the time block does not invalidate the cache and is not itself cached.
- `withCacheBreakpoint` marks the last content block of the last message for
  incremental conversation-history caching, without mutating stored history.
- `tools` is passed after `system`, so it caches alongside the trailing
  system block.
- `logCacheUsage` logs `cache_read` and `cache_creation` on every call as a
  regression canary.

The em dash / en dash prompt edits changed the stable system text's bytes once
(permanently, from that deploy), which is a one-time cache-creation cost, not
per-request variability. The `plainDashes()` change runs on the reply text
after the API calls return and explicitly does not run on conversation
history, so cached message prefixes stay byte-identical. Live logs during the
Phase 6 voice test showed `cache_read` on essentially every turn. Caching is
working.

### 7.5 Redundant client-side calls - none introduced

`/api/menu` is fetched exactly once per page load, and only on two pages: Home
(new in the redesign, for the Featured Items section) and Menu (pre-existing,
for the full list). These are different pages; no page fetches it twice.
`/api/menu` returns an in-memory object with no model call and no database, so
its cost is negligible. There is no polling, no `setInterval` loop, no
`EventSource`, and no `WebSocket` anywhere in the client code. `app.js` calls
`/chat` on submit and `/reset` on "New Order" only.

The redesign added exactly one network call: Home's single `/api/menu` fetch.

---

## 8. Status at time of writing

- Redesign work sits on branch `nmajeedwork/phase5-touch-targets` at commit
  `e5868f8`. As of this report it has not been merged to `main` and no pull
  request has been opened.
- The known issues recorded during the QA and regression passes
  (past-pickup-time validation, voice name-spelling, voice farewell exit) are
  tracked in `docs/project-instructions.md` under "Known issues / deferred".
- The API hardening items in section 7 are deferred to a separate
  "harden for public deployment" effort and were deliberately not folded into
  the redesign branch.
