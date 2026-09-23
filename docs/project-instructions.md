Project Instructions — 2try1t Café AI Agent

## Context

Nmajeed is building an AI ordering agent ("CafeBot") for a café called 2try1t, while learning to code. Claude Code is the primary implementation tool; this chat is used for planning, review, and troubleshooting alongside Claude Code sessions.

## Tech Stack

* Backend: Node.js + Express
* Frontend: Plain HTML/JS (no framework)
* AI: Claude API with tool use (function calling)
* Data storage: JSON files (menu.json, deals.json) / SQLite for orders
* Telephony (in progress): Twilio Voice
* Git: repo-local identity — n.majeed.work@gmail.com / Nmajeed

## Working Conventions

* Work one milestone at a time. Always present a plan and get it approved before implementation begins.
* Always show diffs before Claude Code commits anything.
* Nmajeed personally verifies functionality in the browser before anything is committed.
* Never amend published/already-committed commits.
* Prefer receiving one milestone's instructions at a time, not the full roadmap dumped at once.
* Business logic decisions (deal stacking rules, validation behavior, etc.) should be confirmed with Nmajeed before implementation, not assumed.
* Server-side/tool-level validation is preferred over relying on prompt instructions alone for anything safety- or accuracy-critical (pricing, totals, hours validation, order confirmation gating).
* Claude Code must always work directly in the project folder — never create worktrees or separate checkouts, even for read-only audits. Use `git show` / `git diff` / `git log` instead if inspection without disturbing the working tree is needed. This caused a real mix-up once (an audit run in a separate worktree reported the repo as clean while uncommitted work sat untouched in the real folder).

## Project Status (update as milestones complete)

### Core agent — COMPLETE (Milestones 1–8)

1. ✅ Project scaffold
2. ✅ Menu-aware Q&A agent
3. ✅ Tool use for cart management
4. ✅ Order type and address collection with operating hours validation
5. ✅ Order confirmation
6. ✅ Promotions and deals
7. ✅ Frontend polish (warm café-themed styling, live cart panel)
8. ✅ Testing pass

### Key locked-in business logic

* Operating hours: 5:00 AM – 2:00 AM, all days (Mon–Sun), with a 30-minute last-order buffer before closing (applies to both pickup and delivery)
* BOGO deals discount the cheaper of the two qualifying items
* Only the single best promotion applies per order — no stacking
* Pickup validation uses customer-specified time; delivery validation uses current server time
* `set_order_type` accepts optional `customer_name` and `pickup_time` for pickup orders (no separate tool needed)
* `confirm_order` has a server-side guard against empty carts (not just prompt-level guidance)

### System prompt files (in project repo)

* `system-prompt-milestone2.md` through `system-prompt-milestone5.md` — scoped prompts used during incremental development
* `system-prompt.md` — the full, unified prompt (all tools exist) — in use since Milestone 6

### Phone/Voice Support (COMPLETE)

Using Twilio Voice. Broken into sub-milestones:

1. ✅ Basic call connectivity (answer call, static greeting, no AI yet)
2. ✅ STT/TTS pipeline (speech-to-text and text-to-speech, still no CafeBot logic)
3. ✅ Connect to existing CafeBot logic (route transcribed text through existing /chat tool-use flow)
4. ✅ Voice-specific prompt tuning (shorter responses, no long lists read aloud, explicit confirmations since there's no visual cart)
5. ✅ Testing pass (real calls, mishearing, silence, background noise)

### Deployment (COMPLETE)

CafeBot is live at https://cafe-2try1t.onrender.com/. Both browser chat and voice ordering have been verified working end-to-end on the actual production deployment, not just local testing, including a complete real phone order that produced a valid order ID.

The visual redesign, all four security hardening passes (H1-H4), and deployment are all complete. See [redesign-report.md](redesign-report.md) and [hardening-report.md](hardening-report.md) for details.

## Future/deferred (not yet scoped)

* WhatsApp integration
* POS system integration
* In-chat payment collection
* Address validation/geocoding for delivery zones
* Customer profiles / repeat customer history

## Inventory/Stock Management Dashboard (deferred, not yet scoped in detail)

Goal: replace the static menu.json with live inventory tracking, and give Nmajeed a web dashboard to add/edit items and mark things out of stock, with CafeBot responding based on real-time availability instead of a fixed list.

Known scope, roughly comparable in size to the visual redesign effort:
* Requires a real database (menu.json's flat-file model doesn't support live read/write updates)
* Requires authentication for the dashboard. An unauthenticated admin panel would undo the H1-H4 hardening work
* Requires new/updated agent tools so CafeBot checks and decrements stock, not just reads a static list
* Requires a dashboard UI to be designed and built

Not started. Treat as its own project phase (plan, approve, implement, same working convention as everything else) once picked up. Don't fold into an existing milestone.

## Known issues / deferred

* `validateOrderTiming` (server.js) checks whether a requested pickup time falls within operating hours, but does not check whether that time has already passed earlier today. A stale-but-in-hours time (e.g. asking for pickup at 6 PM when it is already 7:30 PM) passes the server guard, so handling falls to the model alone, and that is inconsistent turn to turn (sometimes it accepts and stores the past time, sometimes it flags it and asks for a new one). Low severity, deferred, revisit later. Surfaced during the Phase 6 regression pass.
* Voice: name-spelling confirmation is sometimes too aggressive, and degraded "Sarah" to "Sara" in testing. Surfaced during the Phase 6 regression pass's real Twilio call test.
* Voice: farewell exit is clumsy when there are unconfirmed items in the cart at the time the call ends. Surfaced during the Phase 6 regression pass's real Twilio call test.
* Voice: a combined cancel-and-goodbye utterance in one sentence (e.g. "I don't want anything and bye") wasn't understood on first attempt during a live call while the agent was mid-flow asking for pickup name. It did not recognize this as an exit signal immediately. The call did eventually end correctly after a follow-up exchange. Distinct from the farewell-exit note above, which is about cart state at call end. This is about a specific phrasing combination.

### Resolved

* RESOLVED — Timezone bug: server.js used raw server clock time (Render runs UTC) as if it were the café's local time (Winnipeg, America/Winnipeg), with no timezone conversion anywhere in the codebase. This caused incorrect open/closed determinations and fed the wrong current day/time into every chat and voice interaction since deployment. Never caught in local testing because the local dev machine's clock happened to already be in Winnipeg time. Found via a real phone call from a friend at 9 PM Winnipeg time that was incorrectly told the café was closed. Fixed by adding a getCafeNow() helper using Intl.DateTimeFormat with the America/Winnipeg timezone, replacing every raw new Date() call site used for café-local time. Added test/hours.test.js (14 tests) as permanent regression coverage. Verified fixed via a live phone call after deployment.

## Lessons Learned (apply going forward)

* Create milestone-scoped system prompt files proactively/upfront when planning a multi-stage build, not reactively after a mismatch is discovered — this already caused rework once (Milestones 3–5 prompts had to be created retroactively).
* Environment setup (Node.js, git init) should be verified early in a new environment before assuming tooling is available.
* Third-party skills, plugins, and connectors get trialled in a scratch project first — never introduced into a repo that has already passed a testing round. Evaluate what a skill actually installs (how many skills ship in the bundle, what scripts it runs, what files it can read, whether anything runs automatically) before it touches working code.
