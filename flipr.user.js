// ==UserScript==
// @name         FLIPR: Flip Profit Tracker
// @namespace    http://torn.city.com.dot.com.com
// @version      2.43.0
// @description  Automatically logs what you paid for bazaar/item market purchases (via your own Torn API key) and warns you before you list them for less than a real profit, accounting for Torn's item market sales tax
// @updateURL    https://raw.githubusercontent.com/WhereIsBaron/flipr/main/flipr.user.js
// @downloadURL  https://raw.githubusercontent.com/WhereIsBaron/flipr/main/flipr.user.js
// @author       The_Baron [1467784]
// @match        https://www.torn.com/*
// @run-at       document-end
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// @connect      api.torn.com
// @license      MIT
// ==/UserScript==

// ---------------------------------------------------------------------------
// COMPLIANCE NOTE (read this before adding anything new):
// This script is a read-only assistant. It never clicks, submits, or fills
// any form field on the user's behalf - it only reads text/data Torn (or
// the user's own Torn API key) already produced, and writes its own numbers
// into its own floating panel. Purchase data enters storage either because
// the user typed it into FLIPR's own panel, or because FLIPR polled the
// user's own activity log via Torn's official API using a key the user
// entered themselves. It never performs a game action, never calls any
// endpoint other than the official read-only Torn API, and never sends
// data anywhere but api.torn.com (using the user's own key, for the user's
// own account). Keep it that way.
// ---------------------------------------------------------------------------
// See CHANGELOG.md for full version history.
//
// The listing-page price-field detection is still a best-effort DOM
// heuristic (Torn's sell form wasn't available live while writing this).
// If it doesn't pick up a listing page's price field, the manual
// "Sell Check" panel always works standalone. Flip DEBUG to true and
// report the console output if it needs tightening.

