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

* Operating hours: Mon–Fri 7am–8pm, Sat–Sun 9am–10pm, with a 30-minute last-order buffer before closing (applies to both pickup and delivery)
* BOGO deals discount the cheaper of the two qualifying items
* Only the single best promotion applies per order — no stacking
* Pickup validation uses customer-specified time; delivery validation uses current server time
* `set_order_type` accepts optional `customer_name` and `pickup_time` for pickup orders (no separate tool needed)
* `confirm_order` has a server-side guard against empty carts (not just prompt-level guidance)

### System prompt files (in project repo)

* `system-prompt-milestone2.md` through `system-prompt-milestone5.md` — scoped prompts used during incremental development
* `system-prompt.md` — the full, unified prompt (all tools exist) — in use since Milestone 6

## Next phase — Phone/Voice Support (in progress)

Using Twilio Voice. Broken into sub-milestones:

1. Basic call connectivity (answer call, static greeting, no AI yet)
2. STT/TTS pipeline (speech-to-text and text-to-speech, still no CafeBot logic)
3. Connect to existing CafeBot logic (route transcribed text through existing /chat tool-use flow)
4. Voice-specific prompt tuning (shorter responses, no long lists read aloud, explicit confirmations since there's no visual cart)
5. Testing pass (real calls, mishearing, silence, background noise)

## Future/deferred (not yet scoped)

* WhatsApp integration
* Inventory/stock checking (flagged as wanted, not yet planned in detail)
* POS system integration
* In-chat payment collection
* Address validation/geocoding for delivery zones
* Customer profiles / repeat customer history

## Lessons Learned (apply going forward)

* Create milestone-scoped system prompt files proactively/upfront when planning a multi-stage build, not reactively after a mismatch is discovered — this already caused rework once (Milestones 3–5 prompts had to be created retroactively).
* Environment setup (Node.js, git init) should be verified early in a new environment before assuming tooling is available.
