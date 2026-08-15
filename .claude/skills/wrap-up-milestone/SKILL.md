---
name: wrap-up-milestone
description: End-of-milestone routine for the 2try1t CafeBot project — review and commit the milestone's changes, then stop the dev server/ngrok tunnel and clean up leftover log files. Use when the user confirms a milestone is working and wants to close it out (e.g. "confirmed working, commit this and stop the server").
---

# Wrap up a 2try1t CafeBot milestone

This project's established workflow, seen across every milestone so far: the user tests a change (in the browser or over a live phone call), confirms it's working, then wants the change committed and the local dev processes shut down cleanly before ending the session. This skill runs that whole sequence so it doesn't need to be spelled out step by step each time.

Follow these steps in order. Narrate what you're doing briefly as you go — don't silently batch everything into one wall of output.

## 1. Review what changed

Run `git status` and `git diff` on the tracked files only. Never run `git add -A` — this project always stages specific files by name (see CLAUDE.md / docs/project-instructions.md conventions).

Exclude from consideration:
* `.env` — gitignored, may contain dev-only toggles (see step 5). Never stage or commit it.
* `*_out.log` / `*_err.log` — gitignored server/ngrok output, never committed; deleted in step 4.
* `node_modules/`, `.claude/` — already gitignored.

If there are no tracked changes, say so and skip to step 3.

## 2. Commit

Show the user the diff (or a summary of it if it's long) before committing — this project's convention is to always show the diff first, never commit silently.

Propose a commit message in the style already used in this repo's history, e.g.:
* `Phone Milestone N: <short description> — <what changed and why>`
* Or for a fix mid-milestone: `<Area>: <what was fixed>`

Check `git log --oneline -10` if unsure of the current milestone number or naming style.

Stage exactly the relevant tracked files by name (never `-A`), then commit. If the user already gave an exact commit message in their request, use it verbatim rather than rewording it.

## 3. Stop the dev server and ngrok tunnel

Find and stop any running processes for this project:

```powershell
$serverProcs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*server.js*' }
$ngrokProcs = Get-CimInstance Win32_Process -Filter "Name = 'ngrok.exe'"
$serverProcs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$ngrokProcs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
```

Verify both actually stopped (re-query and confirm no matching process remains) rather than assuming the stop succeeded.

## 4. Clean up leftover log files

Delete any `server_out.log`, `server_err.log`, `ngrok_out.log`, `ngrok_err.log` in the project root. These are dev-only redirect targets created when starting the server/tunnel in the background; they're already gitignored, so this is just tidying the working directory, not a git operation.

## 5. Check for dev-only .env toggles left on

Read `.env` and check for `DISABLE_HOURS_CHECK=true` (or any other dev-only override that might get added later in the same spirit — a toggle that changes runtime behavior for testing and is never meant to stay on by default). If found, flag it to the user explicitly and ask whether to remove it now — don't remove it silently, since they may still be mid-testing. If the server is currently running when it gets removed, restart it so the change actually takes effect (env vars are only read at startup) and confirm the startup log no longer shows the corresponding warning.

## 6. Confirm final state

Run `git status` one more time and report that the working tree is clean (or, if step 1 found nothing to commit, that it was already clean). Summarize in 1-2 sentences what was committed (if anything) and confirm both processes are stopped.

## Notes

* This skill only touches this project's own dev processes (`server.js`, `ngrok`) — never kill unrelated `node.exe` processes (e.g. other apps) by matching on name alone; always filter by `CommandLine`.
* If the user's request differs from the full routine (e.g. "just stop the server, don't commit yet"), do only the parts they asked for rather than running the whole sequence regardless.
