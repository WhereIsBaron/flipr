FLIPR - Flip Profit Tracker
A Torn userscript by The_Baron [1467784]
================================================================

FLIPR tracks what you paid, warns you before you list below a real profit, and
shows what you actually made. Works on desktop and the Torn PDA.


WHAT IT DOES
----------------------------------------------------------------
- Logs your buys automatically - item market, bazaar, points market. Nothing to
  type in.
- Holdings - what you paid per item, and your breakeven price after tax.
- Profits tab - your realized profit over time, matched against what each item
  actually cost you.
- Sell Check - type a price and see profit or loss instantly (5% market, 15%
  anonymous, or 0% bazaar).
- Breakeven warning - catches a listing price below breakeven before you submit.
- Weapon stats per copy - records each weapon's own Damage and Accuracy, so two
  of the same name stay separate.
- After-tax helper - click an Item Market listing to see its price minus the 5%
  tax.
- Points tracker - its own tab for Points Market buys.

It is a small floating panel. Drag it anywhere, or collapse it to a button.


READ-ONLY, FULLY WITHIN THE RULES
----------------------------------------------------------------
FLIPR never clicks, submits, or fills anything in for you. It reads your own API
log and the numbers Torn already shows you, then displays its own. Nothing is
sent anywhere except Torn's own API, for your own account - apart from the
optional cloud sync described below, which stays off until you turn it on.


YOUR DATA
----------------------------------------------------------------
By default everything is stored in your own browser and nothing is sent anywhere
except Torn's own API, using your key, for your own account. One optional extra,
cloud sync, is off unless you turn it on: with it on, FLIPR mirrors your own
tracked data to a private cloud copy tied to your Torn ID so your desktop and PDA
stay in sync. Your API key is never uploaded, including when sync is on, and
turning sync off deletes the cloud copy.

API key selections used:
    user  -> basic   (your player id, so sync can confirm the key is yours)
    user  -> log     (your own buys and sells)
    torn  -> items   (item names)
Nothing else is requested.

Make a FLIPR-only key with this link (opens Torn's Custom Key Builder with just
those three boxes ticked):

    https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=FLIPR&user=basic,log&torn=items

A key scoped this way cannot read your money, battle stats, messages or faction
data. There is a shortcut to the same link inside the script, next to where you
paste the key. A Full key works too, but gives away far more than FLIPR ever
reads. On the PDA there is nothing to paste; it supplies its own key.


INSTALL
----------------------------------------------------------------
1. Install a userscript manager (Tampermonkey or Violentmonkey).
2. Install FLIPR - from the GreasyFork listing, or open flipr.user.js from this
   repository and let your userscript manager pick it up.
3. It works out of the box. Adding a Torn API key in Settings makes syncing
   reliable - use the FLIPR-only key link above, it is all this script needs.


BUGS
----------------------------------------------------------------
Settings has a "Copy debug export" button (your API key is stripped out of it).
Send that to The_Baron [1467784] on Torn.


LICENSE
----------------------------------------------------------------
Copyright (c) 2026 The_Baron [1467784]. All rights reserved.
Personal, non-commercial use is permitted; any other use (copying, modifying,
forking, redistributing, or reusing the code) requires prior written permission,
and commercial use is not allowed without permission. See the LICENSE file for
the full terms.