(() => {
  'use strict';

  ////////////////////////////////////////////////////////////////////////////
  ////  CONFIG / CONSTANTS
  ////////////////////////////////////////////////////////////////////////////

  const DEBUG = false;
  const SCRIPT_VERSION = '2.42.0';

  const STORAGE_KEY = 'flipr_lots_v1';
  const SETTINGS_KEY = 'flipr_settings_v1';
  const API_KEY_NAME = 'flipr_api_key';
  const ITEM_CATALOG_KEY = 'flipr_item_catalog_v1';
  const LOG_STATE_KEY = 'flipr_log_state_v1';
  const POINTS_STATS_KEY = 'flipr_points_stats_v1';
  // Durable dedup ledgers (see the AUTO-DETECT dedup section for the model): every
  // API log-entry id ever turned into a lot, plus the bidirectional DOM<->API
  // reconciliation tickets - both persisted so a purchase can never be stored twice
  // across reloads, overlapping polls, or multiple open tabs.
  const PROCESSED_LOG_IDS_KEY = 'flipr_processed_log_ids_v1';
  const PROCESSED_TRADES_KEY = 'flipr_processed_trades_v1';
  const PENDING_TICKETS_KEY = 'flipr_pending_tickets_v2';
  // Realized-profit ledger (see the SALES TRACKER section). Forward-only from the
  // build that introduced it: a detected sale is matched FIFO against open lots at
  // that moment, and its proceeds/profit are frozen into running totals - the same
  // "log it on the action once, ignore what happens after" rule the buy path uses.
  const SALES_KEY = 'flipr_sales_v1';
  const RECENT_SALES_MAX = 200; // cap on the per-sale detail list; the running totals are uncapped
  const SALES_ROWS_SHOWN = 30; // how many of those rows are actually DRAWN (perf; totals cover all)

  // Torn's Custom Key Builder, pre-filled for FLIPR. The two selections below are
  // genuinely all this script calls:
  //   user  > log    the user's own activity log - where buys and sells are read from
  //   torn  > items  the public item list, used only to turn an item id into a name
  // Nothing else is ever requested (see the COMPLIANCE NOTE at the top of the file).
  //
  // FORMAT, easy to get wrong: the separator after `tab=api` is a QUESTION MARK, not
  // an ampersand. `#tab=api` picks the tab, then `?` opens a parameter string that the
  // API tab itself parses. Written as `#tab=api&step=...` the whole thing reads as
  // more tab parameters, so the page opens on the right tab with nothing filled in and
  // no error - it just silently does nothing. Verified against TornW3b's working link:
  //   ...preferences.php#tab=api?step=addNewKey&title=TornW3B&user=basic,bazaar,log,...
  const CUSTOM_KEY_URL =
    'https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=FLIPR&user=log&torn=items';

  const FETCH_TIMEOUT_MS = 10000;
  const API_KEY_REGEX = /^[A-Za-z0-9]{16,}$/;
  // One log-poll = one API call. Torn's standard key rate limit is ~100
  // calls/min, so even 5s (12 calls/min) leaves huge headroom for other
  // tools sharing the same key (TornTools, YATA, etc.) - the item catalog
  // only refreshes once a day on top of this, nothing else calls the API.
  // 10s felt noticeably laggy for points-market purchases specifically,
  // since (unlike bazaar/item market) they may have no instant on-page
  // confirmation to fall back on, making this poll the only detection path.
  const LOG_POLL_INTERVAL_MS = 5000;
  const ITEM_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  // The poll always re-fetches this whole recent window (deduped by the processed
  // log-id ledger) instead of only fetching past a high-water timestamp. A
  // watermark silently LOSES purchases on a busy account: Torn publishes log
  // entries late (a points entry was observed arriving ~26s after the purchase),
  // so a newer non-purchase entry (race, nerve, bust...) fetched in between
  // advances the watermark past the purchase's timestamp before it ever becomes
  // visible, and no later fetch can see it (confirmed via debug export:
  // fetchedCount 0 on every poll while real purchases sat in the visible log).
  const LOG_POLL_LOOKBACK_SECONDS = 15 * 60;
  const PROCESSED_LOG_IDS_MAX = 3000; // FIFO cap on remembered API log-entry ids (plenty of headroom over any single session)

  // Torn's standard Item Market sales tax (live since 2025-06-22). Anonymous
  // listings pay an additional 10% on top (0% with the 5* Car
  // Dealership/Property Broker specials) - the 15% option below assumes no
  // such special is active. Selling via Bazaar instead of Item Market has no
  // sales tax at all, so FLIPR's math only applies to Item Market listings.
  const FEE_STANDARD = 0.05;
  const FEE_ANONYMOUS = 0.15;
  const FEE_BAZAAR = 0; // selling via your own Bazaar instead of the Item Market has no sales tax at all

  const log = (...args) => { if (DEBUG) console.log('[FLIPR]', ...args); };

  ////////////////////////////////////////////////////////////////////////////
  ////  ENVIRONMENT DETECTION
  ////////////////////////////////////////////////////////////////////////////
  // The Torn PDA substitutes a real API key for the literal token below when it
  // injects the script, so an intact ###...### wrapper means we are NOT on the PDA.
  // This is the PDA's own documented mechanism and the only reliable way to tell
  // the two environments apart (user-agent sniffing does not work - the PDA is a
  // stock webview). Same detection BUSTR uses, which is confirmed working on PDA.
  const PDA_API_KEY = '###PDA-APIKEY###';
  function isPDA() {
    return !/^(###).+(###)$/.test(PDA_API_KEY);
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  STORAGE
  ////////////////////////////////////////////////////////////////////////////
  // Everything persists through this one shim rather than calling GM_* directly.
  // The GM_* functions DO exist on the PDA, but only as a shim that does not
  // persist reliably between page loads - so a plain `typeof GM_getValue ===
  // "function"` test picks the broken path there and holdings/settings silently
  // reset on every page load. Testing isPDA() instead of feature-detecting is
  // deliberate for exactly that reason: the feature is present, it just does not
  // work. Desktop is unchanged (GM_* stays the isolated, page-unreadable store, so
  // existing Tampermonkey data keeps loading from where it already lives); the PDA
  // is forced onto localStorage, which its webview does implement properly.
  // Keys are namespaced on the localStorage side to avoid colliding with Torn's own
  // localStorage entries. NOTE: values must stay strings on both paths (GM_* would
  // happily store objects) - every caller already JSON.stringify/parses.
  const HAS_GM_STORAGE =
    typeof GM_getValue === 'function' && typeof GM_setValue === 'function' && typeof GM_deleteValue === 'function';
  const USE_GM_STORAGE = HAS_GM_STORAGE && !isPDA();
  const LS_PREFIX = 'flipr_';
  const Store = {
    get(key, fallback) {
      if (USE_GM_STORAGE) return GM_getValue(key, fallback);
      const v = localStorage.getItem(LS_PREFIX + key);
      return v === null ? fallback : v;
    },
    set(key, value) {
      if (USE_GM_STORAGE) return GM_setValue(key, value);
      localStorage.setItem(LS_PREFIX + key, String(value));
    },
    del(key) {
      if (USE_GM_STORAGE) return GM_deleteValue(key);
      localStorage.removeItem(LS_PREFIX + key);
    },
  };

  function loadLots() {
    try {
      const raw = Store.get(STORAGE_KEY, '[]');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      log('loadLots failed, resetting', e);
      return [];
    }
  }

  function saveLots(lots) {
    try {
      Store.set(STORAGE_KEY, JSON.stringify(lots));
    } catch (e) {
      log('saveLots failed', e);
    }
  }

  // A saved panel position is only usable if both numbers are there - a partial or
  // hand-edited value falls back to the default spot instead of throwing later.
  function readPanelPos(v) {
    return v && typeof v.top === 'number' && typeof v.left === 'number' ? { top: v.top, left: v.left } : null;
  }

  // A saved manual panel size (see PANEL RESIZE). Both numbers must be finite or
  // it falls back to the default sizing; the values are re-clamped to the screen
  // when applied, so a size saved on a big monitor still fits a phone.
  function readPanelSize(v) {
    return v && Number.isFinite(Number(v.width)) && Number.isFinite(Number(v.bodyHeight))
      ? { width: Number(v.width), bodyHeight: Number(v.bodyHeight) } : null;
  }

  function loadSettings() {
    try {
      const raw = Store.get(SETTINGS_KEY, '{}');
      const parsed = JSON.parse(raw);
      return {
        feeMode: ['bazaar', 'standard', 'anon'].includes(parsed.feeMode) ? parsed.feeMode : 'bazaar',
        collapsed: !!parsed.collapsed,
        scanPageText: typeof parsed.scanPageText === 'boolean' ? parsed.scanPageText : true,
        holdingsMode: parsed.holdingsMode === 'lump' ? 'lump' : 'separate',
        // Show the after-5%-tax price when a listing is clicked on the Item
        // Market (see the MARKET TAX HELPER section). On by default.
        marketTaxHelper: typeof parsed.marketTaxHelper === 'boolean' ? parsed.marketTaxHelper : true,
        // Draw the quality/bonus overlay on Item Market + Bazaar weapon/armour
        // listings (see the MARKET QUALITY OVERLAY section). On by default.
        marketQuality: typeof parsed.marketQuality === 'boolean' ? parsed.marketQuality : true,
        // Record completed player trades (trade.php) as buys/sales (see the PLAYER
        // TRADE LOG section). On by default.
        trackTrades: typeof parsed.trackTrades === 'boolean' ? parsed.trackTrades : true,
        // How the launcher is shown. 'float' is the classic draggable button
        // that collapses to a round puck you can park anywhere. 'docked' hides
        // that puck and instead wedges an open/close button into Torn's bottom
        // bar next to Notes/People, which is a fixed, easy-to-hit target on the
        // PDA (asked for by -IBY- [3603459]). Default stays 'float' so no
        // existing install changes on its own. See DOCKED LAUNCHER.
        launcherMode: parsed.launcherMode === 'docked' ? 'docked' : 'float',
        // Where the docked button sits among the other buttons in Torn's bottom
        // bar, as a 0-based index you set by dragging it (see DOCKED LAUNCHER).
        // null means "not placed yet" - added at the end. Best-effort: it is an
        // index, so another script adding a bar button can nudge it, but Torn's
        // own Notes/People anchors are stable enough that it lands back where you
        // left it. Clamped on re-insert, so a shorter bar just puts it last.
        dockIndex: (Number.isInteger(parsed.dockIndex) && parsed.dockIndex >= 0) ? parsed.dockIndex : null,
        // Every page load re-runs this script from scratch (a fresh tab has
        // no memory of what was open before), so which panel tab was last
        // active has to be persisted here the same way collapsed/feeMode
        // already are, or a refresh would always reset back to Flip.
        activeTab: ['main', 'profits', 'points', 'settings'].includes(parsed.activeTab) ? parsed.activeTab : 'main',
        // Where the panel was last dragged to (see DRAGGABLE POSITIONING). The
        // expanded window and the collapsed button deliberately remember SEPARATE
        // spots - see applyPanelPosition for why sharing one broke. null means
        // "never dragged in that state, use the default fixed top-right spot".
        panelPos: readPanelPos(parsed.panelPos),
        collapsedPos: readPanelPos(parsed.collapsedPos),
        // How wide the panel and how tall its scrolling body were last set to by
        // dragging the resize grip (see PANEL RESIZE). null = default sizing.
        panelSize: readPanelSize(parsed.panelSize),
      };
    } catch (e) {
      return { feeMode: 'bazaar', collapsed: false, scanPageText: true, holdingsMode: 'separate', marketTaxHelper: true, marketQuality: true, trackTrades: true, launcherMode: 'float', dockIndex: null, activeTab: 'main', panelPos: null, collapsedPos: null, panelSize: null };
    }
  }

  function saveSettings(settings) {
    try {
      Store.set(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
      log('saveSettings failed', e);
    }
  }

  let lots = loadLots();
  let settings = loadSettings();

  // On the PDA the app injects the user's own key into PDA_API_KEY for us, so there
  // is nothing to type in and nothing to store - it is the same key, for the same
  // account, used the same read-only way (see the COMPLIANCE NOTE at the top). A key
  // the user has already saved themselves still wins, so switching to the PDA never
  // silently swaps which key a configured install is using.
  function getApiKey() {
    try {
      const v = Store.get(API_KEY_NAME, '');
      if (typeof v === 'string' && v) return v;
      return isPDA() ? PDA_API_KEY : '';
    } catch (e) {
      return isPDA() ? PDA_API_KEY : '';
    }
  }

  function setApiKey(key) {
    try {
      Store.set(API_KEY_NAME, key);
    } catch (e) {
      log('setApiKey failed', e);
    }
  }

  function loadItemCatalog() {
    try {
      const raw = Store.get(ITEM_CATALOG_KEY, '{}');
      const parsed = JSON.parse(raw);
      return {
        fetchedAt: typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0,
        names: parsed.names && typeof parsed.names === 'object' ? parsed.names : {},
      };
    } catch (e) {
      return { fetchedAt: 0, names: {} };
    }
  }

  function saveItemCatalog(catalog) {
    try {
      Store.set(ITEM_CATALOG_KEY, JSON.stringify(catalog));
    } catch (e) {
      log('saveItemCatalog failed', e);
    }
  }

  function loadLogState() {
    try {
      const raw = Store.get(LOG_STATE_KEY, '{}');
      const parsed = JSON.parse(raw);
      return { lastTimestamp: typeof parsed.lastTimestamp === 'number' ? parsed.lastTimestamp : 0 };
    } catch (e) {
      return { lastTimestamp: 0 };
    }
  }

  function saveLogState(stateObj) {
    try {
      Store.set(LOG_STATE_KEY, JSON.stringify(stateObj));
    } catch (e) {
      log('saveLogState failed', e);
    }
  }

  // Lifetime points-purchase lots - a list of {qty, unitCost, ts}, one entry
  // per distinct price ever paid (merged the same way addLot() merges
  // regular items: same price combines, different prices stay separate) -
  // decremented when you sell them. See the POINTS TRACKER section
  // below for why points are tracked separately from lots/Holdings.
  function loadPointsStats() {
    try {
      const raw = Store.get(POINTS_STATS_KEY, '[]');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((p) => p && p.qty > 0 && p.unitCost >= 0);
      }
      // One-time migration from the earlier single-blended-total shape
      // ({ totalQty, totalSpent }) into one lot, so an already-tracked
      // total isn't lost now that purchases are split out by price -
      // the per-price breakdown for anything bought before this change
      // just isn't recoverable.
      if (parsed && parsed.totalQty > 0) {
        return [{ qty: parsed.totalQty, unitCost: parsed.totalSpent / parsed.totalQty, ts: Date.now() }];
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  function savePointsStats(pointsLots) {
    try {
      Store.set(POINTS_STATS_KEY, JSON.stringify(pointsLots));
    } catch (e) {
      log('savePointsStats failed', e);
    }
  }

  // Realized-sales store: ONE object holding lifetime running totals (never
  // pruned, so lifetime profit survives even after old detail rows age out) plus a
  // capped list of recent per-sale records for the detail view. Kept under a single
  // key so a sale updates both atomically and one cross-tab listener keeps another
  // open tab in sync. Totals accumulate; they are never recomputed from `recent`.
  function emptySalesTotals() {
    return {
      realizedProfit: 0, // matchedProceeds - matchedCost, the number the user asked for
      matchedProceeds: 0, // NET proceeds of the portion of sales matched to a known lot
      matchedCost: 0, // cost basis of that matched portion
      matchedQty: 0,
      untrackedProceeds: 0, // NET proceeds of sold units with no recorded cost (crime loot etc.)
      untrackedQty: 0,
      feePaid: 0, // total Item Market sales tax paid (0 for bazaar) - FLIPR's whole thesis, quantified
      salesCount: 0,
      firstTs: null,
      lastTs: null,
    };
  }
  function loadSales() {
    try {
      const parsed = JSON.parse(Store.get(SALES_KEY, '{}'));
      const totals = Object.assign(emptySalesTotals(), parsed && parsed.totals);
      const recent = Array.isArray(parsed && parsed.recent) ? parsed.recent : [];
      return { totals, recent };
    } catch (e) {
      return { totals: emptySalesTotals(), recent: [] };
    }
  }
  function saveSales(data) {
    try {
      Store.set(SALES_KEY, JSON.stringify(data));
    } catch (e) {
      log('saveSales failed', e);
    }
  }

  // The permanent "already stored" ledger for the API path: a flat list of every
  // Torn log-entry id that has ever been turned into a lot. Kept as an array (for
  // FIFO capping) mirrored by a Set (for O(1) lookup).
  function loadProcessedLogIds() {
    try {
      const raw = Store.get(PROCESSED_LOG_IDS_KEY, '[]');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch (e) {
      return [];
    }
  }

  function saveProcessedLogIds(ids) {
    try {
      Store.set(PROCESSED_LOG_IDS_KEY, JSON.stringify(ids));
    } catch (e) {
      log('saveProcessedLogIds failed', e);
    }
  }

  // Bidirectional DOM<->API reconciliation tickets, shape { dom: {fp:[expiryMs]},
  // api: {fp:[expiryMs]} }. Stored in GM storage (not just memory) so the
  // reconciliation survives a page reload and is visible to every open tab. Each
  // push/consume does a load-modify-save. See the AUTO-DETECT dedup section for how
  // the two sides reconcile the instant on-page scan against the (laggy) API poll.
  function loadTickets() {
    const norm = (o) => {
      const out = {};
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        for (const [k, v] of Object.entries(o)) {
          if (Array.isArray(v)) out[k] = v.filter((n) => typeof n === 'number');
        }
      }
      return out;
    };
    try {
      const parsed = JSON.parse(Store.get(PENDING_TICKETS_KEY, '{}'));
      return { dom: norm(parsed && parsed.dom), api: norm(parsed && parsed.api) };
    } catch (e) {
      return { dom: {}, api: {} };
    }
  }

  function saveTickets(t) {
    try {
      Store.set(PENDING_TICKETS_KEY, JSON.stringify(t));
    } catch (e) {
      log('saveTickets failed', e);
    }
  }

  let itemCatalog = loadItemCatalog();
  let logState = loadLogState();
  let pointsLots = loadPointsStats();
  let salesData = loadSales();
  let processedLogIds = loadProcessedLogIds();
  let processedLogIdSet = new Set(processedLogIds);

  function isLogIdProcessed(id) {
    return processedLogIdSet.has(String(id));
  }
  // Records an id as stored-forever. Returns false if it was already recorded
  // (caller can treat that as "someone already handled this entry").
  function markLogIdProcessed(id) {
    const key = String(id);
    if (processedLogIdSet.has(key)) return false;
    processedLogIdSet.add(key);
    processedLogIds.push(key);
    while (processedLogIds.length > PROCESSED_LOG_IDS_MAX) {
      const dropped = processedLogIds.shift();
      processedLogIdSet.delete(dropped);
    }
    saveProcessedLogIds(processedLogIds);
    return true;
  }

  // Each open Torn tab runs its own independent copy of this script, with
  // its own in-memory `lots`/`pointsLots` loaded once at page load - a
  // purchase caught by the tab where it actually happened writes to GM
  // storage correctly, but any OTHER already-open tab (e.g. viewing the
  // Items page while several Bazaar tabs are open buying things) has no way
  // to know storage changed underneath it and just keeps showing whatever
  // it loaded when IT started (reported: real bazaar purchases confirmed
  // in other tabs never showed up in Holdings on the tab the panel was
  // being watched from). GM_addValueChangeListener fires in every tab
  // except the one that made the write (the `remote` flag distinguishes
  // "another tab changed this" from "I just changed this myself", so this
  // doesn't loop back on our own saves) - reload from storage and re-render
  // whenever another tab logs something new.
  if (typeof GM_addValueChangeListener === 'function') {
    GM_addValueChangeListener(STORAGE_KEY, (name, oldValue, newValue, remote) => {
      if (!remote) return;
      lots = loadLots();
      renderAll();
    });
    GM_addValueChangeListener(POINTS_STATS_KEY, (name, oldValue, newValue, remote) => {
      if (!remote) return;
      pointsLots = loadPointsStats();
      renderAll();
    });
    // A sale logged in another open tab updates both the realized-profit totals and
    // (via the lots write it made) Holdings; adopt the new sales ledger and re-render
    // so this tab's Profits tab is not stale. The lots change rides in on the
    // STORAGE_KEY listener above.
    GM_addValueChangeListener(SALES_KEY, (name, oldValue, newValue, remote) => {
      if (!remote) return;
      salesData = loadSales();
      renderAll();
    });
    // Keep the "already stored" ledger in sync with whatever another open tab has
    // recorded, so two tabs both polling the same key don't each log the same
    // entry (see processLogEntries). No re-render needed - this is dedup state,
    // not display state.
    GM_addValueChangeListener(PROCESSED_LOG_IDS_KEY, (name, oldValue, newValue, remote) => {
      if (!remote) return;
      processedLogIds = loadProcessedLogIds();
      processedLogIdSet = new Set(processedLogIds);
    });
    // Same idea for settings: a fee mode / holdings-lump / instant-detection
    // change made in one tab was previously invisible to other already-open tabs
    // (each read its own in-memory `settings` from page load and never re-read
    // storage), so the other tab kept using the old value until reloaded. Adopt
    // only these SHARED, data-affecting choices from another tab. Per-tab UX state
    // (collapsed, dragged position, which tab is open) is deliberately left alone
    // so another tab can't move or collapse this one's panel out from under you.
    GM_addValueChangeListener(SETTINGS_KEY, (name, oldValue, newValue, remote) => {
      if (!remote) return;
      const incoming = loadSettings();
      let changed = false;
      let holdingsModeChanged = false;
      let launcherModeChanged = false;
      let marketQualityChanged = false;
      for (const k of ['feeMode', 'holdingsMode', 'scanPageText', 'marketTaxHelper', 'marketQuality', 'trackTrades', 'launcherMode']) {
        if (settings[k] !== incoming[k]) {
          if (k === 'holdingsMode') holdingsModeChanged = true;
          if (k === 'launcherMode') launcherModeChanged = true;
          if (k === 'marketQuality') marketQualityChanged = true;
          settings[k] = incoming[k];
          changed = true;
        }
      }
      if (!changed) return;
      if (holdingsModeChanged) unbindPriceInput(); // the bound entry's id no longer matches the new mode
      if (launcherModeChanged) applyLauncherMode(); // stand up / tear down the bottom-bar button to match
      if (marketQualityChanged) applyMarketQuality(); // draw or clear the market overlay to match
      syncSettingsControls();
      renderAll();
    });
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  LOT / HOLDINGS MODEL
  ////////////////////////////////////////////////////////////////////////////

  const normalize = (name) => String(name || '').trim().toLowerCase();

  // Every weapon (melee, primary, secondary) and armor piece in Torn is its
  // own unique item, not a stackable/fungible one like Points or Gasoline -
  // each individual copy rolls its own Damage/Accuracy/Quality/Bonus, so two
  // "Baseball Bat"s (or two SIG 552s, even with the exact same Bonus TYPE -
  // a real example: one 20% Specialist, another 24% Specialist) bought at
  // the same price are NOT interchangeable. Reduced to a single string key
  // so two stat readings compare equal only when every number AND the bonus
  // name all match exactly; `null` (no stats captured, or nothing found to
  // capture) is its own distinct key so stat-less lots still merge with
  // each other as before.
  const statsKeyOf = (s) => (s ? `${s.dmg ?? ''}|${s.acc ?? ''}|${s.armor ?? ''}|${s.quality ?? ''}|${s.bonusPct ?? ''}|${s.bonusName ?? ''}` : null);

  // Merges into an existing open lot of the same item at the same price
  // (rounded to the nearest dollar, since Torn prices are whole dollars and
  // dom-text/api-log can derive a unit cost with tiny floating-point noise)
  // AND the same stats (see statsKeyOf above - two copies with different
  // Damage/Accuracy rolls are never merged, even at an identical price)
  // rather than creating a new near-identical row every time. Rapid
  // repeat-buying the same item at a stable price would otherwise pile up
  // into a wall of separate "x1" entries that are individually correct but
  // collectively unreadable. Different prices (or different stats) still get
  // their own lot, so per-price and per-weapon-instance tracking is
  // unaffected.
  // `uid` (optional) is Torn's per-copy instance id, available only from the API buy
  // path (the instant DOM "You bought" text has none). It is what lets a later sale
  // match the EXACT copy it came from (see consumeLotsForSale). Kept as a `uids`
  // ARRAY because a lot can hold several merged copies; only non-null uids are
  // tracked, so stackables (uid null) just carry an empty list and behave as before.
  function addLot(itemName, qty, unitCost, source, stats, uid) {
    itemName = String(itemName || '').trim();
    qty = Number(qty);
    unitCost = Number(unitCost);
    if (!itemName || !(qty > 0) || !(unitCost >= 0)) return null;
    stats = stats && (stats.dmg != null || stats.acc != null || stats.armor != null || stats.quality != null || stats.bonusPct != null) ? stats : null;
    const statsKey = statsKeyOf(stats);

    const existing = lots.find(
      (l) =>
        l.qty > 0 &&
        normalize(l.itemName) === normalize(itemName) &&
        Math.round(l.unitCost) === Math.round(unitCost) &&
        (l.statsKey ?? null) === statsKey
    );
    if (existing) {
      existing.qty += qty;
      if (uid != null) {
        if (!Array.isArray(existing.uids)) existing.uids = [];
        if (!existing.uids.includes(uid)) existing.uids.push(uid);
      }
      saveLots(lots);
      return existing;
    }

    const lotEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      itemName,
      qty,
      unitCost,
      ts: Date.now(),
      source: source || 'unknown', // 'dom-text' (instant page-text read) or 'api-log:<entryId>' (API poll)
      stats, // { dmg, acc } best-effort DOM read, or null if not captured/not applicable
      statsKey,
      uids: uid != null ? [uid] : [], // per-copy instance ids in this lot (API path only)
    };
    lots.push(lotEntry);
    saveLots(lots);
    return lotEntry;
  }

  // Attach a per-copy uid to an ALREADY-stored lot. Used when the API poll recognizes
  // a purchase the instant DOM scan stored first (DOM text has no uid): the API knows
  // the uid, so it back-fills it onto the matching lot instead of storing a duplicate.
  // Matches by name + rounded price; if several lots qualify, the most recent gets it.
  // A mis-annotation is harmless - the only consumer (consumeLotsForSale) treats a uid
  // as a hint that resolves to a same-name-same-price lot either way. Never creates or
  // removes a lot, so it cannot affect the purchase-dedup guarantees.
  function annotateLotUid(itemName, unitCost, uid) {
    if (uid == null) return;
    const key = normalize(itemName);
    const price = Math.round(Number(unitCost));
    let target = null;
    for (const l of lots) {
      if (l.qty <= 0 || normalize(l.itemName) !== key || Math.round(l.unitCost) !== price) continue;
      if (!Array.isArray(l.uids)) l.uids = [];
      if (l.uids.includes(uid) || l.uids.length >= l.qty) continue; // already known, or no free slot
      if (!target || l.ts > target.ts) target = l;
    }
    if (target) {
      target.uids.push(uid);
      saveLots(lots);
    }
  }

  function removeLot(id) {
    lots = lots.filter((l) => l.id !== id);
    saveLots(lots);
  }

  // Undoes just the qty from one auto-logged purchase, not the whole lot -
  // since addLot() above merges same-item-same-price purchases together,
  // the lot a toast's Undo points at may already include earlier merged
  // purchases that shouldn't be wiped out along with the one just added.
  function undoLotQty(id, qty) {
    const lotEntry = lots.find((l) => l.id === id);
    if (!lotEntry) return;
    lotEntry.qty -= qty;
    if (lotEntry.qty <= 0) {
      lots = lots.filter((l) => l.id !== id);
    }
    saveLots(lots);
  }

  // Grouped by item name AND stats (see statsKeyOf) - two differently-rolled
  // copies of the same weapon never get blended into one average, even in
  // "lump" mode, since that would erase exactly the distinction this is for.
  function getHoldings() {
    const byItem = new Map();
    for (const lotEntry of lots) {
      if (lotEntry.qty <= 0) continue;
      const key = normalize(lotEntry.itemName) + ' ' + (lotEntry.statsKey ?? '');
      if (!byItem.has(key)) {
        byItem.set(key, { itemName: lotEntry.itemName, qty: 0, totalCost: 0, stats: lotEntry.stats ?? null });
      }
      const h = byItem.get(key);
      h.qty += lotEntry.qty;
      h.totalCost += lotEntry.qty * lotEntry.unitCost;
    }
    return [...byItem.values()]
      .map((h) => ({ ...h, avgCost: h.totalCost / h.qty }))
      .sort((a, b) => a.itemName.localeCompare(b.itemName));
  }

  // Individual purchases, oldest first (FIFO) - unlike getHoldings(), which
  // blends same-item lots into one average, this keeps each purchase (and
  // its own price) separate so Sell Check can be checked against exactly
  // what a specific batch cost, not a blended average across all of them.
  function getOpenLots() {
    return lots.filter((l) => l.qty > 0).sort((a, b) => a.ts - b.ts);
  }

  function findLotById(id) {
    return lots.find((l) => l.id === id) || null;
  }

  const LUMP_ID_PREFIX = 'lump:';

  // Holdings, the Sell Check dropdown, and price-field auto-detection all
  // need "the list of things you can currently pick" - what that list looks
  // like depends on settings.holdingsMode: either every open lot separately
  // (exact price per purchase, FIFO order) or one blended row per item
  // (summed qty, average cost), for traders who don't care about tracking
  // each individual purchase price. Both shapes expose the same
  // {id, itemName, qty, unitCost} contract so every caller below can stay
  // agnostic to which mode is active.
  function getDisplayEntries() {
    if (settings.holdingsMode === 'lump') {
      return getHoldings().map((h) => ({
        id: LUMP_ID_PREFIX + normalize(h.itemName) + ' ' + (statsKeyOf(h.stats) ?? ''),
        itemName: h.itemName,
        qty: h.qty,
        unitCost: h.avgCost,
        stats: h.stats,
        isLump: true,
      }));
    }
    return getOpenLots().map((l) => ({ ...l, isLump: false }));
  }

  function findEntryById(id) {
    if (String(id).startsWith(LUMP_ID_PREFIX)) {
      return getDisplayEntries().find((e) => e.id === id) || null;
    }
    return findLotById(id);
  }

  // Clears whatever a Holdings row's X button represents in the current mode: a
  // single purchase in "separate" mode, or every lot of that item+stats
  // combo at once in "lump" mode, since the row is presenting them as one
  // combined batch - a differently-rolled copy of the same weapon (a
  // different statsKey) is its own row and is left untouched. Reuses the
  // exact same "itemName + statsKey" key getHoldings()/getDisplayEntries()
  // group by, so this always matches whatever row was actually clicked.
  function clearEntry(id) {
    if (String(id).startsWith(LUMP_ID_PREFIX)) {
      const key = id.slice(LUMP_ID_PREFIX.length);
      lots = lots.filter((l) => normalize(l.itemName) + ' ' + (l.statsKey ?? '') !== key);
      saveLots(lots);
    } else {
      removeLot(id);
    }
  }

  // Correcting a price by hand. Needed because a mis-read purchase used to leave you
  // only the X button - delete the row and lose the record entirely - and a wrong cost
  // basis silently poisons every profit figure that lot ever feeds into.
  //
  // In "separate" mode a row IS one purchase, so this edits that lot alone. In "lump"
  // mode the row is a blended average across several lots, and there is no honest way to
  // split one number back out across them, so it sets every lot in that group to the
  // price entered. The title text says so before you click.
  function setEntryUnitCost(id, unitCost) {
    if (!Number.isFinite(unitCost) || unitCost < 0) return false;
    if (String(id).startsWith(LUMP_ID_PREFIX)) {
      const key = id.slice(LUMP_ID_PREFIX.length);
      let touched = false;
      for (const l of lots) {
        if (normalize(l.itemName) + ' ' + (l.statsKey ?? '') === key) { l.unitCost = unitCost; touched = true; }
      }
      if (touched) saveLots(lots);
      return touched;
    }
    const lot = findLotById(id);
    if (!lot) return false;
    lot.unitCost = unitCost;
    saveLots(lots);
    return true;
  }

  // Correcting a COUNT by hand - e.g. you sold some and the sale wasn't caught, so the
  // row still shows the old number. The per-unit price you paid is kept untouched, so
  // every total (position value, whole-lot profit, Sell Check) simply falls out of the
  // new count - editing 10 down to 5 halves the money the row represents. In "separate"
  // mode a row is one purchase, so this sets that lot's count directly (0 removes it).
  // In "lump" mode the row is several lots blended into one average, so a SMALLER number
  // is applied oldest-first (FIFO) - exactly as an untracked sale would consume them -
  // and a number the same or larger is refused (there is no honest single lot to add
  // phantom units to). Returns true if anything changed.
  function setEntryQty(id, newQty) {
    newQty = Math.floor(Number(newQty));
    if (!Number.isFinite(newQty) || newQty < 0) return false;
    if (String(id).startsWith(LUMP_ID_PREFIX)) {
      const key = id.slice(LUMP_ID_PREFIX.length);
      const group = lots
        .filter((l) => normalize(l.itemName) + ' ' + (l.statsKey ?? '') === key && l.qty > 0)
        .sort((a, b) => a.ts - b.ts); // FIFO
      const total = group.reduce((s, l) => s + l.qty, 0);
      if (newQty >= total) return false; // a blended row can only be corrected DOWN
      let toRemove = total - newQty;
      for (const l of group) {
        if (toRemove <= 0) break;
        const take = Math.min(l.qty, toRemove);
        l.qty -= take;
        toRemove -= take;
      }
      lots = lots.filter((l) => l.qty > 0);
      saveLots(lots);
      return true;
    }
    const lot = findLotById(id);
    if (!lot) return false;
    if (newQty <= 0) { removeLot(id); return true; }
    lot.qty = newQty;
    saveLots(lots);
    return true;
  }

  // Swaps a Holdings row's price text for an input. Enter or clicking away saves,
  // Escape cancels. Commit-on-blur is deliberate: the common case is typing a number and
  // clicking back onto the page, and losing that silently would be worse than the rare
  // accidental save, which Escape and a re-edit both undo.
  function startPriceEdit(metaSpan, entry) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'flipr-price-edit';
    input.value = String(Math.round(entry.unitCost));
    input.title = 'Enter to save, Escape to cancel';
    metaSpan.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      if (commit) {
        // Tolerate whatever gets pasted in: "$4,517,899" and "4517899" both work.
        const v = Number(String(input.value).replace(/[^0-9.]/g, ''));
        if (Number.isFinite(v) && v >= 0) setEntryUnitCost(entry.id, v);
      }
      renderAll();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  // Same inline-edit dance as startPriceEdit, but for the COUNT - swap the "×N"
  // for a small number box so an untracked sale can be corrected by hand (bought 10,
  // quietly sold 5, type 5). The per-unit price is left alone, so the row's money just
  // follows the new count. A blended ("lump") row can only be corrected DOWNward and
  // setEntryQty refuses anything else; that refusal is surfaced as a toast so the edit
  // doesn't look like it silently did nothing.
  function startQtyEdit(qtySpan, entry) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'flipr-price-edit';
    input.style.width = '3.5em';
    input.value = String(entry.qty);
    input.title = 'Enter to save, Escape to cancel';
    qtySpan.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      if (commit) {
        const v = Math.floor(Number(String(input.value).replace(/[^0-9]/g, '')));
        if (Number.isFinite(v) && v >= 0 && v !== entry.qty) {
          if (!setEntryQty(entry.id, v) && entry.isLump) {
            showToast(`Enter a number below ${entry.qty} - a blended row can only be corrected down.`);
          }
        }
      }
      renderAll();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  // Loose match used for scanning page text: exact normalized match first,
  // then substring match if exactly one distinct item name appears in the
  // text. Page text only ever names the item, never which specific
  // purchase, so in "separate" mode this returns the oldest open lot (FIFO).
  function matchEntryInText(text) {
    const entries = getDisplayEntries();
    if (!entries.length) return null;
    const hay = normalize(text);
    const names = [...new Set(entries.map((e) => normalize(e.itemName)))];
    const exactNames = names.filter((n) => hay === n);
    const matchNames = exactNames.length === 1 ? exactNames : names.filter((n) => hay.includes(n));
    if (matchNames.length !== 1) return null;
    return entries.find((e) => normalize(e.itemName) === matchNames[0]) || null;
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  POINTS TRACKER
  ////////////////////////////////////////////////////////////////////////////
  // Points bought at the Points Market get spent (training, refills, item
  // shop) rather than held-then-resold like a normal flip item, so nobody
  // would ever manually clear a "Points" row out of Holdings the way they
  // would once a Bottle of Beer sells. Tracked as its own lifetime lot list
  // instead - purchases at the same price merge together (same as addLot()
  // does for regular items), different prices stay as separate entries, so
  // an averaged figure never hides what was actually paid across different
  // buys - with no Sell Check/breakeven math, since that model doesn't
  // apply here. See logPurchaseIfNew's "points" branch for where a detected
  // purchase gets routed here instead of into lots.

  function addPointsPurchase(qty, unitCost) {
    qty = Number(qty);
    unitCost = Number(unitCost);
    if (!(qty > 0) || !(unitCost >= 0)) return;
    const existing = pointsLots.find((p) => Math.round(p.unitCost) === Math.round(unitCost));
    if (existing) {
      existing.qty += qty;
    } else {
      pointsLots.push({ qty, unitCost, ts: Date.now() });
    }
    savePointsStats(pointsLots);
  }

  // Reverses exactly the purchase just added, for the toast's Undo button -
  // finds the same price-matched entry and removes it entirely if this
  // undo would take it to zero or below.
  function undoPointsPurchase(qty, unitCost) {
    qty = Number(qty);
    unitCost = Number(unitCost);
    const existing = pointsLots.find((p) => Math.round(p.unitCost) === Math.round(unitCost));
    if (!existing) return;
    existing.qty -= qty;
    if (existing.qty <= 0) pointsLots = pointsLots.filter((p) => p !== existing);
    savePointsStats(pointsLots);
  }

  // Clears a single price entry (the row's X button), not the whole tracker.
  function clearPointsLot(unitCost) {
    pointsLots = pointsLots.filter((p) => Math.round(p.unitCost) !== Math.round(unitCost));
    savePointsStats(pointsLots);
  }

  // Consume points you bought, oldest first, when a Points Market SALE is detected -
  // the points equivalent of consumeLotsForSale. Returns the cost basis of the part
  // we could match, so recordSale can work out real profit. Selling points therefore
  // removes them from the Points tab, exactly as selling an item clears it from
  // Holdings. Points bought before FLIPR was tracking (or on another account) match
  // nothing and come back as untracked proceeds, same rule as items.
  function consumePointsForSale(qty) {
    const oldestFirst = [...pointsLots].sort((a, b) => a.ts - b.ts);
    let remaining = Number(qty) || 0;
    let matchedQty = 0;
    let matchedCost = 0;
    for (const p of oldestFirst) {
      if (remaining <= 0) break;
      const take = Math.min(p.qty, remaining);
      matchedQty += take;
      matchedCost += take * p.unitCost;
      p.qty -= take;
      remaining -= take;
    }
    if (matchedQty > 0) {
      pointsLots = pointsLots.filter((p) => p.qty > 0);
      savePointsStats(pointsLots);
    }
    return { matchedQty, matchedCost };
  }

  function resetPointsStats() {
    pointsLots = [];
    Store.del(POINTS_STATS_KEY);
  }

  // One-time cleanup for anyone who already had "Points" purchases logged
  // into Holdings before this lifetime tracker existed - folds any legacy
  // "Points" lots into pointsLots and removes them from Holdings, so they
  // don't linger there forever now that new points purchases skip lots
  // entirely (see logPurchaseIfNew's "points" branch).
  function migrateLegacyPointsLots() {
    const legacy = lots.filter((l) => normalize(l.itemName) === 'points');
    if (!legacy.length) return;
    for (const l of legacy) addPointsPurchase(l.qty, l.unitCost);
    lots = lots.filter((l) => normalize(l.itemName) !== 'points');
    saveLots(lots);
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  SALES TRACKER (realized profit)
  ////////////////////////////////////////////////////////////////////////////
  // Sales arrive ONLY via the API log poll (you are rarely at the keyboard when a
  // bazaar listing sells), so there is no DOM primary-writer/ticket dance like the
  // buy path has - the durable log-entry-id ledger in processLogEntries is the sole
  // idempotency guard, exactly as it is for the API fallback on buys.
  //
  // The money semantics were read off real log entries (see sale-log-probe / ROADMAP):
  //   Item market sell: cost_total is NET of tax, cost_each is GROSS, and `fee` is
  //     given explicitly. THE TRAP: cost_total != cost_each*qty. Use cost_total.
  //   Bazaar sell:      no `fee`, cost_total == cost_each*qty (untaxed).
  // Proceeds = the NET money that actually reached the wallet = cost_total.

  // Consume open lots of `itemName`, decrementing their qty (this is what makes
  // Holdings self-cleaning once something sells) and returning the cost basis of the
  // portion we could match. Two-stage matching:
  //   1. EXACT by `saleUid`: when the sale and a held lot share a per-copy instance
  //      id, the precise copy that sold is known, so its real cost is used. This is
  //      what keeps profit correct for non-stackable items (weapons/armor) bought at
  //      different prices and sold out of order - plain FIFO would book the wrong
  //      copy's cost and leave the wrong basis behind on the unsold one.
  //   2. FIFO by NAME for whatever is left (stackables, or any copy with no uid on
  //      one side): oldest-first, the neutral default, which is also correct
  //      accounting for fungible goods.
  // A sale of crime/OC loot, or of anything bought before FLIPR was installed, matches
  // nothing and comes back all-untracked - honest, not a bug. The consumed lot's stats
  // ride along only for display.
  function consumeLotsForSale(itemName, qty, saleUid) {
    const key = normalize(itemName);
    let remaining = qty;
    let matchedQty = 0;
    let matchedCost = 0;
    let matchedStats = null;

    // Stage 1: exact per-copy match. A uid'd item is non-stackable, so this claims
    // exactly one unit from the lot that holds it.
    if (saleUid != null && remaining > 0) {
      const exact = lots.find(
        (l) => l.qty > 0 && normalize(l.itemName) === key && Array.isArray(l.uids) && l.uids.includes(saleUid)
      );
      if (exact) {
        matchedQty += 1;
        matchedCost += exact.unitCost;
        if (exact.stats) matchedStats = exact.stats;
        exact.uids = exact.uids.filter((u) => u !== saleUid);
        exact.qty -= 1;
        remaining -= 1;
      }
    }

    // Stage 2: FIFO by name for the remainder.
    if (remaining > 0) {
      const candidates = lots
        .filter((l) => l.qty > 0 && normalize(l.itemName) === key)
        .sort((a, b) => a.ts - b.ts);
      for (const lot of candidates) {
        if (remaining <= 0) break;
        const take = Math.min(lot.qty, remaining);
        matchedQty += take;
        matchedCost += take * lot.unitCost;
        if (matchedStats === null && lot.stats) matchedStats = lot.stats;
        lot.qty -= take;
        // Drop the consumed copies' uids from the front so the lot's uid list never
        // outgrows its remaining qty (keeps annotateLotUid's free-slot check honest).
        if (Array.isArray(lot.uids) && lot.uids.length) lot.uids = lot.uids.slice(take);
        remaining -= take;
      }
    }

    if (matchedQty > 0) {
      lots = lots.filter((l) => l.qty > 0);
      saveLots(lots);
    }
    return { matchedQty, matchedCost, matchedStats };
  }

  // Freeze one detected sale into the ledger: match basis now, split proceeds into
  // the matched (profit-bearing) and untracked (no-basis) portions, accumulate the
  // uncapped totals, and prepend a capped detail row. Idempotency is upstream (the
  // caller only reaches here for a log-entry id not already processed).
  // `proceeds` is the NET total received; `fee` is the tax paid (0 for bazaar);
  // `tsSeconds` is the log entry's own timestamp so backfilled rows sort correctly.
  // `market` is 'item' | 'bazaar' | 'points'. Points never match a lot in v1 (the
  // Points tab tracks lifetime purchases, not consumable holdings), so they land
  // wholly in the untracked bucket - fine, this account sold points once in 5 months.
  function recordSale(itemName, qty, proceeds, fee, market, tsSeconds, saleUid) {
    itemName = String(itemName || '').trim();
    qty = Number(qty);
    proceeds = Number(proceeds);
    fee = Number(fee) || 0;
    if (!itemName || !(qty > 0) || !(proceeds >= 0)) return null;

    const { matchedQty, matchedCost, matchedStats } =
      market === 'points'
        ? Object.assign({ matchedStats: null }, consumePointsForSale(qty))
        : consumeLotsForSale(itemName, qty, saleUid);
    const unitProceeds = proceeds / qty;
    const matchedProceeds = unitProceeds * matchedQty;
    const untrackedQty = qty - matchedQty;
    const untrackedProceeds = unitProceeds * untrackedQty;
    const profit = matchedProceeds - matchedCost;
    const ts = (Number(tsSeconds) || Math.floor(Date.now() / 1000)) * 1000;

    const t = salesData.totals;
    t.realizedProfit += profit;
    t.matchedProceeds += matchedProceeds;
    t.matchedCost += matchedCost;
    t.matchedQty += matchedQty;
    t.untrackedProceeds += untrackedProceeds;
    t.untrackedQty += untrackedQty;
    t.feePaid += fee;
    t.salesCount += 1;
    t.firstTs = t.firstTs === null ? ts : Math.min(t.firstTs, ts);
    t.lastTs = t.lastTs === null ? ts : Math.max(t.lastTs, ts);

    const record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      itemName,
      qty,
      market,
      proceeds,
      fee,
      matchedQty,
      matchedCost,
      profit,
      ts,
      stats: matchedStats,
    };
    salesData.recent.push(record);
    // Keep only the most recent RECENT_SALES_MAX detail rows; the totals above
    // already carry everything older, so nothing lifetime is lost by trimming.
    if (salesData.recent.length > RECENT_SALES_MAX) {
      salesData.recent = salesData.recent.slice(-RECENT_SALES_MAX);
    }
    saveSales(salesData);
    return record;
  }

  function clearSalesHistory() {
    salesData = { totals: emptySalesTotals(), recent: [] };
    Store.del(SALES_KEY);
  }

  // Confirmed sell log-entry types (numeric details.id, read off the live log):
  // 1113 Item market sell, 1104 its legacy variant, 1226 Bazaar sell, 1221 its
  // legacy variant, 5011 Points market sell.
  const SALE_LOG_TYPE_IDS = new Set([1113, 1104, 1226, 1221, 5011]);
  const SALE_TYPE_MARKET = { 1113: 'item', 1104: 'item', 1226: 'bazaar', 1221: 'bazaar', 5011: 'points' };

  // Turn one confirmed sale log entry into a ledger record, then refresh the panel
  // and toast it. Returns the record (truthy) so the caller can count it, or null if
  // the payload did not parse. Idempotency is the caller's job (log-id ledger).
  function processSaleEntry(entry, typeId) {
    const market = SALE_TYPE_MARKET[typeId] || 'item';
    const d = entry.data || {};
    const ts = entry.timestamp;

    let rec = null;
    if (market === 'points') {
      // Points market sell is flat (quantity/cost_each/cost_total, no items[]), same
      // shape as a points BUY. No confirmed points sales tax, so proceeds == gross.
      const qty = Number(d.quantity) || 0;
      const proceeds = Number(d.cost_total ?? (d.cost_each != null && qty ? d.cost_each * qty : NaN));
      if (!(qty > 0) || !Number.isFinite(proceeds)) return null;
      rec = recordSale('Points', qty, proceeds, 0, 'points', ts);
    } else {
      // Item market / bazaar: items[] holds {id, qty} but the MONEY is at entry level
      // (cost_total is NET, `fee` is the tax) - NOT inside items[]. Every sampled sell
      // was single-item; if one ever carries multiple distinct ids we cannot split the
      // entry-level proceeds per item, so fold to the first item's name with the summed
      // qty (best effort, logged) rather than invent a per-item price.
      const items = Array.isArray(d.items) ? d.items : [];
      if (!items.length) return null;
      const totalQty = items.reduce((s, it) => s + (Number(it.qty) || 0), 0);
      if (!(totalQty > 0)) return null;
      const proceeds = Number(d.cost_total ?? (d.cost_each != null ? d.cost_each * totalQty : NaN));
      if (!Number.isFinite(proceeds)) return null;
      const fee = market === 'item' ? Number(d.fee) || 0 : 0;
      if (items.length > 1) log('sale entry has multiple item ids, folding to first', entry.id, items);
      // items[0].uid enables exact per-copy basis matching (null for stackables).
      rec = recordSale(resolveItemName(items[0].id), totalQty, proceeds, fee, market, ts, items[0].uid);
    }

    if (rec) {
      log('auto-logged sale via api-log', entry.id, rec);
      renderAll();
      showToast(saleToastText(rec)); // informational, no Undo (a sale already consumed its lots)
    }
    return rec;
  }

  function saleToastText(rec) {
    const q = rec.qty.toLocaleString('en-US');
    const sign = rec.profit >= 0 ? '+' : '';
    if (rec.matchedQty >= rec.qty && rec.matchedQty > 0) {
      return `FLIPR sold: ${q}\u00D7 ${rec.itemName} \u00B7 ${sign}${money(rec.profit)} profit`;
    }
    if (rec.matchedQty > 0) {
      return `FLIPR sold: ${q}\u00D7 ${rec.itemName} \u00B7 ${sign}${money(rec.profit)} on ${rec.matchedQty}, rest no basis`;
    }
    return `FLIPR sold: ${q}\u00D7 ${rec.itemName} \u00B7 ${money(rec.proceeds)} (no cost basis)`;
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  PROFIT MATH
  ////////////////////////////////////////////////////////////////////////////

  function breakeven(unitCost, fee) {
    return unitCost / (1 - fee);
  }

  function netProceedsPerUnit(price, fee) {
    return price * (1 - fee);
  }

  function profitTotal(price, unitCost, fee, qty) {
    return (netProceedsPerUnit(price, fee) - unitCost) * qty;
  }

  const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const pct = (n) => (n >= 0 ? '+' : '') + n.toFixed(1) + '%';

  ////////////////////////////////////////////////////////////////////////////
  ////  UI - STYLES
  ////////////////////////////////////////////////////////////////////////////

  const style = document.createElement('style');
  style.textContent = `
    #flipr-panel { position: fixed; top: 0; right: 10px; width: 300px;
      background: #2b2b2b; color: #ccc; border: 1px solid #111;
      border-radius: 8px; font-size: 12px; line-height: 1.4; z-index: 999999;
      box-shadow: 0 8px 28px rgba(0,0,0,0.7);
      /* border-box so a manual resize width read from getBoundingClientRect
         round-trips through inline style.width without drifting by the border. */
      box-sizing: border-box; }
    #flipr-panel.flipr-collapsed .flipr-body { display: none; }
    /* Collapsed = a small round draggable button instead of the full-width
       bar, so it can sit out of the way anywhere on screen (still the same
       #flipr-header element/handlers either way - see the drag-to-move
       section in the script for why). */
    /* !important so a manual resize width set inline on the panel (see PANEL
       RESIZE) can never stop the collapsed puck from shrinking back to 44px. */
    #flipr-panel.flipr-collapsed { width: 44px !important; height: 44px !important; border-radius: 50%; overflow: hidden; }
    /* Manual resize grip (bottom-right corner). Pointer-driven, not CSS resize,
       so it behaves the same on the PDA as on desktop (see makePanelResizable).
       The width is set on the panel and the scroll height on .flipr-body; both
       persist in settings.panelSize. Hidden while collapsed - a puck has nothing
       to resize. The stripes are just a diagonal grip hint. */
    #flipr-resize { position: absolute; right: 3px; bottom: 3px; width: 15px; height: 15px;
      cursor: nwse-resize; z-index: 3; opacity: 0.45; touch-action: none;
      background: linear-gradient(135deg, transparent 0 45%, #4da3ff 45% 55%, transparent 55% 68%, #4da3ff 68% 78%, transparent 78%); }
    #flipr-resize:hover { opacity: 0.85; }
    #flipr-panel.flipr-collapsed #flipr-resize { display: none; }
    #flipr-header { display: flex; justify-content: space-between; align-items: center;
      padding: 8px 10px; background: #1f1f1f; border-radius: 8px 8px 0 0; cursor: grab;
      user-select: none; touch-action: none; }
    /* touch-action: none lets a touch drag on the handle move the panel instead of
       the PDA/mobile webview claiming the gesture for scrolling (see pointer-event
       drag handlers below). */
    #flipr-header:active { cursor: grabbing; }
    #flipr-panel.flipr-collapsed #flipr-header { width: 100%; height: 100%; border-radius: 50%;
      justify-content: center; padding: 0; }
    #flipr-header b { color: #4da3ff; font-size: 13px; }
    .flipr-header-mini { display: none; color: #4da3ff; font-weight: bold; font-size: 16px; }
    #flipr-panel.flipr-collapsed .flipr-header-full { display: none; }
    #flipr-panel.flipr-collapsed .flipr-header-mini { display: inline; }
    /* Docked launcher (settings.launcherMode === 'docked', see DOCKED LAUNCHER).
       In this mode "closed" means the whole panel is hidden and reopened from a
       button in Torn's bottom bar, instead of shrinking to a floating round
       puck. Two classes beat the single-class .flipr-collapsed rule above, so
       display:none wins over the 44px circle. The expanded panel is unchanged. */
    #flipr-panel.flipr-docked.flipr-collapsed { display: none; }
    /* The button dropped into Torn's bottom bar. It borrows the Notes/People
       button's own class list (see ensureDockButton) so it lands in the bar's
       slot and takes taps the same way they do; these rules restyle it into a
       filled blue "F" tile - FLIPR's own Flip-tab blue and white - so it reads
       as a real bar icon alongside the others rather than bare text. Its box is
       sized in JS to sit level with the neighbouring icons. An #id selector beats
       Torn's single-class rules, so our colours win even over the borrowed class. */
    #flipr-dock-btn { display: inline-flex; align-items: center; justify-content: center;
      box-sizing: border-box; width: 24px; height: 24px; padding: 0; border-radius: 4px;
      background: #2f6fbf; color: #fff; border: 1px solid #1d477e; box-shadow: none;
      font-weight: bold; font-size: 14px; line-height: 1; text-indent: 0;
      cursor: pointer; user-select: none; touch-action: none; vertical-align: middle; }
    /* touch-action: none so a touch-drag to reorder moves the button instead of
       the webview grabbing the gesture to scroll. A plain tap still opens it. */
    #flipr-dock-btn:hover { background: #3a80d6; color: #fff; }
    #flipr-dock-btn.flipr-dock-dragging { opacity: 0.55; cursor: grabbing; }
    #flipr-status-line { margin-bottom: 10px; color: #6fa8dc; font-size: 10px; }
    #flipr-status-line:empty { display: none; }
    #flipr-status-line.flipr-status-warn { color: #e5534b; }
    .flipr-body { padding: 10px; max-height: min(520px, calc(100vh - 110px)); overflow-y: auto;
      box-sizing: border-box; }
    .flipr-section { margin-bottom: 12px; border-top: 1px solid #3c3c3c; padding-top: 10px; }
    .flipr-section:first-child { border-top: none; padding-top: 0; }
    #flipr-panel .flipr-section h4 { margin: 2px 0 6px; color: #6fa8dc; font-size: 9px; font-weight: bold;
      text-transform: uppercase; letter-spacing: 0.03em; }
    .flipr-row { display: flex; gap: 6px; margin-bottom: 6px; align-items: center; }
    .flipr-row label { flex: 1; color: #bbb; }
    .flipr-row input, .flipr-row select { flex: 1; min-width: 0; height: 24px; box-sizing: border-box;
      background: #1a1a1a; color: #ddd; border: 1px solid #444; border-radius: 4px; padding: 1px 7px;
      font: inherit; }
    .flipr-row input.flipr-input-price { flex: 0 0 110px; text-align: center; }
    .flipr-row input.flipr-input-qty { flex: 0 0 90px; text-align: center; }
    .flipr-checkbox-row { display: flex; align-items: center; gap: 6px; color: #bbb; cursor: pointer; }
    .flipr-checkbox-row input { margin: 0; }
    .flipr-btn { background: #2f6fbf; color: #fff; border: 1px solid #1d477e; border-radius: 4px;
      height: 24px; padding: 0 10px; cursor: pointer; font: inherit; font-size: 11px; }
    .flipr-btn:hover { background: #3a80d6; }
    .flipr-btn.flipr-btn-danger { background: #5a2d2d; border-color: #3c1f1f; }
    .flipr-btn.flipr-btn-danger:hover { background: #6e3838; }
    .flipr-btn.flipr-btn-block { display: block; width: 100%; height: auto; padding: 7px; margin-top: 4px; }
    #flipr-holdings { max-height: 180px; overflow-y: auto; }
    .flipr-holding { display: flex; justify-content: space-between; align-items: center;
      padding: 4px 0; border-bottom: 1px solid #3c3c3c; gap: 4px; }
    .flipr-holding:last-child { border-bottom: none; }
    .flipr-holding-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #ddd; }
    .flipr-holding-meta { color: #888; font-size: 10px; }
    .flipr-holding-meta:hover { color: #cfc; text-decoration: underline dotted; }
    .flipr-price-edit { width: 96px; background: #111; color: #eee; border: 1px solid #6c6;
      border-radius: 3px; font: 11px monospace; padding: 1px 4px; }
    .flipr-x { background: none; border: none; color: #a55; cursor: pointer; font: inherit;
      padding: 0 3px; }
    .flipr-empty { color: #777; font-style: italic; }
    .flipr-result { margin-top: 6px; padding: 8px; border-radius: 4px; background: #1a1a1a; }
    .flipr-result.flipr-profit { border-left: 3px solid #3fb950; }
    .flipr-result.flipr-loss { border-left: 3px solid #e5534b; }
    .flipr-result .flipr-verdict { font-weight: bold; }
    .flipr-result.flipr-profit .flipr-verdict { color: #3fb950; }
    .flipr-result.flipr-loss .flipr-verdict { color: #e5534b; }
    .flipr-result div:last-child { color: #999; font-size: 10px; margin-top: 2px; }
    .flipr-toast { position: fixed; top: 0; right: 320px; max-width: 260px;
      background: #2b2b2b; color: #ccc; border: 1px solid #111; border-left: 3px solid #3fb950;
      border-radius: 4px; padding: 8px 22px 8px 10px; font-size: 12px; line-height: 1.4; z-index: 999999;
      box-shadow: 0 8px 28px rgba(0,0,0,0.7); cursor: pointer; }
    .flipr-toast button { margin-top: 6px; }
    .flipr-toast-close { position: absolute; top: 4px; right: 6px; color: #888; font-size: 13px;
      line-height: 1; cursor: pointer; }
    .flipr-toast-close:hover { color: #ccc; }
    .flipr-fee-toggle { display: flex; flex-wrap: wrap; gap: 6px 10px; font-size: 11px; color: #bbb; margin-bottom: 8px; }
    .flipr-fee-toggle label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
    .flipr-hint { color: #888; font-size: 10px; margin: 2px 0 8px; }
    .flipr-debug-textarea { width: 100%; height: 90px; margin-top: 6px; background: #1a1a1a; color: #ddd;
      border: 1px solid #444; border-radius: 4px; font-size: 10px; padding: 6px; box-sizing: border-box; }
    .flipr-tabs { display: flex; gap: 4px; margin-bottom: 16px; }
    .flipr-tab-btn { flex: 1; background: #1a1a1a; color: #999; border: 1px solid #444; border-radius: 4px;
      height: 26px; cursor: pointer; font: inherit; font-size: 11px; }
    .flipr-tab-btn:hover { background: #232323; color: #ccc; }
    .flipr-tab-btn.flipr-tab-active { background: #2f6fbf; color: #fff; border-color: #1d477e; }
    #flipr-tax-popover { position: fixed; z-index: 1000000; background: #2b2b2b; color: #ddd;
      border: 1px solid #111; border-left: 3px solid #3fb950; border-radius: 6px;
      padding: 8px 26px 8px 10px; font-size: 12px; line-height: 1.5; max-width: 220px;
      box-shadow: 0 8px 28px rgba(0,0,0,0.7); }
    #flipr-tax-popover .flipr-tax-orig { color: #999; font-size: 11px; }
    #flipr-tax-popover .flipr-tax-net b { color: #3fb950; }
    #flipr-tax-popover .flipr-tax-copy { margin-top: 6px; }
    #flipr-tax-popover .flipr-tax-close { position: absolute; top: 3px; right: 7px; color: #888;
      cursor: pointer; font-size: 14px; line-height: 1; }
    #flipr-tax-popover .flipr-tax-close:hover { color: #ccc; }
  `;
  // Guarded for the same reason as the panel append below: at document-end <head> is
  // always parsed in practice, but appending to null would throw and take the whole
  // script down, and a style element works parented to <html> either way.
  (document.head || document.documentElement).appendChild(style);

  ////////////////////////////////////////////////////////////////////////////
  ////  UI - PANEL
  ////////////////////////////////////////////////////////////////////////////

  const panel = document.createElement('div');
  panel.id = 'flipr-panel';
  if (settings.collapsed) panel.classList.add('flipr-collapsed');
  panel.innerHTML = `
    <div id="flipr-header">
      <span class="flipr-header-full"><b>FLIPR</b> v${SCRIPT_VERSION}</span>
      <span class="flipr-header-mini">F</span>
      <span id="flipr-toggle" class="flipr-header-full">${settings.collapsed ? '\u25B8' : '\u25BE'}</span>
    </div>
    <div class="flipr-body">
      <div id="flipr-status-line"></div>
      <div class="flipr-tabs">
        <button class="flipr-tab-btn flipr-tab-active" id="flipr-tab-btn-main">Flip</button>
        <button class="flipr-tab-btn" id="flipr-tab-btn-profits">Profits</button>
        <button class="flipr-tab-btn" id="flipr-tab-btn-points">Points</button>
        <button class="flipr-tab-btn" id="flipr-tab-btn-settings">\u2699</button>
      </div>
      <div id="flipr-tab-main">
        <div class="flipr-section">
          <h4>Holdings</h4>
          <label class="flipr-checkbox-row">
            <input type="checkbox" id="flipr-holdings-lump">
            Lump same items together (avg price)
          </label>
          <div id="flipr-holdings"></div>
        </div>
        <div class="flipr-section">
          <h4>Sell Check</h4>
          <div class="flipr-fee-toggle">
            <label><input type="radio" name="flipr-fee" value="bazaar" /> Bazaar (0%)</label>
            <label><input type="radio" name="flipr-fee" value="standard" /> Market (5%)</label>
            <label><input type="radio" name="flipr-fee" value="anon" /> Anonymous (15%)</label>
          </div>
          <div class="flipr-row">
            <select id="flipr-check-item"></select>
          </div>
          <div class="flipr-row">
            <input type="number" id="flipr-check-price" class="flipr-input-price" placeholder="Listing price" min="0" />
            <input type="number" id="flipr-check-qty" class="flipr-input-qty" placeholder="Qty" min="1" />
          </div>
          <div id="flipr-check-result"></div>
        </div>
      </div>
      <div id="flipr-tab-profits" style="display:none;">
        <div class="flipr-section">
          <h4>Realized Profit</h4>
          <div id="flipr-profits-summary"></div>
          <div class="flipr-hint">Auto-logged when a listing sells (needs your API key). Profit is proceeds minus what you paid for that item in FLIPR. Items you sold but never bought through FLIPR (crime loot, pre-install stock) count as sold but have no cost basis.</div>
        </div>
        <div class="flipr-section">
          <h4>Recent Sales</h4>
          <div id="flipr-sales-list"></div>
        </div>
        <div class="flipr-section">
          <button class="flipr-btn flipr-btn-danger flipr-btn-block" id="flipr-clear-sales-btn">Clear profit history</button>
        </div>
      </div>
      <div id="flipr-tab-points" style="display:none;">
        <div class="flipr-section">
          <h4>Points Held</h4>
          <div id="flipr-points-summary" class="flipr-holding-meta"></div>
          <div id="flipr-points-lots"></div>
        </div>
        <div class="flipr-section">
          <h4>Sell Check</h4>
          <div class="flipr-row">
            <select id="flipr-points-check-tier"></select>
          </div>
          <div class="flipr-row">
            <input type="number" id="flipr-points-check-price" class="flipr-input-price" placeholder="Listing price" min="0" />
            <input type="number" id="flipr-points-check-qty" class="flipr-input-qty" placeholder="Qty" min="1" />
          </div>
          <div class="flipr-hint">No confirmed Points Market sales tax (unlike Item Market), so this checks raw profit at 0% - flag it if that's wrong.</div>
          <div id="flipr-points-check-result"></div>
        </div>
      </div>
      <div id="flipr-tab-settings" style="display:none;">
        <div class="flipr-section">
          <h4>Purchase detection</h4>
          <label class="flipr-checkbox-row">
            <input type="checkbox" id="flipr-scan-page-text" checked>
            Instant purchase detection
          </label>
          <div class="flipr-hint">Logs a buy the second it happens on the Bazaar/Item Market/Points Market pages themselves - turn off to use only the slower, safer API check.</div>
        </div>
        <div class="flipr-section">
          <h4>Market tools</h4>
          <label class="flipr-checkbox-row">
            <input type="checkbox" id="flipr-market-tax">
            After-tax price on Item Market click
          </label>
          <div class="flipr-hint">On the Item Market, click a listing to see its price minus Torn's 5% sales tax, with a Copy button. Read-only - it never fills or clicks anything for you.</div>
          <label class="flipr-checkbox-row">
            <input type="checkbox" id="flipr-market-quality">
            Show weapon/armour quality and bonuses
          </label>
          <div class="flipr-hint">Draws a "Q %" quality badge and the bonus percentages onto each weapon/armour on the Item Market, Bazaar, your Items page, any Display Case and your Faction Armory. Read-only - it reads what the page already shows (and, on the Item Market, the page's own listing data) and adds no API calls. If another quality-overlay script has already tagged a listing, FLIPR steps aside on it.</div>
        </div>
        <div class="flipr-section">
          <h4>Player trades</h4>
          <label class="flipr-checkbox-row">
            <input type="checkbox" id="flipr-track-trades">
            Track completed player trades
          </label>
          <div class="flipr-hint">When you open a finished trade's log (trade.php), FLIPR reads what changed hands: money for one item = a buy (into Holdings) or a sale (into Profits, no tax). Read-only - it only reads the log page you opened, and each trade is recorded once. Multi-item or item-for-item trades are noted but not auto-priced (no honest way to split one lump of money across different items).</div>
        </div>
        <div class="flipr-section">
          <h4>Launcher</h4>
          <label class="flipr-checkbox-row">
            <input type="checkbox" id="flipr-launcher-dock">
            Dock button to Torn's bottom bar
          </label>
          <div class="flipr-hint">Off (default): a floating button you drag anywhere and tap to open. On: hides that floating button and puts a fixed "F" next to the Notes/People icons in Torn's bottom bar - easier to open and close on the PDA than dragging. The panel still drags and closes the same way once open.</div>
        </div>
        <div class="flipr-section">
          <h4>API key</h4>
          <div id="flipr-api-key-section"></div>
          <div id="flipr-log-status" class="flipr-holding-meta"></div>
        </div>
        <div class="flipr-section">
          <h4>Debug export</h4>
          <div class="flipr-hint">Share this with the script maintainer to help debug FLIPR - it includes your settings, holdings, and log-sync state. Your API key is NEVER included.</div>
          <button class="flipr-btn flipr-btn-block" id="flipr-debug-export-btn">Copy debug export</button>
          <textarea id="flipr-debug-export-area" readonly class="flipr-debug-textarea" style="display:none;"></textarea>
        </div>
        <div class="flipr-section">
          <button class="flipr-btn flipr-btn-danger flipr-btn-block" id="flipr-reset-btn">Reset all data</button>
        </div>
      </div>
    </div>
    <div id="flipr-resize" title="Drag to resize FLIPR"></div>
  `;
  // Defensive, not a known fix: <body> is expected to exist by the time this runs on
  // both targets (at document-end it is parsed, and the PDA injects after
  // window.onload). But appending to a null body throws and would take the whole
  // script down before the panel ever renders, which is indistinguishable from
  // "FLIPR is invisible" - the exact symptom reported on the PDA - so it is not worth
  // leaving unguarded. documentElement (<html>) always exists, and the panel is
  // position:fixed so it lays out identically parented to either one.
  (document.body || document.documentElement).appendChild(panel);

  const $ = (sel) => panel.querySelector(sel);

  const FLIPR_TAB_NAMES = ['main', 'profits', 'points', 'settings'];
  // Persists the choice to settings so a page refresh (which re-runs this
  // whole script from scratch, with no memory of what was open a moment
  // ago) reopens on whichever tab was last active instead of always
  // resetting back to Flip.
  function showFliprTab(activeName) {
    for (const name of FLIPR_TAB_NAMES) {
      $(`#flipr-tab-${name}`).style.display = name === activeName ? '' : 'none';
      $(`#flipr-tab-btn-${name}`).classList.toggle('flipr-tab-active', name === activeName);
    }
    settings.activeTab = activeName;
    saveSettings(settings);
    renderAll(); // the newly shown tab may be stale - renderAll only draws this one
  }
  for (const name of FLIPR_TAB_NAMES) {
    $(`#flipr-tab-btn-${name}`).addEventListener('click', () => showFliprTab(name));
  }
  showFliprTab(settings.activeTab); // restore whichever tab was open before the last refresh

  ////////////////////////////////////////////////////////////////////////////
  ////  DRAGGABLE POSITIONING
  ////////////////////////////////////////////////////////////////////////////
  // The header doubles as a drag handle in both the expanded panel and the
  // collapsed round-button state (same element either way - see the
  // .flipr-collapsed CSS above), so the whole widget can be moved anywhere
  // on screen instead of staying fixed top-right. Position is saved to
  // settings so it survives a reload. Uses POINTER events (not mouse), so the
  // same drag works with a mouse on desktop AND a finger on the Torn PDA /
  // mobile - pointer events unify both and carry the same clientX/clientY, and
  // `touch-action: none` on the handle (see CSS) stops the webview claiming a
  // touch-drag as a scroll. A plain click/tap still has to keep working to
  // expand/collapse it, so a completed drag and a click are told apart by
  // movement distance: pointerup only counts as a drag if the pointer moved
  // more than DRAG_CLICK_THRESHOLD_PX from where the pointerdown started;
  // anything smaller falls through to the click handler below exactly as before.
  const DRAG_CLICK_THRESHOLD_PX = 4;
  let dragState = null;
  let justDragged = false;

  // The window and the collapsed button share ONE saved position, so the panel opens
  // exactly where you left the button rather than jumping to some other remembered
  // spot. Ported from the private build, where this has been in use for a while.
  //
  // These were SEPARATE until now, and for a real reason: reported on Firefox for
  // Android, a button parked at the right edge for easy reach opened the 300px window
  // mostly off-screen, because the button had only ever been clamped to its own 44px
  // width. That is no longer possible - applyPanelPosition re-clamps against the
  // panel's CURRENT size every time it runs, so restoring the window from a
  // right-edge button pulls it back fully on-screen instead of stranding it. The
  // clamp is what fixed that case; the separate positions were belt-and-braces.
  //
  // settings.collapsedPos is still read and written by loadSettings/saveSettings so
  // an existing install's stored value is preserved rather than thrown away, it just
  // no longer decides anything.
  function currentPanelPos() {
    return settings.panelPos;
  }

  function applyPanelPosition() {
    const pos = currentPanelPos();
    if (!pos) {
      // Never dragged in this state: clear the inline styles and let the stylesheet's
      // default top-right anchoring take over again (it is right-anchored, so it fits
      // any screen width on its own).
      panel.style.top = '';
      panel.style.left = '';
      panel.style.right = '';
      return;
    }
    // Re-clamped on every apply, not just on drop: the panel is being measured at the
    // size it is NOW, so a spot saved while collapsed gets pulled back on-screen when
    // the bigger window restores it. That is also what repairs the single shared
    // position saved by earlier versions, and what survives a rotate/resize.
    const { top, left } = clampPanelPosition(pos.top, pos.left);
    panel.style.top = `${top}px`;
    panel.style.left = `${left}px`;
    panel.style.right = 'auto';
  }

  // Keeps the panel fully on-screen no matter where it's dragged to -
  // letting it go half off an edge would make it hard to grab again.
  function clampPanelPosition(top, left) {
    const rect = panel.getBoundingClientRect();
    const maxTop = Math.max(window.innerHeight - rect.height, 0);
    const maxLeft = Math.max(window.innerWidth - rect.width, 0);
    return { top: Math.min(Math.max(top, 0), maxTop), left: Math.min(Math.max(left, 0), maxLeft) };
  }

  function onPanelDragMove(e) {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (!dragState.moved && (Math.abs(dx) > DRAG_CLICK_THRESHOLD_PX || Math.abs(dy) > DRAG_CLICK_THRESHOLD_PX)) {
      dragState.moved = true;
    }
    if (!dragState.moved) return;
    const { top, left } = clampPanelPosition(dragState.originTop + dy, dragState.originLeft + dx);
    panel.style.top = `${top}px`;
    panel.style.left = `${left}px`;
    panel.style.right = 'auto';
  }

  function onPanelDragEnd() {
    document.removeEventListener('pointermove', onPanelDragMove);
    document.removeEventListener('pointerup', onPanelDragEnd);
    document.removeEventListener('pointercancel', onPanelDragEnd);
    if (!dragState) return;
    if (dragState.moved) {
      const rect = panel.getBoundingClientRect();
      // One shared position (see currentPanelPos) - whichever state was dragged writes
      // the same spot, so the window opens where the button was left.
      settings.panelPos = { top: rect.top, left: rect.left };
      saveSettings(settings);
      justDragged = true; // suppresses the click-driven collapse toggle that follows a real drag
    }
    dragState = null;
  }

  $('#flipr-header').addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return; // left/primary or touch only, not right-click
    const rect = panel.getBoundingClientRect();
    dragState = { startX: e.clientX, startY: e.clientY, originTop: rect.top, originLeft: rect.left, moved: false };
    // pointercancel fires if the webview aborts the gesture (e.g. it decides to
    // scroll); treat it exactly like pointerup so a half-finished drag cleans up.
    document.addEventListener('pointermove', onPanelDragMove);
    document.addEventListener('pointerup', onPanelDragEnd);
    document.addEventListener('pointercancel', onPanelDragEnd);
  });

  ////////////////////////////////////////////////////////////////////////////
  ////  PANEL RESIZE
  ////////////////////////////////////////////////////////////////////////////
  //
  // A pointer-driven grip in the bottom-right corner sets the panel WIDTH (inline on
  // #flipr-panel) and the scroll-area HEIGHT (inline on .flipr-body). Both are saved in
  // settings.panelSize and re-applied on load, so a size survives refresh until the
  // user drags it again. Same reasons as the drag code above for using pointer events
  // rather than the CSS `resize` property: `resize` is unreliable inside the PDA
  // webview and gives no way to persist or clamp the result.
  //
  // Width lives on the panel; height lives on the body (not the panel) so the header
  // stays its natural height and only the scrolling content grows - matching what the
  // default max-height already did. Both values are clamped on the way in AND on the
  // way out (applyPanelSize) so a size saved on a big screen cannot strand the panel
  // off a small one.
  const PANEL_MIN_W = 280;
  const PANEL_MAX_W = 720;
  const PANEL_MIN_BODY_H = 120;
  let resizeState = null;

  function panelMaxWidth() {
    return Math.max(Math.min(PANEL_MAX_W, window.innerWidth - 20), PANEL_MIN_W);
  }
  function panelMaxBodyHeight() {
    // Leave room for the header and a margin so the panel never taller than the screen.
    return Math.max(window.innerHeight - 120, PANEL_MIN_BODY_H);
  }

  function applyPanelSize() {
    const size = settings.panelSize;
    const body = $('.flipr-body');
    if (!size) {
      // Never resized in this install: clear the inline overrides and let the
      // stylesheet's 300px width / max-height take over again.
      panel.style.width = '';
      if (body) { body.style.height = ''; body.style.maxHeight = ''; }
      return;
    }
    panel.style.width = Math.min(Math.max(size.width, PANEL_MIN_W), panelMaxWidth()) + 'px';
    if (body) {
      const h = Math.min(Math.max(size.bodyHeight, PANEL_MIN_BODY_H), panelMaxBodyHeight());
      body.style.height = h + 'px';
      body.style.maxHeight = h + 'px';
    }
  }

  function onResizeMove(e) {
    if (!resizeState) return;
    const dx = e.clientX - resizeState.startX;
    const dy = e.clientY - resizeState.startY;
    const w = Math.min(Math.max(resizeState.startW + dx, PANEL_MIN_W), panelMaxWidth());
    const h = Math.min(Math.max(resizeState.startH + dy, PANEL_MIN_BODY_H), panelMaxBodyHeight());
    resizeState.curW = w;
    resizeState.curH = h;
    panel.style.width = w + 'px';
    resizeState.body.style.height = h + 'px';
    resizeState.body.style.maxHeight = h + 'px';
  }

  function onResizeEnd() {
    document.removeEventListener('pointermove', onResizeMove);
    document.removeEventListener('pointerup', onResizeEnd);
    document.removeEventListener('pointercancel', onResizeEnd);
    if (!resizeState) return;
    settings.panelSize = { width: resizeState.curW, bodyHeight: resizeState.curH };
    saveSettings(settings);
    resizeState = null;
    // Growing toward the right/bottom edge can push the panel partly off-screen;
    // re-clamp its position against the new size, exactly as a rotate/resize does.
    applyPanelPosition();
  }

  $('#flipr-resize').addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return; // left/primary or touch only
    e.preventDefault();
    e.stopPropagation(); // the grip overlaps the panel; don't also start a header/panel drag
    const body = $('.flipr-body');
    if (!body) return;
    const panelRect = panel.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    resizeState = {
      startX: e.clientX, startY: e.clientY,
      startW: panelRect.width, startH: bodyRect.height,
      curW: panelRect.width, curH: bodyRect.height,
      body: body
    };
    document.addEventListener('pointermove', onResizeMove);
    document.addEventListener('pointerup', onResizeEnd);
    document.addEventListener('pointercancel', onResizeEnd);
  });

  applyPanelSize();     // restore a saved manual size first, so the position clamp below
  applyPanelPosition(); // measures the restored size and keeps it fully on-screen

  // Rotating a phone (or resizing a window) can leave a saved spot beyond the new
  // viewport - re-applying re-clamps it back into view. Skipped entirely when this
  // state has no saved spot, so the default-position case costs nothing on the
  // resize storm a mobile browser fires while its address bar hides and shows.
  window.addEventListener('resize', () => {
    // Re-clamp a saved manual size first (a size that fit a big screen may be too wide
    // or tall for the new viewport), then re-clamp the position against that size.
    if (settings.panelSize) applyPanelSize();
    if (currentPanelPos()) applyPanelPosition();
  });

  $('#flipr-header').addEventListener('click', () => {
    if (justDragged) {
      justDragged = false;
      return;
    }
    panel.classList.toggle('flipr-collapsed');
    settings.collapsed = panel.classList.contains('flipr-collapsed');
    $('#flipr-toggle').textContent = settings.collapsed ? '\u25B8' : '\u25BE';
    // Must run AFTER the class toggle: the new state has a different width/height,
    // and applyPanelPosition both picks that state's own saved spot and measures the
    // panel at its new size to keep it on-screen.
    applyPanelPosition();
    saveSettings(settings);
  });

  ////////////////////////////////////////////////////////////////////////////
  ////  DOCKED LAUNCHER (bottom-bar open/close button)
  ////////////////////////////////////////////////////////////////////////////
  // An alternative to the floating round puck: a small "F" wedged into Torn's
  // bottom bar next to the Notes/People icons, so the panel opens and closes
  // from a fixed, easy-to-hit target instead of a button you have to drag
  // around. Asked for by -IBY- [3603459] as a PDA convenience (chasing a
  // floating button around a phone screen is fiddly). Same anchor + re-attach
  // idea the Supply Pack Analyzer uses. Only built while launcherMode is
  // 'docked'; in 'float' mode none of this runs and nothing is added to the bar.
  let dockObserver = null;
  let dockRecheckQueued = false;
  let dockDrag = null;         // in-progress reorder drag of the docked button, or null
  let dockJustDragged = false; // true between a drag ending and the click it spawns

  // Torn's bottom bar is thrown away and rebuilt on its SPA navigations, taking
  // our button with it; the observer below puts it back. Notes and People are
  // the two stable ids in that bar, so we anchor to whichever exists.
  function findDockAnchor() {
    return document.getElementById('notes_panel_button') ||
           document.getElementById('people_panel_button');
  }

  // Pure open/close toggle for the panel, mirroring the header click. "Closed"
  // in docked mode is fully hidden (see the .flipr-docked.flipr-collapsed CSS),
  // so this just flips collapsed and re-applies position/label the same way.
  function toggleFromDock() {
    panel.classList.toggle('flipr-collapsed');
    settings.collapsed = panel.classList.contains('flipr-collapsed');
    const tgl = $('#flipr-toggle');
    if (tgl) tgl.textContent = settings.collapsed ? String.fromCharCode(0x25B8) : String.fromCharCode(0x25BE);
    applyPanelPosition();
    saveSettings(settings);
  }

  function ensureDockButton() {
    if (settings.launcherMode !== 'docked') return;
    if (document.getElementById('flipr-dock-btn')) return; // already in place
    const anchor = findDockAnchor();
    if (!anchor || !anchor.parentNode) return; // bar not built yet - observer retries
    // Build it as a real <button> that borrows the Notes/People button's own
    // class list, so ours drops into Torn's bottom bar as a first-class member -
    // same slot, same sizing, same hit area - and a tap registers exactly the
    // way theirs does. The earlier version inserted a bare <span>: it rendered
    // in the bar and looked right, but the bar's own layout left it without a
    // working tap target, so pressing it did nothing (no listener, plain or
    // delegated, ever saw the click). This is how the Supply Pack Analyzer's
    // docked button is built, and it is reliable on the PDA. Click is bound
    // straight on the button; if Torn ever rebuilds the bar the observer
    // re-creates it and re-binds.
    const btn = document.createElement('button');
    btn.id = 'flipr-dock-btn';
    btn.type = 'button';
    btn.className = anchor.className; // inherit Torn's bar-button styling + hit area
    btn.title = 'FLIPR - open/close (drag to reorder)';
    btn.textContent = 'F';
    // Size the blue tile to sit level with the neighbouring bar icons instead of
    // guessing - measured off the anchor and clamped so an odd box never makes it
    // huge or tiny. Falls back to the CSS 24px if the bar has not laid out yet.
    const ar = anchor.getBoundingClientRect();
    const side = Math.round(Math.min(ar.width || 24, ar.height || 24));
    if (side >= 16 && side <= 40) { btn.style.width = side + 'px'; btn.style.height = side + 'px'; }
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (dockJustDragged) { dockJustDragged = false; return; } // that click ended a drag, not a tap
      toggleFromDock();
    });
    makeDockButtonDraggable(btn);
    anchor.parentNode.appendChild(btn);
    applyDockIndex(btn); // drop it back at the slot it was last dragged to
  }

  // Lets the docked button be dragged left/right to sit anywhere among the other
  // buttons in Torn's bottom bar, instead of always at the end. Pointer events,
  // not HTML5 drag-and-drop (which the PDA handles poorly), so it behaves the
  // same on desktop and in the app; the same movement-threshold trick the
  // floating puck uses tells a reorder drag apart from a plain open/close tap.
  function makeDockButtonDraggable(btn) {
    btn.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return; // primary button / touch only
      dockJustDragged = false; // clear any stale flag so a fresh tap is never eaten
      dockDrag = { startX: e.clientX, startY: e.clientY, moved: false };
      document.addEventListener('pointermove', onDockDragMove);
      document.addEventListener('pointerup', onDockDragEnd);
      document.addEventListener('pointercancel', onDockDragEnd);
    });
  }

  function onDockDragMove(e) {
    if (!dockDrag) return;
    const dx = e.clientX - dockDrag.startX;
    const dy = e.clientY - dockDrag.startY;
    if (!dockDrag.moved && (Math.abs(dx) > DRAG_CLICK_THRESHOLD_PX || Math.abs(dy) > DRAG_CLICK_THRESHOLD_PX)) {
      dockDrag.moved = true;
      const b = document.getElementById('flipr-dock-btn');
      if (b) b.classList.add('flipr-dock-dragging');
    }
    if (!dockDrag.moved) return;
    const btn = document.getElementById('flipr-dock-btn');
    if (!btn || !btn.parentNode) return;
    const parent = btn.parentNode;
    // Reorder live: sort the sibling buttons by their on-screen x (so a flex row
    // that is not in DOM order still reorders correctly), find the first whose
    // centre is past the pointer, and slot in ahead of it; past the last, go last.
    const sibs = [...parent.children].filter((s) => {
      if (s === btn) return false;
      const r = s.getBoundingClientRect();
      return r.width > 0 || r.height > 0; // skip hidden siblings
    }).sort((a, b2) => a.getBoundingClientRect().left - b2.getBoundingClientRect().left);
    let target = null;
    for (const sib of sibs) {
      const r = sib.getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) { target = sib; break; }
    }
    if (target) {
      if (btn.nextElementSibling !== target) parent.insertBefore(btn, target);
    } else if (parent.lastElementChild !== btn) {
      parent.appendChild(btn);
    }
  }

  function onDockDragEnd() {
    document.removeEventListener('pointermove', onDockDragMove);
    document.removeEventListener('pointerup', onDockDragEnd);
    document.removeEventListener('pointercancel', onDockDragEnd);
    if (!dockDrag) return;
    if (dockDrag.moved) {
      const btn = document.getElementById('flipr-dock-btn');
      if (btn && btn.parentNode) {
        btn.classList.remove('flipr-dock-dragging');
        // Save as an index among the bar's buttons (see loadSettings.dockIndex).
        settings.dockIndex = [...btn.parentNode.children].indexOf(btn);
        saveSettings(settings);
      }
      dockJustDragged = true; // stop the trailing click from also toggling the panel
    }
    dockDrag = null;
  }

  // Puts the button back at its saved slot after it is (re)created - on load and
  // whenever Torn rebuilds the bar. Index-based and clamped: if the bar now holds
  // fewer buttons than when the index was saved, it just lands at the end.
  function applyDockIndex(btn) {
    if (settings.dockIndex == null || !btn.parentNode) return;
    const others = [...btn.parentNode.children].filter((c) => c !== btn);
    const ref = others[settings.dockIndex] || null; // out of range => null => append at end
    btn.parentNode.insertBefore(btn, ref);
  }

  function removeDockButton() {
    const btn = document.getElementById('flipr-dock-btn');
    if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
  }

  // Throttled to one re-check per frame: Torn churns the DOM constantly, and a
  // rebuild scan on every single mutation would be wasteful - a check on the
  // next frame after a burst catches the bar getting swapped out just as well.
  function startDockObserver() {
    if (dockObserver) return;
    dockObserver = new MutationObserver(() => {
      if (dockRecheckQueued) return;
      dockRecheckQueued = true;
      requestAnimationFrame(() => {
        dockRecheckQueued = false;
        ensureDockButton();
      });
    });
    dockObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  function stopDockObserver() {
    if (!dockObserver) return;
    dockObserver.disconnect();
    dockObserver = null;
  }

  // Switches the widget between the two launcher styles. Safe to call any time -
  // at startup and live from the settings toggle: it sets the panel's docked
  // class, then either stands up the bottom-bar button and its re-attach
  // observer, or tears them down and lets the floating puck take over again.
  function applyLauncherMode() {
    const docked = settings.launcherMode === 'docked';
    panel.classList.toggle('flipr-docked', docked);
    if (docked) {
      ensureDockButton();
      startDockObserver();
    } else {
      stopDockObserver();
      removeDockButton();
    }
    applyPanelPosition();
  }

  applyLauncherMode(); // stand up whichever launcher the saved setting asks for

  $('#flipr-launcher-dock').checked = settings.launcherMode === 'docked';
  $('#flipr-launcher-dock').addEventListener('change', (e) => {
    settings.launcherMode = e.target.checked ? 'docked' : 'float';
    saveSettings(settings);
    applyLauncherMode();
  });

  $('#flipr-scan-page-text').checked = settings.scanPageText;
  $('#flipr-scan-page-text').addEventListener('change', (e) => {
    settings.scanPageText = e.target.checked;
    saveSettings(settings);
    refreshStatusLine();
  });

  $('#flipr-market-tax').checked = settings.marketTaxHelper;
  $('#flipr-market-tax').addEventListener('change', (e) => {
    settings.marketTaxHelper = e.target.checked;
    saveSettings(settings);
    if (!settings.marketTaxHelper) hideTaxPopover();
  });

  $('#flipr-market-quality').checked = settings.marketQuality;
  $('#flipr-market-quality').addEventListener('change', (e) => {
    settings.marketQuality = e.target.checked;
    saveSettings(settings);
    applyMarketQuality(); // draw the overlay now, or strip it back off, live
  });

  $('#flipr-track-trades').checked = settings.trackTrades;
  $('#flipr-track-trades').addEventListener('change', (e) => {
    settings.trackTrades = e.target.checked;
    saveSettings(settings);
    if (settings.trackTrades) scanTradeLog(); // re-read the trade currently open, if any
  });

  $('#flipr-holdings-lump').checked = settings.holdingsMode === 'lump';
  $('#flipr-holdings-lump').addEventListener('change', (e) => {
    settings.holdingsMode = e.target.checked ? 'lump' : 'separate';
    saveSettings(settings);
    unbindPriceInput(); // the bound entry's id (lot id vs "lump:item") no longer matches the new mode
    renderAll();
  });

  function setLogStatus(text) {
    const el = $('#flipr-log-status');
    if (el) el.textContent = text;
  }

  // Instant detection being off is easy to lose track of - it's a checkbox
  // tucked away in the Settings tab, nothing else in the panel reflects its
  // state, and with it off FLIPR silently falls back to the slower API poll
  // alone (or logs nothing at all if no API key is set either) - reported:
  // a real purchase went untracked with the toggle off and no visible sign
  // anywhere that this was why. Surfaced here in the one place always
  // visible regardless of which tab is open, and in a warning color when
  // instant detection is off so it can't blend in with the normal status.
  function refreshStatusLine() {
    const el = $('#flipr-status-line');
    if (!el) return;
    const openLots = getOpenLots();
    const itemCount = openLots.length;
    const hasKey = !!getApiKey();
    let syncLabel;
    if (settings.scanPageText && hasKey) syncLabel = 'instant + API sync on';
    else if (settings.scanPageText) syncLabel = 'instant detection only';
    else if (hasKey) syncLabel = 'instant detection OFF \u00B7 API sync only';
    else syncLabel = 'instant detection OFF \u00B7 no API key - nothing will log';
    el.classList.toggle('flipr-status-warn', !settings.scanPageText);
    el.textContent = itemCount
      ? `${itemCount} open purchase${itemCount === 1 ? '' : 's'} \u00B7 ${syncLabel}`
      : `Nothing tracked yet \u00B7 ${syncLabel}`;
  }

  // Once a key is saved there's no reason to ever show the entry form again
  // (or the key itself) until the user explicitly clears it - so this section
  // has exactly two states, and never both: an empty entry form, or a
  // "saved" status line with a way to clear it. No key is ever re-displayed
  // once saved.
  function renderApiKeySection() {
    const container = $('#flipr-api-key-section');
    container.innerHTML = '';
    if (getApiKey()) {
      const row = document.createElement('div');
      row.className = 'flipr-row';
      const status = document.createElement('span');
      status.className = 'flipr-holding-meta';
      status.style.flex = '1';
      status.textContent = 'API key saved.';
      const clearBtn = document.createElement('button');
      clearBtn.className = 'flipr-btn flipr-btn-danger';
      clearBtn.textContent = 'Clear key';
      clearBtn.addEventListener('click', () => {
        setApiKey('');
        setLogStatus('No API key set - on-page detection still runs, the API poll just will not.');
        renderApiKeySection();
        refreshStatusLine();
      });
      row.appendChild(status);
      row.appendChild(clearBtn);
      container.appendChild(row);
    } else {
      const row = document.createElement('div');
      row.className = 'flipr-row';
      const input = document.createElement('input');
      input.type = 'password';
      input.id = 'flipr-api-key-input';
      input.placeholder = 'Torn API key';
      input.autocomplete = 'off';
      const saveBtn = document.createElement('button');
      saveBtn.className = 'flipr-btn';
      saveBtn.textContent = 'Save';
      saveBtn.addEventListener('click', () => {
        const key = input.value.trim();
        if (!API_KEY_REGEX.test(key)) {
          setLogStatus('That does not look like a valid API key.');
          return;
        }
        setApiKey(key);
        logState = { lastTimestamp: 0 }; // re-arm "first poll" so it starts watching from now
        saveLogState(logState);
        logPollFatalError = false; // a freshly-entered key re-arms the auto-poll if a previous key was rejected
        renderApiKeySection();
        refreshStatusLine();
        setLogStatus('Checking...');
        pollLog();
      });
      row.appendChild(input);
      row.appendChild(saveBtn);
      container.appendChild(row);

      // A one-click link to Torn's Custom Key Builder, pre-filled with ONLY the two
      // selections FLIPR actually reads. Torn's own guidance is to request as little
      // as possible, and a key scoped to these cannot be used to read your money,
      // battle stats, messages, faction data or anything else - so if it ever leaks,
      // the blast radius is your own buy/sell history and a public item list.
      const keyHint = document.createElement('div');
      keyHint.className = 'flipr-hint';
      const keyLink = document.createElement('a');
      keyLink.href = CUSTOM_KEY_URL;
      keyLink.target = '_blank';
      keyLink.rel = 'noopener';
      keyLink.textContent = 'Make a FLIPR-only key';
      keyLink.style.color = '#4da3ff';
      keyHint.appendChild(keyLink);
      keyHint.appendChild(document.createTextNode(
        ' - opens Torn with just the two boxes FLIPR needs already ticked: '
        + 'user > log (your own buys and sells) and torn > items (item names). '
        + 'If it opens without them ticked, tick those two by hand. A Full key works '
        + 'too, but gives away far more than this script ever reads.'
      ));
      container.appendChild(keyHint);

      setLogStatus('No API key set - on-page detection still runs, the API poll just will not.');
    }
  }
  renderApiKeySection();

  // Snapshot of non-sensitive state, meant to be pasted to the script
  // maintainer for debugging - never includes the API key itself, only
  // whether one is set. See the COMPLIANCE NOTE at the top of the file.
  function buildDebugExport() {
    return {
      scriptVersion: SCRIPT_VERSION,
      exportedAt: new Date().toISOString(),
      hasApiKey: !!getApiKey(),
      // Which environment/storage code path this install actually took. Booleans
      // only - never the key itself. Without this, a PDA bug report can only be
      // guessed at: isPDA tells us the PDA replaced its token (so the script really
      // is running under the PDA at all), and useGM tells us whether persistence is
      // going through GM_* or localStorage.
      platform: { isPDA: isPDA(), useGM: USE_GM_STORAGE, viewport: `${window.innerWidth}x${window.innerHeight}` },
      logSyncStatus: ($('#flipr-log-status') || {}).textContent || '',
      logState,
      // Durable dedup diagnostics - the log-id ledger size, and how many DOM/API
      // reconciliation tickets are currently outstanding (awaiting the other path).
      processedLogIdCount: processedLogIds.length,
      pendingTickets: (() => { const t = loadTickets(); return { dom: Object.keys(t.dom).length, api: Object.keys(t.api).length }; })(),
      // Diagnostic snapshot of the most recent API log poll: how many raw
      // entries came back, how many matched as purchases, and (if any were
      // skipped) their title/category so a miss can be root-caused directly
      // from this export.
      lastPollDebug,
      itemCatalog: { fetchedAt: itemCatalog.fetchedAt, cachedItemCount: Object.keys(itemCatalog.names).length },
      settings: {
        feeMode: settings.feeMode,
        feeValue: currentFee(),
        collapsed: settings.collapsed,
        scanPageText: settings.scanPageText,
        holdingsMode: settings.holdingsMode,
        marketTaxHelper: settings.marketTaxHelper,
        marketQuality: settings.marketQuality,
        trackTrades: settings.trackTrades,
        activeTab: settings.activeTab,
        // Read alongside platform.viewport above: a panel reported as missing or
        // half off-screen is usually a saved spot that no longer fits the screen.
        panelPos: settings.panelPos,
        collapsedPos: settings.collapsedPos,
      },
      holdings: getHoldings(),
      // Each lot's `source` is either 'dom-text' (instant on-page confirmation
      // read) or 'api-log:<entryId>' (API poll fallback).
      lots,
      pointsLots,
      // Realized-profit ledger: the uncapped running totals plus how many detail
      // rows are currently retained (capped at RECENT_SALES_MAX). No per-sale rows
      // are dumped here - the totals are what diagnose a wrong profit number.
      sales: { totals: salesData.totals, recentCount: salesData.recent.length },
      // The last 30 sale records in full. Needed to diagnose a wrong profit figure:
      // proceeds/matchedQty/matchedCost/profit together show whether the fault was the
      // proceeds read, the basis match, or the same sale being recorded twice.
      salesRecent: salesData.recent.slice(-30),
      pointsLotsDetail: pointsLots,
      // Any "you bought" text the instant DOM-text scanner saw but couldn't
      // parse - see recordUnmatchedPurchaseText() for why this exists.
      recentUnmatchedPurchaseTexts,
      // Best-effort Damage/Accuracy DOM reads attempted around recent
      // purchases (found or not) - see resolveWeaponStats() for why this
      // exists; a run of `found: false` entries with real stat text sitting
      // in `snippet` means the regex/search-depth needs adjusting.
      recentStatsCaptureAttempts,
      // Click-time weapon-stat capture attempts (see captureWeaponStatsFromClick):
      // for each weapon-card-ish Item Market click, whether it stashed, the stat
      // pair it saw, and whether a weapon name matched in the SAME element text.
      // `weaponNameMatched: false` with a real `statPairSeen` means the name and the
      // numbers live in separate DOM branches (need the card outerHTML to pair them).
      recentClickCaptureAttempts,
    };
  }

  // One-way debug export only, no Import - there's nothing to restore since
  // settings/holdings are already edited live in this panel.
  $('#flipr-debug-export-btn').addEventListener('click', () => {
    const area = $('#flipr-debug-export-area');
    area.value = JSON.stringify(buildDebugExport(), null, 2);
    area.style.display = 'block';
    area.focus();
    area.select();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(area.value);
    } catch (err) {
      // clipboard API unavailable - textarea is already selected for manual copy
    }
  });

  function currentFee() {
    const checked = panel.querySelector('input[name="flipr-fee"]:checked');
    if (!checked) return FEE_BAZAAR;
    if (checked.value === 'anon') return FEE_ANONYMOUS;
    if (checked.value === 'standard') return FEE_STANDARD;
    return FEE_BAZAAR;
  }
  const feeRadio = panel.querySelector(`input[name="flipr-fee"][value="${settings.feeMode}"]`);
  if (feeRadio) feeRadio.checked = true;
  panel.querySelectorAll('input[name="flipr-fee"]').forEach((r) =>
    r.addEventListener('change', () => {
      settings.feeMode = r.value;
      saveSettings(settings);
      renderSellCheckResult();
    })
  );

  // Best-effort Damage/Accuracy read (see findWeaponStatsNear) formatted for
  // display - blank for anything the scanner didn't find stats for (most
  // items, since only weapons/gear roll their own stats at all), so this
  // never shows up as a confusing "Dmg 0.00" on things that don't have it.
  function formatStats(stats) {
    if (!stats) return '';
    const parts = [];
    if (stats.dmg != null) parts.push(`Dmg ${Number(stats.dmg).toFixed(2)}`);
    if (stats.acc != null) parts.push(`Acc ${Number(stats.acc).toFixed(2)}`);
    if (stats.armor != null) parts.push(`Armor ${Number(stats.armor).toFixed(2)}`);
    // Quality/Bonus are intentionally not shown - only Damage/Accuracy are tracked
    // for weapons (armor shows Armor). See extractStatsFromText, which no longer
    // captures them either, so old rows may still carry values that stay hidden.
    return parts.length ? ` \u00B7 ${parts.join('/')}` : '';
  }

  // Shows either each purchase separately or one blended row per item,
  // depending on settings.holdingsMode - sharing the exact same entries the
  // Sell Check dropdown builds its options from either way, so clearing a
  // row here removes it from both places at once.
  function renderHoldings() {
    const container = $('#flipr-holdings');
    const entries = getDisplayEntries();
    const fee = currentFee();
    container.innerHTML = '';
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'flipr-empty';
      empty.textContent = 'Nothing logged yet.';
      container.appendChild(empty);
    } else {
      for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'flipr-holding';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'flipr-holding-name';
        // Meta text is computed once so it can appear both in the meta column and,
        // with the name and qty, in the name's hover title (below).
        const costLabel = entry.isLump ? 'avg' : '/unit';
        // At 0% fee (Bazaar), breakeven is mathematically identical to cost -
        // showing both is just noise, so only add it once a fee actually
        // pushes it above cost (Market/Anonymous).
        const metaText = (fee > 0
          ? `${money(entry.unitCost)} ${costLabel} \u00B7 b/e ${money(breakeven(entry.unitCost, fee))}`
          : `${money(entry.unitCost)} ${costLabel}`) + formatStats(entry.stats);

        // Name and the "\u00D7N" count are separate children so ONLY the count is
        // click-to-edit - clicking the item name does nothing, matching the price
        // column where just the number is live. The count is underlined so it reads
        // as an editable field rather than plain label text.
        nameSpan.appendChild(document.createTextNode(entry.itemName + ' '));
        const qtySpan = document.createElement('span');
        qtySpan.className = 'flipr-holding-qty';
        qtySpan.textContent = `\u00D7${entry.qty}`;
        qtySpan.style.cursor = 'pointer';
        qtySpan.style.textDecoration = 'underline dotted';
        qtySpan.title = entry.isLump
          ? 'Click to correct the count (down only) - e.g. an untracked sale reduced it'
          : 'Click to correct the count - e.g. you sold some and it was not caught';
        qtySpan.addEventListener('click', (e) => { e.stopPropagation(); startQtyEdit(qtySpan, entry); });
        nameSpan.appendChild(qtySpan);
        // The name column ellipsis-clips long item names, so the hover title carries
        // the whole row untruncated: full name, qty, and the same price/breakeven/
        // stats shown in the meta column - "hover to read all of it".
        nameSpan.title = `${entry.itemName} \u00D7${entry.qty} \u00B7 ${metaText}`;

        const metaSpan = document.createElement('span');
        metaSpan.className = 'flipr-holding-meta';
        metaSpan.textContent = metaText;

        // Click the price to correct it. The X deletes the row outright, which is a
        // blunt instrument when all that is wrong is the number.
        metaSpan.style.cursor = 'pointer';
        metaSpan.title = entry.isLump
          ? 'Click to edit - sets EVERY purchase of this item to the price you enter'
          : 'Click to edit the price you paid';
        metaSpan.addEventListener('click', () => startPriceEdit(metaSpan, entry));

        const delBtn = document.createElement('button');
        delBtn.className = 'flipr-x';
        delBtn.textContent = '\u2715';
        delBtn.title = entry.isLump ? 'Clear all purchases of this item (e.g. once sold)' : 'Clear this purchase (e.g. once sold)';
        delBtn.addEventListener('click', () => {
          clearEntry(entry.id);
          renderAll();
        });

        row.appendChild(nameSpan);
        row.appendChild(metaSpan);
        row.appendChild(delBtn);
        container.appendChild(row);
      }
    }
    renderCheckItemOptions(entries);
  }

  // Purchases at different prices are shown as separate rows (never
  // averaged together) - only ever merged when the price actually matches,
  // same as addLot() does for regular items. Sorted most-recent-first.
  function renderPointsLots() {
    const summaryEl = $('#flipr-points-summary');
    const listEl = $('#flipr-points-lots');
    if (!summaryEl || !listEl) return;

    if (!pointsLots.length) {
      summaryEl.textContent = '';
      listEl.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'flipr-empty';
      empty.textContent = 'No points purchases logged yet.';
      listEl.appendChild(empty);
      return;
    }

    const totalQty = pointsLots.reduce((sum, p) => sum + p.qty, 0);
    const totalSpent = pointsLots.reduce((sum, p) => sum + p.qty * p.unitCost, 0);
    summaryEl.textContent = `${totalQty.toLocaleString('en-US')} pts held \u00B7 ${money(totalSpent)} cost`;

    listEl.innerHTML = '';
    const sorted = [...pointsLots].sort((a, b) => b.ts - a.ts);
    for (const p of sorted) {
      const row = document.createElement('div');
      row.className = 'flipr-holding';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'flipr-holding-name';
      nameSpan.textContent = `${p.qty.toLocaleString('en-US')} pts`;

      const metaSpan = document.createElement('span');
      metaSpan.className = 'flipr-holding-meta';
      metaSpan.textContent = `${money(p.unitCost)}/pt \u00B7 ${money(p.qty * p.unitCost)}`;

      const delBtn = document.createElement('button');
      delBtn.className = 'flipr-x';
      delBtn.textContent = '\u2715';
      delBtn.title = 'Clear this price entry';
      delBtn.addEventListener('click', () => {
        clearPointsLot(p.unitCost);
        renderAll();
      });

      row.appendChild(nameSpan);
      row.appendChild(metaSpan);
      row.appendChild(delBtn);
      listEl.appendChild(row);
    }
    renderPointsCheckTierOptions();
  }

  // Points' own Sell Check, mirroring the Flip tab's - same profit-math
  // helpers, just against pointsLots instead of getDisplayEntries(), and
  // with no fee toggle (see the hint text next to it in the panel for why:
  // no confirmed Points Market sales tax the way Item Market has one).
  function renderPointsCheckTierOptions() {
    const select = $('#flipr-points-check-tier');
    if (!select) return;
    const prev = select.value;
    select.innerHTML = '';
    if (!pointsLots.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(no points purchases logged)';
      select.appendChild(opt);
      select.disabled = true;
    } else {
      select.disabled = false;
      const sorted = [...pointsLots].sort((a, b) => b.ts - a.ts);
      for (const p of sorted) {
        const opt = document.createElement('option');
        opt.value = String(Math.round(p.unitCost));
        opt.textContent = `${p.qty.toLocaleString('en-US')} pts @ ${money(p.unitCost)}`;
        select.appendChild(opt);
      }
      if (prev && [...select.options].some((o) => o.value === prev)) select.value = prev;
    }
    renderPointsCheckResult();
  }

  function findPointsLotByUnitCost(unitCostStr) {
    const target = Number(unitCostStr);
    return pointsLots.find((p) => Math.round(p.unitCost) === target) || null;
  }

  function renderPointsCheckResult() {
    const resultBox = $('#flipr-points-check-result');
    if (!resultBox) return;
    const entry = findPointsLotByUnitCost($('#flipr-points-check-tier').value);
    const price = Number($('#flipr-points-check-price').value);
    const qty = Number($('#flipr-points-check-qty').value) || 1;
    resultBox.innerHTML = '';
    if (!entry || !(price >= 0) || !$('#flipr-points-check-price').value) return;

    const profit = profitTotal(price, entry.unitCost, 0, qty);
    const isProfit = profit >= 0;

    const box = document.createElement('div');
    box.className = 'flipr-result ' + (isProfit ? 'flipr-profit' : 'flipr-loss');
    const verdict = document.createElement('div');
    verdict.className = 'flipr-verdict';
    verdict.textContent = `${isProfit ? 'PROFIT' : 'LOSS'} of ${money(Math.abs(profit))} (${pct((profit / (entry.unitCost * qty)) * 100)})`;
    const detail = document.createElement('div');
    detail.textContent = `Cost ${money(entry.unitCost)}/pt \u00B7 sell ${money(price)}/pt`;
    box.appendChild(verdict);
    box.appendChild(detail);
    resultBox.appendChild(box);
  }

  // Reuses the entries renderHoldings() already computed instead of calling
  // getDisplayEntries() again, since it's always invoked right after.
  function renderCheckItemOptions(entries) {
    const select = $('#flipr-check-item');
    const prev = select.value;
    select.innerHTML = '';
    if (!entries.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(no purchases logged)';
      select.appendChild(opt);
      select.disabled = true;
    } else {
      select.disabled = false;
      for (const entry of entries) {
        const opt = document.createElement('option');
        opt.value = entry.id;
        opt.textContent = `${entry.itemName} (\u00D7${entry.qty} @ ${money(entry.unitCost)})${formatStats(entry.stats)}`;
        select.appendChild(opt);
      }
      if (prev && [...select.options].some((o) => o.value === prev)) select.value = prev;
    }
    renderSellCheckResult();
  }

  function renderSellCheckResult() {
    const resultBox = $('#flipr-check-result');
    const entry = findEntryById($('#flipr-check-item').value);
    const price = Number($('#flipr-check-price').value);
    const qty = Number($('#flipr-check-qty').value) || 1;
    resultBox.innerHTML = '';
    if (!entry || !(price >= 0) || !$('#flipr-check-price').value) return;

    const fee = currentFee();
    const net = netProceedsPerUnit(price, fee);
    const profit = profitTotal(price, entry.unitCost, fee, qty);
    const be = breakeven(entry.unitCost, fee);
    const isProfit = profit >= 0;

    const box = document.createElement('div');
    box.className = 'flipr-result ' + (isProfit ? 'flipr-profit' : 'flipr-loss');
    const verdict = document.createElement('div');
    verdict.className = 'flipr-verdict';
    verdict.textContent = `${isProfit ? 'PROFIT' : 'LOSS'} of ${money(Math.abs(profit))} (${pct((profit / (entry.unitCost * qty)) * 100)})`;
    const detail = document.createElement('div');
    detail.textContent = `Cost ${money(entry.unitCost)}/unit \u00B7 net ${money(net)}/unit after fee \u00B7 breakeven ${money(be)}`;
    box.appendChild(verdict);
    box.appendChild(detail);
    resultBox.appendChild(box);
  }

  $('#flipr-check-item').addEventListener('change', () => {
    const entry = findEntryById($('#flipr-check-item').value);
    if (entry) $('#flipr-check-qty').value = entry.qty; // default to "sell all of this batch", still editable
    renderSellCheckResult();
  });
  $('#flipr-check-price').addEventListener('input', renderSellCheckResult);
  $('#flipr-check-qty').addEventListener('input', renderSellCheckResult);

  // Scrolling over the closed dropdown cycles the selection like a spinner,
  // so picking a lot out of a long holdings list doesn't require opening it.
  $('#flipr-check-item').addEventListener(
    'wheel',
    (e) => {
      const select = e.currentTarget;
      if (select.disabled || select.options.length < 2) return;
      e.preventDefault();
      const dir = e.deltaY > 0 ? 1 : -1;
      const next = select.selectedIndex + dir;
      if (next < 0 || next >= select.options.length) return;
      select.selectedIndex = next;
      select.dispatchEvent(new Event('change'));
    },
    { passive: false }
  );

  $('#flipr-points-check-tier').addEventListener('change', () => {
    const entry = findPointsLotByUnitCost($('#flipr-points-check-tier').value);
    if (entry) $('#flipr-points-check-qty').value = entry.qty; // default to "sell all of this batch", still editable
    renderPointsCheckResult();
  });
  $('#flipr-points-check-price').addEventListener('input', renderPointsCheckResult);
  $('#flipr-points-check-qty').addEventListener('input', renderPointsCheckResult);
  $('#flipr-points-check-tier').addEventListener(
    'wheel',
    (e) => {
      const select = e.currentTarget;
      if (select.disabled || select.options.length < 2) return;
      e.preventDefault();
      const dir = e.deltaY > 0 ? 1 : -1;
      const next = select.selectedIndex + dir;
      if (next < 0 || next >= select.options.length) return;
      select.selectedIndex = next;
      select.dispatchEvent(new Event('change'));
    },
    { passive: false }
  );

  $('#flipr-reset-btn').addEventListener('click', () => {
    if (!confirm('Clear all FLIPR purchase and sales history? This cannot be undone.')) return;
    lots = [];
    Store.del(STORAGE_KEY); // loadLots() already defaults to [] when the key is absent, same end state as saving '[]'
    resetPointsStats();
    clearSalesHistory();
    // Clear the durable dedup ledgers too, so a reset genuinely starts clean.
    // Safe because the log watermark (logState.lastTimestamp) is left intact, so
    // resetting does not re-import old purchases the ledger was suppressing.
    processedLogIds = [];
    processedLogIdSet = new Set();
    Store.del(PROCESSED_LOG_IDS_KEY);
    recentlyLoggedDomFingerprints.clear();
    Store.del(PENDING_TICKETS_KEY);
    renderAll();
  });

  // Scoped to profit history only. Unlike Reset, this deliberately does NOT touch
  // the processed-log-id ledger, so already-counted sales are not re-imported by the
  // next poll's lookback - it just zeroes the profit numbers and the recent list.
  $('#flipr-clear-sales-btn').addEventListener('click', () => {
    if (!confirm('Clear FLIPR profit history? Holdings and purchases are kept.')) return;
    clearSalesHistory();
    renderAll();
  });

  // Reflects the shared settings (fee mode, holdings lump mode, instant-detection
  // toggle) onto the visible form controls. Used by the cross-tab settings
  // listener so this tab's panel shows the truth after another tab changes one of
  // them, instead of a stale radio/checkbox (currentFee() and getDisplayEntries()
  // read those controls/values directly, so they must be updated before re-render).
  function syncSettingsControls() {
    const feeRadio = panel.querySelector(`input[name="flipr-fee"][value="${settings.feeMode}"]`);
    if (feeRadio) feeRadio.checked = true;
    const lump = $('#flipr-holdings-lump');
    if (lump) lump.checked = settings.holdingsMode === 'lump';
    const scan = $('#flipr-scan-page-text');
    if (scan) scan.checked = settings.scanPageText;
    const tax = $('#flipr-market-tax');
    if (tax) tax.checked = settings.marketTaxHelper;
    const mq = $('#flipr-market-quality');
    if (mq) mq.checked = settings.marketQuality;
    const tt = $('#flipr-track-trades');
    if (tt) tt.checked = settings.trackTrades;
    const dock = $('#flipr-launcher-dock');
    if (dock) dock.checked = settings.launcherMode === 'docked';
  }

  // Realized-profit view: a summary block (the numbers RiotFrog asked for) plus a
  // capped list of recent sales. Reads salesData only - never recomputes from lots,
  // since each sale's profit was frozen at detection time (see recordSale).
  function renderProfits() {
    const summaryEl = $('#flipr-profits-summary');
    const listEl = $('#flipr-sales-list');
    if (!summaryEl || !listEl) return;
    const t = salesData.totals;

    summaryEl.innerHTML = '';
    if (!t.salesCount) {
      const empty = document.createElement('div');
      empty.className = 'flipr-empty';
      empty.textContent = 'No sales logged yet.';
      summaryEl.appendChild(empty);
      listEl.innerHTML = '';
      return;
    }

    // Headline realized profit - the one number the feature exists for.
    const profitRow = document.createElement('div');
    profitRow.className = 'flipr-holding';
    const profitName = document.createElement('span');
    profitName.className = 'flipr-holding-name';
    profitName.textContent = 'Realized profit';
    const profitVal = document.createElement('span');
    profitVal.className = 'flipr-holding-meta';
    profitVal.style.color = t.realizedProfit >= 0 ? '#6c6' : '#e66';
    profitVal.textContent = `${t.realizedProfit >= 0 ? '+' : ''}${money(t.realizedProfit)}`;
    profitRow.appendChild(profitName);
    profitRow.appendChild(profitVal);
    summaryEl.appendChild(profitRow);

    // Supporting context lines. `since` uses firstTs so it reads as a real window.
    const since = t.firstTs ? new Date(t.firstTs).toLocaleDateString() : '';
    const lines = [
      `${money(t.matchedProceeds)} sold with known cost across ${t.matchedQty.toLocaleString('en-US')} item(s)`,
    ];
    if (t.untrackedQty > 0) {
      lines.push(`${money(t.untrackedProceeds)} from ${t.untrackedQty.toLocaleString('en-US')} item(s) with no recorded cost`);
    }
    if (t.feePaid > 0) {
      lines.push(`${money(t.feePaid)} paid in Item Market tax (bazaar selling avoids this)`);
    }
    lines.push(`${t.salesCount.toLocaleString('en-US')} sale(s)${since ? ` since ${since}` : ''}`);
    for (const text of lines) {
      const div = document.createElement('div');
      div.className = 'flipr-holding-meta';
      div.textContent = text;
      summaryEl.appendChild(div);
    }

    // Recent sales, newest first.
    listEl.innerHTML = '';
    // Draw only the newest few: the totals above already account for every sale, and
    // rendering hundreds of rows was the main cause of the panel getting slow.
    const sorted = [...salesData.recent].sort((a, b) => b.ts - a.ts).slice(0, SALES_ROWS_SHOWN);
    for (const rec of sorted) {
      const row = document.createElement('div');
      row.className = 'flipr-holding';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'flipr-holding-name';

      const metaSpan = document.createElement('span');
      metaSpan.className = 'flipr-holding-meta';
      let metaText;
      if (rec.matchedQty > 0) {
        const sign = rec.profit >= 0 ? '+' : '';
        metaSpan.style.color = rec.profit >= 0 ? '#6c6' : '#e66';
        const partial = rec.matchedQty < rec.qty ? ` (${rec.matchedQty}/${rec.qty})` : '';
        metaText = `${sign}${money(rec.profit)}${partial}${formatStats(rec.stats)}`;
      } else {
        metaText = `${money(rec.proceeds)} \u00B7 no basis`;
      }
      metaSpan.textContent = metaText;

      nameSpan.textContent = `${rec.itemName} \u00D7${rec.qty}`;
      // Full untruncated detail on hover (same idea as renderHoldings): the name
      // column clips long names, so the title carries name, qty and the profit line.
      nameSpan.title = `${rec.itemName} \u00D7${rec.qty} \u00B7 ${metaText}`;

      row.appendChild(nameSpan);
      row.appendChild(metaSpan);
      listEl.appendChild(row);
    }
  }

  // Renders ONLY the tab currently on screen, plus the always-visible status line.
  // Rebuilding every tab on every purchase/sale was pure waste - the Profits list can
  // be hundreds of rows, and rebuilding it while you are looking at the Flip tab is
  // work nobody sees. Switching tabs renders the newly shown one (see showFliprTab),
  // so what you look at is always current.
  function renderAll() {
    const tab = settings.activeTab;
    if (tab === 'main') renderHoldings();
    else if (tab === 'profits') renderProfits();
    else if (tab === 'points') renderPointsLots();
    else {
      // Settings tab: nothing data-driven is on screen, but the Sell Check dropdown
      // on the Flip tab must stay in sync for when you switch back to it.
      renderCheckItemOptions(getDisplayEntries());
    }
    refreshStatusLine();
  }
  migrateLegacyPointsLots();
  renderAll();

  ////////////////////////////////////////////////////////////////////////////
  ////  TOAST (auto-log confirmation with undo)
  ////////////////////////////////////////////////////////////////////////////

  // Cut down from the original 10s - a purchase toast fires constantly while
  // actively flipping, and previously the only way to get rid of one early
  // was to wait out the full timer (or click Undo, which isn't what you want
  // most of the time). Now paired with click-to-dismiss below, so this is
  // just the fallback for whenever it isn't clicked away first.
  const TOAST_AUTO_DISMISS_MS = 5000;

  function showToast(text, onUndo) {
    const toast = document.createElement('div');
    toast.className = 'flipr-toast';
    const msg = document.createElement('div');
    msg.textContent = text;
    toast.appendChild(msg);
    if (onUndo) {
      const undoBtn = document.createElement('button');
      undoBtn.className = 'flipr-btn';
      undoBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // Undo already dismisses the toast itself - don't also trigger the click-to-dismiss below
        onUndo();
        toast.remove();
        renderAll();
      });
      undoBtn.textContent = 'Undo';
      toast.appendChild(undoBtn);
    }
    // Clicking anywhere else on the toast dismisses it immediately, instead
    // of only ever going away via Undo or the auto-dismiss timer.
    const closeMark = document.createElement('span');
    closeMark.className = 'flipr-toast-close';
    closeMark.textContent = '\u00D7';
    closeMark.title = 'Dismiss';
    toast.appendChild(closeMark);
    toast.addEventListener('click', () => toast.remove());
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), TOAST_AUTO_DISMISS_MS);
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  AUTO-DETECT: purchases
  ////////////////////////////////////////////////////////////////////////////
  // Two detectors feed the same shared logger, so either one catching a
  // purchase is enough:
  // 1) Instant DOM-text read of Torn's own "You bought..." confirmation
  //    (live-verified exact wording) - fires the moment the confirmation
  //    appears on the page, no waiting.
  // 2) API log poll (needs a key entered in Settings, below) - polls the
  //    user's own /v2/user/log every 10s for "buy" entries under the
  //    "Item market"/"Bazaars" categories, reading each item's real cost
  //    straight from Torn. This is the reliable fallback if the DOM text
  //    ever changes, or a purchase happens somewhere the text scan misses.
  //    Item names are resolved from a cached id->name catalog fetched once
  //    a day from Torn's public item list.
  //
  // No key entered -> only the instant DOM-text path runs; the API poller
  // simply never starts. Every auto-logged purchase shows a toast with a
  // 10-second Undo, so a wrong match is cheap to fix even with no manual
  // entry form to fall back on.

  // Dedupe model (rewritten in 1.2.0.37). The instant on-page (dom-text) scan is
  // the PRIMARY writer - it stores the moment a purchase confirmation appears, so
  // Holdings update instantly, and it works even for the many purchases the API
  // poll never fetches (a busy account's log is flooded with non-purchase entries
  // that race the poll watermark past a laggy purchase entry). The API poll is a
  // reliable-but-slow fallback for anything the on-page scan misses.
  //
  // The two paths reconcile through bidirectional tickets so the SAME real
  // purchase is stored exactly once no matter which path sees it first:
  //   - When the on-page scan stores a purchase it pushes a 'dom' ticket. When the
  //     API poll later processes that same purchase it consumes the 'dom' ticket
  //     and skips (does not store a duplicate).
  //   - When the API poll stores a purchase the on-page scan never caught, it
  //     pushes an 'api' ticket, which a later on-page sighting consumes and skips.
  // The 1.2.0.31-.35 version only had the first direction AND expired tickets after
  // 20s - shorter than Torn's points-log publish lag (~26s observed), so the late
  // API poll missed the ticket and stored a second copy (reported: points buys 2x).
  // TICKET_TTL_MS below is now well past that lag, and the second direction covers
  // the rarer "API stored first" case. Same-source repeats are handled separately:
  // dom re-render/echo bursts by recentlyLoggedDomFingerprints below, API re-polls
  // by the processedLogIds ledger (see processLogEntries).
  const TICKET_TTL_MS = 150000; // 2.5 min - must comfortably exceed Torn's log publish lag

  function pruneTicketSide(side) {
    const now = Date.now();
    for (const k of Object.keys(side)) {
      const kept = side[k].filter((exp) => exp > now);
      if (kept.length) side[k] = kept;
      else delete side[k];
    }
  }

  // Push one ticket of `kind` ('dom' | 'api') for this fingerprint.
  function pushTicket(kind, fingerprint) {
    const t = loadTickets();
    pruneTicketSide(t.dom);
    pruneTicketSide(t.api);
    const side = t[kind];
    (side[fingerprint] = side[fingerprint] || []).push(Date.now() + TICKET_TTL_MS);
    saveTickets(t);
  }

  // Consume one ticket of `kind` for this fingerprint if any exist. Returns true
  // when it consumed one - meaning the OTHER path already stored this exact
  // purchase, so the caller must NOT store it again.
  function consumeTicket(kind, fingerprint) {
    const t = loadTickets();
    pruneTicketSide(t.dom);
    pruneTicketSide(t.api);
    const arr = t[kind][fingerprint];
    if (!arr || !arr.length) { saveTickets(t); return false; }
    arr.shift();
    if (!arr.length) delete t[kind][fingerprint];
    saveTickets(t);
    return true;
  }

  // One real purchase frequently produces SEVERAL "you bought..." sightings
  // on the page, in DIFFERENT wordings, from different DOM locations and/or
  // React re-renders - an instant inline swap, a separately-worded activity
  // echo, the same line re-rendered a beat later, etc. An earlier attempt
  // tried to model this as a strict "inline fires first, echoes follow"
  // sequence and consume one echo per inline; that assumption broke on the
  // Points Market, where the confirmation only ever matched the
  // activity-log wording (no inline), fired THREE times with nothing to
  // consume against, and tripled every points purchase (reported: 30x
  // points logged as 90x, i.e. exactly 3x, every time).
  //
  // This replaces that fragile dance with a simple, wording-agnostic rule:
  // once a given item/qty/price has been logged from the page, any further
  // dom-text sighting of that SAME fingerprint within a short window is
  // treated as a re-render/echo of the same purchase and dropped. It
  // doesn't matter how the duplicate is worded or where in the DOM it came
  // from. A genuine rapid rebuy of the exact same item at the exact same
  // unit price within the window is the one thing this can wrongly drop from
  // the instant path - but the API poll (authoritative, keyed off Torn's own
  // unique log-entry IDs) still records it a few seconds later for anyone
  // with an API key set, so nothing is actually lost there. Different price,
  // different qty, or a different item is a different fingerprint and is
  // never affected.
  const recentlyLoggedDomFingerprints = new Map(); // fingerprint -> expiry
  const DOM_FINGERPRINT_DEDUPE_MS = 4000;

  // In-memory only, on purpose: this window just collapses the burst of repeat
  // "you bought" sightings a single purchase fires within a few seconds (React
  // re-renders, differently-worded echoes) into one stored lot + one dom ticket. A
  // page reload clears the transient on-page confirmation too, so there is nothing
  // for it to guard against post-reload; the durable cross-reload/cross-tab
  // guarantee is the persisted tickets + processedLogIds.
  function pruneRecentDomFingerprints() {
    const now = Date.now();
    for (const [key, expiry] of recentlyLoggedDomFingerprints) {
      if (expiry <= now) recentlyLoggedDomFingerprints.delete(key);
    }
  }

  function logPurchaseIfNew(itemName, qty, unitCost, source, stats, uid) {
    itemName = String(itemName || '').trim();
    qty = Number(qty);
    unitCost = Number(unitCost);
    if (!itemName || !(qty > 0) || !(unitCost >= 0)) return;

    const fingerprint = `${normalize(itemName)}|${qty}|${Math.round(qty * unitCost)}`;
    const isApiPollFallback = String(source || '').startsWith('api-log');

    if (isApiPollFallback) {
      // API poll (idempotent per log-entry id upstream in processLogEntries).
      // Reconcile against the instant on-page scan: if the page already stored this
      // purchase, consume its dom ticket and skip; otherwise store, and leave an
      // api ticket so a later on-page sighting of the same purchase defers to us.
      if (consumeTicket('dom', fingerprint)) {
        log('duplicate suppressed (API poll re-saw a purchase the page already stored)', fingerprint);
        // The DOM scan that stored it had no uid; the API does. Back-fill it so a
        // future sale can still match this copy exactly (see annotateLotUid).
        annotateLotUid(itemName, unitCost, uid);
        return;
      }
      pushTicket('api', fingerprint);
    } else {
      // Instant on-page scan - the primary, instant writer. First collapse the
      // burst of repeat sightings one real purchase fires (React re-renders, echoes)
      // so only ONE lot and ONE dom ticket result.
      pruneRecentDomFingerprints();
      const dupExpiry = recentlyLoggedDomFingerprints.get(fingerprint);
      if (dupExpiry !== undefined && dupExpiry > Date.now()) {
        log('duplicate suppressed (same purchase re-rendered on page within echo window)', fingerprint);
        return;
      }
      recentlyLoggedDomFingerprints.set(fingerprint, Date.now() + DOM_FINGERPRINT_DEDUPE_MS);
      // Reconcile against the API poll: if the API already stored this purchase
      // (rare - it usually lags the page), consume its api ticket and skip;
      // otherwise store instantly and leave a dom ticket so the API poll defers to
      // us when it finally sees the entry, even a couple of minutes later.
      if (consumeTicket('api', fingerprint)) {
        log('duplicate suppressed (page re-saw a purchase the API poll already stored)', fingerprint);
        return;
      }
      pushTicket('dom', fingerprint);
    }

    // Points get spent, not resold like flip inventory - tracked as a
    // lifetime spend total instead of a Holdings row (see POINTS TRACKER
    // section above).
    if (normalize(itemName) === 'points') {
      addPointsPurchase(qty, unitCost);
      log('auto-logged points purchase via', source, qty, unitCost);
      renderAll();
      showToast(`FLIPR logged: ${qty.toLocaleString('en-US')} points @ ${money(unitCost)}`, () => undoPointsPurchase(qty, unitCost));
      return;
    }

    // Weapons/armor show their stats only on the listing card, never in the
    // confirmation - so if none came through with this purchase, use what was
    // captured when the card's Buy was clicked (see captureWeaponStatsFromClick).
    stats = attachPendingWeaponStats(itemName, stats);
    const lotEntry = addLot(itemName, qty, unitCost, source, stats, uid);
    if (lotEntry) {
      log('auto-logged purchase via', source, lotEntry);
      renderAll();
      showToast(`FLIPR logged: ${qty}\u00D7 ${itemName} @ ${money(unitCost)}${formatStats(lotEntry.stats)}`, () => undoLotQty(lotEntry.id, qty));
    }
  }

  // Instant path: Torn shows a "You bought..." confirmation right on the
  // page the moment a purchase completes, but the exact wording depends on
  // where the purchase happened - live-verified against real confirmations
  // (Activity Log entries), all ending "at $X each for a total of $Y":
  //   Points market: "You bought 30x points from Seller on the points
  //     market at $X each for a total of $Y"
  //   Bazaar:        "You bought a Bottle of Beer on Seller's bazaar at $X
  //     each for a total of $Y" (or "some Xanax ...", or "Nx ..." for
  //     qty>1 - the qty word depends on the item, not the market)
  //   Item market:   "You bought some Kerosene on the item market from
  //     Seller at $X each for a total of $Y" (or "Nx ..." for qty>1)
  // An earlier version used one loose pattern for all three, assuming a
  // single "You bought Nx Item from Seller for a total of $X" shape - that
  // was wrong on every count (qty word varies, "on the item market"/"'s
  // bazaar" sits between the item and the seller, points reverses the
  // seller/market order) and it was silently swallowing "on the item
  // market" into the item name instead of matching at all (confirmed via a
  // debug export showing "Bottle of Beer on the item market" as a literal
  // logged item name). A later version assumed bazaar always uses "a/an"
  // and item market always uses "some" - also wrong, since a real bazaar
  // confirmation ("You bought some Xanax on Brafy's bazaar...") showed
  // "some" is a per-item wording choice, not tied to the market. Both
  // patterns now accept "a"/"an"/"some"/"Nx" for the qty word. A further
  // real confirmation ("You bought a pair of Combat Boots on Melchizedek7's
  // bazaar...") showed a fourth qty wording for naturally-paired gear
  // (boots, gloves) - "a pair of" needs to be checked before the bare "a"
  // alternative below, or the lazy item-name capture would swallow "pair
  // of" into the name the same way "on the item market" once was. Matched
  // as three separate patterns instead of one catch-all so each only
  // matches its own wording. Unit cost is read directly from "$X each"
  // rather than derived from total/qty, since that's the exact figure Torn
  // shows.
  // Every money figure below is matched STRICTLY - proper thousands grouping
  // (\d{1,3}(?:,\d{3})*) and no digit/comma allowed right after. A loose [\d,]+
  // was the source of phantom duplicate lots at ~10x the real price (confirmed
  // via debug export): the DOM sometimes re-renders the confirmation banner
  // inside a WIDER node whose textContent glues the money to whatever digits
  // come next on the page ("total of $13,880" + a neighboring "1" ->
  // "$13,8801"), and the loose pattern swallowed the extra digit, producing a
  // "new" purchase at a garbage price (2x Diesel @ $69,400.50 from a real
  // $6,940 buy). Torn always renders money with proper thousands separators, so
  // a malformed group like "13,8801" can only be concatenation - the strict
  // pattern refuses to match it at all, the corrupted sighting falls through to
  // recentUnmatchedPurchaseTexts (diagnosable), and no lot is created. The real
  // purchase was already logged from the clean text, and if it ever isn't, the
  // API lookback stores it from the log instead.
  const PURCHASE_CONFIRMATION_POINTS_RE = /you bought\s+([\d,]+)\s*x\s+points\s+from\s+.+?\s+on the points market at\s*\$\s*(\d{1,3}(?:,\d{3})*)(?![\d,])\s*each/i;
  const PURCHASE_CONFIRMATION_BAZAAR_RE = /you bought\s+(?:a pair of|an?|some|([\d,]+)\s*x)\s+(.+?)\s+on\s+.+?'s bazaar at\s*\$\s*(\d{1,3}(?:,\d{3})*)(?![\d,])\s*each/i;
  const PURCHASE_CONFIRMATION_MARKET_RE = /you bought\s+(?:a pair of|an?|some|([\d,]+)\s*x)\s+(.+?)\s+on the item market from\s+.+?\s+at\s*\$\s*(\d{1,3}(?:,\d{3})*)(?![\d,])\s*each/i;
  // Confirmed via live screenshots: buying directly from the Points Market
  // page itself shows an inline confirmation that replaces the listing row
  // you clicked buy on - worded completely differently from the Activity
  // Log's "...from Seller on the points market..." phrasing above (no
  // seller name, no "x", "listed at" instead of "on the points market at"):
  // "You bought 60 points listed at $31,200 each for a total of
  // $1,872,000." This is the fast, on-page path (matches bazaar/item
  // market's speed) - checked first since it's the one that actually
  // fires the instant a purchase completes; the Activity Log wording above
  // is a secondary match for whenever that text shows up instead (e.g. the
  // header's history dropdown).
  const PURCHASE_CONFIRMATION_POINTS_INLINE_RE = /you bought\s+([\d,]+)\s+points?\s+listed at\s*\$\s*(\d{1,3}(?:,\d{3})*)(?![\d,])\s*each\s+for a total of\s*\$\s*\d{1,3}(?:,\d{3})*(?![\d,])/i;
  // Same discovery, for Bazaar this time: buying directly from a bazaar's
  // own page (confirmed via screenshot: torn.com/bazaar.php) shows an
  // inline confirmation completely different from the Activity Log wording
  // above - "from Seller's bazaar" instead of "on Seller's bazaar", and no
  // "at $X each" segment at all, just a total: "You bought 1 x Flexible
  // Body Armor from GhostR1der's bazaar for a total of $9,706,008." This is
  // why real bazaar purchases made this way were never being caught - the
  // Activity Log pattern requires "at $X each", which this text doesn't
  // have. Unit cost has to be derived from total/qty here since no
  // per-unit figure is shown. Checked early, same as the points inline
  // pattern, since this is the actual fast on-page path.
  const PURCHASE_CONFIRMATION_BAZAAR_INLINE_RE = /you bought\s+(?:a pair of|an?|some|([\d,]+)\s*x)\s+(.+?)\s+from\s+.+?'s bazaar for a total of\s*\$\s*(\d{1,3}(?:,\d{3})*)(?![\d,])/i;
  // A fourth wording, confirmed via a debug export's recentUnmatchedPurchaseTexts
  // for a real Baseball Bat purchase: "You bought 1x Baseball Bat from
  // Big_Bumple for a total of $135" - drops BOTH the "'s bazaar" phrase the
  // inline pattern above requires AND the "at $X each" segment the
  // non-inline patterns below require, so none of the existing patterns
  // could match it at all (this is actually the original v1.0 wording per
  // CHANGELOG.md, lost when the more specific patterns above were added).
  // Left unhandled, any purchase whose only on-page confirmation renders
  // this way (melee weapons were reported affected) silently falls through
  // to unmatched and is never logged via dom-text. Checked LAST, only after
  // every more specific pattern below has already failed - it's deliberately
  // loose ("from Seller for a total of $Y" with no "at each"/"'s bazaar"/
  // "item market" anchor), and a real Item Market confirmation's full
  // sentence ("...on the item market from Seller at $X each for a total of
  // $Y") would otherwise let this swallow "on the item market" into the item
  // name the same way that exact mistake happened once before (see the big
  // comment above PURCHASE_CONFIRMATION_POINTS_RE).
  const PURCHASE_CONFIRMATION_GENERIC_INLINE_RE = /you bought\s+(?:a pair of|an?|some|([\d,]+)\s*x)\s+(.+?)\s+from\s+.+?\s+for a total of\s*\$\s*(\d{1,3}(?:,\d{3})*)(?![\d,])/i;
  // Shops have no seller, so there is no "from X" to anchor on. Confirmed live on the
  // Switzerland travel page: "You bought 28x Chamois Plushie for a total of $11,200".
  // Deliberately requires the "Nx " quantity form rather than allowing "a/an/some": with
  // no seller clause, a looser pattern would let the item name run on and swallow
  // whatever text follows, which is exactly how "on the item market" once ended up
  // inside an item name (see the comment above PURCHASE_CONFIRMATION_POINTS_RE).
  // Only the travel shops and city shops. Used to gate the seller-less purchase pattern,
  // which must never run anywhere a seller name could appear in the sentence.
  function isShopPage() {
    const path = location.pathname;
    if (/\/shops\.php/i.test(path)) return true;
    return /\/page\.php/i.test(path) && /sid=travel/i.test(location.search);
  }

  const PURCHASE_CONFIRMATION_SHOP_RE = /you bought\s+([\d,]+)\s*x\s+(.+?)\s+for a total of\s*\$\s*(\d{1,3}(?:,\d{3})*)(?![\d,])/i;
  // A single mutation can touch a whole row/section containing far more
  // text than just the confirmation sentence (e.g. a bazaar grid row update
  // that also carries neighboring items' names/prices/stock counts in the
  // same textContent), easily pushing the combined length past the normal
  // single-line cap even though the actual confirmation buried inside it is
  // short. Rather than reject the whole blob outright by length, each
  // "you bought ... total of $X" occurrence is extracted and re-tested on
  // its own instead.
  // The total is matched STRICTLY (proper thousands grouping, no trailing digit),
  // same as every other money figure and for the same reason - see the big comment
  // above PURCHASE_CONFIRMATION_POINTS_RE. This is load-bearing for dedup, not just
  // tidiness: the extracted line is what the "already processed this confirmation"
  // guard (seenPurchaseTexts) keys on. If the banner re-renders with a digit glued
  // onto the total ("total of $283,620" + a neighboring "1" -> "$283,6201"), a loose
  // total made the extracted text DIFFERENT each time, so the guard missed it and
  // re-logged the purchase - and since the item/qty/unit-price it actually stores
  // come from the clean "at $X each" earlier in the sentence, the re-log merged into
  // the existing lot and silently inflated its quantity (reported: a real 5x buy
  // creeping to 10x+ over time, at the correct price). With a strict total, a glued
  // total either matches identically (so the guard catches the re-render) or does
  // not match at all (so the corrupted sighting is dropped) - either way, no re-log.
  const PURCHASE_LINE_EXTRACT_RE = /you bought[^]*?total of\s*\$\s*\d{1,3}(?:,\d{3})*(?![\d,])/gi;

  // Diagnostic capture mirroring lastPollDebug.skipped for the API-log
  // path: any "you bought" text that reached here without matching a
  // single known pattern (or that got rejected for length with nothing
  // extractable) is kept, short and capped, so a miss can be root-caused
  // from a debug export instead of needing another screenshot every time
  // the wording turns out to be yet another undocumented variant - which
  // it has been, every single time so far.
  const recentUnmatchedPurchaseTexts = [];
  const UNMATCHED_PURCHASE_TEXT_LIMIT = 8;
  function recordUnmatchedPurchaseText(note) {
    recentUnmatchedPurchaseTexts.unshift(note);
    if (recentUnmatchedPurchaseTexts.length > UNMATCHED_PURCHASE_TEXT_LIMIT) {
      recentUnmatchedPurchaseTexts.length = UNMATCHED_PURCHASE_TEXT_LIMIT;
    }
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  WEAPON STATS (best-effort)
  ////////////////////////////////////////////////////////////////////////////
  // Melee weapons (and some other gear) roll individual Damage/Accuracy/
  // Quality stats per copy, shown between the item name and price - two
  // "Baseball Bat"s at the same price are NOT the same weapon. Confirmed via
  // a real screenshot of an item's expanded detail panel (opened by
  // clicking/hovering a listing card): "Damage: [icon]17.05", "Accuracy:
  // [icon]50.38", "Quality: 14.29%" - real labeled text DOES exist, but only
  // in this expanded panel, NOT on the compact grid cards themselves (those
  // only ever show a bare icon+number with no label word at all, confirmed
  // via a separate screenshot - a purely text-label-based read could never
  // have matched that view no matter how the regex was tuned). Torn's
  // purchase confirmation text never includes these figures either way, so
  // unlike everything else logged here this can't come from regex-parsing
  // the confirmation sentence itself.
  //
  // There's likely an icon glyph (not the literal characters "Damage:")
  // sitting between the label and the number in real markup - the number
  // gap below is deliberately generous (any short run of non-digit
  // characters) rather than requiring an exact ":"/whitespace shape, so an
  // icon glyph or extra markup-derived whitespace in between doesn't break
  // the match.
  //
  // The decimal point in the captured number is REQUIRED, not optional -
  // confirmed via a debug export: the ancestor walk below can reach as far
  // up as the page's own "Damage 0 - 100 / Accuracy 0 - 100" filter-slider
  // labels (a completely different piece of UI - the search range, not any
  // item's actual stats), and matched the slider's bare integer minimum "0"
  // as if it were the item's Damage/Accuracy, logging a bogus "Dmg 0.00/Acc
  // 0.00". Every real per-item stat seen so far always renders with two
  // decimal places (17.05, 50.38, 39.00, 14.29%), while the filter sliders
  // only ever show bare integers (0, 100) - requiring a decimal point is
  // enough to tell them apart without needing to know the real DOM structure
  // at all.
  const WEAPON_STAT_DAMAGE_RE = /damage[^0-9]{0,8}(\d+\.\d+)/i;
  const WEAPON_STAT_ACCURACY_RE = /accuracy[^0-9]{0,8}(\d+\.\d+)/i;
  // Quality and Bonus are intentionally NOT captured (user request - only
  // Damage/Accuracy identify a weapon copy), so their patterns were removed.
  const WEAPON_STAT_SEARCH_MAX_DEPTH = 10;
  // How far past an occurrence of the item's own name to look for a
  // Damage/Accuracy pair, for the page-wide fallback below.
  const STATS_PAGE_WIDE_WINDOW_CHARS = 500;

  const recentStatsCaptureAttempts = [];
  const STATS_CAPTURE_ATTEMPT_LIMIT = 8;
  const STATS_SNIPPET_MAX_CHARS = 400;
  function recordStatsCaptureAttempt(itemName, found, via, widestText) {
    const cleaned = String(widestText || '').replace(/\s+/g, ' ').trim();
    recentStatsCaptureAttempts.unshift({
      itemName,
      found,
      via, // 'ancestor' (found via findWeaponStatsNear), 'page-wide' (found via findWeaponStatsPageWide), or 'none'
      widestTextLength: cleaned.length, // lets a miss be told apart from "search never reached anything wider than the confirmation itself"
      snippet: cleaned.slice(0, STATS_SNIPPET_MAX_CHARS),
    });
    if (recentStatsCaptureAttempts.length > STATS_CAPTURE_ATTEMPT_LIMIT) {
      recentStatsCaptureAttempts.length = STATS_CAPTURE_ATTEMPT_LIMIT;
    }
  }

  // Reference Damage/Accuracy RANGES for every weapon in the game (melee,
  // primary, secondary) - used ONLY to sanity-check a captured stat reading
  // against what's actually possible for that specific weapon, catching a
  // false positive the same way the "Dmg 0.00/Acc 0.00" filter-slider
  // mismatch was caught once already (any other unforeseen false match
  // would also very likely land outside the real weapon's actual range).
  // NEVER used to invent or estimate a stat when nothing was captured - a
  // reading is only ever recorded when read directly off the page for the
  // specific copy that was actually bought (player instruction). China Lake
  // and SMAW Launcher are omitted (unlisted stats in the source data) - an
  // item with no entry here simply skips validation, same as before this
  // table existed. Source: player-submitted reference data (weapon name,
  // Damage min, Damage max, Accuracy min, Accuracy max).
  const WEAPON_STAT_RANGE_TABLE = `
9mm uzi|65|70|43|48
ak-47|56|61|52|57
ak74u|46|51|41|46
armalite m-15a4|68|73|57|62
benelli m1 tactical|39|44|65|70
benelli m4 super|59|64|55|60
bushmaster carbon 15|50|55|57|62
dual bushmasters|76|81|47|52
dual mp5s|78|83|46|51
dual p90s|77|82|45|50
dual tmps|79|84|40|45
dual uzis|80|85|36|41
egg propelled launcher|64|69|24|29
enfield sa-80|63|68|55|60
gold plated ak-47|75|80|62|67
heckler & koch sl8|60|65|46|51
ithaca 37|49|54|62|67
jackhammer|69|74|52|57
m16 a2 rifle|61|66|47|52
m249 saw|67|72|41|46
m4a1 colt carbine|55|60|47|52
mag 7|56|61|62|67
minigun|72|77|28|33
mp 40|37|42|41|46
mp5 navy|45|50|51|56
negev ng-5|69|74|35|40
neutrilux 2000|59|64|25|30
nock gun|95|100|45|50
p90|48|53|51|56
pkm|76|79|49|51
prototype|68|73|36|41
rheinmetall mg 3|66|71|36|41
sawed-off shotgun|41|46|63|68
sig 550|62|67|50|55
sig 552|69|74|50|55
sks carbine|46|51|47|52
snow cannon|52|57|24|29
steyr aug|64|69|45|50
stoner 96|69|74|49|54
tavor tar-21|65|70|52|57
thompson|39|44|43|48
vektor cr-21|50|55|48|53
xm8 rifle|50|55|56|61
type 98 anti tank|78|83|25|30
beretta 92fs|48|53|51|56
beretta m9|36|41|54|59
beretta pico|54|59|53|58
blowgun|15|20|39|44
blunderbuss|46|51|24|29
bt mp9|61|66|55|60
cobra derringer|61|66|53|58
crossbow|35|40|63|68
desert eagle|59|64|36|41
dual 92g berettas|64|69|30|35
fiveseven|52|57|49|54
flamethrower|67|72|39|44
flare gun|18|23|22|27
glock 17|28|33|53|58
harpoon|47|52|63|68
homemade pocket shotgun|63|68|60|65
lorcin 380|27|32|41|46
luger|35|40|48|53
magnum|55|60|38|43
milkor mgl|74|79|39|44
mp5k|42|47|52|57
pink mac-10|74|79|45|50
qsz-92|62|67|53|58
raven mp25|29|34|52|57
rpg launcher|77|82|39|44
ruger 57|32|37|56|61
s&w m29|47|52|52|57
s&w revolver|42|47|54|59
skorpion|40|45|54|59
slingshot|14|18|54|59
springfield 1911|33|38|57|62
taser|1|5|54|59
taurus|30|35|57|62
tmp|38|43|45|50
tranquilizer gun|15|20|45|50
usp|44|49|58|63
axe|34|39|52|57
baseball bat|16|21|57|62
blood spattered sickle|36|41|55|60
bone saw|54|58|52|56
bo staff|13|18|55|60
bread knife|41|43|65|70
bug swatter|5|10|59|64
butterfly knife|24|29|55|60
cattle prod|1|6|59|64
chain whip|31|36|52|57
chainsaw|61|66|23|28
claymore sword|57|62|49|54
cleaver|51|56|56|61
cricket bat|18|23|42|47
crowbar|20|25|52|57
dagger|28|33|60|65
devil's pitchfork|61|66|41|46
diamond bladed knife|60|65|62|67
diamond icicle|45|50|48|53
dual axes|70|75|54|59
dual hammers|70|75|54|59
dual samurai swords|70|75|54|59
dual scimitars|70|75|54|59
duke's hammer|18|18|55|55
fine chisel|16|21|50|55
flail|71|76|28|33
frying pan|19|24|43|48
golden broomstick|60|65|48|53
golf club|29|32|59|63
guandao|63|68|35|40
hammer|17|22|55|60
handbag|67|72|63|68
ice pick|51|56|60|65
ivory walking cane|53|58|57|62
kama|35|40|55|60
katana|52|57|55|60
kitchen knife|25|30|55|60
knuckle dusters|11|16|62|67
kodachi|62|67|56|61
lead pipe|26|31|33|38
leather bullwhip|27|32|52|57
macana|57|62|65|70
madball|60|65|45|50
meat hook|62|67|39|44
metal nunchakus|61|66|60|65
naval cutlass|64|69|52|57
ninja claws|39|44|51|56
pair of high heels|40|45|63|68
pair of ice skates|43|48|45|50
pen knife|21|26|45|50
penelope|17|17|57|57
petrified humerus|48|53|48|53
pillow|1|5.3|63|68
plastic sword|5|10|29|34
poison umbrella|35|40|49|54
riding crop|21|26|54|59
rusty sword|22|27|15|20
sai|29|34|52|57
samurai sword|58|63|52|57
scalpel|56|61|47|52
scimitar|40|45|58|63
sledgehammer|58|63|50|55
spear|38|43|48|53
swiss army knife|23|28|52|57
twin tiger hooks|50|55|53|58
wand of destruction|60|65|26|31
wooden nunchaku|22|27|59|64
wushu double axes|53|58|51|56
yasukuni sword|65|70|49|54
`;
  const WEAPON_STAT_RANGES = {};
  for (const line of WEAPON_STAT_RANGE_TABLE.trim().split('\n')) {
    const [name, dmgMin, dmgMax, accMin, accMax] = line.split('|');
    WEAPON_STAT_RANGES[name] = [Number(dmgMin), Number(dmgMax), Number(accMin), Number(accMax)];
  }

  // Buffer beyond the exact listed range. A tight 0.5 was tried first and
  // rejected real data: a SIG 552's actual captured Damage readings (74.91
  // and 74.34, both from real screenshots) sit slightly ABOVE this table's
  // listed max of 74 - likely a small imprecision in the reference table
  // itself, or an effect of the weapon's own Bonus roll, either way real
  // and not something this check should reject. The whole point of this
  // validation is to catch GROSS errors (a false match landing tens of
  // points off, like the original 0.00 on a 16-21 range item), not to be a
  // precise game-data validator - a generous buffer still catches that
  // class of error while tolerating small real-world variance like this.
  const WEAPON_STAT_RANGE_TOLERANCE = 5;
  function validateStatsAgainstRange(itemName, stats) {
    if (!stats) return null;
    const range = WEAPON_STAT_RANGES[normalize(itemName)];
    if (!range) return stats; // no reference range for this item - trust the capture as-is
    const [dmgMin, dmgMax, accMin, accMax] = range;
    if (stats.dmg != null && (stats.dmg < dmgMin - WEAPON_STAT_RANGE_TOLERANCE || stats.dmg > dmgMax + WEAPON_STAT_RANGE_TOLERANCE)) return null;
    if (stats.acc != null && (stats.acc < accMin - WEAPON_STAT_RANGE_TOLERANCE || stats.acc > accMax + WEAPON_STAT_RANGE_TOLERANCE)) return null;
    return stats;
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  WEAPON STATS (click-time capture from the listing card)
  ////////////////////////////////////////////////////////////////////////////
  // The Item Market GRID shows a weapon's Damage/Accuracy only as a bare icon +
  // number (a damage glyph then e.g. "20.20", an accuracy glyph then "52.00"), with
  // NO "Damage:"/"Accuracy:" label - so the label-based text capture below
  // (findWeaponStatsNear / findWeaponStatsPageWide) can never read them - and the
  // specific listing vanishes the instant it is bought, so there is nothing left to
  // read afterward either. The reliable source is the card the moment its Buy
  // control is clicked: this reads each stat off that exact card by its own
  // aria-label ("16.83 damage points" / "51.46 accuracy points"), identifies the
  // weapon by name, validates against the range table, and stashes it for the
  // purchase confirmation that follows a beat later. Only ever the stats of the copy
  // actually bought - never estimated.

  // Weapon names longest-first, so a card's text matches the most specific name
  // (e.g. "dual hammers" wins over "hammer", which is a substring of it).
  const WEAPON_NAMES_BY_LEN = Object.keys(WEAPON_STAT_RANGES).sort((a, b) => b.length - a.length);
  function weaponNameInText(text) {
    const hay = normalize(text);
    for (const name of WEAPON_NAMES_BY_LEN) {
      if (hay.includes(name)) return name;
    }
    return null;
  }

  const WEAPON_CLICK_CAPTURE_TTL_MS = 30000; // click -> confirmation is a second or two
  let pendingWeaponStats = null; // { itemName, stats, ts }

  // Reads a card's stats off their per-value aria-labels ("16.83 damage points" /
  // "51.46 accuracy points" for weapons, "20.21 armor points" for armor), scoped to
  // `node`. Each value is its own leaf, so this is immune to the merged-textContent
  // trap (adjacent stat spans have no separator, so textContent glues them:
  // "16.83"+"51.46" -> "16.8351.46", which /\d+\.\d+/ misreads as one value 16.8351)
  // AND the label names the stat, so we never assume a stat by DOM position.
  function readStatsFromAriaLabels(node) {
    if (!node || !node.querySelectorAll) return null;
    let dmg = null, acc = null, armor = null;
    for (const el of node.querySelectorAll('[aria-label]')) {
      const m = (el.getAttribute('aria-label') || '').match(/^(\d+(?:\.\d+)?)\s+(damage|accuracy|armor)\s+points/i);
      if (!m) continue;
      const val = parseFloat(m[1]);
      const kind = m[2].toLowerCase();
      if (kind === 'damage') { if (dmg == null) dmg = val; }
      else if (kind === 'accuracy') { if (acc == null) acc = val; }
      else if (armor == null) armor = val;
    }
    return (dmg == null && acc == null && armor == null) ? null : { dmg, acc, armor };
  }

  // Reads a BAZAAR card's stats, which the Item Market's per-value aria-labels
  // don't cover: a bazaar shows each stat as its own <i class="bonus-attachment
  // -item-<kind>-bonus"> icon next to a <span class="t-overflow"><value></span>,
  // all wrapped in one .infoBonuses group per card. The icon class names the
  // stat, so like readStatsFromAriaLabels this can't be fooled by the merged-
  // textContent trap (the value spans sit in separate container divs, so
  // node.textContent would still glue "18.19"+"55.42" into "18.1955.42" - but
  // here each value is read from its own span, not the blob).
  //
  // CRITICAL single-card guard: the stat-capture walk can climb from a clicked
  // card into the row container that holds ALL cards in that row (seen live when
  // a bazaar buy-menu covers the clicked card's own stats, pushing the walk one
  // level up into the row). Reading every icon there would pair one card's value
  // with a neighbour's - e.g. stashing a Combat Boots armor rating under the
  // adjacent Steyr AUG's name. The weapon path is shielded by the range table,
  // but armor has no range to reject a mismatch, so instead we refuse to read at
  // all when the icons span more than one card: every card has its own icon group
  // (icon -> .container -> .infoBonuses), so if not all icons share one group
  // parent this is a multi-card container and we return null, leaving the correct
  // single-card stash (made when the card itself was clicked) untouched.
  function readStatsFromBonusIcons(node) {
    if (!node || !node.querySelectorAll) return null;
    const icons = [];
    for (const icon of node.querySelectorAll('i[class*="bonus-attachment-item-"]')) {
      if (/bonus-attachment-item-(damage|accuracy|armou?r|defen[cs]e)-bonus/i.test(icon.getAttribute('class') || '')) icons.push(icon);
    }
    if (!icons.length) return null;
    const groupOf = (icon) => (icon.parentElement && icon.parentElement.parentElement) || null;
    const group0 = groupOf(icons[0]);
    for (const icon of icons) {
      if (groupOf(icon) !== group0) return null; // icons from >1 card - don't guess
    }
    let dmg = null, acc = null, armor = null;
    for (const icon of icons) {
      const kind = icon.getAttribute('class').match(/bonus-attachment-item-(damage|accuracy|armou?r|defen[cs]e)-bonus/i)[1].toLowerCase();
      const container = icon.parentElement;
      const valEl = container && (container.querySelector('.t-overflow') || container.querySelector('span'));
      if (!valEl) continue;
      const val = parseFloat((valEl.textContent || '').trim());
      if (!(val > 0)) continue;
      if (kind === 'damage') { if (dmg == null) dmg = val; }
      else if (kind === 'accuracy') { if (acc == null) acc = val; }
      else if (armor == null) armor = val; // "armor"/"armour" (Item Market) or "defence" (bazaar)
    }
    return (dmg == null && acc == null && armor == null) ? null : { dmg, acc, armor };
  }

  // Reads a card's stats from whichever source the page exposes: the Item
  // Market's per-value aria-labels or the bazaar's bonus-icon spans. A given
  // card only carries one family, so the two never conflict; merged per field
  // so a partial read from one is completed by the other rather than lost.
  function readCardStats(node) {
    const a = readStatsFromAriaLabels(node) || { dmg: null, acc: null, armor: null };
    const b = readStatsFromBonusIcons(node) || { dmg: null, acc: null, armor: null };
    const dmg = a.dmg != null ? a.dmg : b.dmg;
    const acc = a.acc != null ? a.acc : b.acc;
    const armor = a.armor != null ? a.armor : b.armor;
    return (dmg == null && acc == null && armor == null) ? null : { dmg, acc, armor };
  }

  // Pulls the item name off a card via its action buttons' accessibility labels,
  // scoped to `node`. Covers both page styles: the Item Market ("Buy item Leather
  // Gloves, $303, 1 in total." / "View info for item Leather Gloves.") and the
  // bazaar ("Buy: Hammer" / "Show info: Hammer"). Used for armor, which has no
  // reference-range table to identify it by name the way weapons do; the label is
  // the card's own text, so this needs no per-item name list and can't bleed a
  // neighbouring card's name in.
  function itemNameFromCard(node) {
    if (!node || !node.querySelectorAll) return null;
    for (const el of node.querySelectorAll('[aria-label]')) {
      const label = el.getAttribute('aria-label') || '';
      const m = label.match(/^Buy item (.+?),\s*\$/i)
        || label.match(/^View info for item (.+?)\.?$/i)
        || label.match(/^Buy:\s*(.+?)\s*$/i)
        || label.match(/^Show info:\s*(.+?)\s*$/i);
      if (m) return m[1].trim();
    }
    return null;
  }

  // Reads an item card starting from `root`: walk up a few compact levels and stash
  // the first card's stats. Works on both the Item Market and the bazaar via
  // readCardStats, which reads whichever stat source the page exposes (per-value
  // aria-labels or bonus-icon spans). WEAPON path: at the first node naming a known
  // weapon, read Damage/Accuracy - primary source readCardStats, fallback two
  // cleanly-separated decimals in DOM order, which requires >= 2 matches so a
  // concatenated "16.8351.46" (one match) is rejected rather than misread - then
  // validate against the range table. ARMOR path: armor has one armor value and no
  // reference range, so at the first node exposing an armor stat take that value and
  // the item name from the card's own buttons (itemNameFromCard), stored unvalidated.
  //
  // CRITICAL single-card boundary: a bazaar buy-menu covers the clicked card's own
  // stats, so the walk climbs past it into the row container that holds every card
  // in that row. Reading there pairs the wrong card's data with a purchase - even a
  // range-VALID one (seen live: a Lorcin 380 buy stashed the neighbouring Diamond
  // Bladed Knife's real 61.24/62.25 under that knife's name, since those validate
  // fine, clobbering the correct Lorcin stash). Bazaar cards carry a stable
  // `data-testid="item"`, so the moment `node` contains more than one of them we
  // have left the single card and must stop - the correct value was already stashed
  // when the card itself was clicked. (Item Market cards don't use this testid, so
  // this is a no-op there and that page's capture is unchanged.)
  function tryCaptureWeaponStats(root) {
    let node = root;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      if (node.querySelectorAll && node.querySelectorAll('[data-testid="item"]').length > 1) break;
      const text = (node.textContent || '').trim();
      if (text.length > 400) break; // climbed out of a single card into a container
      const labelled = readCardStats(node);
      // Armor: a lone armor value plus the card's own item name. A weapon card never
      // carries an armor stat (and vice versa), so the two paths can't cross-contaminate.
      if (labelled && labelled.armor != null) {
        const armorName = itemNameFromCard(node);
        if (armorName) {
          pendingWeaponStats = {
            itemName: armorName,
            stats: { dmg: null, acc: null, armor: labelled.armor, quality: null, bonusPct: null, bonusName: null },
            ts: Date.now(),
          };
          return true;
        }
      }
      const weaponName = weaponNameInText(text);
      if (!weaponName) continue;
      let dmg = null, acc = null;
      if (labelled && (labelled.dmg != null || labelled.acc != null)) {
        dmg = labelled.dmg; acc = labelled.acc;
      } else {
        const decimals = (text.match(/\d+\.\d+/g) || []).map(parseFloat).filter((n) => n > 0);
        if (decimals.length < 2) continue; // need Damage and Accuracy
        dmg = decimals[0]; acc = decimals[1];
      }
      const stats = validateStatsAgainstRange(weaponName, {
        dmg, acc, quality: null, bonusPct: null, bonusName: null,
      });
      if (stats) {
        pendingWeaponStats = { itemName: weaponName, stats, ts: Date.now() };
        return true;
      }
    }
    return false;
  }

  // Diagnostic ring buffer surfaced in the debug export, so a weapon-stat miss is
  // pinpointable without another blind guess at the grid DOM: for a weapon-card-ish
  // click it records what element text was examined, the stat pair seen, and whether
  // a weapon name matched in that same text (the crux - if the name and the two
  // numbers are NOT in one element, capture can't pair them).
  const recentClickCaptureAttempts = [];
  function recordClickCapture(info) {
    recentClickCaptureAttempts.unshift(info);
    if (recentClickCaptureAttempts.length > 10) recentClickCaptureAttempts.length = 10;
  }
  // Compact {tag, class, text} of an element for the debug diagnostic below.
  function describeEl(el) {
    if (!el || !el.tagName) return null;
    const cls = (el.getAttribute && el.getAttribute('class')) || '';
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return { tag: el.tagName, cls: cls.slice(0, 70), text: text.slice(0, 80) };
  }

  function captureWeaponStatsFromClick(e) {
    // Read the weapon card under the click. Try the clicked element's own chain and
    // everything stacked under the exact click point (the Buy/cart control is an
    // overlay on top of the card, not a DOM child of it), so capture does not depend
    // on the click landing inside the card in the DOM tree. Runs on every click.
    const target = e.target;
    const stack = typeof document.elementsFromPoint === 'function'
      ? document.elementsFromPoint(e.clientX, e.clientY) : [];
    let stashed = false;
    let via = null;
    for (const root of [target].concat(stack)) {
      if (tryCaptureWeaponStats(root)) { stashed = true; via = root === target ? 'target' : 'stack'; break; }
    }
    // Diagnostic: record every real market click (not our own panel/chip/toast) with
    // the full element stack under it, so a weapon-stat miss is fully diagnosable from
    // a debug export - it shows exactly which element holds the stat numbers and the
    // weapon name, and whether the click even reaches this handler. Verbose on purpose;
    // trimmed back once weapon-stat capture is confirmed working.
    if (!(target.closest && target.closest('#flipr-panel, #flipr-tax-popover, .flipr-toast'))) {
      recordClickCapture({
        at: new Date().toISOString(),
        stashed,
        via,
        item: stashed && pendingWeaponStats ? pendingWeaponStats.itemName : null,
        target: describeEl(target),
        stack: stack.slice(0, 8).map(describeEl),
      });
    }
  }

  // Attach click-captured stats to a just-logged purchase when the confirmation DOM
  // carried none (the usual case - the grid has no labelled stats). Only if it's the
  // same weapon and still fresh; consumed on use so it can't leak to a later buy.
  function attachPendingWeaponStats(itemName, stats) {
    const hasStats = stats && (stats.dmg != null || stats.acc != null || stats.armor != null);
    if (hasStats || !pendingWeaponStats) return stats || null;
    if (normalize(pendingWeaponStats.itemName) !== normalize(itemName)) return stats || null;
    if (Date.now() - pendingWeaponStats.ts >= WEAPON_CLICK_CAPTURE_TTL_MS) return stats || null;
    const captured = pendingWeaponStats.stats;
    pendingWeaponStats = null;
    return captured;
  }

  // Only Damage and Accuracy are captured for weapons - Quality and Bonus are
  // deliberately ignored (user request), so a copy is identified by Dmg/Acc alone.
  function extractStatsFromText(text) {
    const dmgMatch = text.match(WEAPON_STAT_DAMAGE_RE);
    const accMatch = text.match(WEAPON_STAT_ACCURACY_RE);
    if (!dmgMatch && !accMatch) return null;
    return {
      dmg: dmgMatch ? parseFloat(dmgMatch[1]) : null,
      acc: accMatch ? parseFloat(accMatch[1]) : null,
      quality: null,
      bonusPct: null,
      bonusName: null,
    };
  }

  // Walks up from the DOM node the "you bought" text was seen on, checking a
  // handful of ancestor levels' combined text for "Damage: X"/"Accuracy: Y".
  // Torn's confirmation typically only swaps the price/buy-button portion of
  // a listing card, leaving the rest of that same card (image, stats) intact
  // - so the stats should still be present a few levels up the tree from
  // wherever the confirmation text itself landed, IF this particular page
  // shows them right there on the card (unconfirmed either way - see
  // findWeaponStatsPageWide below for the case where they're actually in a
  // separate detail panel elsewhere in the DOM, not an ancestor of the
  // confirmation at all). Capped depth so a miss doesn't walk all the way up
  // to a page-wide ancestor and match some unrelated weapon's stats
  // elsewhere on the page. Returns the WIDEST ancestor text actually checked
  // alongside the result (even on a miss) - an earlier version only ever
  // recorded the original leaf node's own text for diagnosis, which is
  // always just the confirmation sentence itself and said nothing about
  // what the ancestor walk actually searched through.
  function findWeaponStatsNear(node, itemName) {
    if (!node) return { stats: null, widestText: '' };
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    let widestText = '';
    for (let depth = 0; el && depth < WEAPON_STAT_SEARCH_MAX_DEPTH; depth++) {
      const text = el.textContent || '';
      widestText = text; // walking upward, so the last one checked is the widest
      const stats = extractStatsFromText(text);
      // A rejected candidate here isn't retried at a wider ancestor level -
      // every wider level's text already CONTAINS this same text, so the
      // regex would just find the same false match again, not skip past it
      // to a different, correct one (unlike findWeaponStatsPageWide below,
      // which genuinely checks separate occurrences of the item name and
      // can keep looking).
      if (stats) return { stats: validateStatsAgainstRange(itemName, stats), widestText };
      el = el.parentElement;
    }
    return { stats: null, widestText };
  }

  // Fallback for when the stats live in a separate detail/info panel rather
  // than sharing an ancestor with the purchase confirmation (confirmed via a
  // real screenshot: Torn shows a "Damage:/Accuracy:/Quality:" block in an
  // expanded item panel opened by clicking a card, which may not be nested
  // anywhere near wherever the confirmation text itself renders). Scans the
  // whole page's text for each occurrence of the item's own name, and checks
  // a short window right after it for a Damage/Accuracy pair - anchoring on
  // the item name (rather than just grabbing the first "Damage:" found
  // anywhere) avoids misattributing some OTHER item's currently-open detail
  // panel to this purchase. Still imperfect: if multiple listings of the
  // same item name are on the page and a different one's panel happens to
  // be open, this can't tell them apart - best-effort only.
  function findWeaponStatsPageWide(itemName) {
    if (!itemName) return null;
    const body = document.body.textContent || '';
    const escaped = itemName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameRe = new RegExp(escaped, 'i');
    let searchFrom = 0;
    while (searchFrom < body.length) {
      const rel = body.slice(searchFrom).search(nameRe);
      if (rel === -1) break;
      const at = searchFrom + rel;
      const window = body.slice(at, at + STATS_PAGE_WIDE_WINDOW_CHARS);
      const stats = extractStatsFromText(window);
      if (stats && stats.dmg != null && stats.acc != null) {
        // Unlike findWeaponStatsNear, this loop genuinely visits a
        // DIFFERENT occurrence of the item name each time around, so a
        // rejected candidate here doesn't give up - it keeps looking at
        // the next occurrence instead.
        const validated = validateStatsAgainstRange(itemName, stats);
        if (validated) return validated;
      }
      searchFrom = at + itemName.length;
    }
    return null;
  }

  // Looks up stats for a just-detected purchase and records the attempt
  // (found or not, and via which path) for later diagnosis, regardless of
  // outcome - only called once an item name is known, so the diagnostic
  // entries are readable on their own. Tries the ancestor walk first (cheap,
  // and correct if the stats really do sit in the same card as the
  // confirmation), then falls back to the page-wide name-anchored search
  // (see findWeaponStatsPageWide) for the case where they live in a separate
  // detail panel instead. Logs the widest ancestor text actually searched
  // (see findWeaponStatsNear above), not just the original node's own text,
  // so a miss is actually diagnosable from a debug export instead of just
  // confirming the obvious.
  function resolveWeaponStats(itemName, statsNode) {
    const { stats: ancestorStats, widestText } = statsNode ? findWeaponStatsNear(statsNode, itemName) : { stats: null, widestText: '' };
    if (ancestorStats) {
      recordStatsCaptureAttempt(itemName, true, 'ancestor', widestText);
      return ancestorStats;
    }
    const pageWideStats = findWeaponStatsPageWide(itemName);
    recordStatsCaptureAttempt(itemName, !!pageWideStats, pageWideStats ? 'page-wide' : 'none', widestText);
    return pageWideStats;
  }

  // A real "you bought" confirmation only ever appears on a page where a
  // purchase can actually happen right now - the Bazaar page, or the Item
  // Market/Points Market views of page.php. Historical trade-log text using
  // the EXACT SAME wording ("You bought a Crocus on Seller's bazaar at $X
  // each...") also shows up in places that have nothing to do with buying
  // anything right now - e.g. a user's profile page has its own "Actions"
  // panel listing past interaction history with that person, which
  // periodically re-renders on its own while the page just sits open
  // (reported: staying on a trading partner's profile caused the same
  // already-logged purchase to be logged again and again, inflating
  // Holdings qty by one every time that panel refreshed - "i bought 1 flower
  // now it shows 2 when i revisit your profile"). Restricting DOM-text
  // purchase logging to pages where a purchase can genuinely happen right
  // now eliminates this at the source, rather than trying to tell "fresh"
  // apart from "historical" after the fact - a profile page, the Log page,
  // or any news/notification feed can render this exact text and none of
  // them are ever where a real purchase just happened.
  function isPurchasablePage() {
    const path = location.pathname;
    const search = location.search;
    if (/\/bazaar\.php/i.test(path)) return true;
    // The real Points Market lives at pmarket.php, confirmed via a real
    // address bar - NOT page.php?sid=pointsMarket as originally guessed here
    // (reported: points purchases only ever got caught by the slower API
    // poll, never the instant path, on the actual Points Market page - this
    // allowlist simply never matched it). Kept both checks since Item
    // Market's page.php?sid=ItemMarket form is confirmed correct and an
    // sid=pointsMarket route may exist elsewhere even if pmarket.php is the
    // one actually used today.
    if (/\/pmarket\.php/i.test(path)) return true;
    if (/\/page\.php/i.test(path) && /sid=(itemmarket|pointsmarket)/i.test(search)) return true;
    // Travel page: the foreign shops abroad are where plushies and flowers get bought for
    // resale, and those purchases confirm right on this page.
    if (/\/page\.php/i.test(path) && /sid=travel/i.test(search)) return true;
    // City shops (Nikeh, Big Al's and the rest) use their own page.
    if (/\/shops\.php/i.test(path)) return true;
    return false;
  }

  function isItemMarketPage() {
    return /\/page\.php/i.test(location.pathname) && /sid=itemmarket/i.test(location.search);
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  PLAYER TRADE LOG (record a completed trade as a buy/sale)
  ////////////////////////////////////////////////////////////////////////////
  // When you open a completed trade's log on trade.php, read what changed hands and
  // record a clean single-item trade into your books: money one side + exactly one
  // item type the other. A buy goes into Holdings, a sale into Profits (a trade has
  // no 5% market tax). Anything more complex (several item types, item-for-item
  // swaps, money on both sides) is NOTED and skipped - there is no honest way to
  // split one lump of money across different items. All cases mark the trade ID done
  // so a re-render/reload can't re-toast or re-record it. Read-only: it only reads
  // the log page you opened; it never accepts, cancels, fills, or clicks anything.

  // A completed trade lives on trade.php under an ID. Torn has shipped this view under
  // more than one step name (step=logview historically, step=view on the current
  // site), so we DON'T gate on the step string - what actually makes a page recordable
  // is proven inside readTradeLog: it requires the .trade-cont columns AND the "the
  // trade was accepted by" line before it records anything.
  function isTradeLogPage() {
    const q = location.hash + '&' + location.search;
    return /\/trade\.php/i.test(location.pathname) && /[?&#]ID=\d+/i.test(q);
  }

  function currentTradeId() {
    const m = (location.hash + '&' + location.search).match(/[?&#]ID=(\d+)/i);
    return m ? m[1] : null;
  }

  // Persistent "already recorded" ledger, keyed on the trade ID. Capped so it can't
  // grow without bound; only IDs matter, not order.
  let processedTrades = loadProcessedTrades();
  function loadProcessedTrades() {
    try {
      const a = JSON.parse(Store.get(PROCESSED_TRADES_KEY, '[]'));
      return Array.isArray(a) ? a.map(String) : [];
    } catch (e) {
      return [];
    }
  }
  function isTradeProcessed(id) {
    return processedTrades.includes(String(id));
  }
  function markTradeProcessed(id) {
    id = String(id);
    if (processedTrades.includes(id)) return;
    processedTrades.push(id);
    if (processedTrades.length > 500) processedTrades = processedTrades.slice(-500);
    try {
      Store.set(PROCESSED_TRADES_KEY, JSON.stringify(processedTrades));
    } catch (e) {
      log('markTradeProcessed save failed', e);
    }
  }

  // Who am I. Read straight off the page (works on every Torn page, no API call):
  // the "View Profile" link in the user menu carries your own XID, and another link
  // to that same XID carries your name. Cached after the first resolve.
  let selfIdentity = null;
  function getSelfIdentity() {
    if (selfIdentity) return selfIdentity;
    let id = null, name = null;
    const anchors = Array.from(document.querySelectorAll('a[href*="profiles.php?XID="]'));
    const vp = anchors.find((a) => /view profile/i.test((a.textContent || '').trim()));
    if (vp) {
      const m = vp.href.match(/XID=(\d+)/);
      if (m) id = m[1];
    }
    if (id) {
      const named = anchors.find(
        (a) => a.href.includes('XID=' + id) && (a.textContent || '').trim() && !/view profile/i.test(a.textContent)
      );
      if (named) name = (named.textContent || '').trim();
    }
    if (!name) {
      // Sidebar "Name:" row fallback (its container class is hashed, so anchor by the label text).
      const label = Array.from(document.querySelectorAll('*')).find(
        (el) => el.children.length === 0 && (el.textContent || '').trim() === 'Name:'
      );
      if (label && label.parentElement) {
        const t = (label.parentElement.textContent || '').replace(/name:/i, '').trim();
        if (t) name = t;
      }
    }
    if (id || name) selfIdentity = { id, name };
    return selfIdentity;
  }

  // Parse one .user column into { name, money, items:[{name,qty}], resolved }.
  function parseTradeSide(userEl) {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const header = userEl.querySelector('.title-black') || userEl.firstElementChild;
    let name = header ? clean(header.textContent) : '';
    name = name.replace(/'s items traded\s*$/i, '').trim();

    let money = 0, hasMoney = false, sawItemsLine = false;
    const items = [];
    const seen = new Set();
    const rows = Array.from(userEl.querySelectorAll('.cont .name'));
    for (const r of rows) {
      if (seen.has(r)) continue;
      seen.add(r);
      const t = clean(r.textContent);
      if (!t) continue;
      if (/no money in trade/i.test(t)) { hasMoney = true; continue; }
      const mm = t.match(/\$([\d,]+)\s*in trade/i);
      if (mm) { money = Number(mm[1].replace(/,/g, '')); hasMoney = true; continue; }
      if (/no items in trade/i.test(t) || /no properties in trade/i.test(t)) { sawItemsLine = true; continue; }
      if (/in trade$/i.test(t)) continue; // any other "... in trade" summary line
      // Item row: "Name x10" or "10x Name"; bare name is a single non-stackable copy.
      let im = t.match(/^(.+?)\s*x\s*([\d,]+)$/i);
      if (im) { items.push({ name: im[1].trim(), qty: Number(im[2].replace(/,/g, '')) || 1 }); sawItemsLine = true; continue; }
      im = t.match(/^([\d,]+)\s*x\s+(.+)$/i);
      if (im) { items.push({ name: im[2].trim(), qty: Number(im[1].replace(/,/g, '')) || 1 }); sawItemsLine = true; continue; }
      items.push({ name: t, qty: 1 }); sawItemsLine = true;
    }
    // Fallback if the money label wasn't inside a .name element for some layout.
    if (!hasMoney) {
      const mm = clean(userEl.textContent).match(/\$([\d,]+)\s*in trade/i);
      if (mm) { money = Number(mm[1].replace(/,/g, '')); hasMoney = true; }
    }
    // `resolved` = this column has finished rendering both its money and its items
    // summary lines. A half-rendered React column (accepted line already on screen,
    // rows not yet in) would otherwise parse as an empty side and get mis-classified
    // as an un-priceable trade, burning the ID on the processed ledger for good.
    return { name, money, items, resolved: hasMoney && sawItemsLine };
  }

  // Parse "14:54:57 - 03/07/26" (DD/MM/YY) near the accepted line into unix seconds.
  function acceptedTsSeconds(text) {
    const m = text.match(/(\d{2}):(\d{2}):(\d{2})\s*-\s*(\d{2})\/(\d{2})\/(\d{2})[\s\S]{0,60}?the trade was accepted by/i);
    if (!m) return Math.floor(Date.now() / 1000);
    const [, HH, MM, SS, dd, mo, yy] = m;
    const d = new Date(2000 + Number(yy), Number(mo) - 1, Number(dd), Number(HH), Number(MM), Number(SS));
    const t = Math.floor(d.getTime() / 1000);
    return Number.isFinite(t) ? t : Math.floor(Date.now() / 1000);
  }

  function readTradeLog() {
    if (!settings.trackTrades) return;
    if (!isTradeLogPage()) return;
    const tradeId = currentTradeId();
    if (!tradeId || isTradeProcessed(tradeId)) return;

    const cont = document.querySelector('.trade-cont');
    if (!cont) return; // React hasn't rendered the trade yet - the observer will call again
    const pageText = document.body ? document.body.textContent : '';
    if (!/the trade was accepted by/i.test(pageText)) return; // not a completed/accepted trade

    const left = cont.querySelector('.user.left');
    const right = cont.querySelector('.user.right');
    if (!left || !right) return;

    const self = getSelfIdentity();
    if (!self || !self.name) return; // can't tell which side is me - retry on a later load
    const norm = (s) => normalize(String(s || ''));
    const sides = [parseTradeSide(left), parseTradeSide(right)];
    if (!sides[0].resolved || !sides[1].resolved) return; // columns still rendering - retry, don't mark done
    let mine = null, theirs = null;
    if (norm(sides[0].name) === norm(self.name)) { mine = sides[0]; theirs = sides[1]; }
    else if (norm(sides[1].name) === norm(self.name)) { mine = sides[1]; theirs = sides[0]; }
    if (!mine) return; // neither header matched my name; don't guess, don't mark done

    const tsSeconds = acceptedTsSeconds(pageText);

    // BUY: I paid money for exactly one item type, and gave no items of my own.
    if (mine.money > 0 && mine.items.length === 0 && theirs.money === 0 && theirs.items.length === 1) {
      const it = theirs.items[0];
      const unitCost = mine.money / it.qty;
      const lotEntry = addLot(it.name, it.qty, unitCost, `trade:${tradeId}`, null, null);
      markTradeProcessed(tradeId);
      if (lotEntry) {
        renderAll();
        showToast(
          `FLIPR logged trade buy: ${it.qty}× ${it.name} @ ${money(unitCost)}`,
          () => undoLotQty(lotEntry.id, it.qty)
        );
      }
      return;
    }

    // SELL: I gave exactly one item type and got money for it (a trade has no tax).
    if (mine.items.length === 1 && mine.money === 0 && theirs.money > 0 && theirs.items.length === 0) {
      const it = mine.items[0];
      recordSale(it.name, it.qty, theirs.money, 0, 'trade', tsSeconds);
      markTradeProcessed(tradeId);
      renderAll();
      showToast(`FLIPR logged trade sale: ${it.qty}× ${it.name} for ${money(theirs.money)} (no tax)`);
      return;
    }

    // Everything else is noted, not priced - marking it done so it can't re-toast.
    markTradeProcessed(tradeId);
    let why;
    if (mine.items.length > 1 || theirs.items.length > 1) why = 'several item types';
    else if (mine.items.length && theirs.items.length) why = 'item-for-item swap';
    else if (mine.money && theirs.money) why = 'money on both sides';
    else if (mine.items.length + theirs.items.length === 0) why = 'no items';
    else why = 'mixed items and money';
    showToast(`FLIPR: trade #${tradeId} not auto-priced (${why}) - log it by hand if you want it tracked`);
  }

  // Debounced entry point: trade.php is a React SPA that renders the log a moment
  // after navigation, so this is called from an observer, on hashchange, and once at
  // init; readTradeLog is idempotent (guards on the processed ledger) so extra calls
  // are harmless.
  let tradeScanScheduled = false;
  function scanTradeLog() {
    if (!/\/trade\.php/i.test(location.pathname)) return;
    startTradePoll(); // event triggers can be starved in the userscript sandbox - poll as a safety net
    if (tradeScanScheduled) return;
    tradeScanScheduled = true;
    setTimeout(() => {
      tradeScanScheduled = false;
      try { readTradeLog(); } catch (e) { log('readTradeLog failed', e); }
    }, 400);
  }

  // Belt-and-suspenders invocation for the trade reader. Tampermonkey sandboxes the
  // script, and on Torn's trade SPA the event-based triggers can all miss (a
  // hashchange or pushState done on the page's real history never reaches our wrap),
  // so a completed trade you reach by clicking through the site could render with no
  // watcher ever calling readTradeLog. A bounded setInterval (which fires reliably in
  // the sandbox) closes that gap: it re-reads every 700ms until the trade is recorded,
  // we leave trade.php, or the cap is hit. readTradeLog self-dedupes on the processed
  // ledger and bails off trade.php, so the poll cannot double-count or leak.
  let tradePollTimer = null;
  function startTradePoll() {
    if (tradePollTimer) return;
    if (!settings.trackTrades) return;
    if (!/\/trade\.php/i.test(location.pathname)) return;
    let ticks = 0;
    tradePollTimer = setInterval(() => {
      ticks += 1;
      try { readTradeLog(); } catch (e) { log('trade poll readTradeLog failed', e); }
      const done = ticks >= 25 || !/\/trade\.php/i.test(location.pathname) ||
        (currentTradeId() && isTradeProcessed(currentTradeId()));
      if (done) { clearInterval(tradePollTimer); tradePollTimer = null; }
    }, 700);
  }

  // Persistent trade-log watcher: attach ONE body-scoped observer unconditionally and
  // redraw on hashchange/popstate/pushState, so a completed trade is caught however
  // you arrive at it (fresh load, Past-Trades click, or in-site navigation).
  window.addEventListener('hashchange', () => scanTradeLog());
  window.addEventListener('popstate', () => scanTradeLog());
  try {
    new MutationObserver(() => scanTradeLog())
      .observe(document.body || document.documentElement, { childList: true, subtree: true });
  } catch (e) {
    log('trade observer attach failed', e);
  }
  try {
    const wrapHist = (orig) => function () { const r = orig.apply(this, arguments); try { scanTradeLog(); } catch (e) { /* ignore */ } return r; };
    history.pushState = wrapHist(history.pushState);
    history.replaceState = wrapHist(history.replaceState);
  } catch (e) { /* history not writable - hashchange + observer still cover most cases */ }
  scanTradeLog();

  ////////////////////////////////////////////////////////////////////////////
  ////  MARKET TAX HELPER (click a listing -> price minus 5% tax, with Copy)
  ////////////////////////////////////////////////////////////////////////////
  // Read-only convenience for flipping: clicking a listing on the Item Market
  // pops a small chip showing that price minus Torn's 5% sales tax (what you
  // actually net if you sell at it), with a Copy button. See the COMPLIANCE NOTE
  // at the top - this only READS a price already on the page and copies a number
  // to the clipboard when YOU click Copy; it never fills, submits, or clicks any
  // Torn field for you.

  // Reads a listing price without ever gluing an adjacent cell's digits onto it,
  // via two rules: (1) the price is matched STRICTLY (proper thousands grouping, no
  // trailing digit) - the same fix used for purchase parsing, so a "$350" next to
  // "1 available" can never read as "$3,501"; (2) it is only read from a SHORT
  // element (a price cell), never a whole row's run-together text. Tolerates a
  // trailing word, e.g. "$611 each".
  const TAX_PRICE_RE = /\$\s*(\d{1,3}(?:,\d{3})*)(?![\d,])/;
  const TAX_PRICE_CELL_MAX_CHARS = 24;

  // Returns the price from the first LEAF price element inside `root` (root or a
  // descendant with no child elements of its own). A leaf's textContent is only its
  // own text, so a sibling cell's digits can never be concatenated in - that plus
  // strict money reads "$4,800" cleanly out of a listing row regardless of how the
  // row is otherwise structured. Searching descendants means a click anywhere in a
  // listing (its image, name, seller, Buy button) still finds that row's price cell.
  function priceInElement(root) {
    const candidates = [root, ...root.querySelectorAll('*')];
    for (const c of candidates) {
      if (c.childElementCount > 0) continue; // leaf elements only
      const text = (c.textContent || '').trim();
      if (!text || text.length > TAX_PRICE_CELL_MAX_CHARS) continue;
      const m = text.match(TAX_PRICE_RE);
      if (!m) continue;
      const n = parseInt(m[1].replace(/,/g, ''), 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  }

  // Walks up from the clicked node to the listing that holds a price cell and reads
  // it (see priceInElement). Stops once it climbs into a big multi-listing container
  // rather than guess, which also keeps the chip silent on empty-space clicks. An
  // earlier version additionally required a "buy/available" marker word at the SAME
  // level as the price to prove it was a listing; that was too strict and stopped
  // the chip firing on real listings (reported), so scoping is now done purely by
  // excluding the sidebar/header/chat in the click handler plus these size limits.
  function findMarketPriceNear(el) {
    let node = el;
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      const text = node.textContent || '';
      if (text.length > 400) break; // climbed above the individual listing - stop
      const price = priceInElement(node);
      if (price != null) return price;
    }
    return null;
  }

  let taxPopoverEl = null;
  function hideTaxPopover() {
    if (taxPopoverEl) {
      taxPopoverEl.remove();
      taxPopoverEl = null;
    }
  }

  function showTaxPopover(clientX, clientY, price, afterTax) {
    hideTaxPopover();
    const pop = document.createElement('div');
    pop.id = 'flipr-tax-popover';
    pop.innerHTML = `
      <span class="flipr-tax-close" title="Dismiss">\u00D7</span>
      <div class="flipr-tax-orig">Market ${money(price)}</div>
      <div class="flipr-tax-net"><b>After 5% tax: ${money(afterTax)}</b></div>
      <button class="flipr-btn flipr-tax-copy" type="button">Copy ${money(afterTax)}</button>`;
    document.body.appendChild(pop);

    // Place near the cursor, clamped so it never spills off-screen.
    const pad = 8;
    const rect = pop.getBoundingClientRect();
    const left = Math.min(clientX + 12, window.innerWidth - rect.width - pad);
    const top = Math.min(clientY + 12, window.innerHeight - rect.height - pad);
    pop.style.left = Math.max(pad, left) + 'px';
    pop.style.top = Math.max(pad, top) + 'px';

    pop.querySelector('.flipr-tax-close').addEventListener('click', (ev) => {
      ev.stopPropagation();
      hideTaxPopover();
    });
    const copyBtn = pop.querySelector('.flipr-tax-copy');
    copyBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // Copy it formatted, exactly as the popover shows it ($8,141,897). A bare
      // integer was hard to read and looked wrong when pasted into chat or a DM.
      // If you ever need the raw number for a price input, strip the punctuation.
      const text = money(afterTax);
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
      } catch (err) {
        // clipboard API unavailable - the number is still shown for manual copy
      }
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { if (copyBtn.isConnected) copyBtn.textContent = `Copy ${money(afterTax)}`; }, 1200);
    });
    taxPopoverEl = pop;
  }

  // The chip should only appear on a deliberate "about to buy this listing" click,
  // not on any click in the market (requested: it was too eager). For the row
  // listings that point is the Qty field you click to set how many to buy; the
  // weapon/armor grid cards have no Qty field, so there it is the Buy button / cart
  // icon. So: fire on a Qty input, or on a buy control.
  function isBuyIntentTarget(target) {
    if (!target || typeof target.closest !== 'function') return false;
    if (target.closest('input')) return true; // Qty field (the numeric input)
    // A buy control: the "BUY" text button, or an icon-only buy/cart control that
    // carries the hint in its title/aria-label/class instead of visible text.
    const clickable = target.closest('a, button, [role="button"]');
    const attrs = [];
    for (const el of [target, clickable]) {
      if (!el || !el.getAttribute) continue;
      attrs.push(el.getAttribute('title') || '', el.getAttribute('aria-label') || '', el.getAttribute('class') || '');
    }
    if (/buy|cart|purchase/i.test(attrs.join(' '))) return true;
    if (clickable && /\bbuy\b/i.test(clickable.textContent || '')) return true;
    return false;
  }

  // One capture-phase, passive Item Market click handler (attached only there, see
  // the bottom wiring). It never preventDefault/stopPropagation, so it can't
  // interfere with the real page click (opening the listing, buying, etc.). It does
  // two independent jobs: capture a clicked weapon card's stats for the purchase
  // that follows, and show the after-tax chip.
  function onItemMarketClick(e) {
    const target = e.target;
    if (!target || typeof target.closest !== 'function') return;
    if (target.closest('#flipr-tax-popover')) return; // Copy/close handle their own clicks
    hideTaxPopover(); // any click elsewhere dismisses an open chip

    // Weapon/armor stats capture runs on EVERY buy-page click (Item Market AND
    // bazaar), independent of the tax-chip setting and of whether the click looks
    // like a "buy" - it reads the card under the click point and stashes its shown
    // Damage/Accuracy/Armor for the purchase confirmation that follows a beat later.
    // No-ops unless the click is on a real weapon/armor card, so clicking a plain
    // listing, a filter, or empty space stashes nothing.
    captureWeaponStatsFromClick(e);

    // The after-tax chip is an Item Market convenience only (a bazaar buy isn't
    // taxed the way an Item Market listing is), so it stays scoped to that page.
    if (!IS_ITEM_MARKET || !settings.marketTaxHelper) return;
    if (!isBuyIntentTarget(target)) return; // tax chip only on the Qty field or a Buy control
    // Scope to the market content by excluding our own UI and the page furniture
    // that lives on every page: the left menu/info panel (where "Money $X" is), the
    // header, and chat (where a message might contain a "$"). Uses SPECIFIC ids only
    // - broad [class*="sidebar"]/[class*="appHeader"] wildcards were dropped because
    // they could match the market content's own wrappers and silently kill every
    // click (reported: the chip stopped appearing entirely).
    if (target.closest('#flipr-panel, #flipr-tax-popover, .flipr-toast, #sidebar, #sidebarroot, #left-column, #header, #topHeaderWrapper, #chatRoot')) return;
    const price = findMarketPriceNear(target);
    if (price == null) return;
    const afterTax = Math.round(price * (1 - FEE_STANDARD));
    showTaxPopover(e.clientX, e.clientY, price, afterTax);
  }

  // Watching characterData mutations (see pageObserver below) means a single
  // real "you bought" confirmation can trigger this function several times
  // in a row - e.g. a React re-render touching nested text nodes fires the
  // observer once per node even though the final text only changed once.
  // Once a confirmation text has been processed, the EXACT same text is never
  // processed again for as long as it keeps being sighted (each sighting refreshes
  // its memory entry; entries only expire TTL after the last sighting). This is
  // what stops the slow-burn duplication (reported with a debug export: one 5x
  // Diesel purchase re-logged 18 times over ~44 minutes into a 90x row). Torn's
  // "You bought..." banner STAYS on the Item Market page and re-renders every
  // couple of minutes as the live listings update around it - each re-render is a
  // fresh mutation carrying the identical text, and the previous guard only
  // suppressed repeats for 4 seconds / 800ms. A page reload clears the banner and
  // this in-memory map together, so per-tab memory is exactly the right lifetime.
  //
  // The one real thing this can suppress: a genuine rebuy whose confirmation is
  // byte-identical (same seller, same qty, same price - the text includes all
  // three). That purchase is NOT lost: the API poll (reliable since the lookback
  // rewrite, see pollLog) stores it from its own log entry within seconds, and
  // finding no dom ticket for it, does so exactly once.
  const seenPurchaseTexts = new Map(); // exact text -> expiry (refreshed on every sighting)
  const SEEN_PURCHASE_TEXT_TTL_MS = 30 * 60 * 1000;
  function pruneSeenPurchaseTexts() {
    const now = Date.now();
    for (const [key, expiry] of seenPurchaseTexts) {
      if (expiry <= now) seenPurchaseTexts.delete(key);
    }
  }

  function tryLogPurchaseFromText(text, statsNode) {
    if (!settings.scanPageText) return;
    if (!isPurchasablePage()) return;
    if (!text) return;
    if (text.length > 300) {
      const matches = [];
      let m;
      while ((m = PURCHASE_LINE_EXTRACT_RE.exec(text))) matches.push(m[0]);

      if (matches.length > 1) {
        // A single live purchase confirmation only ever produces ONE "you
        // bought...total of $" occurrence in one mutation, even embedded in
        // a noisy blob (see the comment above PURCHASE_LINE_EXTRACT_RE).
        // Multiple occurrences landing in one mutation is the signature of a
        // list/feed widget re-rendering many past events at once (Torn's
        // header "events" dropdown does exactly this), not a fresh purchase -
        // reject the whole blob rather than risk re-logging any of several
        // already-seen purchases as fresh ones. Backstops isInsideHistoryFeed
        // for any feed container that selector list doesn't know about.
        log('skipped purchase text blob with multiple "you bought" occurrences (likely a history feed re-render)', matches.length);
        return;
      }

      if (matches.length === 1) {
        tryLogPurchaseFromText(matches[0].trim(), statsNode);
      } else {
        recordUnmatchedPurchaseText(`[${text.length} chars, no "...total of $" found] ${text.slice(0, 300)}`);
      }
      return;
    }

    pruneSeenPurchaseTexts();
    const alreadySeen = seenPurchaseTexts.has(text);
    seenPurchaseTexts.set(text, Date.now() + SEEN_PURCHASE_TEXT_TTL_MS); // record/refresh either way
    if (alreadySeen) {
      log('skipped already-processed confirmation text (persistent banner re-render)');
      return;
    }

    const mpInline = text.match(PURCHASE_CONFIRMATION_POINTS_INLINE_RE);
    if (mpInline) {
      const qty = parseInt(mpInline[1].replace(/,/g, ''), 10);
      const unitCost = parseInt(mpInline[2].replace(/,/g, ''), 10);
      if (qty && unitCost) logPurchaseIfNew('Points', qty, unitCost, 'dom-text');
      return;
    }

    const mbInline = text.match(PURCHASE_CONFIRMATION_BAZAAR_INLINE_RE);
    if (mbInline) {
      const qty = mbInline[1] ? parseInt(mbInline[1].replace(/,/g, ''), 10) : 1;
      const itemName = mbInline[2].trim();
      const total = parseInt(mbInline[3].replace(/,/g, ''), 10);
      const unitCost = qty ? total / qty : NaN;
      if (qty && itemName && Number.isFinite(unitCost)) {
        logPurchaseIfNew(itemName, qty, unitCost, 'dom-text', resolveWeaponStats(itemName, statsNode));
      }
      return;
    }

    const mp = text.match(PURCHASE_CONFIRMATION_POINTS_RE);
    if (mp) {
      const qty = parseInt(mp[1].replace(/,/g, ''), 10);
      const unitCost = parseInt(mp[2].replace(/,/g, ''), 10);
      if (qty && unitCost) logPurchaseIfNew('Points', qty, unitCost, 'dom-text');
      return;
    }

    const mb = text.match(PURCHASE_CONFIRMATION_BAZAAR_RE);
    if (mb) {
      const qty = mb[1] ? parseInt(mb[1].replace(/,/g, ''), 10) : 1;
      const itemName = mb[2].trim();
      const unitCost = parseInt(mb[3].replace(/,/g, ''), 10);
      if (qty && itemName && unitCost) {
        logPurchaseIfNew(itemName, qty, unitCost, 'dom-text', resolveWeaponStats(itemName, statsNode));
      }
      return;
    }

    const mm = text.match(PURCHASE_CONFIRMATION_MARKET_RE);
    if (mm) {
      const qty = mm[1] ? parseInt(mm[1].replace(/,/g, ''), 10) : 1;
      const itemName = mm[2].trim();
      const unitCost = parseInt(mm[3].replace(/,/g, ''), 10);
      if (qty && itemName && unitCost) {
        logPurchaseIfNew(itemName, qty, unitCost, 'dom-text', resolveWeaponStats(itemName, statsNode));
        return;
      }
    }

    const mGeneric = text.match(PURCHASE_CONFIRMATION_GENERIC_INLINE_RE);
    if (mGeneric) {
      const qty = mGeneric[1] ? parseInt(mGeneric[1].replace(/,/g, ''), 10) : 1;
      const itemName = mGeneric[2].trim();
      const total = parseInt(mGeneric[3].replace(/,/g, ''), 10);
      const unitCost = qty ? total / qty : NaN;
      if (qty && itemName && Number.isFinite(unitCost)) {
        logPurchaseIfNew(itemName, qty, unitCost, 'dom-text', resolveWeaponStats(itemName, statsNode));
        return;
      }
    }

    // Shops (foreign travel shops and city shops) have NO seller, so the wording drops
    // the "from X" that every other pattern anchors on:
    //   "You bought 28x Chamois Plushie for a total of $11,200"
    //
    // Checked LAST and ONLY on a shop page, both deliberately. With no seller clause this
    // pattern is inherently greedy, and on an Item Market confirmation
    //   "You bought 2x Erotic DVD from Illuminescense for a total of $9,035,798"
    // it captures "Erotic DVD from Illuminescense" as the item name. That is not just an
    // ugly label: the API log later records the same purchase as plain "Erotic DVD", the
    // two names do not match, the dedup guard cannot pair them, and the buy gets counted
    // TWICE. Confirmed live - it produced two 2x Erotic DVD lots at $4,517,899 from one
    // purchase. Running it after every seller-anchored pattern, and only where no seller
    // can exist, makes both failure paths impossible.
    if (isShopPage()) {
      const mShop = text.match(PURCHASE_CONFIRMATION_SHOP_RE);
      if (mShop) {
        const qty = mShop[1] ? parseInt(mShop[1].replace(/,/g, ''), 10) : 1;
        const itemName = mShop[2].trim();
        const total = parseInt(mShop[3].replace(/,/g, ''), 10);
        const unitCost = qty ? total / qty : NaN;
        if (qty && itemName && Number.isFinite(unitCost)) {
          logPurchaseIfNew(itemName, qty, unitCost, 'dom-text', resolveWeaponStats(itemName, statsNode));
          return;
        }
      }
    }

    // Contained "you bought" (the only reason this function gets called at
    // all - see scanMutationsForPurchaseText below) but matched none of the
    // known patterns.
    recordUnmatchedPurchaseText(text);
  }

  // Exposed so the single page-wide observer set up near the bottom of the
  // script (shared with price-field scanning, to avoid running two separate
  // whole-document MutationObservers) can call this per mutation batch.
  //
  // Handles two distinct kinds of DOM change: a brand new node appearing
  // (childList - what this originally only checked), and an EXISTING text
  // node's own content changing in place (characterData). The bazaar page's
  // inline confirmation turned out to be the second kind - it swaps an
  // existing label's text (e.g. "Are you sure...?" -> "You bought...")
  // rather than removing and re-inserting a whole new element, which a
  // childList-only observer never sees at all. That's why it was only ever
  // getting caught later, once the header's history dropdown rendered a
  // genuinely new set of nodes for the same event - the instant, on-page
  // path needs characterData watched too.
  // Torn's header "recent activity" dropdown (the clock icon) renders every
  // past event - including historically-worded "You bought..." rows using
  // the exact same phrasing a live confirmation uses - into a fixed
  // container, "#recent-history-wrapper .recent-history-content" (confirmed
  // via a real page dump). That dropdown can open on top of ANY page,
  // including the Bazaar/Item Market where a live purchase genuinely can
  // happen, so a page-URL check alone can't exclude it, and repeatedly
  // opening it was re-logging the same old purchases as brand new ones
  // (reported: Holdings/points qty multiplying every time it was opened).
  // Rather than keep trying to tell "historical" from "fresh" by the text
  // content (age-marker and multi-match heuristics both proved unreliable -
  // see PURCHASE_LINE_EXTRACT_RE usage above), this checks WHERE in the DOM
  // the text physically lives: anything inside that history dropdown (or the
  // events feed, or the Log page's own activity list) is never a live
  // confirmation and is skipped outright. A genuine on-page bazaar/market
  // confirmation renders inside the purchase page's own content, never
  // inside these containers, so this can't suppress a real one.
  const HISTORY_FEED_SELECTOR = '#recent-history-wrapper, .recent-history-content, #nav-events, .activity-log, #activityLog';
  function isInsideHistoryFeed(node) {
    const el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return !!(el && el.closest && el.closest(HISTORY_FEED_SELECTOR));
  }

  // A chat message can carry the exact "You bought Nx Item for a total of $X"
  // wording - someone pastes or shares their own transaction into faction/company
  // chat, the observer sees a brand new chat node whose text matches a
  // confirmation regex, and THEIR purchase gets logged as if it were yours
  // (reported: a faction-mate's shared buy landed in Holdings). All Torn chat
  // lives under #chatRoot (the same anchor the tax-popover exclusion uses), and a
  // genuine on-page purchase confirmation never renders inside it, so anything in
  // there is skipped outright - it can only ever be someone else's text.
  function isInsideChat(node) {
    const el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return !!(el && el.closest && el.closest('#chatRoot'));
  }

  function scanMutationsForPurchaseText(mutations) {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        // Cheap "you bought" text test FIRST, before the DOM-walking
        // isInsideHistoryFeed(closest()) - the vast majority of mutations on a
        // busy page (chat, timers, live listings) are not purchase text, so this
        // skips the ancestor walk for all of them. The mutated text node is also
        // the anchor findWeaponStatsNear walks up from for nearby stat figures.
        const text = mutation.target.textContent;
        if (!text || !/you bought/i.test(text)) continue;
        if (isInsideHistoryFeed(mutation.target)) continue;
        if (isInsideChat(mutation.target)) continue;
        tryLogPurchaseFromText(text.trim(), mutation.target);
        continue;
      }
      for (const node of mutation.addedNodes) {
        const text = node.textContent;
        if (!text || !/you bought/i.test(text)) continue;
        if (isInsideHistoryFeed(node)) continue;
        if (isInsideChat(node)) continue;
        tryLogPurchaseFromText(text.trim(), node);
      }
    }
  }

  async function tornApiFetch(url) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) {
        const e = new Error(`Torn API ${data.error.code}: ${data.error.error}`);
        e.tornCode = data.error.code;
        throw e;
      }
      return data;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  async function ensureItemCatalog(apiKey) {
    if (Date.now() - itemCatalog.fetchedAt < ITEM_CATALOG_MAX_AGE_MS && Object.keys(itemCatalog.names).length) {
      return itemCatalog;
    }
    const data = await tornApiFetch(`https://api.torn.com/torn/?selections=items&key=${apiKey}`);
    const names = {};
    if (data.items && typeof data.items === 'object') {
      if (Array.isArray(data.items)) {
        for (const it of data.items) if (it && it.id != null) names[it.id] = it.name;
      } else {
        for (const [id, it] of Object.entries(data.items)) {
          if (it && typeof it.name === 'string') names[id] = it.name;
        }
      }
    }
    if (!Object.keys(names).length) {
      log('item catalog fetch returned no usable names', data);
      return itemCatalog; // keep whatever we had, don't overwrite with an empty map
    }
    itemCatalog = { fetchedAt: Date.now(), names };
    saveItemCatalog(itemCatalog);
    return itemCatalog;
  }

  function resolveItemName(id) {
    return itemCatalog.names[id] || `Item #${id}`;
  }

  // 'points market' is a guess at the category string, unverified against a
  // real log entry - if it's wrong this category just never matches (falls
  // through to the normal "skipped" diagnostic list below), no harm done.
  // 'shops' covers BOTH the foreign travel shops and the city shops - Torn files them
  // under one category ("Item shop buy", type 4200) with an `area` field distinguishing
  // them. Confirmed from a real log entry.
  const PURCHASE_LOG_CATEGORIES = new Set(['item market', 'bazaars', 'points market', 'shops']);

  // data.log turned out ambiguous from a browser JSON-tree view alone - it
  // could be a real array or an object keyed by opaque/numeric-looking IDs
  // (Torn's v1 log endpoint used the latter). Handling both defensively:
  // an unconfirmed shape here previously meant the poller ran cleanly every
  // cycle, advanced its watermark, and silently logged zero purchases no
  // matter what was actually bought (reported: real purchases never showed
  // up over a ~15-minute test window with no errors surfaced anywhere).
  function extractLogEntries(data) {
    const raw = data && data.log;
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') return Object.values(raw);
    return [];
  }

  // Diagnostic snapshot of the most recent poll, surfaced in the debug
  // export so a miss can be root-caused from a pasted export instead of
  // guessed at - see buildDebugExport() below.
  let lastPollDebug = { at: null, since: null, fetchedCount: null, matchedCount: 0, skipped: [], error: null };

  function processLogEntries(entries) {
    let maxTimestamp = logState.lastTimestamp;
    let matchedCount = 0;
    const skipped = [];
    // Oldest first, so lots are recorded in the order they actually happened.
    const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
    for (const entry of sorted) {
      maxTimestamp = Math.max(maxTimestamp, entry.timestamp);

      // Durable idempotency (the "once stored, never stored again" guarantee for
      // the API path): an entry id already turned into a lot is never processed
      // again - across reloads, overlapping polls, or another open tab that got
      // to it first. This is what makes appending safe the way BUSTR's rebuild-
      // from-log model is safe by construction. Entries with no id (unexpected)
      // fall through to the watermark alone, exactly as before this ledger existed.
      const entryId = entry.id;
      const hasEntryId = entryId !== undefined && entryId !== null && entryId !== '';
      if (hasEntryId && isLogIdProcessed(entryId)) continue;

      const details = entry.details || {};
      const category = String(details.category || '').toLowerCase();
      const title = String(details.title || '').toLowerCase();
      const typeId = Number(details.id);

      // Sales (realized profit) are detected by EXACT log-type id, confirmed off the
      // live log - no title-regex guessing. Claim the id first (same rule as buys)
      // so no reload/re-poll/other-tab can ever record the same sale twice. Handled
      // before the purchase check below, which would otherwise skip a sell as
      // "not a purchase".
      if (SALE_LOG_TYPE_IDS.has(typeId)) {
        if (hasEntryId) markLogIdProcessed(entryId);
        const stored = processSaleEntry(entry, typeId);
        if (stored) matchedCount++;
        else if (skipped.length < 20) skipped.push({ title: details.title, category: details.category, rawData: entry.data });
        continue;
      }

      // Matches "buy" or "purchase" in the title - the only confirmed real
      // sample used "Item market buy", but a Bazaar purchase's exact title
      // has never been observed live, so this stays deliberately broad.
      if (!PURCHASE_LOG_CATEGORIES.has(category) || !/buy|purchase/.test(title)) {
        if (skipped.length < 20) skipped.push({ title: details.title, category: details.category });
        log('log entry skipped (not a purchase)', details.title, details.category);
        continue;
      }

      // This IS a purchase entry - claim its id now, before logging its items, so
      // no later poll/reload/tab can ever turn it into a second lot regardless of
      // how (or whether) each of its items parses below.
      if (hasEntryId) markLogIdProcessed(entryId);

      // Points market buys are a single flat purchase (quantity/cost_each/
      // cost_total directly on `data`), confirmed against a real log entry:
      // { seller, quantity: 30, cost_each: 31200, cost_total: 936000,
      // listing_id }. Handled separately from item market/bazaar, which use
      // an items[] array of {id, qty, cost_each} instead - assuming every
      // purchase category shared that same items[] shape was the earlier
      // bug here (confirmed via a debug export: points market buys always
      // fell through to "skipped" because they have no items array at all).
      if (category === 'points market') {
        const data = entry.data || {};
        const qty = Number(data.quantity) || 0;
        const unitCost = Number(data.cost_each ?? (data.cost_total != null && qty ? data.cost_total / qty : NaN));
        if (qty && Number.isFinite(unitCost)) {
          matchedCount++;
          logPurchaseIfNew('Points', qty, unitCost, `api-log:${entry.id}`);
        } else if (skipped.length < 20) {
          skipped.push({ title: details.title, category: details.category, rawData: entry.data });
        }
        continue;
      }

      // Shops log a SINGLE item flat on `data`, with no items[] array at all:
      //   { item: 172, quantity: 1, cost_each: 95, cost_total: 95, area: 103 }
      // confirmed from a real "Item shop buy" (type 4200) entry. Same flat shape as the
      // points market, and handled here for the same reason: without it, every shop
      // purchase falls into the "no items[] array" skip below and is lost silently.
      if (category === 'shops') {
        const data = entry.data || {};
        const qty = Number(data.quantity) || 0;
        const unitCost = Number(data.cost_each ?? (data.cost_total != null && qty ? data.cost_total / qty : NaN));
        if (data.item != null && qty && Number.isFinite(unitCost)) {
          matchedCount++;
          logPurchaseIfNew(resolveItemName(data.item), qty, unitCost, `api-log:${entry.id}`);
        } else if (skipped.length < 20) {
          skipped.push({ title: details.title, category: details.category, rawData: entry.data });
        }
        continue;
      }

      const items = entry.data && entry.data.items;
      if (!Array.isArray(items)) {
        // Known purchase category (title/category matched) but no items[]
        // array - a shape mismatch we haven't seen yet. Captures the raw
        // payload so the next miss like this is diagnosable straight from a
        // debug export instead of needing a fresh live API pull every time.
        if (skipped.length < 20) skipped.push({ title: details.title, category: details.category, rawData: entry.data });
        log('log entry skipped (purchase category but no items[] array)', details.title, details.category);
        continue;
      }
      // CONFIRMED against a real "Bazaar buy" (type 1225) log entry: the cost fields sit
      // on `data`, NOT on each item. The items[] entries carry only {id, uid, qty}:
      //   data: { seller, items: [{id:428, uid:0, qty:1}], cost_each: 16819999,
      //           cost_total: 16819999 }
      // Reading cost off the item alone therefore produced NaN for every bazaar purchase
      // and dropped it silently - a Casino Pass bought from a bazaar never reached
      // Holdings even though the log entry existed and passed the category/title filter.
      const dataCostEach = Number(entry.data.cost_each);
      const dataCostTotal = Number(entry.data.cost_total);
      const totalQty = items.reduce((n, it) => n + (Number(it.qty) || 0), 0);

      for (const item of items) {
        const qty = Number(item.qty) || 0;
        // Per-item fields win when present (the "Item market buy" shape), then fall back
        // to the entry-level ones. cost_total covers the whole purchase, so it divides by
        // the total quantity, not this item's.
        const unitCost = Number(
          item.cost_each
          ?? item.price
          ?? (item.cost_total != null && qty ? item.cost_total / qty : undefined)
          ?? (Number.isFinite(dataCostEach) ? dataCostEach : undefined)
          ?? (Number.isFinite(dataCostTotal) && totalQty ? dataCostTotal / totalQty : NaN)
        );
        if (!qty || !Number.isFinite(unitCost)) {
          // Known purchase category/title and a real items[] array, but this
          // particular item's cost fields didn't parse - previously silently
          // dropped with no trace at all (confirmed via a debug export:
          // fetchedCount:2, matchedCount:0, skipped:[] - a poll that fetched
          // real entries but left zero record of why none of them logged).
          // Captured here the same way every other skip reason already is.
          if (skipped.length < 20) skipped.push({ title: details.title, category: details.category, rawItem: item });
          continue;
        }
        matchedCount++;
        // item.uid (per-copy instance id, null for stackables) rides along so a
        // later sale can match this exact copy - see consumeLotsForSale.
        logPurchaseIfNew(resolveItemName(item.id), qty, unitCost, `api-log:${entry.id}`, undefined, item.uid);
      }
    }
    if (maxTimestamp > logState.lastTimestamp) {
      logState = { lastTimestamp: maxTimestamp };
      saveLogState(logState);
    }
    return { matchedCount, skipped };
  }

  let logPollInFlight = false;
  // Set once Torn rejects the key outright (incorrect key / access level too low).
  // Torn warns that hammering the API with a bad key can get your IP temporarily
  // banned, so once a poll comes back with a fatal key error we stop polling
  // entirely instead of retrying every 5s forever. Cleared only when a new key is
  // saved (see the Save handler in renderApiKeySection). Ported from BUSTR.
  let logPollFatalError = false;

  async function pollLog() {
    const apiKey = getApiKey();
    if (!apiKey || logPollInFlight || logPollFatalError || document.hidden) return;
    logPollInFlight = true;
    try {
      await ensureItemCatalog(apiKey);
      // Rolling lookback, NOT a watermark (see LOG_POLL_LOOKBACK_SECONDS for why a
      // watermark silently loses late-published purchase entries). Re-fetching the
      // same window every poll is safe: purchase entries already stored are skipped
      // by the processed log-id ledger, non-purchase entries just re-classify as
      // skips. The watermark is still tracked, and when it is OLDER than the
      // lookback start (tab was closed for a while) the fetch starts from it
      // instead, so purchases made in that gap are backfilled too.
      const lookbackStart = Math.floor(Date.now() / 1000) - LOG_POLL_LOOKBACK_SECONDS;
      const since = logState.lastTimestamp
        ? Math.min(logState.lastTimestamp + 1, lookbackStart)
        : lookbackStart;
      const data = await tornApiFetch(`https://api.torn.com/v2/user/log?key=${apiKey}&from=${since}&limit=100`);
      const entries = extractLogEntries(data);
      // Refresh the durable dedup ledger from storage first, so a purchase that
      // another open tab (every tab runs its own poll on the same key) already
      // logged and recorded is skipped here instead of double-counted.
      processedLogIds = loadProcessedLogIds();
      processedLogIdSet = new Set(processedLogIds);
      const { matchedCount, skipped } = processLogEntries(entries);
      lastPollDebug = { at: new Date().toISOString(), since, fetchedCount: entries.length, matchedCount, skipped, error: null };
      setLogStatus(`Last checked ${new Date().toLocaleTimeString()}.`);
    } catch (e) {
      log('pollLog failed', e);
      lastPollDebug = { at: new Date().toISOString(), since: null, fetchedCount: null, matchedCount: 0, skipped: [], error: e.message };
      // Torn code 2 = incorrect key, 16 = access level too low. Both are
      // permanent for this key (a typo, a revoked key, or a key without the
      // `log` selection), not a transient network blip - so stop the auto-poll
      // instead of hammering the API with a key it will keep rejecting. Any
      // other error (network/HTTP/timeout) is left transient: the next tick
      // retries normally.
      if (e && (e.tornCode === 2 || e.tornCode === 16)) {
        logPollFatalError = true;
        setLogStatus(`API key rejected (${e.message}). Auto-check paused - re-enter your key in Settings.`);
      } else {
        setLogStatus(`Error: ${e.message}`);
      }
    } finally {
      logPollInFlight = false;
    }
  }

  // Do NOT poll the instant the DOM appears. On a reload that is precisely when Torn
  // is building the page and every other userscript is starting up, and piling an API
  // call plus its processing onto that window is what makes a reload feel frozen.
  // A few seconds' grace costs nothing: the poll uses a rolling lookback, so a late
  // start cannot miss a purchase.
  const POLL_START_DELAY_MS = 4000;
  function startLogPolling() {
    setTimeout(() => {
      pollLog();
      setInterval(pollLog, LOG_POLL_INTERVAL_MS);
    }, POLL_START_DELAY_MS);
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  AUTO-DETECT: sell/listing price field
  ////////////////////////////////////////////////////////////////////////////
  // Best-effort heuristic: find a text/number input whose own attributes (or
  // nearby label text) suggest it's a price field, then check whether the
  // surrounding container's text names exactly one item we hold. If so, wire
  // the Sell Check panel to that item and poll the input's value (covers
  // both native typing and another script setting .value programmatically,
  // which may not fire an 'input' event).

  let boundPriceInput = null;
  let pricePollHandle = null;

  // Requires the input's OWN attributes to say "price" - deliberately drops
  // the weaker "nearby text says price" checks that used to fire on totally
  // unrelated inputs on busy pages like the Item Market browse view (report:
  // bound to a stray input there and produced a nonsense multi-million loss
  // figure from garbage price/qty values it picked up off that page).
  function looksLikePriceField(input) {
    const haystack = [
      input.name, input.id, input.placeholder, input.getAttribute('aria-label'),
    ].filter(Boolean).join(' ').toLowerCase();
    return /price/.test(haystack);
  }

  // Only ever looks inside an actual open dialog/modal - no fallback to
  // "form" or the input's own parent, since those match far too much of a
  // normal page (see looksLikePriceField comment above for why that matters).
  function findListingDialog(input) {
    return input.closest('[role="dialog"], .modal');
  }

  function findQtyNear(input, container) {
    const candidates = container.querySelectorAll('input[type="number"], input[type="text"]');
    for (const c of candidates) {
      if (c === input) continue;
      const haystack = [c.name, c.id, c.placeholder, c.getAttribute('aria-label')]
        .filter(Boolean).join(' ').toLowerCase();
      if (/qty|quantity/.test(haystack)) return c;
    }
    return null;
  }

  function bindPriceInput(input, lotEntry, dialog) {
    if (boundPriceInput === input) return;
    unbindPriceInput();
    boundPriceInput = input;
    log('bound to price input', input, 'matched lot', lotEntry.itemName, lotEntry.id);

    if (panel.classList.contains('flipr-collapsed')) {
      panel.classList.remove('flipr-collapsed');
      $('#flipr-toggle').textContent = '\u25BE';
      applyPanelPosition(); // same reason as the header toggle: restore the window's own on-screen spot
    }
    $('#flipr-check-item').value = lotEntry.id;

    const qtyInput = findQtyNear(input, dialog);
    const sync = () => {
      // If the listing dialog got closed, the input is still technically a
      // live object but detached from the page - stop polling it instead of
      // running forever every 600ms until some other dialog happens to bind.
      if (!document.contains(input)) {
        unbindPriceInput();
        return;
      }
      if (document.hidden) return; // tab backgrounded - nothing to sync against right now
      $('#flipr-check-price').value = input.value.replace(/[^0-9.]/g, '');
      if (qtyInput && qtyInput.value) $('#flipr-check-qty').value = qtyInput.value.replace(/[^0-9.]/g, '');
      renderSellCheckResult();
    };
    input.addEventListener('input', sync);
    input._fliprSync = sync;
    pricePollHandle = setInterval(sync, 600);
    sync();
  }

  function unbindPriceInput() {
    if (boundPriceInput && boundPriceInput._fliprSync) {
      boundPriceInput.removeEventListener('input', boundPriceInput._fliprSync);
    }
    if (pricePollHandle) clearInterval(pricePollHandle);
    boundPriceInput = null;
    pricePollHandle = null;
  }

  function scanForPriceField() {
    if (document.hidden) return; // tab backgrounded - nothing to bind to right now
    if (!getDisplayEntries().length) return;
    if (boundPriceInput && document.contains(boundPriceInput)) return; // already bound and still on page
    const inputs = document.querySelectorAll('input[type="text"], input[type="number"], input:not([type])');
    for (const input of inputs) {
      if (!looksLikePriceField(input)) continue;
      const dialog = findListingDialog(input);
      if (!dialog) continue; // only bind inside an actual open listing dialog, never on a browse/listing page
      const entry = matchEntryInText(dialog.textContent);
      if (entry) {
        bindPriceInput(input, entry, dialog);
        return;
      }
    }
  }

  let scanDebounce = null;
  const debouncedScan = () => {
    clearTimeout(scanDebounce);
    scanDebounce = setTimeout(scanForPriceField, 800);
  };

  // Page type computed once (a fresh page load re-runs this whole script, so it
  // never changes mid-life). Used to attach heavy per-page listeners only where
  // they can actually do something, instead of on every Torn page.
  const IS_ITEM_MARKET = isItemMarketPage();
  // The observer is needed anywhere you can BUY (the purchasable pages, for the
  // instant confirmation scan) or LIST something for sale (those same pages plus
  // the Items page, where an inventory sell can start - for the Sell Check
  // price-field auto-detect). Everywhere else it is not attached.
  const OBSERVE_THIS_PAGE = isPurchasablePage() || /\/item\.php/i.test(location.pathname);

  // The whole-document observer (purchase-text detection + sell-dialog price-field
  // detection) is the script's one hot path: with `characterData` + `subtree` it
  // fires on every chat message, timer tick, and live-listing update. Attaching it
  // only on buy/sell pages means the majority of Torn browsing costs nothing. The
  // API poll below still runs on every page, so a purchase is caught even if you
  // navigate away immediately. `characterData` is needed alongside `childList` so a
  // label's text changing in place (the bazaar page's inline confirmation) is seen
  // too, not just whole new nodes appearing.
  if (OBSERVE_THIS_PAGE) {
    const pageObserver = new MutationObserver((mutations) => {
      if (document.hidden) return;
      scanMutationsForPurchaseText(mutations);
      debouncedScan();
    });
    // documentElement rather than body for the same defensive reason the panel is
    // appended to it above: observing null throws, and observing <html> covers body
    // once it is parsed anyway, subtree included.
    pageObserver.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
    debouncedScan();
    // Catch up immediately on returning to the tab, rather than waiting for the
    // next incidental page mutation to trigger a rescan.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) debouncedScan();
    });
  }

  startLogPolling();

  // Buy-page click handler: captures a clicked card's Damage/Accuracy/Armor (Item
  // Market AND bazaar) and, on the Item Market only, shows the after-5%-tax chip
  // (passive, read-only - see onItemMarketClick). Attached on every purchasable
  // page so bazaar buys get their stats too; the tax-chip portion self-gates to the
  // Item Market. Capture phase so the chip from a previous click is dismissed even
  // when the new click lands on a stopPropagation-ing element; Escape also closes it.
  if (isPurchasablePage()) {
    document.addEventListener('click', onItemMarketClick, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideTaxPopover();
    });
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  MARKET QUALITY OVERLAY (Item Market + Bazaar + Items page + Display Case)
  ////////////////////////////////////////////////////////////////////////////
  //
  // Draws a "Q %" quality badge and the bonus percentages onto each weapon/armour
  // listing so you can read the quality of what you are buying or holding at a
  // glance. FLIPR's own card readers do the reading; the base-stat numbers and the
  // quality formula are facts about the game, not code borrowed from anywhere.
  //
  // Quality is DERIVED, never fetched from an item-info API: Torn already renders
  // each listing's damage/accuracy (or armour) on the tile, and a fixed 0%-quality
  // base value per item is known, so quality is just how far above base this copy
  // sits:
  //     weapon: ((dmg - baseDmg) + (acc - baseAcc)) * 10
  //     armour: (armour - baseArmour) * 20
  //
  // Data sources per page - both read-only, both adding ZERO API calls:
  //   Bazaar      pure DOM. The item ID is in the tile's image URL; damage/
  //               accuracy/armour and the bonuses are on the tile.
  //   Item Market the newer React tiles carry no item ID, so the page's OWN
  //               responses (the sid=iMarket calls Torn already makes) are read via
  //               a pass-through fetch wrapper into an in-memory cache of
  //               {id, price, stats, bonuses}, and each tile is matched to it by
  //               price + stats. That cache is EPHEMERAL - never written to storage,
  //               never reused for anything else, capped in size, gone on reload -
  //               which is the boundary Torn staff confirmed is acceptable. The
  //               wrapper only observes; it never blocks or alters a response.
  //
  // If another quality-overlay script has already tagged a listing (a known marker
  // class), FLIPR steps aside on that tile so the two never draw over each other.

  // Base (0%-quality) Damage per item ID. Torn's own values (facts); keep in step
  // with the game as new weapons ship or their listings simply show no badge.
  const MQ_BASE_DAMAGE = {
    1: 17, 2: 16, 3: 20, 4: 11, 5: 21, 6: 25, 7: 28, 8: 34, 9: 40, 10: 61,
    11: 58, 12: 28, 13: 29, 14: 32, 15: 36, 16: 44, 17: 48, 18: 52, 19: 55, 20: 59,
    21: 64, 22: 41, 23: 39, 24: 45, 25: 48, 26: 56, 27: 55, 28: 59, 29: 61, 30: 64,
    31: 67, 63: 72, 76: 52, 98: 59, 99: 33, 100: 64, 108: 65, 109: 77, 110: 27, 111: 39,
    146: 65, 147: 22, 170: 60, 173: 24, 174: 50, 175: 1, 177: 61, 189: 42, 217: 57, 218: 35,
    219: 63, 223: 69, 224: 23, 225: 56, 227: 38, 228: 50, 230: 18, 231: 60, 232: 62, 233: 61,
    234: 31, 235: 22, 236: 35, 237: 62, 238: 29, 240: 78, 241: 50, 243: 30, 244: 15, 245: 13,
    247: 52, 248: 62, 249: 46, 250: 50, 251: 53, 252: 49, 253: 27, 254: 47, 255: 67, 289: 70,
    290: 70, 291: 70, 292: 70, 346: 40, 359: 16, 360: 53, 382: 75, 387: 67, 388: 74, 391: 57,
    393: 14, 395: 61, 397: 71, 398: 69, 399: 68, 400: 63, 401: 26, 402: 51, 438: 18, 439: 19,
    440: 1, 483: 42, 484: 46, 485: 40, 486: 38, 487: 39, 488: 37, 489: 35, 490: 46, 539: 36,
    545: 79, 546: 76, 547: 78, 548: 77, 549: 80, 599: 60, 600: 61, 604: 43, 605: 45, 612: 65,
    613: 47, 614: 60, 615: 64, 632: 48, 790: 5, 792: 17, 805: 18, 830: 95, 831: 54, 832: 21,
    837: 66, 838: 63, 839: 60, 844: 15, 845: 58, 846: 56, 850: 58, 871: 5, 874: 68, 1053: 41,
    1055: 35, 1056: 40, 1152: 76, 1153: 74, 1154: 73, 1155: 70, 1156: 68, 1157: 69, 1158: 62,
    1159: 51, 1173: 37, 1231: 29, 1255: 54, 1257: 1, 1296: 27
  };
  const MQ_BASE_ACCURACY = {
    1: 55, 2: 57, 3: 52, 4: 62, 5: 45, 6: 55, 7: 60, 8: 52, 9: 58, 10: 23,
    11: 52, 12: 53, 13: 52, 14: 56, 15: 54, 16: 58, 17: 51, 18: 49, 19: 38, 20: 36,
    21: 30, 22: 63, 23: 65, 24: 51, 25: 51, 26: 52, 27: 47, 28: 55, 29: 47, 30: 45,
    31: 41, 63: 28, 76: 24, 98: 24, 99: 57, 100: 24, 108: 43, 109: 39, 110: 52, 111: 51,
    146: 49, 147: 15, 170: 24, 173: 55, 174: 56, 175: 54, 177: 53, 189: 54, 217: 49, 218: 63,
    219: 55, 223: 52, 224: 52, 225: 62, 227: 48, 228: 48, 230: 22, 231: 46, 232: 50, 233: 55,
    234: 52, 235: 59, 236: 55, 237: 56, 238: 52, 240: 25, 241: 57, 243: 57, 244: 39, 245: 55,
    247: 55, 248: 53, 249: 47, 250: 53, 251: 51, 252: 62, 253: 41, 254: 52, 255: 39, 289: 54,
    290: 54, 291: 54, 292: 54, 346: 63, 359: 50, 360: 57, 382: 62, 387: 63, 388: 45, 391: 65,
    393: 54, 395: 60, 397: 28, 398: 50, 399: 57, 400: 35, 401: 33, 402: 60, 438: 42, 439: 43,
    440: 63, 483: 52, 484: 41, 485: 54, 486: 45, 487: 43, 488: 41, 489: 48, 490: 24, 539: 55,
    545: 38, 546: 47, 547: 46, 548: 45, 549: 36, 599: 48, 600: 41, 604: 45, 605: 48, 612: 52,
    613: 63, 614: 62, 615: 52, 632: 48, 790: 29, 792: 57, 805: 55, 830: 45, 831: 53, 832: 54,
    837: 36, 838: 60, 839: 45, 844: 45, 845: 53, 846: 52, 850: 50, 871: 59, 874: 57, 1053: 65,
    1055: 49, 1056: 47, 1152: 42, 1153: 44, 1154: 40, 1155: 45, 1156: 36, 1157: 49, 1158: 39,
    1159: 56, 1173: 67, 1231: 59, 1255: 52, 1257: 59, 1296: 58
  };
  const MQ_BASE_ARMOUR = {
    32: 20, 33: 32, 34: 34, 49: 31, 50: 36, 176: 23, 178: 30, 332: 38, 333: 40, 334: 42,
    348: 10, 538: 25, 640: 32, 641: 34, 642: 30, 643: 30, 644: 34, 645: 30, 646: 24, 647: 20,
    648: 20, 649: 20, 650: 20, 651: 38, 652: 38, 653: 38, 654: 38, 655: 35, 656: 45, 657: 45,
    658: 45, 659: 45, 660: 44, 661: 44, 662: 44, 663: 44, 664: 44, 665: 46, 666: 46, 667: 46,
    668: 46, 669: 46, 670: 49, 671: 49, 672: 49, 673: 49, 674: 49, 675: 40, 676: 52, 677: 52,
    678: 52, 679: 52, 680: 55, 681: 55, 682: 55, 683: 55, 684: 55, 848: 32, 1164: 38, 1165: 50,
    1166: 50, 1167: 50, 1168: 50, 1174: 39, 1307: 53, 1308: 53, 1309: 53, 1310: 53, 1311: 53,
    1355: 48, 1356: 48, 1357: 48, 1358: 48, 1359: 48
  };

  // Bonuses with a fixed effect and no percentage (shown as a bare name).
  const MQ_FIXED_BONUSES = new Set(['Smash', 'Sleep', 'Storage']);
  // Tier colours by how close to the top of its range the quality is (0-100%
  // normalised): weak -> strong. Two palettes so the badge reads on either theme.
  const MQ_TIER = {
    dark: ['#e4e4e4', '#57efea', '#c286ff', '#ffd700'],
    light: ['#717171', '#009590', '#8e19c1', '#e37100']
  };
  const MQ_CACHE_MAX = 1500;

  const mqCache = [];            // ephemeral Item Market listings (see section header)
  let mqProcessed = new WeakMap(); // tile -> last drawn signature, so a redraw is a no-op
  let mqBazaarObserver = null;
  let mqItemMarketObserver = null;
  let mqInventoryObserver = null;
  let mqDisplayCaseObserver = null;
  let mqStarted = false;
  let mqRaf = 0;

  // Item Market quality filter (HIGHLIGHT-only, non-destructive): glow the tiles whose
  // derived Q% is >= a minimum (and, optionally, that carry a named bonus). Torn's own
  // filters cannot target our Q%, so this fills that gap; it only marks tiles, never
  // hides or reorders them. State persists in localStorage.
  const MQ_FILTER_KEY = 'flipr_mq_filter_v1';
  let mqFilter = { on: false, minQ: 0, bonus: '' };
  try { const s = JSON.parse(localStorage.getItem(MQ_FILTER_KEY) || 'null'); if (s && typeof s === 'object') mqFilter = { on: !!s.on, minQ: +s.minQ || 0, bonus: String(s.bonus || '') }; } catch (e) { /* defaults */ }
  function mqSaveFilter() { try { localStorage.setItem(MQ_FILTER_KEY, JSON.stringify(mqFilter)); } catch (e) { /* ignore */ } }
  function mqMatchesFilter(quality, bonuses) {
    if (quality == null || quality < mqFilter.minQ) return false;
    const want = mqFilter.bonus.trim().toLowerCase();
    if (want && !(bonuses || []).some((b) => (b.name || '').toLowerCase().includes(want))) return false;
    return true;
  }

  const mqIsBazaar = () => /\/bazaar\.php/i.test(location.pathname);
  const mqIsInventory = () => /\/item\.php/i.test(location.pathname);
  const mqIsDisplayCase = () => /\/displaycase\.php/i.test(location.pathname);
  const mqIsArmoury = () => /\/factions\.php/i.test(location.pathname) && /tab=armoury/i.test(location.hash);

  // Coalesce the flurry of observer callbacks (Torn redraws the whole grid on any
  // scroll/filter) into one pass per frame. The signature gate below makes each
  // pass idempotent, so our own badge inserts can't drive an infinite loop.
  function mqSchedule() {
    if (mqRaf) return;
    mqRaf = requestAnimationFrame(() => { mqRaf = 0; try { mqProcessCurrent(); } catch (e) {} });
  }

  function mqBase(itemID) {
    const id = String(itemID);
    if (!(id in MQ_BASE_DAMAGE) && !(id in MQ_BASE_ACCURACY) && !(id in MQ_BASE_ARMOUR)) return null;
    return { dmg: MQ_BASE_DAMAGE[id] || 0, acc: MQ_BASE_ACCURACY[id] || 0, armour: MQ_BASE_ARMOUR[id] || 0 };
  }

  // Quality as a number (percent), or null if the item isn't in the base tables.
  function mqQuality(itemID, dmg, acc, armour) {
    const base = mqBase(itemID);
    if (!base) return null;
    if (armour != null && armour > 0) return (armour - base.armour) * 20;
    if (dmg == null && acc == null) return null;
    return (((dmg || 0) - base.dmg) + ((acc || 0) - base.acc)) * 10;
  }

  const mqDark = () => !!(document.body && document.body.classList.contains('dark-mode'));

  function mqTierColour(quality, maxRange) {
    const norm = (Math.min(Math.max(quality, 0), maxRange) / maxRange) * 100;
    const t = mqDark() ? MQ_TIER.dark : MQ_TIER.light;
    if (norm <= 25) return t[0];
    if (norm <= 50) return t[1];
    if (norm <= 75) return t[2];
    return t[3];
  }

  // Draw (or replace) the "Q %" pill over the tile's image.
  function mqInjectBadge(imageWrapper, quality, maxRange) {
    if (!imageWrapper) return;
    const clamped = Math.min(Math.max(quality, 0), maxRange);
    const old = imageWrapper.querySelector('.flipr-q-badge');
    if (old) old.remove();
    const dark = mqDark();
    const badge = document.createElement('div');
    badge.className = 'flipr-q-badge';
    badge.textContent = 'Q ' + clamped.toFixed(1) + '%';
    badge.style.cssText = 'position:absolute;top:2px;left:2px;padding:1px 3px;border-radius:3px;' +
      'font-size:11px;font-weight:bold;z-index:5;pointer-events:none;line-height:1.2;' +
      'background:' + (dark ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.9)') + ';' +
      'color:' + mqTierColour(quality, maxRange) + ';';
    if (getComputedStyle(imageWrapper).position === 'static') imageWrapper.style.position = 'relative';
    imageWrapper.appendChild(badge);
  }

  // Draw (or replace) the bonuses under the item's name as compact FLIPR-purple
  // pills - a distinct, at-a-glance row rather than a plain text list.
  function mqInjectBonuses(titleEl, bonuses, insertBeforeEl, inline) {
    if (!titleEl) return;
    const old = titleEl.querySelector('.flipr-mq-bonuses');
    if (old) old.remove();
    if (!bonuses || !bonuses.length) return;
    const dark = mqDark();
    const box = document.createElement('div');
    box.className = 'flipr-mq-bonuses';
    // inline mode (compact "Your items" list rows): sit to the RIGHT of the name
    // text instead of a block below it, which in a fixed-height row overflows and
    // overlaps the next row. Grid/market layouts use the block-below default.
    box.style.cssText = inline
      ? 'display:inline-flex;flex-wrap:wrap;gap:3px;margin-left:6px;vertical-align:middle;'
      : 'display:flex;flex-wrap:wrap;gap:3px;margin-top:2px;';
    for (const b of bonuses) {
      const pill = document.createElement('span');
      pill.style.cssText = 'display:inline-block;padding:1px 6px;border-radius:9px;' +
        'font-size:10px;font-weight:600;line-height:1.4;white-space:nowrap;' +
        'background:' + (dark ? 'rgba(150,90,220,0.22)' : 'rgba(120,40,180,0.1)') + ';' +
        'color:' + (dark ? '#e8d1ff' : '#5b1785') + ';' +
        'border:1px solid ' + (dark ? 'rgba(180,130,240,0.35)' : 'rgba(120,40,180,0.25)') + ';';
      if (MQ_FIXED_BONUSES.has(b.name)) pill.textContent = b.name;
      else if (b.value != null && b.value !== '') pill.textContent = b.name + ' ' + b.value + (b.pct ? '%' : '');
      else pill.textContent = b.name;
      box.appendChild(pill);
    }
    if (insertBeforeEl && insertBeforeEl.parentNode === titleEl) titleEl.insertBefore(box, insertBeforeEl);
    else titleEl.appendChild(box);
  }

  // Bazaar bonus icons carry the name/description in data attributes; the title can
  // be a little HTML (<b>Name</b>...). Stat icons (damage/accuracy/armour) live in a
  // different group but are excluded here defensively.
  function mqReadBazaarBonuses(tile) {
    const out = [];
    const icons = tile.querySelectorAll('[class*="iconBonuses___"] i, i[data-bonus-attachment-title]');
    for (const icon of icons) {
      const cls = icon.getAttribute('class') || '';
      if (/bonus-attachment-item-(damage|accuracy|armou?r|defen[cs]e)-bonus/i.test(cls)) continue;
      const rawTitle = icon.getAttribute('data-bonus-attachment-title') || '';
      const rawDesc = icon.getAttribute('data-bonus-attachment-description') || '';
      if (!rawTitle && !rawDesc) continue;
      const tmp = document.createElement('div');
      tmp.innerHTML = rawTitle;
      const bold = tmp.querySelector('b');
      const name = ((bold ? bold.textContent : tmp.textContent) || '').trim();
      if (!name) continue;
      const descText = ((tmp.textContent || '').replace(name, '').trim()) || rawDesc;
      const num = descText.match(/(\d+(?:\.\d+)?)/);
      const value = num ? num[1] : null;
      const pct = value != null && new RegExp(value.replace('.', '\\.') + '\\s*%').test(descText);
      out.push({ name, value, pct });
    }
    return out;
  }

  // Item Market bonuses come from the cached listing (shape is best-effort: read a
  // name and, if present, a percentage). The quality badge does not depend on this.
  function mqApiBonuses(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const b of arr) {
      if (!b) continue;
      const name = String(b.title || b.type || b.name || '').trim();
      if (!name) continue;
      const value = (b.value != null && b.value !== '') ? b.value : null;
      const desc = String(b.description || '');
      const pct = value != null && new RegExp(String(value).replace('.', '\\.') + '\\s*%').test(desc);
      out.push({ name, value, pct });
    }
    return out;
  }

  const mqRound2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

  function mqPlausible(quality, maxRange) {
    // A wrong cache match or a mis-read shows up as a wildly out-of-band number;
    // clamp the display but refuse to draw an obviously nonsense badge.
    return quality > -60 && quality < maxRange + 120;
  }

  // ---- Bazaar (pure DOM) --------------------------------------------------
  function mqProcessBazaar() {
    const tiles = document.querySelectorAll('#bazaarRoot [class*="item___"]');
    for (const tile of tiles) {
      if (tile.querySelector('.openmarket-quality-box')) continue; // another quality script already tagged this tile
      const img = tile.querySelector('[class*="imgContainer___"] img');
      if (!img) continue;
      const m = (img.src || '').match(/\/images\/items\/(\d+)\//);
      if (!m || !mqBase(m[1])) continue;
      const itemID = m[1];
      const stats = readCardStats(tile);
      if (!stats) continue;
      const quality = mqQuality(itemID, stats.dmg, stats.acc, stats.armor);
      if (quality == null) continue;
      const maxRange = (stats.armor != null && stats.armor > 0) ? 100 : 300;
      if (!mqPlausible(quality, maxRange)) continue;
      const bonuses = mqReadBazaarBonuses(tile);
      const sig = itemID + '|' + stats.dmg + '|' + stats.acc + '|' + stats.armor + '|' +
        bonuses.map((b) => b.name + b.value).join(',');
      if (mqProcessed.get(tile) === sig) continue;
      const imageWrapper = tile.querySelector('[class*="imgBar___"]') || img.parentElement;
      const titleEl = tile.querySelector('[class*="description___"]');
      const stockEl = titleEl ? titleEl.querySelector('[class*="amount___"]') : null;
      mqInjectBadge(imageWrapper, quality, maxRange);
      mqInjectBonuses(titleEl, bonuses, stockEl);
      mqProcessed.set(tile, sig);
    }
  }

  function mqInitBazaar() {
    mqWaitFor('#bazaarRoot', (root) => {
      mqSchedule();
      const obs = new MutationObserver(() => mqSchedule());
      obs.observe(root, { childList: true, subtree: true });
      mqBazaarObserver = obs;
    });
  }

  // ---- Item Market (fetch cache + tile matching) --------------------------
  function mqPushCache(items) {
    const seen = new Set(mqCache.map((i) => i.listingID));
    for (const it of items) if (it && !seen.has(it.listingID)) mqCache.push(it);
    if (mqCache.length > MQ_CACHE_MAX) mqCache.splice(0, mqCache.length - MQ_CACHE_MAX);
  }

  function mqMatchCache(tile) {
    const priceEl = tile.querySelector('[class*="priceAndTotal___"] span');
    const price = priceEl ? parseInt((priceEl.textContent || '').replace(/[^\d]/g, ''), 10) : 0;
    if (!price) return null;
    const stats = readCardStats(tile) || { dmg: null, acc: null, armor: null };
    const dmg = mqRound2(stats.dmg), acc = mqRound2(stats.acc), armor = mqRound2(stats.armor);
    const hits = mqCache.filter((it) => {
      if (it.minPrice !== price) return false;
      if (it.armor && it.armor > 0) return mqRound2(it.armor) === armor;
      return mqRound2(it.damage) === dmg && mqRound2(it.accuracy) === acc;
    });
    return hits.length === 1 ? hits[0] : null; // 0 or ambiguous: don't guess
  }

  // The Item Market list is a CSS grid with FIXED 115px rows (grid-template-rows:
  // 115px 115px ...), so a second bonus pill - or a long name that wraps - grows
  // past the 115px cell and bleeds into the card below. Let each row size to its
  // OWN content instead - at least Torn's original 115px, taller only where the
  // extra pill/name actually needs it - via one injected stylesheet that beats
  // Torn's hashed class rules. Removed again when the overlay is switched off.
  //
  // We deliberately do NOT pin a fixed 140px row or force a tile min-height any more:
  // that stretched every SHORT weapon tile (and the image Torn sizes to fill it) taller
  // than its content, which is what mangled the weapon images. minmax(115px,auto) keeps
  // the native look on normal tiles and only grows the ones that overflow.
  function mqEnsureMarketGridStyle() {
    if (document.getElementById('flipr-mq-grid')) return;
    const st = document.createElement('style');
    st.id = 'flipr-mq-grid';
    // Two-underscore substring matches Torn's hashed classes (itemList__x /
    // itemTile__x) whether the build uses two or three underscores. "itemList__"
    // matches only the grid, not itemListWrapper__ (no "__" right after "itemList").
    st.textContent =
      '[class*="itemList__"]{grid-template-rows:none !important;grid-auto-rows:minmax(115px,auto) !important;}';
    (document.head || document.documentElement).appendChild(st);
  }

  function mqProcessItemMarket() {
    // Root id can drift; fall back to a document-wide tile query so a renamed
    // container never silently kills the overlay.
    let tiles = document.querySelectorAll('#item-market-root [class*="itemTile___"]');
    if (!tiles.length) tiles = document.querySelectorAll('[class*="itemTile___"]');
    let drew = 0; // weapon/armour tiles on this page (categories like energy drinks have none)
    for (const tile of tiles) {
      if (tile.querySelector('.openmarket-quality-box')) continue; // another quality script already tagged this tile

      // Preferred path: read the item ID straight from the tile image, exactly
      // like the Bazaar. No fetch, no cache, no cross-context anything - so when
      // it works it is the most reliable and most compliant route.
      let itemID = null, dmg = null, acc = null, armour = null, bonuses = [], listingSig = '';
      const img = tile.querySelector('img');
      const m = img && (img.src || '').match(/\/images\/items\/(\d+)\//);
      if (m && mqBase(m[1])) {
        const stats = readCardStats(tile);
        if (!stats) continue;
        itemID = m[1];
        dmg = stats.dmg; acc = stats.acc; armour = stats.armor;
        bonuses = mqReadBazaarBonuses(tile);
      } else {
        // Fallback: the ID is not in the DOM, so match the tile to a listing we
        // observed Torn fetch (ephemeral cache - see the fetch wrapper below).
        if (!mqCache.length) continue;
        const cached = mqMatchCache(tile);
        if (!cached || !mqBase(cached.itemID)) continue;
        itemID = cached.itemID;
        dmg = cached.damage || null; acc = cached.accuracy || null; armour = cached.armor || null;
        bonuses = mqApiBonuses(cached.bonuses);
        listingSig = '|' + cached.listingID;
      }

      const quality = mqQuality(itemID, dmg, acc, armour);
      if (quality == null) continue;
      const maxRange = (armour != null && armour > 0) ? 100 : 300;
      if (!mqPlausible(quality, maxRange)) continue;
      drew++; // a weapon/armour tile we own the overlay for (counted even if the redraw is a no-op)
      const filterSig = mqFilter.on ? ('|F' + mqFilter.minQ + ':' + mqFilter.bonus) : '';
      const sig = itemID + listingSig + '|' + dmg + '|' + acc + '|' + armour + '|' +
        bonuses.map((b) => b.name + b.value).join(',') + filterSig;
      if (mqProcessed.get(tile) === sig) continue;
      const imageWrapper = tile.querySelector('[class*="tileImage___"]') || (img && img.parentElement);
      const titleEl = tile.querySelector('div > [class*="title___"]') || tile.querySelector('[class*="title___"]');
      mqInjectBadge(imageWrapper, quality, maxRange);
      mqInjectBonuses(titleEl, bonuses, null);
      tile.classList.toggle('flipr-mq-match', mqFilter.on && mqMatchesFilter(quality, bonuses)); // highlight-only filter
      mqProcessed.set(tile, sig);
    }
    // Only reshape the grid and show the filter when this category actually has
    // weapons/armour. On energy drinks / other non-gear categories we draw nothing,
    // so leave Torn's native layout alone (the 140px override mangled small tiles).
    if (drew) { mqEnsureMarketGridStyle(); mqEnsureFilterStyle(); mqEnsureFilterBar(); }
    else {
      const gs = document.getElementById('flipr-mq-grid');
      if (gs) gs.remove();
      mqRemoveFilterBar();
    }
  }

  // ---- Item Market quality filter (highlight-only) ------------------------
  function mqEnsureFilterStyle() {
    if (document.getElementById('flipr-mq-filter-style')) return;
    const st = document.createElement('style');
    st.id = 'flipr-mq-filter-style';
    st.textContent =
      '.flipr-mq-match{outline:2px solid #b06bf0 !important;outline-offset:-2px !important;' +
      'box-shadow:0 0 12px rgba(176,107,240,0.75) !important;border-radius:5px;}' +
      '#flipr-mq-filter{position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:99998;' +
      'display:flex;align-items:center;gap:7px;padding:6px 10px;border-radius:9px;font:600 12px/1.3 inherit;' +
      'background:rgba(20,16,28,0.96);color:#e8d1ff;border:1px solid rgba(180,130,240,0.45);' +
      'box-shadow:0 3px 12px rgba(0,0,0,0.55);}' +
      '#flipr-mq-filter input[type=number]{width:46px;}#flipr-mq-filter input[type=text]{width:96px;}' +
      '#flipr-mq-filter input{background:rgba(255,255,255,0.06);color:#f2e8ff;border:1px solid rgba(180,130,240,0.4);' +
      'border-radius:5px;padding:2px 5px;font:inherit;}' +
      '#flipr-mq-filter label{display:flex;align-items:center;gap:4px;white-space:nowrap;}' +
      '#flipr-mq-filter .flipr-mq-x{cursor:pointer;opacity:0.7;padding:0 2px;}#flipr-mq-filter .flipr-mq-x:hover{opacity:1;}';
    (document.head || document.documentElement).appendChild(st);
  }

  function mqRemoveFilterBar() {
    const b = document.getElementById('flipr-mq-filter');
    if (b) b.remove();
  }

  // A small fixed control (bottom centre) for the Item Market only. Highlights tiles
  // whose derived Q% is >= "Q>=" and (if set) that carry the named bonus. Non-
  // destructive: it never hides or reorders, just glows the matches.
  function mqEnsureFilterBar() {
    if (document.getElementById('flipr-mq-filter')) return;
    const bar = document.createElement('div');
    bar.id = 'flipr-mq-filter';
    const tag = document.createElement('span'); tag.textContent = 'FLIPR filter'; tag.style.cssText = 'font-weight:800;letter-spacing:0.2px;';
    const onWrap = document.createElement('label');
    const onBox = document.createElement('input'); onBox.type = 'checkbox'; onBox.checked = mqFilter.on;
    onWrap.appendChild(onBox); onWrap.appendChild(document.createTextNode('on'));
    const qWrap = document.createElement('label'); qWrap.appendChild(document.createTextNode('Q>='));
    const qIn = document.createElement('input'); qIn.type = 'number'; qIn.step = '1'; qIn.value = String(mqFilter.minQ); qWrap.appendChild(qIn);
    const bWrap = document.createElement('label'); bWrap.appendChild(document.createTextNode('bonus'));
    const bIn = document.createElement('input'); bIn.type = 'text'; bIn.placeholder = 'any'; bIn.value = mqFilter.bonus; bWrap.appendChild(bIn);
    const x = document.createElement('span'); x.className = 'flipr-mq-x'; x.textContent = 'x'; x.title = 'Hide this bar (turns the filter off)';
    const sync = () => { mqFilter.on = onBox.checked; mqFilter.minQ = +qIn.value || 0; mqFilter.bonus = bIn.value || ''; mqSaveFilter(); mqSchedule(); };
    onBox.addEventListener('change', sync);
    qIn.addEventListener('input', sync);
    bIn.addEventListener('input', sync);
    x.addEventListener('click', () => { mqFilter.on = false; mqSaveFilter(); document.querySelectorAll('.flipr-mq-match').forEach((el) => el.classList.remove('flipr-mq-match')); mqRemoveFilterBar(); });
    bar.appendChild(tag); bar.appendChild(onWrap); bar.appendChild(qWrap); bar.appendChild(bWrap); bar.appendChild(x);
    (document.body || document.documentElement).appendChild(bar);
  }

  // Pass-through wrapper on the page's own fetch: it reads the Item Market listing
  // responses Torn already requests and does nothing else - never blocks, never
  // alters, never issues a request of its own. Guarded so it installs at most once.
  function mqInstallFetchHook() {
    // FLIPR runs in the userscript sandbox (it uses GM_* storage), so plain
    // window.fetch here is the sandbox's copy, NOT the fetch Torn's page calls -
    // wrapping it would observe nothing. unsafeWindow is the real page window, so
    // its fetch is the one Torn's Item Market actually uses. Fall back to window
    // for engines (e.g. Torn PDA) that run us in the page and expose no
    // unsafeWindow; both cases are guarded so nothing ever throws.
    let pageWin;
    try { pageWin = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window; }
    catch (e) { pageWin = window; }
    if (!pageWin || pageWin.__fliprMqFetchHooked) return;
    const original = pageWin.fetch;
    if (typeof original !== 'function') return;
    pageWin.__fliprMqFetchHooked = true;
    pageWin.fetch = function (...args) {
      const out = original.apply(this, args);
      try {
        const a0 = args[0];
        const url = (a0 && typeof a0 === 'object' && a0.url) ? String(a0.url) : String(a0 || '');
        if (/sid=iMarket/i.test(url) && out && typeof out.then === 'function') {
          out.then((resp) => {
            try {
              resp.clone().json().then((data) => {
                if (data && Array.isArray(data.items) && data.items.length) {
                  mqPushCache(data.items);
                  mqSchedule();
                }
              }).catch(() => {});
            } catch (e) { /* cross-context read refused: DOM path still covers it */ }
          }).catch(() => {});
        }
      } catch (e) { /* never let our observation break the page's fetch */ }
      return out;
    };
  }

  function mqInitItemMarket() {
    mqInstallFetchHook();
    mqWaitFor('#item-market-root', (root) => {
      mqSchedule();
      const obs = new MutationObserver(() => mqSchedule());
      obs.observe(root, { childList: true, subtree: true });
      mqItemMarketObserver = obs;
    });
  }

  // ---- Items page / inventory (pure DOM) ----------------------------------
  // item.php lists each owned weapon/armour as an <li data-item="ID"> whose
  // damage/accuracy (or armour) sit in an inline .bonuses-wrap - the SAME
  // bonus-attachment icon markup the bazaar uses - so readCardStats reads it with
  // no expansion and no API call. The item ID is right on the tile (data-item),
  // so quality is derived exactly like the bazaar. Empty bonus slots render as
  // bonus-attachment-blank-* icons and are skipped; a real weapon bonus (Poison
  // etc.) carries its own icon + value span, read best-effort below.
  // The intrinsic weapon bonus (Poison, Slow, ...) is the icon carrying a
  // non-empty data-bonusid; empty slots have data-bonusid="", the damage/accuracy
  // stat icons carry none (they use a value <span> instead, read as quality), and
  // the player's attached mods (Reflex Sight etc.) are a different group without a
  // bonusid - so this cleanly reads the weapon bonus and nothing else. The tooltip
  // name/effect lives ENTITY-ENCODED in the icon's title ("&lt;b&gt;Slow&lt;/b&gt;
  // &lt;br&gt;25% chance to ..."), so it is decoded once, then the bold is the
  // name and the first percentage in the rest is the value (e.g. Poison: 96%).
  function mqReadInventoryBonuses(tile) {
    const out = [];
    const wrap = tile.querySelector('.bonuses-wrap');
    if (!wrap) return out;
    const decode = (html) => { const ta = document.createElement('textarea'); ta.innerHTML = html || ''; return ta.value; };
    for (const icon of wrap.querySelectorAll('i[data-bonusid]')) {
      if (!icon.getAttribute('data-bonusid')) continue; // empty slot
      const holder = document.createElement('div');
      holder.innerHTML = decode(icon.getAttribute('title') || '');
      const bold = holder.querySelector('b');
      let name = ((bold ? bold.textContent : '') || '').trim();
      if (!name) {
        const nm = (icon.getAttribute('class') || '').match(/bonus-attachment-([a-z0-9-]+)/i);
        if (nm && nm[1]) name = nm[1].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      }
      if (!name) continue;
      const desc = (holder.textContent || '').replace(name, '').trim();
      const pm = desc.match(/(\d+(?:\.\d+)?)\s*%/);
      out.push({ name, value: pm ? pm[1] : null, pct: !!pm });
    }
    return out;
  }

  function mqProcessInventory() {
    const tiles = document.querySelectorAll('li[data-item]');
    for (const tile of tiles) {
      if (tile.querySelector('.openmarket-quality-box')) continue; // another quality script already tagged this tile
      const itemID = tile.getAttribute('data-item');
      if (!itemID || !mqBase(itemID)) continue; // only weapons/armour we have a base for
      const stats = readCardStats(tile);
      if (!stats) continue;
      const quality = mqQuality(itemID, stats.dmg, stats.acc, stats.armor);
      if (quality == null) continue;
      const maxRange = (stats.armor != null && stats.armor > 0) ? 100 : 300;
      if (!mqPlausible(quality, maxRange)) continue;
      const bonuses = mqReadInventoryBonuses(tile);
      const sig = itemID + '|' + stats.dmg + '|' + stats.acc + '|' + stats.armor + '|' +
        bonuses.map((b) => b.name + b.value).join(',');
      if (mqProcessed.get(tile) === sig) continue;
      const imageWrapper = tile.querySelector('.thumbnail') || tile.querySelector('.item-plate');
      const nameWrap = tile.querySelector('.name-wrap') || tile.querySelector('.title');
      mqInjectBadge(imageWrapper, quality, maxRange);
      mqInjectBonuses(nameWrap, bonuses, null, true); // inline: right of the name in the compact list
      mqProcessed.set(tile, sig);
    }
  }

  // ---- Display case (pure DOM) --------------------------------------------
  // displaycase.php is CLASSIC (not React). Each grid tile is:
  //   li.torn-divider
  //     div.b-item-name  > span "Leather Vest"          <- name (SIBLING of the wrap)
  //     div.b-item-wrap                                 <- the tile we scan
  //       span.item-plate > img.torn-item               <- image
  //       div.item-hover[itemid="32"]                   <- item ID lives here
  //       div.item-bonuses
  //         div.iconbonuses   (the weapon bonus attachment, e.g. Shock)
  //         div.infobonuses   (the stat icons: damage/accuracy or defence + value)
  // So the ID comes off .item-hover[itemid], the stats are read by readCardStats from
  // .infobonuses' bonus-attachment icons (same markup the bazaar uses), and the weapon
  // bonus is read from .item-bonuses (skipping the stat icons). The badge goes into the
  // .b-item-wrap itself (appended last, so it sits above the .item-hover overlay), and
  // the pills go into the sibling .b-item-name via the parent <li>. Works on anyone's
  // case you view, not just your own - no expansion, no API call.
  function mqReadDisplayCaseBonuses(wrap) {
    const out = [];
    const box = wrap.querySelector('.item-bonuses') || wrap;
    for (const span of box.querySelectorAll('span.bonus-attachment')) {
      const icon = span.querySelector('i');
      const cls = (icon && icon.getAttribute('class')) || '';
      if (/bonus-attachment-item-(damage|accuracy|armou?r|defen[cs]e)-bonus/i.test(cls)) continue; // stat -> quality, not a bonus
      if (/bonus-attachment-blank/i.test(cls)) continue; // empty slot
      const rawTitle = span.getAttribute('title') || (icon && icon.getAttribute('title')) || '';
      const holder = document.createElement('div');
      holder.innerHTML = rawTitle; // display-case titles are real HTML (<b>Name</b><br>...)
      const bold = holder.querySelector('b');
      let name = ((bold ? bold.textContent : '') || '').trim();
      if (!name) {
        const nm = cls.match(/bonus-attachment-([a-z0-9-]+)/i);
        if (nm && nm[1]) name = nm[1].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      }
      if (!name) continue;
      const desc = (holder.textContent || '').replace(name, '').trim();
      const pm = desc.match(/(\d+(?:\.\d+)?)\s*%/);
      out.push({ name, value: pm ? pm[1] : null, pct: !!pm });
    }
    return out;
  }

  function mqProcessDisplayCase() {
    const wraps = document.querySelectorAll('.b-item-wrap');
    for (const wrap of wraps) {
      if (wrap.querySelector('.openmarket-quality-box')) continue; // another quality script already tagged this tile
      const hover = wrap.querySelector('.item-hover[itemid]');
      let itemID = hover ? hover.getAttribute('itemid') : null;
      if (!itemID) {
        const img = wrap.querySelector('img[src*="/images/items/"]');
        if (img) { const m = (img.src || '').match(/\/images\/items\/(\d+)\//); itemID = m ? m[1] : null; }
      }
      if (!itemID || !mqBase(itemID)) continue; // only weapons/armour we have a base for
      const stats = readCardStats(wrap);
      if (!stats) continue;
      const quality = mqQuality(itemID, stats.dmg, stats.acc, stats.armor);
      if (quality == null) continue;
      const maxRange = (stats.armor != null && stats.armor > 0) ? 100 : 300;
      if (!mqPlausible(quality, maxRange)) continue;
      const bonuses = mqReadDisplayCaseBonuses(wrap);
      const sig = itemID + '|' + stats.dmg + '|' + stats.acc + '|' + stats.armor + '|' +
        bonuses.map((b) => b.name + b.value).join(',');
      if (mqProcessed.get(wrap) === sig) continue;
      const li = wrap.closest('li');
      const nameEl = (li && li.querySelector('.b-item-name')) || wrap.querySelector('.b-item-name');
      mqInjectBadge(wrap, quality, maxRange); // into .b-item-wrap, above the .item-hover overlay
      mqInjectBonuses(nameEl, bonuses, null, true); // inline: right of the name
      mqProcessed.set(wrap, sig);
    }
  }

  // ---- Faction Armory (pure DOM, AJAX/SPA tab) ----------------------------
  // factions.php?step=your#/tab=armoury is a React tab (tiles hydrate late), so the
  // body-scoped observer in mqStart re-runs this as the list renders. It has TWO layouts
  // (a view toggle), both handled here:
  //   LIST view:  ul.item-list > li
  //     div.img-wrap[data-itemid="108"] > img.torn-item   <- image + item ID (attribute)
  //     div.name.bold.t-overflow                          <- item name
  //     ul.bonuses > li.left > i.bonus-attachment-item-damage-bonus + span   <- stat
  //                                i.bonus-attachment-item-accuracy-bonus     <- stat
  //                                i.bonus-attachment-<name>[title]           <- weapon bonus
  //   GRID view:  ul.items-cont > li
  //     div.thumbnail-wrap > div.thumbnail > div.image-wrap > img[src=/images/items/26/..] <- id in src
  //     div.title-wrap > div.name-wrap.bold ... .t-overflow                   <- item name
  //     ul.bonuses-wrap > li > i.bonus-attachment-item-(damage|accuracy|defence)-bonus + span
  // The stat icons use the SAME bonus-attachment markup as the bazaar (incl. "defence" for
  // armour), so readCardStats reads either ul unchanged and quality is derived like
  // elsewhere. The id comes from .img-wrap[data-itemid] when present, else the image src.
  // Badge goes on the image wrapper (.img-wrap or .thumbnail), pills next to the name
  // (.name or .name-wrap). Only items we have a base for are tagged, so medical/drug/
  // booster/temporary rows skip.
  function mqReadArmouryBonuses(li) {
    const out = [];
    const box = li.querySelector('ul.bonuses-wrap') || li.querySelector('ul.bonuses') || li;
    for (const icon of box.querySelectorAll('i[class*="bonus-attachment-"]')) {
      const cls = icon.getAttribute('class') || '';
      if (/bonus-attachment-item-(damage|accuracy|armou?r|defen[cs]e)-bonus/i.test(cls)) continue; // stat -> quality, not a bonus
      if (/bonus-attachment-blank/i.test(cls)) continue; // empty slot
      const holder = document.createElement('div');
      holder.innerHTML = icon.getAttribute('title') || ''; // armoury titles are real HTML (<b>Quicken</b><br>...)
      const bold = holder.querySelector('b');
      let name = ((bold ? bold.textContent : '') || '').trim();
      if (!name) {
        const nm = cls.match(/bonus-attachment-([a-z0-9-]+)/i);
        if (nm && nm[1]) name = nm[1].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      }
      if (!name) continue;
      const desc = (holder.textContent || '').replace(name, '').trim();
      const pm = desc.match(/(\d+(?:\.\d+)?)\s*%/);
      out.push({ name, value: pm ? pm[1] : null, pct: !!pm });
    }
    return out;
  }

  function mqProcessArmoury() {
    // The armoury has two layouts depending on the view toggle: a LIST view
    // (ul.item-list > li, id on .img-wrap[data-itemid], stats in ul.bonuses, name in
    // .name, image in .img-wrap) and a GRID/tile view (ul.items-cont > li, no
    // data-itemid so the id is read from the image src, stats in ul.bonuses-wrap, name
    // in .name-wrap, image in .thumbnail). Handle both from one pass.
    const tiles = document.querySelectorAll('ul.item-list > li, ul.items-cont li');
    for (const tile of tiles) {
      if (tile.querySelector('.openmarket-quality-box')) continue; // another quality script already tagged this tile
      const wrap = tile.querySelector('.img-wrap[data-itemid]');
      let itemID = wrap ? wrap.getAttribute('data-itemid') : null;
      if (!itemID) {
        const img = tile.querySelector('img[src*="/images/items/"]');
        if (img) { const m = (img.getAttribute('src') || '').match(/\/images\/items\/(\d+)\//); itemID = m ? m[1] : null; }
      }
      if (!itemID || !mqBase(itemID)) continue; // only weapons/armour we have a base for
      const stats = readCardStats(tile);
      if (!stats) continue;
      const quality = mqQuality(itemID, stats.dmg, stats.acc, stats.armor);
      if (quality == null) continue;
      const maxRange = (stats.armor != null && stats.armor > 0) ? 100 : 300;
      if (!mqPlausible(quality, maxRange)) continue;
      const bonuses = mqReadArmouryBonuses(tile);
      const sig = itemID + '|' + stats.dmg + '|' + stats.acc + '|' + stats.armor + '|' +
        bonuses.map((b) => b.name + b.value).join(',');
      if (mqProcessed.get(tile) === sig) continue;
      const imageWrapper = wrap || tile.querySelector('.img-wrap') ||
        tile.querySelector('.thumbnail') || tile.querySelector('.thumbnail-wrap .image-wrap');
      const nameEl = tile.querySelector('.name-wrap') || tile.querySelector('.name');
      if (!imageWrapper || !nameEl) continue;
      mqInjectBadge(imageWrapper, quality, maxRange);
      mqInjectBonuses(nameEl, bonuses, null, true); // inline: right of the name
      mqProcessed.set(tile, sig);
    }
  }

  // ---- shared lifecycle ---------------------------------------------------
  function mqWaitFor(sel, cb, tries) {
    tries = tries == null ? 40 : tries;
    const el = document.querySelector(sel);
    if (el) { cb(el); return; }
    if (tries <= 0) return;
    setTimeout(() => mqWaitFor(sel, cb, tries - 1), 300);
  }

  function mqProcessCurrent() {
    if (!settings.marketQuality) return;
    if (!isItemMarketPage()) mqRemoveFilterBar(); // filter UI is Item Market only
    if (isItemMarketPage()) mqProcessItemMarket();
    else if (mqIsBazaar()) mqProcessBazaar();
    else if (mqIsInventory()) mqProcessInventory();
    else if (mqIsDisplayCase()) mqProcessDisplayCase();
    else if (mqIsArmoury()) mqProcessArmoury();
  }

  function mqClearOverlay() {
    document.querySelectorAll('.flipr-q-badge, .flipr-mq-bonuses').forEach((el) => el.remove());
    document.querySelectorAll('.flipr-mq-match').forEach((el) => el.classList.remove('flipr-mq-match'));
    mqRemoveFilterBar();
    const gs = document.getElementById('flipr-mq-grid');
    if (gs) gs.remove(); // restore Torn's native row height
    mqProcessed = new WeakMap();
  }

  // Toggled live from Settings and by a cross-tab settings change.
  function applyMarketQuality() {
    if (settings.marketQuality) { mqProcessed = new WeakMap(); mqSchedule(); }
    else mqClearOverlay();
  }

  // Wire the overlay ONCE, page-agnostically. This script runs a single time, but
  // Torn navigates its sidebar via the History API (pushState) WITHOUT re-running any
  // userscript, so a per-page, one-shot init left every page you reached through the
  // menu (classically the Display Case) with no observer at all - it simply never ran.
  // Instead: install the Item Market fetch hook (harmless elsewhere), attach ONE
  // persistent body-scoped observer, and redraw on every client-side navigation.
  // mqProcessCurrent re-checks the URL each run and every processor queries the whole
  // document, so this one wiring covers Item Market, Bazaar, Items page and Display
  // Case alike - and keeps working after any SPA navigation. Drawing stays gated on
  // settings.marketQuality inside mqProcessCurrent, so the toggle still turns it off.
  function mqStart() {
    if (mqStarted) return;
    mqStarted = true;
    try { mqInstallFetchHook(); } catch (e) { /* only the Item Market cache fallback needs it */ }
    const obs = new MutationObserver(() => mqSchedule());
    obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
    mqInventoryObserver = obs;
    window.addEventListener('hashchange', mqSchedule);
    window.addEventListener('popstate', mqSchedule);
    try {
      const wrap = (orig) => function () { const r = orig.apply(this, arguments); try { mqSchedule(); } catch (e) { /* ignore */ } return r; };
      history.pushState = wrap(history.pushState);
      history.replaceState = wrap(history.replaceState);
    } catch (e) { /* history not writable - the observer still covers most cases */ }
    mqSchedule();
  }

  mqStart();

  log('FLIPR ready, version', SCRIPT_VERSION);
})();
