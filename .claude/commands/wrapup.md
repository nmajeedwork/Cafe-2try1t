---
description: Review, confirm, commit, and push/PR the current changes safely
---

You are running the `/wrapup` routine. Follow these steps in order. Do not skip
the confirmation steps, and never commit anything the user has not been shown.

## 1. Show what changed

Run `git status` and `git diff` (include staged and unstaged). Give the user a
concise summary of everything that changed: which files, and what changed in each
and why. If the diff is large, group it by file or concern. Do not commit yet.

## 2. Confirm it is tested and ready

Ask the user explicitly: "Are these changes tested and ready to commit?"

Do NOT assume the changes are ready just because `/wrapup` was typed. Wait for a
clear yes. If the user says something is still in progress or untested, stop and
let them finish.

## 3. Write a specific commit message and commit

Once the user confirms, write a clear, specific commit message:
- Say what changed and why, not just "updates" / "changes" / "fixes".
- Reference the affected area (file, feature, or subsystem).
- Follow the repo's existing commit style.

Stage the relevant files by name (never `git add -A` or `git add .`) and commit.

## 4. Decide push vs PR

Ask the user: "Is this a small, low-risk change (docs, config, single-line fixes),
or a substantial change (new features, multi-file, anything touching server.js
logic or business rules)?"

Then:
- **Small/low-risk AND current branch is `main`:** push directly with
  `git push origin main`. No PR needed.
- **Substantial, OR the current branch is a feature branch:** push the branch
  (`git push -u origin <branch>`), then open a PR against `main` with
  `gh pr create` (fill in a real title and body). If `gh` is not available or not
  authenticated, give the user the manual
  `https://github.com/<owner>/<repo>/pull/new/<branch>` link instead.
  **Stop there. Do NOT merge the PR.** Tell the user it is pushed and the PR is
  ready for their review.

## 5. Hard limits

- Never delete branches as part of this command.
- Never force-push as part of this command.
- Never merge a PR as part of this command.
