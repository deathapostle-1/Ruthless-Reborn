// ==UserScript==
// @name         RR Attack Advisor
// @namespace    txm.fastattack
// @version      4.1.5
// @description  Attack Page QOL Changes & RR War Condition Integration
// @author       TXM [1712536]
// @updateURL    https://raw.githubusercontent.com/deathapostle-1/Ruthless-Reborn/main/rr-attack-advisor.user.js
// @downloadURL  https://raw.githubusercontent.com/deathapostle-1/Ruthless-Reborn/main/rr-attack-advisor.user.js
// @match        https://www.torn.com/page.php?sid=attack*
// @match        https://www.torn.com/loader.php?sid=attack*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @connect      api.torn.com
// @connect      rr-script-auth.deathapostle1.workers.dev
// @connect      api.torn.zzcraft.net
// @run-at       document-end
// ==/UserScript==

(() => {
    'use strict';

    // #region Metadata

    // unsafeWindow is the real page window in both the sandbox and page modes,
    // which keeps the double-injection guard working across PDA re-navigation.
    const PAGE = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;

    if (PAGE.__txmFastAttack) return;
    PAGE.__txmFastAttack = true;

    // #endregion

    // #region Configuration

    const STORAGE_SLOT = 'torn-attack-slot';
    const STORAGE_TYPE = 'torn-attack-type';
    const STORAGE_KEY = 'torn-attack-api-key';              // Legacy localStorage key, migration only
    const SECURE_STORAGE_KEY = 'torn-attack-api-key-v2';
    const SESSION_STORAGE_KEY = 'rr-attack-session-v1';
    const STORAGE_JWT = 'torn-attack-jwt';                  // Legacy cache, removed on startup
    const STORAGE_WAR = 'torn-attack-war';                  // {ourFaction, oppId, roster, at}
    const STORAGE_LIMITS = 'torn-attack-limits';            // {payload, at}
    const STORAGE_SETTINGS = 'torn-attack-settings';        // {v, advisor, buttons, outcome, loglinks}

    // War limits and Start Fight blocking are deliberately NOT in here - they
    // are a faction requirement and have no toggle path.
    const SETTINGS_DEFAULTS = {
        v: 1,
        advisor: true,                                      // bonus chips + slot tags + temp verdict
        buttons: true,                                      // desktop dialog reposition + frame hide
        outcome: true,                                      // leave/mug/hosp filtering
        loglinks: true                                      // defender profile links in the log
    };

    const COMPACT_WIDTH = 1000;                             // Torn drops to the single-panel layout at/below this

    const VERSION = '4.1.5';                                // keep in step with @version above

    // Cross-origin auth traffic uses GM_xmlhttpRequest or TornPDA's native bridge.
    const TORN_API = 'https://api.torn.com/v2';
    const AUTH_API = 'https://rr-script-auth.deathapostle1.workers.dev';
    const ZZCRAFT_API = 'https://api.torn.zzcraft.net';
    const AUTH_REFRESH_MS = 4 * 60 * 1000;
    const AUTH_EXPIRY_SKEW_MS = 15 * 1000;

    const ZZCRAFT_USERAGENT = 'rr-attack-userscript/' + VERSION;  // User agent used on zzcraft

    const TTL_WAR = 5 * 60 * 1000;                          // war state
    const TTL_ROSTER = 10 * 60 * 1000;                      // enemy roster
    const POLL_MIN = 10 * 1000;                             // guard against a bad/missing nextUpdate
    const POLL_MAX = 5 * 60 * 1000;                         // stop an idle page drifting
    const STALE_AFTER = 30 * 1000;                          // limits figure goes amber past this
    const RETRY_NET = 60 * 1000;                            // back off after a transient failure

    // Torn's header labels, discriminated by the icon SVG's viewBox - the label
    // count swings across fight phases and the class strings are identical, so
    // neither DOM order nor classes can tell them apart.
    const LABEL_VIEWBOX = {
        '0 0 16.9 19': 'turns',                             // turns used this fight, caps at 25 - not energy
        '0 0 10.67 17': 'timer',                            // the 5-minute attack window, NOT the chain timer
        '0 0 16 17': 'chain'
    };

    const SLOT = {
        PRIMARY: 1,
        SECONDARY: 2,
        MELEE: 3,
        TEMP: 4
    };

    const SLOT_NAMES = {
        [SLOT.PRIMARY]: 'Primary',
        [SLOT.SECONDARY]: 'Secondary',
        [SLOT.MELEE]: 'Melee',
        [SLOT.TEMP]: 'Temp'
    };

    const ATTACK = {
        LEAVE: 1,
        MUG: 2,
        HOSP: 3
    };

    const ATTACK_NAMES = {
        [ATTACK.LEAVE]: 'Leave',
        [ATTACK.MUG]: 'Mug',
        [ATTACK.HOSP]: 'Hosp'
    };
    const OUTCOME_LABELS = ['leave', 'mug', 'hospitalize'];
    const START_LABELS = ['start fight', 'start', 'fight', 'attack'];

    // DOM slot identifiers, not advice rules.
    const WEAPON_SLOT_IDS = new Set(['weapon_main', 'weapon_second', 'weapon_melee', 'weapon_temp']);

    // #endregion

    // #region Utilities

    // Torn rotates its CSS-module hashes on every redeploy - match the stable prefix.
    const sel = (name) => `[class*="${name}___"]`;
    const q = (root, s) => root ? root.querySelector(s) : null;      // a null root must never widen to document
    const qa = (root, s) => root ? Array.from(root.querySelectorAll(s)) : [];

    // #endregion

    // #region Storage

    function storeGet(key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
    }

    function storeSet(key, value) {
        try { localStorage.setItem(key, value); } catch (e) { /* private mode / PDA */ }
    }

    function storeDel(key) {
        try { localStorage.removeItem(key); } catch (e) { /* private mode / PDA */ }
    }

    async function secureGet(key) {
        const onPda = typeof PAGE.flutter_inappwebview !== 'undefined';
        if (onPda) {
            if (typeof PDA_storage === 'undefined') {
                throw new Error('TornPDA 3.15 or newer is required');
            }
            return await PDA_storage.get(key, null);
        }
        if (typeof GM_getValue === 'function') return await Promise.resolve(GM_getValue(key, null));
        if (typeof GM !== 'undefined' && GM && typeof GM.getValue === 'function') {
            return await GM.getValue(key, null);
        }
        return null;
    }

    async function secureSet(key, value) {
        const onPda = typeof PAGE.flutter_inappwebview !== 'undefined';
        if (onPda) {
            if (typeof PDA_storage === 'undefined') {
                throw new Error('TornPDA 3.15 or newer is required');
            }
            await PDA_storage.set(key, value);
            return;
        }
        if (typeof GM_setValue === 'function') {
            await Promise.resolve(GM_setValue(key, value));
            return;
        }
        if (typeof GM !== 'undefined' && GM && typeof GM.setValue === 'function') {
            await GM.setValue(key, value);
            return;
        }
        throw new Error('Protected userscript storage unavailable');
    }

    async function secureDelete(key) {
        const onPda = typeof PAGE.flutter_inappwebview !== 'undefined';
        if (onPda) {
            if (typeof PDA_storage === 'undefined') return;
            await PDA_storage.delete(key);
            return;
        }
        if (typeof GM_deleteValue === 'function') {
            await Promise.resolve(GM_deleteValue(key));
            return;
        }
        if (typeof GM !== 'undefined' && GM && typeof GM.deleteValue === 'function') {
            await GM.deleteValue(key);
        }
    }

    let authApiKey = '';
    let playerId = null;
    let apiKeyLoaded = false;

    async function loadApiKey() {
        let candidate = await secureGet(SECURE_STORAGE_KEY);
        if (!validKey(candidate)) candidate = storeGet(STORAGE_KEY);

        if (validKey(candidate)) {
            await secureSet(SECURE_STORAGE_KEY, candidate);
            if ((await secureGet(SECURE_STORAGE_KEY)) !== candidate) {
                throw new Error('API key migration could not be verified');
            }
            authApiKey = candidate;
        } else {
            authApiKey = '';
        }
        storeDel(STORAGE_KEY);
    }

    async function saveApiKey(value) {
        if (value && !validKey(value)) throw new Error('Invalid Torn API key');
        if (value) {
            await secureSet(SECURE_STORAGE_KEY, value);
            if ((await secureGet(SECURE_STORAGE_KEY)) !== value) {
                throw new Error('API key save could not be verified');
            }
        } else {
            await secureDelete(SECURE_STORAGE_KEY);
        }
        authApiKey = value;
        storeDel(STORAGE_KEY);
    }

    function jsonGet(key) {
        try { return JSON.parse(storeGet(key) || 'null'); } catch (e) { return null; }
    }

    function jsonSet(key, value) {
        try { storeSet(key, JSON.stringify(value)); } catch (e) { /* quota / cycles */ }
    }

    const fresh = (rec, ttl) => !!(rec && rec.at && Date.now() - rec.at < ttl);

    function safe(label, fn) {                              // one broken selector must not kill the rest
        try { return fn(); } catch (e) { console.error('[RR Attack Advisor]', label, e); }
    }

    // #endregion

    // #region State

    let slot = Number(storeGet(STORAGE_SLOT));
    if (!SLOT_NAMES[slot]) slot = SLOT.MELEE;               // corrupt storage must never pick a ghost slot
    let attackType = Number(storeGet(STORAGE_TYPE));
    if (!ATTACK_NAMES[attackType]) attackType = ATTACK.MUG;      // ...or hide every outcome button

    const settings = { ...SETTINGS_DEFAULTS, ...(jsonGet(STORAGE_SETTINGS) || {}) };

    function saveSettings() {
        jsonSet(STORAGE_SETTINGS, settings);
    }

    let styleEl = null;
    let styleKey = '';
    let lastHelmet = null;                                  // page-scoped only; nothing is persisted
    let lastBonuses = null;                                 // ditto - a 'unknown' read must never clear it
    let barSig = '';                                        // last painted top-bar signature
    let adviceSig = '';                                     // last painted advice-row signature
    let limitsSig = '';                                     // last painted limits/warn signature
    let setupPrompted = false;
    // #endregion

    // #region Styles

    function compact() {
        // Torn's "Desktop View" setting forces the desktop tree on a phone AND
        // strips width=device-width from the viewport meta, so innerWidth
        // reports the UA fallback (~980) - under the threshold. The html class
        // is set before React mounts and never removed.
        if (document.documentElement.classList.contains('html-manual-desktop')) return false;
        return window.innerWidth <= COMPACT_WIDTH;
    }

    function getTopStyle(slotId) {
        switch (slotId) {
            case SLOT.PRIMARY: return '35px';
            case SLOT.SECONDARY: return '135px';
            case SLOT.MELEE: return '235px';
            case SLOT.TEMP: return '335px';
            default: return '235px';
        }
    }

    // CSS notes, kept out of the shipped stylesheet:
    // - Header-hide rules only bite while .txm-fa-bar precedes the header AND
    //   carries data-txm-mirror="1"; if the bar never builds or React tears it
    //   out they stop matching and the native header returns with no JS.
    // - The header wrapper is collapsed, never display:none'd - it carries the
    //   <defs id="app-header-gradient"> paint server, and resolving one inside
    //   a display:none subtree is browser-dependent (could blank icons on PDA).
    // - Dialog frames are visibility-hidden, not display:none'd: the moved-out
    //   buttons are its descendants, and only visibility can be re-asserted on
    //   a descendant. A hidden ancestor also never blocks their pointer events.
    // - [data-txm-block] uses pointer-events (stops mouse AND touch) and never
    //   the .disabled property, which React resets on re-render.
    // - The compact tweaks are an @media block rather than a compact() branch
    //   so phone rotation reacts without a stylesheet rebuild.
    function buildCss() {
        const dialogHide = `
        ${sel('dialogWrapper')}[data-txm-dialog="start"],
        ${sel('dialogWrapper')}[data-txm-dialog="outcome"] { visibility: hidden; }
        ${sel('dialogWrapper')}[data-txm-dialog] ${sel('dialogButtons')} { visibility: visible; }
        `;

        // Buttons move only on desktop and Torn's forced "Desktop View".
        // True Mobile View keeps Torn's native dialog and button placement.
        const positioning = !Session.pass() || !settings.buttons || compact() ? '' : `
        ${sel('player')}:nth-child(2) ${sel('playerWindow')} {
            overflow: visible;
        }

        ${sel('dialogButtons')} {
            z-index: 1000;
            position: absolute;
            top: ${getTopStyle(slot)};
            display: flex;
            left: -300px;
            width: 420px;
            justify-content: center;
            flex-direction: row !important;
        }
        ${dialogHide}
        `;

        return `
        ${sel('modelWrap')} { max-width: 100%; }
        ${positioning}

        [data-txm-hide] { display: none !important; }

        .txm-fa-namelink { color: var(--default-color); }

        .txm-fastattack {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 6px;
            font-size: 12px;
        }

        .txm-fastattack select {
            background: #1f1f1f;
            color: #e6e6e6;
            border: 1px solid #444;
            border-radius: 4px;
            padding: 2px 6px;
            cursor: pointer;
        }

        .txm-fastattack select:hover {
            border-color: #777;
        }

        [data-txm-warn], [data-txm-disarm] { position: relative; }

        [data-txm-warn]::after,
        [data-txm-disarm]::before {
            position: absolute;
            right: 4px;
            bottom: 26px;
            padding: 1px 4px;
            border-radius: 2px;
            font-size: 8px;
            font-weight: 700;
            line-height: 1.2;
            background: rgba(0, 0, 0, .55);
            pointer-events: none;
            z-index: 5;
        }

        [data-txm-warn]::after { content: attr(data-txm-label); }
        [data-txm-disarm]::before { content: attr(data-txm-disarm-label); color: #e0a80d; }
        [data-txm-warn][data-txm-disarm]::before { bottom: 41px; }

        [data-txm-warn="avoid"]::after { color: #d63b3b; }

        .txm-fa-bar[data-txm-mirror="1"] ~ ${sel('appHeaderWrapper')} > ${sel('topSection')},
        .txm-fa-bar[data-txm-mirror="1"] ~ ${sel('appHeaderWrapper')} > ${sel('delimiter')},
        .txm-fa-bar[data-txm-mirror="1"] ~ ${sel('appHeaderWrapper')} > ${sel('bottomSection')} {
            display: none !important;
        }

        .txm-fa-bar[data-txm-mirror="1"] ~ ${sel('appHeaderWrapper')} {
            margin: 0 !important;
            padding: 0 !important;
            border: 0 !important;
            min-height: 0 !important;
        }

        .txm-fa-bar {
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin: 8px 0;
            padding: 8px 12px;
            background: #1f1f1f;
            border: 1px solid rgba(2, 158, 122, .5);
            border-radius: 6px;
            font-size: 12px;
            color: #ddd;
        }

        .txm-fa-row {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            align-items: center;
        }

        .txm-fa-brand {
            color: #029e7a;
            font-weight: 700;
            letter-spacing: 1.5px;
            white-space: nowrap;
        }

        .txm-fa-brand small {
            color: #8a8a8a;
            font-weight: 600;
            letter-spacing: 1px;
            margin-left: 4px;
        }

        .txm-fa-auth-state {
            color: #8a8a8a;
            font-size: 11px;
            margin-left: auto;
        }

        .txm-fa-chips {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            align-items: center;
        }

        .txm-fa-chip {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 2px 8px;
            background: #2a2a2a;
            border: 1px solid #444;
            border-radius: 4px;
            font-size: 11px;
            white-space: nowrap;
        }

        .txm-fa-chip b { font-weight: 700; }
        .txm-fa-chip em { font-style: normal; color: #8a8a8a; }

        .txm-fa-ico { display: inline-flex; align-items: center; }
        .txm-fa-ico svg { width: 11px; height: 12px; opacity: .75; }
        .txm-fa-ico svg, .txm-fa-ico svg path { fill: currentColor; }

        .txm-fa-chip[data-kind="chain"][data-low="1"] { border-color: #e74c3c; }
        .txm-fa-chip[data-kind="chain"][data-low="1"] em { color: #e74c3c; }

        .txm-fa-right {
            margin-left: auto;
            display: flex;
            gap: 8px;
            align-items: center;
            flex-wrap: wrap;
        }

        .txm-fa-escape {
            background: transparent;
            border: 1px solid #029e7a;
            color: #029e7a;
            border-radius: 4px;
            padding: 3px 10px;
            cursor: pointer;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 1px;
            text-transform: uppercase;
        }

        .txm-fa-escape:hover:not(:disabled) { background: #029e7a; color: #fff; }
        .txm-fa-escape:disabled { opacity: .45; cursor: default; border-color: #444; color: #8a8a8a; }

        .txm-fa-back { color: #8a8a8a; font-size: 11px; text-decoration: none; white-space: nowrap; }
        .txm-fa-back:hover { color: #029e7a; }

        .txm-fa-bar .txm-fastattack { margin: 0; }
        .txm-fa-bar .txm-fastattack label { display: inline-flex; align-items: center; gap: 4px; color: #8a8a8a; }

        [data-txm-block] {
            pointer-events: none !important;
            opacity: .45 !important;
            cursor: not-allowed !important;
            filter: grayscale(1);
        }

        .txm-fa-info {
            border-top: 1px solid #333;
            padding-top: 6px;
            font-size: 11px;
        }

        .txm-fa-advice, .txm-fa-limits, .txm-fa-warn {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            align-items: center;
        }

        .txm-fa-limits, .txm-fa-warn { margin-left: auto; }

        .txm-fa-warn {
            color: #e74c3c;
            font-weight: 700;
            letter-spacing: .3px;
        }

        .txm-fa-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #8a8a8a;
            flex: none;
        }

        .txm-fa-adv[data-level="avoid"] .txm-fa-dot { background: #d63b3b; }
        .txm-fa-adv[data-level="caution"] .txm-fa-dot { background: #e0a80d; }
        .txm-fa-adv[data-level="ok"] .txm-fa-dot { background: #4caf50; }

        .txm-fa-age { color: #6f6f6f; font-size: 10px; font-style: italic; white-space: nowrap; }

        .txm-fa-api {
            background: transparent;
            border: 1px solid #029e7a;
            color: #029e7a;
            border-radius: 4px;
            padding: 3px 10px;
            cursor: pointer;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 1px;
        }

        .txm-fa-api:hover { background: #029e7a; color: #fff; }
        .txm-fa-api:disabled { opacity: .5; cursor: default; }

        .txm-fa-gear {
            background: none;
            border: none;
            color: #8a8a8a;
            font-size: 15px;
            line-height: 1;
            padding: 0 4px;
            cursor: pointer;
        }

        .txm-fa-gear:hover { color: #029e7a; }

        .txm-fa-limits { color: #8a8a8a; }

        .txm-fa-key { color: #029e7a; font-weight: 700; letter-spacing: 1px; }
        .txm-fa-sep { color: #444; }
        .txm-fa-lim { white-space: nowrap; }
        .txm-fa-lim b { color: #ddd; font-weight: 700; }
        .txm-fa-mine { margin-left: 14px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
        .txm-fa-val { white-space: nowrap; font-weight: 700; color: #ddd; }
        .txm-fa-bar .txm-fa-val[data-ok="1"] { color: #2ecc71; }
        .txm-fa-bar .txm-fa-val[data-ok="0"] { color: #e74c3c; }
        .txm-fa-bar .txm-fa-val[data-cap="1"] { color: #e0a80d; }
        .txm-fa-bar .txm-fa-age[data-stale="1"] { color: #e0a80d; }

        .txm-fa-bar [hidden] { display: none !important; }

        body:not(.dark-mode) .txm-fa-bar { background: #f2f2f2; color: #333; }
        body:not(.dark-mode) .txm-fa-chip { background: #fff; border-color: #ccc; }
        body:not(.dark-mode) .txm-fa-chip em,
        body:not(.dark-mode) .txm-fa-limits,
        body:not(.dark-mode) .txm-fa-bar .txm-fastattack label { color: #666; }
        body:not(.dark-mode) .txm-fa-bar .txm-fastattack select { background: #fff; color: #333; border-color: #ccc; }
        body:not(.dark-mode) .txm-fa-info { border-top-color: #ddd; }
        body:not(.dark-mode) .txm-fa-lim b,
        body:not(.dark-mode) .txm-fa-val { color: #333; }
        body:not(.dark-mode) .txm-fa-sep { color: #bbb; }
        body:not(.dark-mode) .txm-fa-escape:disabled { color: #999; border-color: #ccc; }
        body:not(.dark-mode) .txm-fa-age { color: #888; }

        .txm-fa-set-overlay {
            position: fixed;
            inset: 0;
            z-index: 999999;
            background: rgba(0, 0, 0, .8);
            backdrop-filter: blur(4px);
            display: flex;
            justify-content: center;
            align-items: center;
        }

        .txm-fa-set-modal {
            display: flex;
            flex-direction: column;
            width: min(520px, 94vw);
            max-height: min(86vh, 700px);
            overflow: hidden;
            background: linear-gradient(180deg, #23252b, #1b1d22);
            border: 1px solid rgba(2, 158, 122, .5);
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0, 0, 0, .35);
            color: #d7d9de;
            font-size: 12px;
        }

        .txm-fa-set-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 12px 14px;
            background: linear-gradient(180deg, #2c2f37, #23252b);
            border-bottom: 1px solid #34373f;
        }

        .txm-fa-set-head b { color: #029e7a; letter-spacing: 1px; }

        .txm-fa-set-close {
            width: 28px;
            height: 28px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background: none;
            border: none;
            color: #8a8a8a;
            font-size: 22px;
            line-height: 1;
            cursor: pointer;
        }

        .txm-fa-set-close:hover { color: #fff; }

        .txm-fa-set-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px; }

        .txm-fa-set-tabs {
            display: flex;
            gap: 6px;
            margin-bottom: 12px;
            border-bottom: 1px solid #34373f;
            padding-bottom: 8px;
        }

        .txm-fa-set-tab {
            border: 1px solid #34373f;
            border-radius: 5px;
            background: #15161a;
            color: #d7d9de;
            font: inherit;
            font-weight: 700;
            min-height: 28px;
            padding: 5px 12px;
            cursor: pointer;
        }

        .txm-fa-set-tab:hover { border-color: #029e7a; color: #029e7a; }
        .txm-fa-set-tab.active { background: #029e7a; border-color: #029e7a; color: #10231d; }

        .txm-fa-set-section {
            background: #1a1a1a;
            border: 1px solid #34373f;
            border-radius: 6px;
            padding: 12px;
            margin-bottom: 12px;
        }

        .txm-fa-set-title {
            color: #8a8d96;
            font-size: 10px;
            font-weight: 700;
            letter-spacing: .07em;
            text-transform: uppercase;
            margin-bottom: 10px;
        }

        .txm-fa-set-input {
            width: 100%;
            box-sizing: border-box;
            background: #15161a;
            color: #d7d9de;
            border: 1px solid #34373f;
            border-radius: 5px;
            padding: 6px 8px;
            font: inherit;
            text-align: center;
            letter-spacing: 2px;
            margin-bottom: 10px;
        }

        .txm-fa-set-input:focus { border-color: #029e7a; outline: none; }
        .txm-fa-set-input[data-bad="1"] { border-color: #e74c3c; }

        .txm-fa-set-status {
            text-align: center;
            padding: 8px;
            background: #15161a;
            border: 1px solid #34373f;
            border-radius: 5px;
            font-size: 11px;
            margin-bottom: 10px;
        }

        .txm-fa-set-status[data-state="ok"] { color: #2ecc71; }
        .txm-fa-set-status[data-state="bad"] { color: #e74c3c; }
        .txm-fa-set-status[data-state="wait"] { color: #e0a80d; }

        .txm-fa-set-actions { display: flex; gap: 8px; }
        .txm-fa-set-actions .txm-fa-api { flex: 1; }

        .txm-fa-set-check {
            display: flex;
            align-items: flex-start;
            gap: 10px;
            padding: 8px;
            background: #15161a;
            border: 1px solid #34373f;
            border-radius: 5px;
            margin-bottom: 8px;
            cursor: pointer;
            font-size: 11px;
        }

        .txm-fa-set-check:hover { border-color: #029e7a; }
        .txm-fa-set-check input { margin-top: 2px; }
        .txm-fa-set-check b { color: #fff; }

        .txm-fa-set-note { font-size: 10px; color: #8a8d96; }

        @media (max-width: ${COMPACT_WIDTH}px) {
            html:not(.html-manual-desktop) .txm-fa-bar { margin: 6px 0; padding: 6px 8px; gap: 4px; }
            html:not(.html-manual-desktop) .txm-fa-row { gap: 6px; }
            html:not(.html-manual-desktop) .txm-fa-brand small { display: none; }
            html:not(.html-manual-desktop) .txm-fa-right,
            html:not(.html-manual-desktop) .txm-fa-mine { margin-left: 0; }
            html:not(.html-manual-desktop) .txm-fa-chip { padding: 2px 6px; }
        }

        @media (max-width: 560px) {
            .txm-fa-set-overlay { align-items: flex-start; padding: 8px 0; overflow-y: auto; -webkit-overflow-scrolling: touch; }
            .txm-fa-set-modal { margin: auto; max-height: 92vh; }
        }
        `;
    }

    // Plain <style> element (TornPDA has no GM_addStyle), kept mutable so Slot
    // changes apply without a reload.
    function refreshStyle() {
        const key = `${slot}|${compact()}|${settings.buttons}|${Session.pass()}`;
        if (key === styleKey && styleEl && styleEl.isConnected) return;
        styleKey = key;

        if (!styleEl || !styleEl.isConnected) {
            styleEl = document.getElementById('txm-fa-style') || document.createElement('style');
            styleEl.id = 'txm-fa-style';
            (document.head || document.documentElement).appendChild(styleEl);
        }

        styleEl.textContent = buildCss();
    }

    // green___ marks the attacker's header, rose___ the defender's - qualified
    // with headerWrapper___ because green___ also lands on result boxes.
    function playerRoot(side) {
        const tint = side === 'defender' ? 'rose' : 'green';
        const header = q(document, `${sel('headerWrapper')}${sel(tint)}`);
        return header ? header.closest(sel('player')) : null;
    }

    // #endregion

    // #region DOM Parsing & Rendering

    // Attack buttons

    function filterOutcomeButtons() {
        const buttons = qa(q(document, sel('dialogButtons')), 'button');
        const selected = OUTCOME_LABELS[attackType - 1];
        buttons.forEach(b => {
            const label = b.textContent.trim().toLowerCase();
            if (Session.pass() && settings.outcome && selected && OUTCOME_LABELS.includes(label) && label !== selected) setAttr(b, 'data-txm-hide', '');
            else delAttr(b, 'data-txm-hide');
        });
    }

    function classifyDialog() {
        const box = q(document, sel('dialogButtons'));
        const wrap = box && box.closest(sel('dialogWrapper'));
        qa(document, sel('dialogWrapper') + '[data-txm-dialog]').forEach(el => {
            if (el !== wrap) delAttr(el, 'data-txm-dialog');
        });
        const labels = qa(box, 'button').map(b => b.textContent.trim().toLowerCase());
        const state = Session.pass() && (labels.some(t => OUTCOME_LABELS.includes(t)) ? 'outcome'
            : labels.includes('continue') ? 'continue' : labels.some(t => START_LABELS.includes(t)) ? 'start' : '');
        if (state) setAttr(wrap, 'data-txm-dialog', state);
        else delAttr(wrap, 'data-txm-dialog');
    }

    // Advisor

    // The player model's native image map lists worn armour:
    //   <area alt="Helmet" title="Riot Helmet">  (alt = slot, title = item)
    function readHelmet() {
        const defender = playerRoot('defender');
        const attacker = playerRoot('attacker');

        let root = defender;
        if (!defender || defender === attacker) {
            // Mobile single-panel layout has no player___ wrappers and renders
            // one model - the DEFENDER's while their (rose) header is active.
            // Any player___ present means desktop mid-remount; a non-active
            // rose header means the model may be your own. Both -> unknown.
            if (q(document, sel('player'))) return { state: 'unknown' };
            if (!q(document, `${sel('headerWrapper')}${sel('rose')} ${sel('activeHeader')}`)) return { state: 'unknown' };
            root = q(document, sel('playersModelWrap'));
        }
        if (!root) return { state: 'unknown' };

        const bodies = qa(root, 'img[usemap]');
        if (bodies.length !== 1) return { state: 'unknown' };
        const mapName = (bodies[0].getAttribute('usemap') || '').replace(/^#/, '');
        const map = mapName && q(root, `map[name="${mapName}"]`);
        if (!map) return { state: 'unknown' };               // not rendered yet, or fight over

        const area = q(map, 'area[alt="Helmet"]');
        return area && area.title
            ? { state: 'known', helmet: area.title }
            : { state: 'bare' };                             // map present, no helmet area = bare-headed
    }

    function weaponName(el) {
        const img = q(el, 'img[alt]');
        const label = el.getAttribute('aria-label') || '';   // "Attack with Pepper Spray"
        const name = (img && img.alt) || label.replace(/^Attack with\s+/i, '');
        return name.trim() || null;
    }

    // weapon_* ids are duplicated (one set per player), so one document scan is
    // bucketed into own slots (by id) and defender slots per advisor pass -
    // never cached across passes, so React remounts cannot orphan anything.
    function weaponSlotBuckets() {
        const own = {};
        const def = [];
        // The defender___ AND matters: a modal carries its own defender___ hash,
        // which weaponSlot___ excludes.
        qa(document, sel('weaponSlot')).forEach(el => {
            if (el.matches(sel('defender'))) def.push(el);
            else if (WEAPON_SLOT_IDS.has(el.id)) own[el.id] = el;
        });
        return { own, def };
    }

    function readOwnTemp(el) {
        if (!el) return null;
        if (el.matches(sel('emptySlot'))) return { el, empty: true };
        return { el, empty: false, name: weaponName(el) };
    }

    function readDefenderBonuses(defSlots) {
        // Desktop-layout data only: mobile never mounts defender weapon slots,
        // so this read stays 'unknown' there.
        const slots = defSlots.filter(el => WEAPON_SLOT_IDS.has(el.id));
        if (!slots.length) return { state: 'unknown' };      // panel not rendered

        // Between fights Torn resets every defender slot to emptySlot___ -
        // that is missing data, never a clean opponent.
        const live = slots.filter(el => !el.matches(sel('emptySlot')));
        if (!live.length) return { state: 'unknown' };

        const out = [];
        live.forEach(el => {
            // Stat icons have no title attribute and blanks an empty one - both drop out.
            qa(el, 'i[data-bonus-attachment-title]').forEach(i => {
                const title = (i.getAttribute('data-bonus-attachment-title') || '').trim();
                if (!title) return;
                const desc = (i.getAttribute('data-bonus-attachment-description') || '').trim();
                out.push({ title, desc });   // plain data only - element refs go stale
            });
        });
        return { state: 'known', bonuses: out };
    }

    // Write-on-change only: the body observer filters attributes to ['class'],
    // so data-*/hidden writes never wake it; setText is the only helper that
    // emits an observed childList record, and only on real change.
    function setAttr(el, name, value) {
        if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
    }

    function delAttr(el, name) {
        if (el && el.hasAttribute(name)) el.removeAttribute(name);
    }

    function setText(el, value) {
        if (el && el.textContent !== value) el.textContent = value;
    }

    function setShown(el, on) {
        if (!el) return;
        if (on) { if (el.hasAttribute('hidden')) el.removeAttribute('hidden'); }
        else if (!el.hasAttribute('hidden')) el.setAttribute('hidden', '');
    }

    // For once-a-second values: poking the existing text node is a characterData
    // change the observer never sees, where textContent would emit childList.
    function setLiveText(el, value) {
        if (!el) return;
        const n = el.firstChild;
        if (n && n.nodeType === 3 && !n.nextSibling) {
            if (n.nodeValue !== value) n.nodeValue = value;
        } else setText(el, value);
    }

    function tagSlot(el, level, tag) {
        if (!el) return;
        if (!level) {
            delAttr(el, 'data-txm-warn');
            delAttr(el, 'data-txm-label');
            return;
        }
        setAttr(el, 'data-txm-warn', level);
        setAttr(el, 'data-txm-label', tag || '');
    }

    // Separate attribute pair (and ::before, not ::after) so a slot can carry
    // a verdict tag and the disarm tag at the same time.
    function tagDisarm(el, on) {
        if (!el) return;
        if (!on) {
            delAttr(el, 'data-txm-disarm');
            delAttr(el, 'data-txm-disarm-label');
            return;
        }
        setAttr(el, 'data-txm-disarm', '1');
        setAttr(el, 'data-txm-disarm-label', 'disarm');
    }

    function advChip(row, level, text, desc) {
        const attrs = { 'data-level': level };
        if (desc) attrs.title = desc;
        const s = chip(row, 'txm-fa-chip txm-fa-adv', text, attrs);
        const dot = document.createElement('i');
        dot.className = 'txm-fa-dot';
        s.insertBefore(dot, s.firstChild);
    }

    function renderAdviceRow(chips) {
        const row = q(document, '.txm-fa-bar .txm-fa-advice');
        if (!row) return;                                    // bar not built yet - sig untouched
        const sig = chips.map(c => `${c.level}|${c.text}|${c.desc || ''}`).join('~');
        if (sig === adviceSig) return;
        adviceSig = sig;
        row.textContent = '';
        chips.forEach(c => advChip(row, c.level, c.text, c.desc));
        setShown(row, chips.length > 0);
    }

    // The advice, limits and warn sections share one bar line - the wrapper
    // row shows while any of them has content.
    function syncInfoRow() {
        const bar = q(document, '.txm-fa-bar');
        if (!bar) return;
        const any = qa(bar, '.txm-fa-advice, .txm-fa-limits, .txm-fa-warn')
            .some(el => !el.hasAttribute('hidden'));
        setShown(q(bar, '.txm-fa-info'), any);
    }

    function renderAdvice() {
        const { own, def } = weaponSlotBuckets();
        const advice = settings.advisor && Analysis.display('advice')?.advice;
        Object.entries(own).forEach(([id, el]) => {
            const tag = advice && advice.tags[id];
            tagSlot(el, tag && tag.level, tag && tag.tag);
            tagDisarm(el, !!(advice && advice.disarmSlots.includes(id)));
            delAttr(el, 'data-txm-temp');
            delAttr(el, 'data-txm-helmet');
        });
        def.forEach(el => tagSlot(el, null));
        // Request failures are reported once in the shared warning row.
        renderAdviceRow(advice ? advice.chips : []);
    }

    // Top bar

    // viewBox first, then the button, then order-free shape fallbacks so a Torn
    // icon redesign degrades to a partial mirror rather than a wrong one.
    function labelKind(el) {
        const svg = q(el, `${sel('labelIconContainer')} svg[viewBox]`);
        const kind = svg && LABEL_VIEWBOX[(svg.getAttribute('viewBox') || '').trim()];
        if (kind) return kind;
        if (q(el, 'button')) return 'escape';

        const t = q(el, sel('labelTitle'));
        if (!t) return null;
        if (/^\d+\s*\/\s*\d+$/.test(t.textContent.trim())) return 'turns';
        if (q(t, 'div')) return 'chain';
        if (t.children.length === 1 && t.firstElementChild.tagName === 'SPAN') return 'timer';
        return null;
    }

    function readHeader() {
        const head = q(document, sel('appHeaderWrapper'));
        if (!head) return null;

        const out = {
            turns: '', timer: '', count: '', time: '', low: false,
            escape: null, backHref: '', backText: '', icons: {}, seen: 0, total: 0
        };

        qa(head, sel('labelContainer')).forEach(el => {
            out.total++;
            const kind = labelKind(el);
            if (!kind) return;
            out.seen++;

            const t = q(el, sel('labelTitle'));
            const text = t ? t.textContent.trim() : '';
            out.icons[kind] = q(el, `${sel('labelIconContainer')} svg`);

            if (kind === 'turns') out.turns = text;
            else if (kind === 'timer') out.timer = text;
            else if (kind === 'chain') {
                const m = /^(\S+)\s*\((.+)\)$/.exec(text);   // "1 (00:19)"
                out.count = m ? m[1] : text;
                out.time = m ? m[2] : '';
                out.low = !!q(t, sel('timeLow'));            // read that state class, never select on it
            } else if (kind === 'escape') {
                out.escape = q(el, 'button');
            }
        });

        const back = q(head, `${sel('linksContainer')} a[href]`);
        if (back) {
            out.backHref = back.getAttribute('href');
            out.backText = back.textContent.trim();
        }

        // Torn's header is only hidden once we have proved we can reproduce it;
        // an empty header mid-remount still counts as mirrored.
        out.mirror = (out.seen > 0 || out.total === 0) && (!back || !!out.backHref);
        return out;
    }

    function buildBar(head, mount) {
        const bar = document.createElement('div');
        bar.className = 'txm-fa-bar';
        bar.setAttribute('data-txm-mode', 'full');
        bar.setAttribute('data-txm-mirror', '0');            // fail closed: Torn's header stays until we mirror

        const opts = (names, current) => Object.entries(names)
            .map(([v, label]) => `<option value="${v}"${Number(v) === current ? ' selected' : ''}>${label}</option>`)
            .join('');

        // Set before insertion so the whole bar is a single childList record.
        bar.innerHTML = `
            <div class="txm-fa-row">
                <span class="txm-fa-brand">RR ATTACK ADVISOR <small>v${VERSION}</small></span>

                <span class="txm-fa-chips">
                    <span class="txm-fa-chip" data-kind="turns" hidden><i class="txm-fa-ico"></i><b></b></span>
                    <span class="txm-fa-chip" data-kind="timer" hidden><i class="txm-fa-ico"></i><b></b></span>
                    <span class="txm-fa-chip" data-kind="chain" hidden><i class="txm-fa-ico"></i><b></b><em></em></span>
                </span>

                <span class="txm-fa-right">
                    <a class="txm-fa-back" href="#" hidden></a>

                    <div class="txm-fastattack">
                        <label>Slot <select id="torn-slot-select">${opts(SLOT_NAMES, slot)}</select></label>
                        <label>Attack <select id="torn-attack-select">${opts(ATTACK_NAMES, attackType)}</select></label>
                    </div>

                    <button type="button" class="txm-fa-escape" hidden>Escape</button>
                    <button type="button" class="txm-fa-gear" title="Settings">&#9881;</button>
                </span>
            </div>

            <div class="txm-fa-row txm-fa-info" hidden>
                <div class="txm-fa-advice" hidden></div>
                <div class="txm-fa-limits" hidden></div>
                <div class="txm-fa-warn" hidden></div>
            </div>
        `;

        // The hide rules use a sibling combinator, so the bar MUST precede the header.
        if (head) mount.insertBefore(bar, head);
        else mount.insertBefore(bar, mount.firstChild);

        q(bar, '#torn-slot-select').addEventListener('change', e => {
            slot = Number(e.target.value) || SLOT.MELEE;
            storeSet(STORAGE_SLOT, String(slot));
            refreshStyle();
        });

        q(bar, '#torn-attack-select').addEventListener('change', e => {
            attackType = Number(e.target.value) || ATTACK.MUG;
            storeSet(STORAGE_TYPE, String(attackType));
            schedule();
        });

        // Proxy, never move: reparenting a React-managed node breaks its unmount
        // and takes the whole attack app down. Resolved at click time.
        q(bar, '.txm-fa-escape').addEventListener('click', () => {
            const btn = q(document, `${sel('appHeaderWrapper')} button[aria-label="escape"]`);
            if (btn && !btn.disabled) btn.click();
        });

        // mousedown + click both bound - some PDA webviews drop the click.
        // openSettings() ignores the second event for the same mounted modal.
        const gear = q(bar, '.txm-fa-gear');
        const onGear = (e) => {
            e.preventDefault();
            e.stopPropagation();
            safe('settings', () => openSettings(gear));
        };
        gear.addEventListener('mousedown', onGear);
        gear.addEventListener('click', onGear);

        barSig = '';                                         // fresh DOM - force a full repaint
        limitsSig = '';                                      // ditto - the limits/warn rows were rebuilt empty
        adviceSig = '';
        return bar;
    }

    function authStatusText() {
        if (!validKey(apiKey())) return 'API key required';
        if (Session.state === 'denied') return 'Access restricted';
        return Session.nextTryAt > Date.now() ? 'Authorization unavailable' : 'Verifying access…';
    }

    function buildAuthBar(head, mount) {
        const bar = document.createElement('div');
        bar.className = 'txm-fa-bar';
        bar.setAttribute('data-txm-mode', 'auth');
        bar.setAttribute('data-txm-mirror', '0');
        bar.innerHTML = `
            <div class="txm-fa-row">
                <span class="txm-fa-brand">RR ATTACK ADVISOR <small>v${VERSION}</small></span>
                <span class="txm-fa-auth-state"></span>
                <button type="button" class="txm-fa-gear" title="Settings">&#9881;</button>
            </div>
        `;

        if (head) mount.insertBefore(bar, head);
        else mount.insertBefore(bar, mount.firstChild);

        const gear = q(bar, '.txm-fa-gear');
        const onGear = (event) => {
            event.preventDefault();
            event.stopPropagation();
            safe('settings', () => openSettings(gear));
        };
        gear.addEventListener('mousedown', onGear);
        gear.addEventListener('click', onGear);
        setText(q(bar, '.txm-fa-auth-state'), authStatusText());
        return bar;
    }

    function renderTopBar() {
        const head = q(document, sel('appHeaderWrapper'));
        const models = q(document, sel('playersModelWrap'));
        const mount = (head && head.parentNode) || q(document, sel('coreWrap')) || (models && models.parentNode);
        if (!mount) return;                                  // attack UI not rendered yet

        let bar = q(document, '.txm-fa-bar');

        const mode = Session.pass() ? 'full' : 'auth';
        if (bar && bar.getAttribute('data-txm-mode') !== mode) {
            bar.remove();
            bar = null;
        }

        if (!bar) {
            bar = Session.pass() ? buildBar(head, mount) : buildAuthBar(head, mount);
        } else if (head && head.parentNode &&
                   !(bar.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING)) {
            head.parentNode.insertBefore(bar, head);         // React remounted its header in front of us
        }

        if (Session.pass()) updateBar(bar);
        else setText(q(bar, '.txm-fa-auth-state'), authStatusText());
    }

    function updateBar(bar) {
        bar = bar || q(document, '.txm-fa-bar');
        if (!bar || !bar.isConnected || bar.getAttribute('data-txm-mode') !== 'full') return;

        const h = readHeader();

        // Against a ranked-war opponent the back link retargets to the enemy
        // faction; in the signature so the link repaints when it changes.
        const tgt = warTarget();

        const sig = h
            ? [h.turns, h.timer, h.count, h.time, h.low ? 1 : 0,
               h.escape ? (h.escape.disabled ? 'd' : 'e') : '-',
               h.backHref, h.mirror ? 1 : 0, tgt ? tgt.oppId : '',
               ['turns', 'timer', 'chain'].map(k => h.icons[k] ? 1 : 0).join('')].join('|')
            : 'none';
        if (sig === barSig) return;                          // hot path: zero DOM writes
        barSig = sig;

        setAttr(bar, 'data-txm-mirror', h && h.mirror ? '1' : '0');

        const chipEl = (kind) => q(bar, `.txm-fa-chip[data-kind="${kind}"]`);
        const fill = (kind, value) => {
            const c = chipEl(kind);
            setShown(c, !!value);
            if (!value) return;
            // The timer ticks every second - setLiveText keeps that write off
            // the observer (characterData, not childList).
            setLiveText(q(c, 'b'), value);

            // Clone Torn's own icon exactly once; CSS repaints it currentColor.
            const ico = q(c, '.txm-fa-ico');
            const src = h.icons[kind];
            if (ico && !ico.firstChild && src) ico.appendChild(src.cloneNode(true));
        };

        fill('turns', h ? h.turns : '');
        fill('timer', h ? h.timer : '');
        fill('chain', h ? h.count : '');

        const ch = chipEl('chain');
        setLiveText(q(ch, 'em'), h && h.time ? `(${h.time})` : '');
        setAttr(ch, 'data-low', h && h.low ? '1' : '0');

        const esc = q(bar, '.txm-fa-escape');
        setShown(esc, !!(h && h.escape));
        if (h && h.escape && esc.disabled !== h.escape.disabled) esc.disabled = h.escape.disabled;

        const back = q(bar, '.txm-fa-back');
        setShown(back, !!(h && h.backHref));
        if (h && h.backHref) {
            if (tgt) {
                setAttr(back, 'href', FACTION_URL(tgt.oppId));
                setText(back, 'Back to faction');
            } else {
                setAttr(back, 'href', h.backHref);
                setText(back, h.backText);
            }
        }
    }

    // #endregion

    // #region Networking & Data Services

    // War limits. localStorage holds the durable caches so a fresh attack page
    // (every attack is one) renders instantly instead of blank.
    const War = {
        state: 'idle',                                      // idle | nowar | war | error
        oppId: null,
        oppName: null,
        roster: null,                                       // Set of enemy user ids
        startAt: 0,                                         // ms; ranked war start time
        inFlight: false,
        retryAt: 0,
        gen: 0,                                             // bumped on key change; stale responses are discarded
        ranked: null,
        rosterId: null
    };

    const Limits = {
        payload: null,
        at: 0,                                              // when the figure was fetched
        nextAt: 0,                                          // when to poll again
        inFlight: false,
        authFailed: false,                                  // a rejected key must never re-hit auth each sync
        rejects: 0,                                         // consecutive resource 401s; 3 strikes ends the re-mint loop
        gen: 0
    };

    function retryDelay(response) {
        const headers = response && response.headers;
        let value = null;
        if (typeof headers === 'string') value = /^retry-after:\s*(.+)$/im.exec(headers)?.[1]?.trim();
        else if (headers && typeof headers === 'object') {
            const key = Object.keys(headers).find(k => k.toLowerCase() === 'retry-after');
            if (key) value = String(headers[key]);
        }
        if (!value) return RETRY_NET;
        const seconds = Number(value);
        const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
        return Number.isFinite(delay) ? Math.max(1000, delay) : RETRY_NET;
    }

    async function keyFingerprint(key) {
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
        return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
    }

    const Session = {
        state: 'unknown', token: null, expiresAt: 0, renewAt: 0, factionId: null,
        nextTryAt: 0, inFlight: false, gen: 0, refreshTimer: null,
        pass() { return this.state === 'ok' && !!this.token && Date.now() < this.expiresAt; },
        reset() {
            this.gen++;
            if (this.refreshTimer) clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
            this.inFlight = false;
            this.state = 'unknown'; this.token = null; this.expiresAt = 0; this.renewAt = 0;
            this.nextTryAt = 0; this.factionId = null;
        },
        accept(data) {
            this.token = data.token; this.expiresAt = data.expiresAt; this.renewAt = data.renewAt;
            this.factionId = data.factionId; playerId = data.playerId;
            this.state = 'ok'; this.nextTryAt = 0;
            this.scheduleRefresh(); onSessionChange();
        },
        scheduleRefresh() {
            if (this.refreshTimer) clearTimeout(this.refreshTimer);
            this.refreshTimer = setTimeout(() => void this.refresh(), Math.max(1000, this.renewAt - Date.now()));
        },
        deferRetry(response) {
            if (!this.pass()) { this.token = null; this.expiresAt = 0; this.state = 'unknown'; }
            const delay = retryDelay(response);
            this.nextTryAt = Date.now() + delay;
            if (this.refreshTimer) clearTimeout(this.refreshTimer);
            this.refreshTimer = setTimeout(() => void this.refresh(), delay);
            onSessionChange();
        },
        async refresh() {
            const key = apiKey();
            if (!validKey(key)) {
                if (this.state !== 'denied' || this.token) { this.reset(); this.state = 'denied'; onSessionChange(); }
                return;
            }
            if (this.pass() && Date.now() < this.renewAt) return;
            if (this.inFlight || Date.now() < this.nextTryAt) return;
            const gen = this.gen;
            this.inFlight = true;
            const run = async () => {
                const keyHash = await keyFingerprint(key);
                if (gen !== this.gen || key !== apiKey()) return;
                const savedText = await secureGet(SESSION_STORAGE_KEY);
                let saved = null;
                try { saved = typeof savedText === 'string' ? JSON.parse(savedText) : null; } catch (_) { /* invalid record is not a session */ }
                if (gen !== this.gen || key !== apiKey()) return;
                if (saved && saved.keyHash === keyHash && saved.version === VERSION &&
                    typeof saved.token === 'string' && saved.token.length > 0 && saved.token.length <= 8192 &&
                    Number.isFinite(saved.expiresAt) && saved.expiresAt > Date.now() + AUTH_EXPIRY_SKEW_MS &&
                    saved.expiresAt <= Date.now() + 5 * 60 * 1000 &&
                    Number.isFinite(saved.renewAt) && saved.renewAt > Date.now() && saved.renewAt < saved.expiresAt &&
                    Number.isSafeInteger(saved.playerId) && saved.playerId > 0 && Number.isSafeInteger(saved.factionId) && saved.factionId > 0) {
                    this.accept(saved); return;
                }
                const response = await crossOriginFetch(AUTH_API, 'POST', '/v1/session',
                    { 'Content-Type': 'application/json' }, JSON.stringify({ apiKey: key, app: 'attack-advisor', clientVersion: VERSION }));
                if (gen !== this.gen || key !== apiKey()) return;
                if (response.status === 200) {
                    const data = JSON.parse(response.text), expiresAt = Number(data.expiresAt) * 1000;
                    if (typeof data.token !== 'string' || !data.token || data.token.length > 8192 ||
                        !Number.isFinite(expiresAt) || expiresAt <= Date.now() + AUTH_EXPIRY_SKEW_MS || expiresAt > Date.now() + 5 * 60 * 1000 ||
                        !Number.isSafeInteger(data.playerId) || data.playerId < 1 || !Number.isSafeInteger(data.factionId) || data.factionId < 1) throw new Error('Invalid authorization response');
                    const record = { token: data.token, expiresAt, renewAt: Math.min(Date.now() + AUTH_REFRESH_MS, expiresAt - AUTH_EXPIRY_SKEW_MS),
                        playerId: data.playerId, factionId: data.factionId, keyHash, version: VERSION };
                    await secureSet(SESSION_STORAGE_KEY, JSON.stringify(record));
                    if (gen !== this.gen || key !== apiKey()) return;
                    this.accept(record);
                } else if (response.status === 401 || response.status === 403) {
                    await secureDelete(SESSION_STORAGE_KEY);
                    if (gen !== this.gen || key !== apiKey()) return;
                    this.token = null; this.expiresAt = 0; this.state = 'denied';
                    this.nextTryAt = Date.now() + retryDelay(response); onSessionChange();
                } else this.deferRetry(response);
            };
            try {
                // Web Locks serialize renewals between tabs. PDA without this browser API
                // still reuses protected storage and coalesces within this script instance.
                if (typeof navigator !== 'undefined' && navigator.locks) await navigator.locks.request('rr-attack-session', run);
                else await run();
            } catch (_) { if (gen === this.gen && key === apiKey()) this.deferRetry(); }
            finally { if (gen === this.gen) this.inFlight = false; }
        }
    };

    const WarRoom = {
        token: null,
        inFlight: false,
        nextTryAt: 0,
        gen: 0,
        reset() {
            this.gen++;
            this.token = null;
            this.inFlight = false;
            this.nextTryAt = 0;
        },
        async ensure() {
            if (!Session.pass() || !validKey(apiKey())) return null;
            if (this.token) return this.token;
            if (this.inFlight || Date.now() < this.nextTryAt) return null;

            const gen = this.gen;
            this.inFlight = true;
            try {
                const response = await crossOriginFetch(
                    ZZCRAFT_API,
                    'POST',
                    '/auth/login',
                    { 'Content-Type': 'application/json', 'User-Agent': ZZCRAFT_USERAGENT },
                    JSON.stringify({ apikey: apiKey() })
                );
                if (gen !== this.gen || !Session.pass()) return null;
                if (!response.ok) {
                    this.nextTryAt = Date.now() + retryDelay(response);
                    return null;
                }

                const data = JSON.parse(response.text);
                if (typeof data.token !== 'string' ||
                    data.token.length < 1 ||
                    data.token.length > 8192 ||
                    /[\u0000-\u001f\u007f]/.test(data.token)) {
                    throw new Error('invalid WarRoom token');
                }
                this.token = data.token;
                this.nextTryAt = 0;
                return this.token;
            } catch (e) {
                if (gen === this.gen) this.nextTryAt = Date.now() + RETRY_NET;
                return null;
            } finally {
                if (gen === this.gen) this.inFlight = false;
            }
        }
    };

    function analysisInput() {
        const { own, def } = weaponSlotBuckets();
        const helmet = readHelmet();
        if (helmet.state === 'known') lastHelmet = helmet.helmet;
        else if (helmet.state === 'bare') lastHelmet = '';
        const bonuses = readDefenderBonuses(def);
        if (bonuses.state === 'known') lastBonuses = bonuses.bonuses;
        const temp = readOwnTemp(own.weapon_temp);
        return {
            helmet: lastHelmet, bonuses: lastBonuses || [],
            temp: temp ? { empty: temp.empty, name: temp.name || null } : null,
            // Required by the deployed API; outcome presentation is now entirely local.
            labels: [], attackType: 1, defenderId: defenderId() ? Number(defenderId()) : null,
            war: { state: War.state, ranked: War.ranked, factionId: Session.factionId,
                roster: War.roster ? { oppId: War.rosterId, ids: Array.from(War.roster) } : null },
            limits: Limits.payload ? { currentLimit: Limits.payload.currentLimit, member: Limits.payload.member } : null
        };
    }

    const Analysis = {
        result: null, signature: '', observed: '', pending: false, gen: 0, nextTryAt: 0, expiresAt: 0, block: null,
        reset() { this.gen++; this.result = null; this.signature = ''; this.observed = ''; this.pending = false; this.nextTryAt = 0; this.expiresAt = 0; this.block = null; },
        current() { return Session.pass() && !!this.result && this.signature === this.observed && Date.now() < this.expiresAt; },
        // Retain presentation during a request only when its relevant observations
        // still match. Permission and data acquisition continue to use current().
        display(section) {
            if (!Session.pass() || !this.result) return null;
            if (this.current()) return this.result;
            if (!this.pending || !this.signature) return null;
            const before = JSON.parse(this.signature), now = analysisInput();
            const context = input => section === 'limits' ? [input.defenderId, input.war] :
                [input.defenderId, input.helmet, input.bonuses, input.temp];
            return JSON.stringify(context(before)) === JSON.stringify(context(now)) ? this.result : null;
        },
        blocked() {
            if (!this.block) return false;
            const input = analysisInput();
            if (!Session.pass() || this.block.sessionGen !== Session.gen || this.block.search !== location.search ||
                Date.now() >= this.block.until || this.block.context !== JSON.stringify([input.defenderId, input.war])) {
                this.block = null;
                return false;
            }
            return true;
        },
        async refresh() {
            if (!Session.pass()) return;
            const input = analysisInput(), signature = JSON.stringify(input);
            this.observed = signature;
            if (this.current() || this.pending || Date.now() < this.nextTryAt) return;
            const gen = this.gen, sessionGen = Session.gen, token = Session.token, search = location.search;
            this.pending = true;
            schedule();
            try {
                const response = await crossOriginFetch(AUTH_API, 'POST', '/v1/attack/analyse',
                    { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, signature);
                if (gen !== this.gen || sessionGen !== Session.gen || token !== Session.token || search !== location.search || !Session.pass()) return;
                if (response.status === 401 || response.status === 403) {
                    Session.reset(); Session.state = response.status === 403 ? 'denied' : 'unknown';
                    Session.nextTryAt = Date.now() + retryDelay(response);
                    await secureDelete(SESSION_STORAGE_KEY); onSessionChange();
                    return;
                }
                if (!response.ok) { this.result = null; this.nextTryAt = Date.now() + retryDelay(response); return; }
                if (signature !== JSON.stringify(analysisInput())) return;
                const result = JSON.parse(response.text);
                if (!result || !result.advice || !result.buttons || !result.war || !result.limits || !Number.isFinite(result.revalidateAt)) throw new Error('Invalid analysis response');
                this.result = result; this.signature = signature;
                this.expiresAt = Math.min(result.revalidateAt, Session.expiresAt);
                this.nextTryAt = 0;
                // A known prohibition survives equipment/advice renewal for this same war target.
                // A new decision replaces it; navigation, authorization and war changes invalidate it.
                this.block = result.limits.blocked ? { sessionGen, search,
                    context: JSON.stringify([input.defenderId, input.war]),
                    until: result.limits.pending ? result.war.startAt : Infinity } : null;
                War.oppId = result.war.oppId; War.oppName = result.war.oppName; War.startAt = result.war.startAt;
            } catch (_) { if (gen === this.gen) { this.result = null; this.nextTryAt = Date.now() + RETRY_NET; } }
            finally { if (gen === this.gen) { this.pending = false; schedule(); } }
        }
    };

    function apiKey() {
        return authApiKey;
    }

    // The API only accepts 16- or 50-char alphanumeric keys - catch typos
    // before transmitting the key anywhere.
    function validKey(k) {
        return /^[A-Za-z0-9]{16}$/.test(k) || /^[A-Za-z0-9]{50}$/.test(k);
    }

    // Keyed to the current URL, not the page lifetime - TornPDA re-navigates
    // in place (the injection guard exists for exactly that), and a stale id
    // here would point war blocking and log links at the previous opponent.
    let defenderCache = { search: null, id: null };

    function defenderId() {
        if (defenderCache.search !== location.search) {
            defenderCache = { search: location.search, id: null };
            try { defenderCache.id = new URLSearchParams(location.search).get('user2ID'); } catch (e) { }
        }
        return defenderCache.id;
    }

    function warTarget() {
        const war = Analysis.current() && Analysis.result.war;
        return war && war.target ? { oppId: war.oppId, pending: war.phase === 'pending' } : null;
    }

    // "Saturday, 8th August at 20:00" in the viewer's local time zone.
    function warStartText() {
        const d = new Date(War.startAt);
        const day = d.getDate();
        const suffix = day % 100 >= 11 && day % 100 <= 13 ? 'th'
            : ['th', 'st', 'nd', 'rd'][day % 10] || 'th';
        const weekday = d.toLocaleDateString('en-GB', { weekday: 'long' });
        const month = d.toLocaleDateString('en-GB', { month: 'long' });
        const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        return `${weekday}, ${day}${suffix} ${month} at ${hm}`;
    }

    const FACTION_URL = (id) => `https://www.torn.com/factions.php?step=profile&ID=${id}`;

    // Torn answers 200 with an {error:{code,error}} envelope, so an ok status
    // is not enough on its own.
    async function tornGet(path) {
        const key = apiKey();
        if (!validKey(key)) return { error: 'nokey' };

        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 20000);  // a hung fetch must never pin inFlight forever
        let res, body;
        try {
            // The timer spans the BODY read too - fetch resolves at headers,
            // and a stalled body would otherwise hang with no abort left.
            res = await fetch(`${TORN_API}${path}`, {
                headers: { Authorization: `ApiKey ${key}` },
                credentials: 'omit',
                signal: ctl.signal
            });
            body = await res.json().catch(() => null);
        } finally {
            clearTimeout(timer);
        }
        if (body && body.error) return { error: body.error.error || 'api', code: body.error.code };
        if (!res.ok) return { error: 'http ' + res.status };
        if (body == null) return { error: 'bad response' };
        return { data: body };
    }

    function readWarCache() {
        const rec = jsonGet(STORAGE_WAR);
        if (rec === null) return null;
        const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
        const id = value => Number.isSafeInteger(value) && value > 0;
        const timestamp = value => Number.isFinite(value) && value > 0 && value <= Date.now();
        const ranked = rec && rec.war && rec.war.ranked;
        if (!object(rec) || !id(rec.factionId) || !object(rec.war) || !timestamp(rec.war.at) ||
            !(ranked === null || (object(ranked) && Number.isFinite(ranked.start) && ranked.start >= 0 &&
                Array.isArray(ranked.factions) && ranked.factions.length === 2 &&
                ranked.factions.every(f => object(f) && id(f.id) && typeof f.name === 'string' && f.name.length <= 200))) ||
            !(rec.roster == null || (object(rec.roster) && id(rec.roster.oppId) && timestamp(rec.roster.at) &&
                Array.isArray(rec.roster.ids) && rec.roster.ids.length <= 500 && rec.roster.ids.every(id)))) {
            storeDel(STORAGE_WAR);
            return null;
        }
        return rec;
    }

    function applyWarCache(rec) {
        if (!Session.pass() || !rec || rec.factionId !== Session.factionId || !fresh(rec.war, TTL_WAR)) return;
        const before = JSON.stringify([War.state, War.ranked, War.rosterId, War.roster && Array.from(War.roster)]);
        War.ranked = rec.war.ranked;
        War.state = rec.war.ranked ? 'war' : 'nowar';
        War.roster = null; War.rosterId = null;
        if (rec.war.ranked && rec.roster && fresh(rec.roster, TTL_ROSTER)) {
            War.roster = new Set(rec.roster.ids); War.rosterId = rec.roster.oppId;
        }
        const changed = before !== JSON.stringify([War.state, War.ranked, War.rosterId, War.roster && Array.from(War.roster)]);
        if (changed) schedule();
        return changed;
    }

    function hydrateWar() {
        applyWarCache(readWarCache());
    }

    async function loadWar() {
        if (!Session.pass() || War.inFlight || Date.now() < War.retryAt) return;
        const gen = War.gen, sessionGen = Session.gen;
        const rec = readWarCache() || {};
        if (rec.factionId !== Session.factionId) { rec.war = null; rec.roster = null; }
        rec.factionId = Session.factionId;
        War.inFlight = true;
        try {
            if (!fresh(rec.war, TTL_WAR)) {
                const r = await tornGet('/faction/wars');
                if (gen !== War.gen || sessionGen !== Session.gen || !Session.pass()) return;
                if (r.error) throw new Error('wars: ' + r.error);
                const ranked = r.data.wars && r.data.wars.ranked;
                rec.war = { ranked: ranked ? { start: ranked.start, factions: ranked.factions.map(f => ({ id: f.id, name: f.name })) } : null, at: Date.now() };
                rec.roster = null;
                jsonSet(STORAGE_WAR, rec);
            }
            // A changed observation must reach analysis before its opponent can select a roster.
            if (applyWarCache(rec) || !rec.war.ranked) return;
            // The server chooses the opposing faction. The client only transports
            // the resulting Torn request using this user's key.
            const oppId = Analysis.current() && Analysis.result.war.oppId;
            if (oppId && (!fresh(rec.roster, TTL_ROSTER) || rec.roster.oppId !== oppId)) {
                const r = await tornGet('/faction/' + oppId + '/members');
                if (gen !== War.gen || sessionGen !== Session.gen || !Session.pass()) return;
                if (r.error) throw new Error('members: ' + r.error);
                rec.roster = { oppId, ids: (r.data.members || []).map(m => m.id), at: Date.now() };
                jsonSet(STORAGE_WAR, rec); applyWarCache(rec);
            }
        } catch (_) {
            if (gen !== War.gen || sessionGen !== Session.gen) return;
            War.state = 'error'; War.ranked = null; War.roster = null; War.rosterId = null;
            War.retryAt = Date.now() + RETRY_NET; storeDel(STORAGE_WAR); schedule();
        } finally { if (gen === War.gen) War.inFlight = false; }
    }

    // WarRoom limits. TornPDA is a Flutter webview with no GM_* API but its own
    // CSP-exempt bridge; probed per call - it can attach after the script loads.
    const isPda = () => typeof PAGE.flutter_inappwebview !== 'undefined';

    function gmx() {
        if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest;
        if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') {
            return GM.xmlHttpRequest.bind(GM);
        }
        return null;
    }

    // Normalises all three transports to {ok, status, text}.
    function crossOriginFetch(baseUrl, method, path, headers, body) {
        const url = baseUrl + path;
        const timeoutMs = baseUrl === AUTH_API ? 25000 : 20000;

        if (isPda()) {
            const call = method === 'POST'
                ? PAGE.flutter_inappwebview.callHandler('PDA_httpPost', url, headers || {}, body || null)
                : PAGE.flutter_inappwebview.callHandler('PDA_httpGet', url, headers || {});
            let timer;
            const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), timeoutMs); });
            return Promise.race([Promise.resolve(call), timeout]).then(r => ({
                ok: r.status >= 200 && r.status < 300, status: r.status, text: r.responseText || '', headers: r.responseHeaders || r.headers || ''
            })).finally(() => clearTimeout(timer));
        }

        const x = gmx();
        if (!x) return Promise.reject(new Error('no GM_xmlhttpRequest - CSP blocks a direct fetch'));

        return new Promise((resolve, reject) => {
            x({
                method, url,
                headers: headers || {},
                data: body || null,
                timeout: timeoutMs,
                onload: r => resolve({
                    ok: r.status >= 200 && r.status < 300, status: r.status, text: r.responseText || '', headers: r.responseHeaders || r.headers || ''
                }),
                onerror: () => reject(new Error('network')),
                ontimeout: () => reject(new Error('timeout'))
            });
        });
    }

    function hydrateLimits() {
        storeDel(STORAGE_JWT);
        storeDel(STORAGE_LIMITS);
        storeDel('txm-debug-seeded');                       // legacy debug fixture marker
        Limits.payload = null;
        Limits.at = 0;
    }

    async function ensurePlayerId() {
        return Session.pass() ? playerId : null;
    }

    function nonNegativeNumberOrNull(value) {
        if (value == null) return null;
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
    }

    function sanitizeCurrentLimit(value) {
        if (value == null) return null;
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

        const minHits = nonNegativeNumberOrNull(value.minHits);
        const maxHits = nonNegativeNumberOrNull(value.maxHits);
        const minTotalRespect = nonNegativeNumberOrNull(value.minTotalRespect);
        const maxTotalRespect = nonNegativeNumberOrNull(value.maxTotalRespect);
        const averageRespectGoal = nonNegativeNumberOrNull(value.averageRespectGoal);
        const noHitsAllowed = value.noHitsAllowed == null ? false : value.noHitsAllowed;
        if ([minHits, maxHits, minTotalRespect, maxTotalRespect, averageRespectGoal]
            .some(number => number === undefined) || typeof noHitsAllowed !== 'boolean') {
            return undefined;
        }
        return {
            minHits, maxHits, minTotalRespect, maxTotalRespect,
            averageRespectGoal, noHitsAllowed
        };
    }

    function sanitizeMember(value) {
        if (value == null) return null;
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
        const nbWarHits = nonNegativeNumberOrNull(value.nbWarHits);
        const averageRespect = nonNegativeNumberOrNull(value.averageRespect);
        const nbHitsNotAllowed = nonNegativeNumberOrNull(value.nbHitsNotAllowed);
        if ([nbWarHits, averageRespect, nbHitsNotAllowed].some(number => number === undefined)) {
            return undefined;
        }
        return { nbWarHits, averageRespect, nbHitsNotAllowed };
    }

    function sanitizeLimitsPayload(value, ownPlayerId) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const currentLimit = sanitizeCurrentLimit(value.currentLimit);
        if (currentLimit === undefined || !Array.isArray(value.members) || value.members.length > 500) {
            return null;
        }
        const rawMember = value.members.find(member =>
            member && typeof member === 'object' && Number(member.id) === ownPlayerId
        );
        const member = sanitizeMember(rawMember || null);
        if (member === undefined) return null;

        const nextUpdate = value.nextUpdate;
        if (nextUpdate != null &&
            (typeof nextUpdate !== 'string' || !Number.isFinite(Date.parse(nextUpdate)))) {
            return null;
        }
        return { currentLimit, member, nextUpdate: nextUpdate || null };
    }

    async function fetchWarRoomLimits(token) {
        return crossOriginFetch(
            ZZCRAFT_API,
            'GET',
            '/rankedwars/last',
            { Authorization: `Bearer ${token}`, 'User-Agent': ZZCRAFT_USERAGENT  }
        );
    }

    async function loadLimits() {
        if (!Session.pass()) return;
        if (Limits.inFlight || Limits.authFailed) return;
        if (Date.now() < Limits.nextAt) return;

        const gen = Limits.gen;                             // a key change mid-flight voids this response
        const sessionGen = Session.gen;
        Limits.inFlight = true;
        try {
            const ownPlayerId = await ensurePlayerId();
            if (gen !== Limits.gen || sessionGen !== Session.gen || !Session.pass()) return;
            let token = await WarRoom.ensure();
            if (gen !== Limits.gen || sessionGen !== Session.gen || !Session.pass()) return;
            if (!ownPlayerId || !token) throw new Error('WarRoom unavailable');

            let res = await fetchWarRoomLimits(token);
            if (res.status === 401) {
                if (gen !== Limits.gen || sessionGen !== Session.gen || !Session.pass()) return;
                WarRoom.reset();
                token = await WarRoom.ensure();
                if (gen !== Limits.gen || sessionGen !== Session.gen) return;
                if (token) res = await fetchWarRoomLimits(token);
            }
            if (gen !== Limits.gen || sessionGen !== Session.gen || !Session.pass()) return;

            if (res.status === 401 || res.status === 403) {
                Limits.rejects++;
                Limits.authFailed = Limits.rejects >= 3;
                WarRoom.reset();
                Limits.payload = null;
                Limits.at = 0;
                Limits.nextAt = Date.now() + RETRY_NET;
                return;
            }
            if (!res.ok) {
                Limits.payload = null; Limits.at = 0; Limits.nextAt = Date.now() + retryDelay(res);
                return;
            }
            Limits.rejects = 0;
            Limits.authFailed = false;

            const payload = sanitizeLimitsPayload(JSON.parse(res.text), ownPlayerId);
            if (!payload) throw new Error('invalid limits response');
            Limits.payload = payload;
            Limits.at = Date.now();

            // Honour the service's own nextUpdate, clamped so a bad value cannot spin us.
            const nx = payload && payload.nextUpdate && Date.parse(payload.nextUpdate);
            const wait = nx ? nx - Date.now() : POLL_MIN;
            Limits.nextAt = Date.now() + Math.max(POLL_MIN, Math.min(POLL_MAX, wait));
        } catch (e) {
            if (gen === Limits.gen) {
                Limits.payload = null;
                Limits.at = 0;
                Limits.nextAt = Date.now() + RETRY_NET;
            }
        } finally {
            if (gen === Limits.gen) { Limits.inFlight = false; schedule(); }
        }
    }

    function blockStartFight(on) {
        const box = q(document, sel('dialogButtons'));
        if (!box) return;

        qa(box, 'button').forEach(b => {
            const text = b.textContent.trim().toLowerCase();
            if (on && Session.pass() && START_LABELS.includes(text)) setAttr(b, 'data-txm-block', '');
            else if (b.hasAttribute('data-txm-block')) b.removeAttribute('data-txm-block');
        });
    }

    function chip(row, cls, text, attrs) {
        const s = document.createElement('span');
        s.className = cls;
        s.textContent = text;
        if (attrs) Object.keys(attrs).forEach(k => s.setAttribute(k, attrs[k]));
        row.appendChild(s);
        return s;
    }

    function renderLimits() {
        const bar = q(document, '.txm-fa-bar');
        if (!bar) return;
        const row = q(bar, '.txm-fa-limits'), warnRow = q(bar, '.txm-fa-warn');
        const result = Analysis.display('limits');
        const view = result && result.limits;
        const unavailable = !!(view && view.visible && !Limits.payload);
        const analysisFailed = Analysis.nextTryAt > 0;
        const signature = JSON.stringify([view, unavailable, Limits.authFailed, Limits.inFlight, analysisFailed]);
        if (signature !== limitsSig) {
            limitsSig = signature;
            setShown(row, !!(view && view.visible && !unavailable));
            if (view && view.visible && !unavailable) {
                const layout = JSON.stringify([view.parts.map(p => p[0]), view.stats.map(s => s.label)]);
                if (row.getAttribute('data-txm-layout') !== layout || !row.children.length) {
                    row.textContent = '';
                    setAttr(row, 'data-txm-layout', layout);
                    chip(row, 'txm-fa-key', 'LIMITS');
                    if (!view.parts.length) chip(row, 'txm-fa-lim', 'none set');
                    view.parts.forEach(([label, value], i) => {
                        if (i) chip(row, 'txm-fa-sep', '·');
                        const part = chip(row, 'txm-fa-lim', label ? label + ' ' : '');
                        const bold = document.createElement('b'); bold.textContent = value; part.appendChild(bold);
                    });
                    const mine = document.createElement('span'); mine.className = 'txm-fa-mine'; row.appendChild(mine);
                    view.stats.forEach((stat, i) => {
                        if (i) chip(mine, 'txm-fa-sep', '·');
                        chip(mine, 'txm-fa-key', stat.label);
                        const attrs = {}; if (stat.ok) attrs['data-ok'] = stat.ok; if (stat.cap) attrs['data-cap'] = '1';
                        chip(mine, 'txm-fa-val', stat.value, attrs);
                    });
                    chip(mine, 'txm-fa-age', '');
                } else {
                    qa(row, '.txm-fa-lim b').forEach((node, i) => setLiveText(node, view.parts[i][1]));
                    qa(row, '.txm-fa-val').forEach((node, i) => {
                        const stat = view.stats[i];
                        setLiveText(node, stat.value);
                        if (stat.ok) setAttr(node, 'data-ok', stat.ok); else delAttr(node, 'data-ok');
                        if (stat.cap) setAttr(node, 'data-cap', '1'); else delAttr(node, 'data-cap');
                    });
                }
            }
            let warning = '';
            if (!result) warning = analysisFailed ? 'Advice and war checks unavailable' : '';
            else if (view.pending) warning = 'The war' + (result.war.oppName ? ' with ' + result.war.oppName : '') + ' starts on ' + warStartText() + '. Start Fight has been disabled until then.';
            else if (view.visible && Limits.authFailed) warning = 'War limits key rejected. Save your Torn API key in Settings to retry.';
            else if (unavailable) warning = Limits.inFlight ? '' : 'War limits unavailable. Retrying…';
            else if (view.reason) warning = 'Warning: ' + view.reason;
            setShown(warnRow, !!warning); setLiveText(warnRow, warning);
        }
        const age = q(row, '.txm-fa-age');
        setLiveText(age, Limits.at ? 'updated ' + Math.round((Date.now() - Limits.at) / 1000) + 's ago' : 'no data');
        setAttr(age, 'data-stale', !Limits.at || Date.now() - Limits.at > STALE_AFTER ? '1' : '0');
        blockStartFight(Analysis.blocked());
    }

    // #endregion

    // #region Settings

    // Settings panel (structure derived from Smart Stock Vault's settings cog)

    async function applyApiKey(v) {
        Session.reset();
        Analysis.reset();
        await secureDelete(SESSION_STORAGE_KEY);
        await saveApiKey(v);

        // A new key invalidates everything derived from the old one, including
        // any response still in flight (generation bump).
        storeDel(STORAGE_JWT);
        storeDel(STORAGE_WAR);
        storeDel(STORAGE_LIMITS);
        Limits.authFailed = false;
        Limits.rejects = 0;
        Limits.payload = null;
        Limits.at = 0;
        Limits.nextAt = 0;
        Limits.gen++;
        War.state = 'idle';
        War.ranked = null;
        War.rosterId = null;
        War.roster = null;
        War.oppId = null;
        War.oppName = null;
        War.startAt = 0;
        War.retryAt = 0;
        War.gen++;
        WarRoom.reset();
        playerId = null;
        limitsSig = '';
        barSig = '';                                        // back-to-faction link keys off the war target
        Session.reset();
        onSessionChange();
        schedule();
        void Session.refresh();
    }

    async function validateKey(btn, setStatus) {
        if (!validKey(apiKey())) { setStatus('✗ No valid key saved - Save first', 'bad'); return; }
        btn.disabled = true;
        setStatus('Validating…', 'wait');
        try {
            const r = await tornGet('/user/basic');
            if (r.error) setStatus(`✗ ${r.error}`, 'bad');
            else {
                const b = r.data && r.data.basic;
                setStatus(b ? `✓ Valid - ${b.name} [${b.id}]` : '✓ Valid key', 'ok');
            }
        } catch (e) {
            setStatus('✗ Connection error', 'bad');
        } finally {
            btn.disabled = false;
        }
    }

    let escClose = null;
    let settingsTrigger = null;

    function closeSettings() {
        const overlay = document.getElementById('txm-fa-settings');
        if (overlay) overlay.remove();
        if (escClose) { document.removeEventListener('keydown', escClose); escClose = null; }
        const trigger = settingsTrigger;
        settingsTrigger = null;
        if (trigger && trigger.isConnected) trigger.focus();
    }

    function openSettings(trigger) {
        const existing = document.getElementById('txm-fa-settings');
        if (existing) {
            q(existing, '.txm-fa-set-input')?.focus();
            return;
        }
        settingsTrigger = trigger || document.activeElement;

        const FEATURES = [
            ['advisor', 'Bonus advisor', 'Enemy bonus chips, weapon slot tags and the temporary-weapon verdict'],
            ['buttons', 'Move attack buttons', 'On desktop layouts, reposition Start Fight / outcome buttons beside your weapons and hide the emptied dialog frame'],
            ['outcome', 'Outcome filter', 'Hide the outcome buttons you have not selected in the Attack dropdown'],
            ['loglinks', 'Log profile links', "Link the defender's name in the fight log to their profile"]
        ];

        const overlay = document.createElement('div');
        overlay.id = 'txm-fa-settings';
        overlay.className = 'txm-fa-set-overlay';

        const modal = document.createElement('div');
        modal.className = 'txm-fa-set-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'txm-fa-settings-title');
        modal.innerHTML = `
            <div class="txm-fa-set-head">
            <b id="txm-fa-settings-title">RR ATTACK ADVISOR</b>
            <button type="button" class="txm-fa-set-close" aria-label="Close settings">&times;</button>
            </div>
            <div class="txm-fa-set-body">
                <div class="txm-fa-set-tabs">
                    <button type="button" class="txm-fa-set-tab active" data-tab="api">API</button>
                    <button type="button" class="txm-fa-set-tab" data-tab="features">Features</button>
                </div>

                <div data-pane="api">
                    <div class="txm-fa-set-section">
                        <div class="txm-fa-set-title">Torn API key (Public Access)</div>
                        <input type="password" class="txm-fa-set-input" placeholder="Paste your API key"
                               autocomplete="off" spellcheck="false"
                               title="16 or 50 alphanumeric characters">
                        <div class="txm-fa-set-status">No API key set</div>
                        <div class="txm-fa-set-actions">
                            <button type="button" class="txm-fa-api" data-act="save">Save</button>
                            <button type="button" class="txm-fa-api" data-act="validate">Validate</button>
                            <button type="button" class="txm-fa-api" data-act="remove">Remove</button>
                        </div>
                    </div>
                </div>

                <div data-pane="features" hidden>
                    <div class="txm-fa-set-section">
                        <div class="txm-fa-set-title">Features</div>
                        ${FEATURES.map(([k, name, desc]) => `
                        <label class="txm-fa-set-check">
                            <input type="checkbox" data-setting="${k}">
                            <span><b>${name}</b> - ${desc}</span>
                        </label>`).join('')}
                        <div class="txm-fa-set-note">War limits &amp; Start Fight blocking are always active - they are a faction requirement and cannot be disabled.</div>
                    </div>
                </div>
            </div>
        `;

        const input = q(modal, '.txm-fa-set-input');
        input.value = apiKey();                             // property write - never interpolated into HTML

        const status = q(modal, '.txm-fa-set-status');
        const setStatus = (text, state) => {
            status.textContent = text;
            setAttr(status, 'data-state', state || '');
        };
        if (validKey(apiKey())) setStatus('✓ API key configured', 'ok');

        input.addEventListener('input', () => delAttr(input, 'data-bad'));

        const doSave = async () => {
            const v = input.value.trim();
            if (v && !validKey(v)) {                         // reject typos before transmitting anything
                setAttr(input, 'data-bad', '1');
                setStatus('✗ Keys are 16 or 50 alphanumeric characters', 'bad');
                return;
            }
            delAttr(input, 'data-bad');
            setStatus('Saving…', 'wait');
            try {
                await applyApiKey(v);
                setStatus(v ? '✓ Key saved' : 'No API key set', v ? 'ok' : '');
            } catch (e) {
                setAttr(input, 'data-bad', '1');
                setStatus('✗ Protected storage unavailable', 'bad');
            }
        };

        modal.addEventListener('click', (e) => {
            const act = e.target.getAttribute && e.target.getAttribute('data-act');
            if (act === 'save') void doSave();
            else if (act === 'remove') {
                input.value = '';
                delAttr(input, 'data-bad');
                setStatus('Removing…', 'wait');
                void applyApiKey('')
                    .then(() => setStatus('Key removed', ''))
                    .catch(() => setStatus('✗ Protected storage unavailable', 'bad'));
            } else if (act === 'validate') safe('validate', () => validateKey(e.target, setStatus));
        });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void doSave(); });

        qa(modal, '.txm-fa-set-tab').forEach(tab => tab.addEventListener('click', () => {
            qa(modal, '.txm-fa-set-tab').forEach(t => t.classList.toggle('active', t === tab));
            qa(modal, '[data-pane]').forEach(p => setShown(p, p.getAttribute('data-pane') === tab.getAttribute('data-tab')));
        }));

        // Feature toggles - applied and persisted immediately, no save step.
        qa(modal, '[data-setting]').forEach(box => {
            const k = box.getAttribute('data-setting');
            box.checked = !!settings[k];
            box.addEventListener('change', () => {
                settings[k] = box.checked;
                saveSettings();
                refreshStyle();                              // styleKey carries the buttons toggle
                schedule();
            });
        });

        q(modal, '.txm-fa-set-close').addEventListener('click', closeSettings);
        // Close only when the CLICK began on the backdrop - a text-selection
        // drag from the key input that ends outside the modal must not close it.
        let downOnOverlay = false;
        overlay.addEventListener('mousedown', (e) => { downOnOverlay = e.target === overlay; });
        overlay.addEventListener('click', (e) => { if (e.target === overlay && downOnOverlay) closeSettings(); });
        escClose = (e) => { if (e.key === 'Escape') closeSettings(); };
        document.addEventListener('keydown', escClose);

        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        input.focus();
    }

    function promptForApiKey() {
        if (setupPrompted || validKey(apiKey())) return;
        setupPrompted = true;
        openSettings(q(document, '.txm-fa-gear'));
    }

    // #endregion

    // #region Extras

    // Attack-log name links

    // Keyed to the defender id so a PDA in-place navigation to a new opponent
    // can never pair the old name with the new id (or vice versa).
    let defNameCache = { id: null, name: null };

    function defenderName() {
        const id = defenderId();
        if (defNameCache.id !== id) defNameCache = { id, name: null };
        const el = q(document, `${sel('headerWrapper')}${sel('rose')} ${sel('userName')}`);
        const t = el && el.textContent.trim();
        if (t) defNameCache.name = t;                        // cached - React tears the header down post-fight
        return defNameCache.name;
    }

    const NAME_CHAR = /[A-Za-z0-9_\-]/;

    function wrapName(node, name, href) {
        let idx = 0;
        while ((idx = node.nodeValue.indexOf(name, idx)) !== -1) {
            const before = node.nodeValue[idx - 1];
            const after = node.nodeValue[idx + name.length];
            if ((before && NAME_CHAR.test(before)) || (after && NAME_CHAR.test(after))) {
                idx += name.length;                          // partial match inside a longer word
                continue;
            }
            const mid = node.splitText(idx);
            mid.splitText(name.length);
            const a = document.createElement('a');
            a.className = 'txm-fa-namelink';
            a.target = '_blank';
            a.rel = 'noopener';
            a.href = href;
            mid.parentNode.insertBefore(a, mid);
            a.appendChild(mid);
            return true;                                     // the name appears at most once per message
        }
        return false;
    }

    // Wrap the defender's name in each log message with a profile link.
    // Mutations stay inside one leaf text run of a row - React tolerates that,
    // but never reparent a React-managed node itself (see the escape proxy
    // note). No processed-marker: the log PREPENDS rows and React reuses row
    // nodes by index, rewriting their text and destroying our anchors - so
    // each pass simply re-links any message that lacks one. Self-healing, and
    // the contains-anchor check keeps settled passes write-free.
    function linkDefenderNames() {
        if (!settings.loglinks) {                            // toggled off: unwrap our own anchors
            qa(document, 'a.txm-fa-namelink').forEach(a => a.replaceWith(...a.childNodes));
            return;
        }
        const id = defenderId();
        if (!id) return;
        const name = defenderName();
        if (!name) return;

        const href = `https://www.torn.com/profiles.php?XID=${id}`;

        qa(document, `${sel('logWrap')} ${sel('message')}`).forEach(msg => {
            if (q(msg, 'a.txm-fa-namelink')) return;

            const walker = document.createTreeWalker(msg, NodeFilter.SHOW_TEXT);
            const nodes = [];
            while (walker.nextNode()) nodes.push(walker.currentNode);

            for (const node of nodes) {
                if (node.parentNode && node.parentNode.closest('a')) continue;
                if (wrapName(node, name, href)) break;
            }
        });
    }

    // #endregion

    // #region Lifecycle

    // Init

    let wasAuthorized = false;

    function teardownAuthorized() {
        Analysis.reset();
        const attributes = [
            'data-txm-block', 'data-txm-hide', 'data-txm-warn', 'data-txm-label',
            'data-txm-disarm', 'data-txm-disarm-label', 'data-txm-dialog',
            'data-txm-temp', 'data-txm-helmet'
        ];
        attributes.forEach(attribute => {
            qa(document, `[${attribute}]`).forEach(element => element.removeAttribute(attribute));
        });
        qa(document, 'a.txm-fa-namelink').forEach(anchor => anchor.replaceWith(...anchor.childNodes));

        const bar = q(document, '.txm-fa-bar');
        if (bar) setAttr(bar, 'data-txm-mirror', '0');
        blockStartFight(false);

        storeDel(STORAGE_JWT);
        storeDel(STORAGE_LIMITS);
        storeDel(STORAGE_WAR);

        War.state = 'idle';
        War.ranked = null;
        War.rosterId = null;
        War.oppId = null;
        War.oppName = null;
        War.roster = null;
        War.startAt = 0;
        War.inFlight = false;
        War.retryAt = 0;
        War.gen++;

        WarRoom.reset();
        playerId = null;

        Limits.payload = null;
        Limits.at = 0;
        Limits.nextAt = 0;
        Limits.inFlight = false;
        Limits.authFailed = false;
        Limits.rejects = 0;
        Limits.gen++;

        lastHelmet = null;
        lastBonuses = null;
        barSig = '';
        adviceSig = '';
        limitsSig = '';
    }

    function onSessionChange() {
        const authorized = Session.pass();
        if (authorized && !wasAuthorized) {
            hydrateLimits();
            hydrateWar();
        } else if (!authorized && wasAuthorized) {
            teardownAuthorized();
        }
        wasAuthorized = authorized;
        styleKey = '';
        schedule();
    }

    // TornPDA navigates in place, so every page-scoped cache keys off the URL.
    let lastSearch = location.search;

    function sync() {
        if (!apiKeyLoaded) return;
        if (location.search !== lastSearch) {               // new opponent, same script instance
            lastSearch = location.search;
            lastHelmet = null;
            lastBonuses = null;
            defNameCache = { id: null, name: null };
            Analysis.reset();
        }
        refreshStyle();                                     // first, so the hide rules exist before the bar lands
        safe('topbar', renderTopBar);
        if (!Session.pass()) {
            if (wasAuthorized) onSessionChange();
            safe('auth', () => void Session.refresh());
            return;
        }
        safe('analysis', () => void Analysis.refresh());
        safe('war-load', () => void loadWar());
        if (Analysis.current() && Analysis.result.limits.visible) safe('limits-load', () => void loadLimits());
        safe('buttons', filterOutcomeButtons);
        safe('dialog', classifyDialog);
        safe('advice', renderAdvice);
        safe('limits', renderLimits);                       // after buttons - it may block START FIGHT
        safe('inforow', syncInfoRow);
        safe('links', linkDefenderNames);
    }

    let queued = false;

    function schedule() {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
            queued = false;
            safe('sync', sync);
        });
    }

    safe('hydrate', hydrateLimits);

    void loadApiKey()
        .then(() => {
            apiKeyLoaded = true;
            Session.reset();
            safe('sync', sync);
            safe('setup', promptForApiKey);
        })
        .catch(() => {
            apiKeyLoaded = true;
            authApiKey = '';
            Session.reset();
            Session.state = 'denied';
            onSessionChange();
            safe('setup', promptForApiKey);
        });

    // The attack UI is entirely client-rendered - observe rather than race it.
    // attributeFilter catches React className churn and the mobile tab switch.
    new MutationObserver(schedule).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class']
    });

    window.addEventListener('resize', schedule);

    // React ticks the header timers via characterData, which the observer never
    // sees (watching characterData on body would fire on every damage number).
    // One bounded poll instead, signature-guarded to zero writes when unchanged.
    setInterval(() => {
        if (document.hidden || !apiKeyLoaded) return;
        if (!Session.pass()) {
            if (wasAuthorized) onSessionChange();
            safe('tick-auth', () => void Session.refresh());
            safe('tick-authbar', renderTopBar);
            return;
        }
        safe('tick-analysis', () => void Analysis.refresh());
        safe('tick-war', () => void loadWar());
        if (Analysis.current() && Analysis.result.limits.visible) safe('tick-limits-load', () => void loadLimits());
        safe('tick', updateBar);
        safe('tick-limits', renderLimits);                  // drives the nextUpdate-paced poll
        safe('tick-inforow', syncInfoRow);
    }, 1000);

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) safe('visibility-auth', () => void Session.refresh());
        schedule();
    });

    // pointer-events:none stops mouse and touch; the capture-phase listener also
    // covers keyboard activation and synthetic clicks.
    document.addEventListener('click', (e) => {
        const t = e.target;
        const blocked = t && t.closest && t.closest('[data-txm-block]');
        if (blocked) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    // #endregion

})();
