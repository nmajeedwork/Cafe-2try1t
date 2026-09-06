---
description: Safely delete a merged feature branch and sync main
argument-hint: [branch-name]
---

You are running the `/cleanup-branch` routine for the branch: **$ARGUMENTS**
(if no branch name was given, ask the user which branch to clean up before
doing anything).

Follow these steps in order. Do not assume the merge happened.

## 1. Confirm the PR is merged

Ask the user to confirm the relevant PR is actually merged on GitHub. Wait for a
clear yes. Do not proceed on assumption.

## 2. Sync main

Run:
```
git checkout main
git pull origin main
```

## 3. Verify the merge is really in main

Confirm the branch's work is actually in `main`'s history — do not just trust that
the merge happened. Use `git log --oneline` to look for the merge commit, and/or
`git merge-base --is-ancestor <branch-tip> HEAD` (exit 0 means it is an ancestor).
If the work is NOT in main, stop and tell the user — do not delete anything.

## 4. Delete the merged branch locally

Run `git branch -d <branch>` (lowercase `-d`). This refuses to delete a branch
that is not actually merged, which is the safety check we want.

Never use `git branch -D` here unless the user has explicitly told you to in this
session.

## 5. Prune stale remote-tracking refs

Run `git fetch --prune`. GitHub auto-deletes the remote branch on merge, so this
removes the stale `origin/<branch>` tracking ref automatically instead of the
user checking by hand. (A direct `git push origin --delete <branch>` is expected
to fail with "remote ref does not exist" in that case — the prune is the correct
tool.)

## 6. Report final state

Run `git branch -a` and `git status`. Confirm to the user that only `main`
remains (locally and for remote-tracking refs) and the working tree is clean.
