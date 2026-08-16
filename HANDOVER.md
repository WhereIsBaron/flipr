# FLIPR Public — Handover (v2.4.2)

## Goal
Fix a user-reported bug: on Torn PDA, extra collapsed "F" buttons stack up under the
original — one more per in-app navigation (repro: Crimes → Pick Pocket → back to hub →
Burglary…), only clearing on a full page refresh. Reporter: Skid_Br0 (Redmi K70, PDA 3.14.3).

## Root cause
Torn PDA re-injects userscripts on each in-app navigation instead of doing a real page
reload. FLIPR's whole IIFE re-ran and appended a fresh `#flipr-panel` (plus a duplicate
set of observers/API pollers) on top of the live one each time. A hard refresh tears down
the DOM, so it reset to one. Desktop never shows it — real navigations reload cleanly.

## Fix (done, in working tree)
- `flipr-public/flipr.user.js` — added early idempotency guard at top of the IIFE
  (just after `'use strict';`): `if (document.getElementById('flipr-panel')) return;`.
  A re-injection detects the existing panel and bails, leaving the live instance and its
  observers/pollers untouched. First run wins; full refresh re-inits normally. This also
  kills the hidden duplicate-observer/duplicate-poller traffic, not just the visible stack.
- `flipr-public/flipr.user.js` — bumped `@version` and `SCRIPT_VERSION` `2.4.1 → 2.4.2`.
- `flipr-public/CHANGELOG.md` — added v2.4.2 entry crediting Skid_Br0's repro.

## State
- All edits saved to disk. Not committed, not pushed. `flipr-public/` is a git repo (remote
  origin/main exists).

## Open loops / next steps
1. Optional: `git add -A && git commit` in `flipr-public/` and push, then update the
   published listing (Greasy Fork / Torn forums — see GREASYFORK_LISTING.md,
   TORN_FORUMS_LISTING.md).
2. **Private build likely has the same bug.** `flipr/flipr-private.user.js` has a different
   multi-IIFE structure and no equivalent early guard — port the guard over. (Not yet done;
   user was asked, awaiting go-ahead.)
3. Reply to Skid_Br0 confirming the fix once released.

## Gotchas
- Version lives in TWO places in the userscript: `@version` header AND `SCRIPT_VERSION`
  const — keep them in sync.
- Script is deliberately read-only (see COMPLIANCE NOTE at top of flipr.user.js) — never
  add anything that clicks/submits/fills forms or calls non-Torn-API endpoints.
