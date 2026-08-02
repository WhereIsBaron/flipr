# Torn forums listing

Not part of the script - a ready-to-paste Torn forums post, kept separate so it can be edited
without touching the script. BBCode did not render as expected on the forum, so the body below is
plain text - paste it as-is. Keep it SHORT; long posts do not get read.

Before posting: replace `<GREASYFORK LINK>` with the real GreasyFork URL. Suggested thread title
is on the first line.

---

## Suggested thread title

FLIPR: Flip Profit Tracker - know what you actually made

---

## Post body (plain text)

FLIPR: Flip Profit Tracker

You buy cheap, list it, and once Torn's 5% tax lands the "profit" is a loss. FLIPR tracks what you paid, warns you before you list too low, and shows your real profit over time.

Small floating panel. No spreadsheets, no manual entry. Works on desktop and on the Torn PDA.

What it does

- Logs your buys automatically - item market, bazaar, points market.
- Holdings - what you paid, and your breakeven price after tax.
- Profits tab - your realized profit over time, matched against what each item cost you.
- Sell Check - type any price and quantity, see profit or loss instantly.
- Breakeven warning while listing - catches a bad price before you submit.
- Weapon stats per copy - two of the same weapon stay separate in your holdings.
- After-tax helper - click an Item Market listing to see its price minus the 5% tax.
- Points tracker - its own tab for Points Market buys.

Read-only, fully within the rules

It never clicks, submits, or fills anything for you. It only reads your own official API log (with a key you enter yourself) and the numbers already on screen, then shows its own figures in its own panel. Your data stays in your browser.

Install

Desktop: install Tampermonkey or Violentmonkey, then open <GREASYFORK LINK> and click Install.

Torn PDA: Settings > User scripts > add the same link. No API key to paste - the PDA supplies its own. Needs v2.0.1 or newer.

Optional on desktop: add a Torn API key (basic + log) in Settings for reliable syncing. A limited key is enough.

Bugs and feedback

Settings has a "Copy debug export" button - it copies a snapshot with your API key stripped out. Send it, or any suggestions, to The_Baron [1467784].

Free, open source, MIT licensed. Happy flipping.
