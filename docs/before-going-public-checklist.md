# Before Going Public Checklist

Run through this before ever sharing the live link with anyone (recruiter, interviewer, portfolio visitor).

- [ ] Render free tier: either upgrade to a paid instance temporarily, or set up a keep-alive ping, so the first request doesn't sit through a 30-50+ second cold-start delay. (Skipped for now while this is private/testing-only. Revisit before sharing.)
- [ ] Confirm Twilio account is active (not suspended) and has a real balance.
- [ ] Confirm ElevenLabs plan is active with enough credits remaining.
- [ ] Confirm NODE_ENV=production and all real environment variables are correctly set in Render (not leftover dev/placeholder values).
- [ ] Place one real test call end to end, and send one real chat message end to end, on the actual live URL (not localhost). Confirm both work before sharing.
- [ ] Check [docs/project-instructions.md](project-instructions.md)'s "Known issues / deferred" section and confirm nothing there has gotten worse since it was written.
- [ ] Replace placeholder image slots with real photos, if that's been done by this point (optional, not a functional blocker, but affects how polished it looks to a visitor).

See [docs/hardening-report.md](hardening-report.md) for the security hardening passes already completed, and [docs/project-instructions.md](project-instructions.md) for the full project reference.
