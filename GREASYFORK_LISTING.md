# GreasyFork listing description

Not part of the script - this is the text for GreasyFork's description field, kept separate so it can be edited without touching the script or the changelog. Keep it SHORT: short bullets, no walls of text.

---

**FLIPR** tracks what you paid, warns you before you list below a real profit, and shows what you actually made. Desktop and Torn PDA.

### What it does

- **Logs your buys automatically** - item market, bazaar, points market. Nothing to type in.
- **Holdings** - what you paid per item, and your breakeven price after tax.
- **Profits tab** - your realized profit over time, matched against what each item cost you.
- **Sell Check** - type a price, see profit or loss instantly (5% market, 15% anonymous, or 0% bazaar).
- **Breakeven warning** - catches a listing price below breakeven before you submit.
- **Weapon stats per copy** - records each weapon's own Damage and Accuracy, so two of the same name stay separate.
- **After-tax helper** - click an Item Market listing to see its price minus the 5% tax.
- **Points tracker** - its own tab for Points Market buys.

Small floating panel. Drag it anywhere, collapse it to a button.

### Read-only, fully within the rules

It never clicks, submits, or fills anything for you. It reads your own API log and the numbers Torn already shows, then displays its own. Nothing is sent anywhere except Torn's own API, for your own account.

### API Terms of Service

You keep full control of your data. Everything is stored in your own browser and nothing is sent anywhere except Torn's own API, using your key, for your own account.

| Data Storage | Data Sharing | Purpose of Use | Key Storage & Sharing | Key Access Level |
| --- | --- | --- | --- | --- |
| Only locally | Nobody | Not eligible - only you have access | Stored locally / Not shared | Custom (see below) |

Selections used: `user` -> `log` (your own buys and sells) and `torn` -> `items` (item names). Nothing else is requested.

**Make a FLIPR-only key:** https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=FLIPR&user=log&torn=items

That link opens Torn's Custom Key Builder with just those two boxes ticked. A key scoped this way cannot read your money, battle stats, messages or faction data, so if it ever leaks the damage is limited to your own trading history. There is a shortcut to the same link inside the script, next to where you paste the key. A Full key works too, but gives away far more than FLIPR ever reads.

### Setup

Works out of the box. Adding a Torn API key in Settings makes syncing reliable - use the FLIPR-only key link above, it is all this script needs. Your key is never included in anything you share. On the PDA there is nothing to paste; it supplies its own key.

### Bugs

Settings has a "Copy debug export" button (API key stripped out). Send it to The_Baron [1467784].

MIT licensed.
