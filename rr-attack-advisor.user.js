// ==UserScript==
// @name         RR Attack Advisor
// @namespace    txm.fastattack
// @version      4.2.2
// @description  Attack Page QOL Changes & RR War Condition Integration
// @author       TXM [1712536]
// @updateURL    https://raw.githubusercontent.com/deathapostle-1/Ruthless-Reborn/main/rr-attack-advisor.user.js
// @downloadURL  https://raw.githubusercontent.com/deathapostle-1/Ruthless-Reborn/main/rr-attack-advisor.user.js
// @match        https://www.torn.com/page.php?sid=attack*
// @match        https://www.torn.com/loader.php?sid=attack*
// @match        https://www.torn.com/page.php?*&sid=attack*
// @match        https://www.torn.com/loader.php?*&sid=attack*
// @match        https://www.torn.com/factions.php*
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
    const LEGACY_KEYS = ['torn-attack-api-key', 'torn-attack-jwt'];  // old page-readable key/token copies, deleted
    const SECURE_STORAGE_KEY = 'torn-attack-api-key-v2';
    const SESSION_STORAGE_KEY = 'rr-attack-session-v1';
    const ZZ_STORAGE_KEY = 'rr-attack-zz-v1';               // {keyHash, token} ZZCraft login, kept between attacks
    const LIMITS_STORAGE_KEY = 'rr-attack-limits-v2';       // {playerId, keyHash, payload, at, dataAt, nextAt, validUntil}
    const VERDICT_STORAGE_KEY = 'rr-attack-verdict-v1';     // the last war-limits answer: {keyHash, war, limits, updatedAt, decision, reason, validUntil}
    const STORAGE_WAR = 'torn-attack-war';                  // {factionId, war: {ranked, at}, roster: {oppId, ids, at}}
    const STORAGE_SETTINGS = 'torn-attack-settings';        // {advisor, buttons, outcome, loglinks}

    // War limits and Start Fight blocking are deliberately NOT in here - they
    // are a faction requirement and have no toggle path.
    const SETTINGS_DEFAULTS = {
        advisor: true,                                      // bonus chips + slot tags + temp verdict
        buttons: true,                                      // desktop dialog reposition + frame hide
        outcome: true,                                      // leave/mug/hosp filtering
        loglinks: true                                      // defender profile links in the log
    };

    const COMPACT_WIDTH = 1000;                             // Torn drops to the single-panel layout at/below this

    const VERSION = '4.2.2';                                // keep in step with @version above

    // Cross-origin auth traffic uses GM_xmlhttpRequest or TornPDA's native bridge.
    const TORN_API = 'https://api.torn.com/v2';
    const AUTH_API = 'https://rr-script-auth.deathapostle1.workers.dev';
    const ZZCRAFT_API = 'https://api.torn.zzcraft.net';
    // Session timings follow the RR Script Auth server: a session ends five minutes after the
    // membership check, and the server reuses that check for four minutes, so renewing sooner
    // would only return a session with the same end time.
    const AUTH_MAX_TTL_MS = 5 * 60 * 1000;
    const AUTH_REFRESH_MS = 4 * 60 * 1000;
    const AUTH_EXPIRY_SKEW_MS = 15 * 1000;

    const ZZCRAFT_USERAGENT = 'rr-attack-userscript/' + VERSION;  // User agent used on zzcraft

    const TTL_WAR = 5 * 60 * 1000;                          // war state
    const TTL_ROSTER = 10 * 60 * 1000;                      // enemy roster
    const POLL_MIN = 10 * 1000;                             // guard against a bad/missing nextUpdate
    const POLL_MAX = 5 * 60 * 1000;                         // stop an idle page drifting
    const RETRY_NET = 60 * 1000;                            // back off after a transient failure
    const RETRY_QUICK = 5 * 1000;                           // a network failure retries soon: it pauses war hits
    const WAR_KEEP = 60 * 60 * 1000;                        // last good war data stays usable while refreshes fail
    const LIMITS_KEEP = 60 * 1000;                          // limits stay usable this long past ZZCraft's next update
    const HOLD_GRACE = 10 * 1000;                           // an allowed verdict covers its own renewal this long
    const HOLD_MAX_MS = 5 * 1000;                           // an unchecked war target is paused at most this long
    const RENEW_LEAD = 3 * 1000;                            // a decision is renewed this long before it runs out
    const REJECTED_RETRY = 10 * 60 * 1000;                  // a key or request refused outright is retried after this
    const STORAGE_TIMEOUT = 10 * 1000;                      // protected storage that does not answer counts as failed
    const LOCK_TIMEOUT = 3 * 1000;                          // another tab's login is not waited for longer than this

    // Torn's header labels, discriminated by the icon SVG's viewBox - the label
    // count swings across fight phases and the class strings are identical, so
    // neither DOM order nor classes can tell them apart.
    const LABEL_VIEWBOX = {
        '0 0 16.9 19': 'turns',                             // turns used this fight, caps at 25 - not energy
        '0 0 10.67 17': 'timer',                            // the 5-minute attack window, NOT the chain timer
        '0 0 16 17': 'chain'
    };

    const SLOT = { PRIMARY: 1, SECONDARY: 2, MELEE: 3, TEMP: 4 };

    const SLOT_NAMES = {
        [SLOT.PRIMARY]: 'Primary',
        [SLOT.SECONDARY]: 'Secondary',
        [SLOT.MELEE]: 'Melee',
        [SLOT.TEMP]: 'Temp'
    };

    const ATTACK = { LEAVE: 1, MUG: 2, HOSP: 3 };

    const ATTACK_NAMES = { [ATTACK.LEAVE]: 'Leave', [ATTACK.MUG]: 'Mug', [ATTACK.HOSP]: 'Hosp' };
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

    // The PC clock is used only as a stopwatch, so it does not matter how wrong it is. Times from
    // other computers are read against the server's clock (ServerTime), or the sending service's
    // own clock, never against the PC's.

    // Server time, learned from the RR server's replies. Each reply is stamped to the second and
    // was made between sending and receiving, which bounds server time minus nowMs() to [lo, hi];
    // later replies narrow that. Until it is known, callers use safe defaults.
    const ServerTime = {
        lo: 0, hi: 0, known: false, confirmed: false,
        observe(stampMs, sentAt, receivedAt) {
            if (!Number.isFinite(stampMs) || !(receivedAt >= sentAt)) return;
            const lo = stampMs - receivedAt, hi = stampMs + 999 - sentAt;
            if (this.known && this.confirmed && lo <= this.hi && hi >= this.lo) {
                this.lo = Math.max(this.lo, lo);
                this.hi = Math.min(this.hi, hi);
            } else Object.assign(this, { lo, hi, known: true });
            this.confirmed = true;
        },
        usable() { nowMs(); return this.known && this.confirmed; },
        estimate() { return this.usable() ? nowMs() + (this.lo + this.hi) / 2 : null; },
        // True only once the server clock has certainly passed t.
        reached(t) { return this.usable() && nowMs() + this.lo >= t; },
        // The earliest moment, on nowMs(), at which the server clock may reach t.
        deadline(t) { return this.usable() ? t - this.hi : null; }
    };

    // Milliseconds on the PC clock, kept running forward if the clock is set back mid-page.
    const monoNow = typeof performance === 'object' && performance && typeof performance.now === 'function'
        ? () => performance.now() : () => Date.now();
    let wallSeen = Date.now(), monoSeen = monoNow(), wallCorrection = 0;
    function nowMs() {
        const wall = Date.now(), mono = monoNow(), expected = wallSeen + (mono - monoSeen);
        if (wall < expected - 1000) {
            wallCorrection += expected - wall;
            setTimeout(afterClockSetBack, 0);
        } else if (wall > expected + 1000) {
            // Set forward, or the PC slept: re-check server time, and the session straight away.
            ServerTime.confirmed = false;
            setTimeout(afterClockSetForward, 0);
        }
        wallSeen = wall; monoSeen = mono;
        return wall + wallCorrection;
    }
    // Stored times use the plain PC clock so other tabs and later pages read them the same way.
    const toStored = t => t - wallCorrection;
    const fromStored = t => t + wallCorrection;

    function headerValue(headers, name) {
        if (typeof headers === 'string') return new RegExp(`^${name}:[ \\t]*(.+?)[ \\t]*$`, 'im').exec(headers)?.[1] || null;
        if (!headers || typeof headers !== 'object') return null;
        const key = Object.keys(headers).find(k => k.toLowerCase() === name);
        return key && headers[key] != null ? String(headers[key]) : null;
    }
    // A reply's own clock reading, from its Date header.
    const replyTime = headers => Date.parse(headerValue(headers, 'date') || '');

    // #endregion

    // #region Storage

    function storeGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

    function storeSet(key, value) {
        try { localStorage.setItem(key, value); } catch (e) { /* private mode / PDA */ }
    }

    function storeDel(key) {
        try { localStorage.removeItem(key); } catch (e) { /* private mode / PDA */ }
    }

    // Settles as p does, or fails after ms, so a store or lock that never answers cannot hold a flag.
    function withTimeout(p, ms, what) {
        let timer;
        const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(what + ' timeout')), ms); });
        return Promise.race([p, late]).finally(() => clearTimeout(timer));
    }

    // Protected storage: TornPDA's own store, else the script manager's (GM_* or GM.*). A store that
    // does not answer within STORAGE_TIMEOUT counts as failed.
    function protectedStore() {
        if (typeof PAGE.flutter_inappwebview !== 'undefined') {
            if (typeof PDA_storage === 'undefined') throw new Error('TornPDA 3.15 or newer is required');
            return { get: k => PDA_storage.get(k, null), set: (k, v) => PDA_storage.set(k, v), del: k => PDA_storage.delete(k) };
        }
        if (typeof GM_getValue === 'function') {
            return { get: k => GM_getValue(k, null), set: (k, v) => GM_setValue(k, v), del: k => typeof GM_deleteValue === 'function' && GM_deleteValue(k) };
        }
        if (typeof GM !== 'undefined' && GM && typeof GM.getValue === 'function') {
            return { get: k => GM.getValue(k, null), set: (k, v) => GM.setValue(k, v), del: k => GM.deleteValue(k) };
        }
        return null;
    }
    const timedStore = op => withTimeout(Promise.resolve().then(op), STORAGE_TIMEOUT, 'storage');

    async function secureGet(key) { const store = protectedStore(); return store ? timedStore(() => store.get(key)) : null; }

    async function secureSet(key, value) {
        const store = protectedStore();
        if (!store) throw new Error('Protected userscript storage unavailable');
        await timedStore(() => store.set(key, value));
    }

    async function secureDelete(key) {
        let store = null;
        try { store = protectedStore(); } catch (e) { return; }
        if (store) await timedStore(() => store.del(key));
    }

    let authApiKey = '';
    let authKeyHash = '';                                   // SHA-256 of the saved key: binds remembered answers to it
    let warmUp = false;                                     // on the faction page: no interface, only keep the checks ready
    const Steps = new Map();                                // step still running -> when it started (nowMs)
    const stepStart = name => Steps.set(name, nowMs());
    const stepEnd = name => Steps.delete(name);
    const LOCK_STEP = "waiting for another tab's login";
    let playerId = null;
    let apiKeyLoaded = false;

    // Only read here, never rewritten, so one failed storage write cannot lose a saved key.
    async function loadApiKey() {
        const candidate = await secureGet(SECURE_STORAGE_KEY);
        authApiKey = validKey(candidate) ? candidate : '';
        authKeyHash = authApiKey ? await keyFingerprint(authApiKey) : '';
        LEGACY_KEYS.forEach(storeDel);
    }

    async function saveApiKey(value) {
        if (value && !validKey(value)) throw new Error('Invalid Torn API key');
        if (value) {
            await secureSet(SECURE_STORAGE_KEY, value);
            if ((await secureGet(SECURE_STORAGE_KEY)) !== value) {
                throw new Error('API key save could not be verified');
            }
        } else { await secureDelete(SECURE_STORAGE_KEY); }
        authApiKey = value;
        authKeyHash = value ? await keyFingerprint(value) : '';
    }

    function jsonGet(key) { try { return JSON.parse(storeGet(key) || 'null'); } catch (e) { return null; } }

    function jsonSet(key, value) {
        try { storeSet(key, JSON.stringify(value)); } catch (e) { /* quota / cycles */ }
    }

    const fresh = (rec, ttl) => !!(rec && rec.at && nowMs() - fromStored(rec.at) < ttl);

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

    function saveSettings() { jsonSet(STORAGE_SETTINGS, settings); }

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
            ${sel('dialogWrapper')}[data-txm-dialog="start"], ${sel('dialogWrapper')}[data-txm-dialog="outcome"] { visibility: hidden; }
            ${sel('dialogWrapper')}[data-txm-dialog] ${sel('dialogButtons')} { visibility: visible; }
        `;

        // Buttons move only on desktop and Torn's forced "Desktop View".
        // True Mobile View keeps Torn's native dialog and button placement.
        const positioning = !Session.pass() || !settings.buttons || compact() ? '' : `
            ${sel('player')}:nth-child(2) ${sel('playerWindow')} { overflow: visible; }
            ${sel('dialogButtons')} { z-index: 1000; position: absolute; top: ${getTopStyle(slot)}; display: flex; left: -300px; width: 420px; justify-content: center; flex-direction: row !important; }
            ${dialogHide}
        `;

        return `
            ${sel('modelWrap')} { max-width: 100%; }
            ${positioning}
            [data-txm-hide] { display: none !important; }
            .txm-fa-namelink { color: var(--default-color); }
            .txm-fastattack { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 12px; }
            .txm-fastattack select { background: #1f1f1f; color: #e6e6e6; border: 1px solid #444; border-radius: 4px; padding: 2px 6px; cursor: pointer; }
            .txm-fastattack select:hover { border-color: #777; }
            [data-txm-warn], [data-txm-disarm] { position: relative; }
            [data-txm-warn]::after, [data-txm-disarm]::before { position: absolute; right: 4px; bottom: 26px; padding: 1px 4px; border-radius: 2px; font-size: 8px; font-weight: 700; line-height: 1.2; background: rgba(0, 0, 0, .55); pointer-events: none; z-index: 5; }
            [data-txm-warn]::after { content: attr(data-txm-label); }
            [data-txm-disarm]::before { content: attr(data-txm-disarm-label); color: #e0a80d; }
            [data-txm-warn][data-txm-disarm]::before { bottom: 41px; }
            [data-txm-warn="avoid"]::after { color: #d63b3b; }
            .txm-fa-bar[data-txm-mirror="1"] ~ ${sel('appHeaderWrapper')} > ${sel('topSection')}, .txm-fa-bar[data-txm-mirror="1"] ~ ${sel('appHeaderWrapper')} > ${sel('delimiter')}, .txm-fa-bar[data-txm-mirror="1"] ~ ${sel('appHeaderWrapper')} > ${sel('bottomSection')} { display: none !important; }
            .txm-fa-bar[data-txm-mirror="1"] ~ ${sel('appHeaderWrapper')} { margin: 0 !important; padding: 0 !important; border: 0 !important; min-height: 0 !important; }
            .txm-fa-bar { display: flex; flex-direction: column; gap: 6px; margin: 8px 0; padding: 8px 12px; background: #1f1f1f; border: 1px solid rgba(2, 158, 122, .5); border-radius: 6px; font-size: 12px; color: #ddd; }
            .txm-fa-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
            .txm-fa-brand { color: #029e7a; font-weight: 700; letter-spacing: 1.5px; white-space: nowrap; }
            .txm-fa-brand small { color: #8a8a8a; font-weight: 600; letter-spacing: 1px; margin-left: 4px; }
            .txm-fa-auth-state { color: #8a8a8a; font-size: 11px; margin-left: auto; }
            .txm-fa-chips { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
            .txm-fa-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; background: #2a2a2a; border: 1px solid #444; border-radius: 4px; font-size: 11px; white-space: nowrap; }
            .txm-fa-chip b { font-weight: 700; }
            .txm-fa-chip em { font-style: normal; color: #8a8a8a; }
            .txm-fa-ico { display: inline-flex; align-items: center; }
            .txm-fa-ico svg { width: 11px; height: 12px; opacity: .75; }
            .txm-fa-ico svg, .txm-fa-ico svg path { fill: currentColor; }
            .txm-fa-chip[data-kind="chain"][data-low="1"] { border-color: #e74c3c; }
            .txm-fa-chip[data-kind="chain"][data-low="1"] em { color: #e74c3c; }
            .txm-fa-right { margin-left: auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
            .txm-fa-escape { background: transparent; border: 1px solid #029e7a; color: #029e7a; border-radius: 4px; padding: 3px 10px; cursor: pointer; font-size: 11px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; }
            .txm-fa-escape:hover:not(:disabled) { background: #029e7a; color: #fff; }
            .txm-fa-escape:disabled { opacity: .45; cursor: default; border-color: #444; color: #8a8a8a; }
            .txm-fa-back { color: #8a8a8a; font-size: 11px; text-decoration: none; white-space: nowrap; }
            .txm-fa-back:hover { color: #029e7a; }
            .txm-fa-bar .txm-fastattack { margin: 0; }
            .txm-fa-bar .txm-fastattack label { display: inline-flex; align-items: center; gap: 4px; color: #8a8a8a; }
            [data-txm-block] { pointer-events: none !important; opacity: .45 !important; cursor: not-allowed !important; filter: grayscale(1); }
            .txm-fa-info { border-top: 1px solid #333; padding-top: 6px; font-size: 11px; }
            .txm-fa-advice, .txm-fa-limits, .txm-fa-warn { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
            .txm-fa-limits, .txm-fa-warn { margin-left: auto; }
            .txm-fa-warn { color: #e74c3c; font-weight: 700; letter-spacing: .3px; }
            .txm-fa-hold { color: #e0a80d; font-weight: 700; letter-spacing: .3px; margin-left: auto; }
            .txm-fa-dot { width: 8px; height: 8px; border-radius: 50%; background: #8a8a8a; flex: none; }
            .txm-fa-adv[data-level="avoid"] .txm-fa-dot { background: #d63b3b; }
            .txm-fa-adv[data-level="caution"] .txm-fa-dot { background: #e0a80d; }
            .txm-fa-adv[data-level="ok"] .txm-fa-dot { background: #4caf50; }
            .txm-fa-age { color: #6f6f6f; font-size: 10px; font-style: italic; white-space: nowrap; }
            .txm-fa-api { background: transparent; border: 1px solid #029e7a; color: #029e7a; border-radius: 4px; padding: 3px 10px; cursor: pointer; font-size: 11px; font-weight: 700; letter-spacing: 1px; }
            .txm-fa-api:hover { background: #029e7a; color: #fff; }
            .txm-fa-api:disabled { opacity: .5; cursor: default; }
            .txm-fa-gear { background: none; border: none; color: #8a8a8a; font-size: 15px; line-height: 1; padding: 0 4px; cursor: pointer; }
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
            body:not(.dark-mode) .txm-fa-chip em, body:not(.dark-mode) .txm-fa-limits, body:not(.dark-mode) .txm-fa-bar .txm-fastattack label { color: #666; }
            body:not(.dark-mode) .txm-fa-bar .txm-fastattack select { background: #fff; color: #333; border-color: #ccc; }
            body:not(.dark-mode) .txm-fa-info { border-top-color: #ddd; }
            body:not(.dark-mode) .txm-fa-lim b, body:not(.dark-mode) .txm-fa-val { color: #333; }
            body:not(.dark-mode) .txm-fa-sep { color: #bbb; }
            body:not(.dark-mode) .txm-fa-escape:disabled { color: #999; border-color: #ccc; }
            body:not(.dark-mode) .txm-fa-age { color: #888; }
            .txm-fa-set-overlay { position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 999999; background: rgba(0, 0, 0, .8); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); display: flex; justify-content: center; align-items: center; }
            .txm-fa-set-modal { display: flex; flex-direction: column; width: min(520px, 94vw); max-height: min(86vh, 700px); overflow: hidden; background: linear-gradient(180deg, #23252b, #1b1d22); border: 1px solid rgba(2, 158, 122, .5); border-radius: 8px; box-shadow: 0 2px 10px rgba(0, 0, 0, .35); color: #d7d9de; font-size: 12px; }
            .txm-fa-set-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; background: linear-gradient(180deg, #2c2f37, #23252b); border-bottom: 1px solid #34373f; }
            .txm-fa-set-head b { color: #029e7a; letter-spacing: 1px; }
            .txm-fa-set-close { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; background: none; border: none; color: #8a8a8a; font-size: 22px; line-height: 1; cursor: pointer; }
            .txm-fa-set-close:hover { color: #fff; }
            .txm-fa-set-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px; }
            .txm-fa-set-tabs { display: flex; gap: 6px; margin-bottom: 12px; border-bottom: 1px solid #34373f; padding-bottom: 8px; }
            .txm-fa-set-tab { border: 1px solid #34373f; border-radius: 5px; background: #15161a; color: #d7d9de; font: inherit; font-weight: 700; min-height: 28px; padding: 5px 12px; cursor: pointer; }
            .txm-fa-set-tab:hover { border-color: #029e7a; color: #029e7a; }
            .txm-fa-set-tab.active { background: #029e7a; border-color: #029e7a; color: #10231d; }
            .txm-fa-set-section { background: #1a1a1a; border: 1px solid #34373f; border-radius: 6px; padding: 12px; margin-bottom: 12px; }
            .txm-fa-set-title { color: #8a8d96; font-size: 10px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; margin-bottom: 10px; }
            .txm-fa-set-input { width: 100%; box-sizing: border-box; background: #15161a; color: #d7d9de; border: 1px solid #34373f; border-radius: 5px; padding: 6px 8px; font: inherit; text-align: center; letter-spacing: 2px; margin-bottom: 10px; }
            .txm-fa-set-input:focus { border-color: #029e7a; outline: none; }
            .txm-fa-set-input[data-bad="1"] { border-color: #e74c3c; }
            .txm-fa-set-status { text-align: center; padding: 8px; background: #15161a; border: 1px solid #34373f; border-radius: 5px; font-size: 11px; margin-bottom: 10px; }
            .txm-fa-set-status[data-state="ok"] { color: #2ecc71; }
            .txm-fa-set-status[data-state="bad"] { color: #e74c3c; }
            .txm-fa-set-status[data-state="wait"] { color: #e0a80d; }
            .txm-fa-set-actions { display: flex; gap: 8px; }
            .txm-fa-set-actions .txm-fa-api { flex: 1; }
            .txm-fa-set-check { display: flex; align-items: flex-start; gap: 10px; padding: 8px; background: #15161a; border: 1px solid #34373f; border-radius: 5px; margin-bottom: 8px; cursor: pointer; font-size: 11px; }
            .txm-fa-set-check:hover { border-color: #029e7a; }
            .txm-fa-set-check input { margin-top: 2px; }
            .txm-fa-set-check b { color: #fff; }
            .txm-fa-set-note { font-size: 10px; color: #8a8d96; }
            @media (max-width: ${COMPACT_WIDTH}px) {
                html:not(.html-manual-desktop) .txm-fa-bar { margin: 6px 0; padding: 6px 8px; gap: 4px; }
                html:not(.html-manual-desktop) .txm-fa-row { gap: 6px; }
                html:not(.html-manual-desktop) .txm-fa-brand small { display: none; }
                html:not(.html-manual-desktop) .txm-fa-right, html:not(.html-manual-desktop) .txm-fa-mine { margin-left: 0; }
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
        const selected = OUTCOME_LABELS[attackType - 1];
        qa(document, sel('dialogButtons')).forEach(box => {
            const buttons = qa(box, 'button'), labels = buttons.map(b => b.textContent.trim().toLowerCase());
            // Other outcomes are hidden only once the chosen one has been on screen, so one always remains. After it
            // is clicked Torn replaces its label while the fight ends; the others stay hidden until the outcome row goes.
            if (labels.includes(selected)) setAttr(box, 'data-txm-chosen', selected);
            else if (!labels.some(t => OUTCOME_LABELS.includes(t)) || box.getAttribute('data-txm-chosen') !== selected) delAttr(box, 'data-txm-chosen');
            const on = Session.pass() && settings.outcome && box.getAttribute('data-txm-chosen') === selected;
            buttons.forEach((b, i) => {
                if (on && OUTCOME_LABELS.includes(labels[i]) && labels[i] !== selected) setAttr(b, 'data-txm-hide', '');
                else delAttr(b, 'data-txm-hide');
            });
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
    function setAttr(el, name, value) { if (el && el.getAttribute(name) !== value) el.setAttribute(name, value); }

    function delAttr(el, name) { if (el && el.hasAttribute(name)) el.removeAttribute(name); }

    function setText(el, value) { if (el && el.textContent !== value) el.textContent = value; }

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
        if (!level) { delAttr(el, 'data-txm-warn'); delAttr(el, 'data-txm-label'); return; }
        setAttr(el, 'data-txm-warn', level);
        setAttr(el, 'data-txm-label', tag || '');
    }

    // Separate attribute pair (and ::before, not ::after) so a slot can carry
    // a verdict tag and the disarm tag at the same time.
    function tagDisarm(el, on) {
        if (!el) return;
        if (!on) { delAttr(el, 'data-txm-disarm'); delAttr(el, 'data-txm-disarm-label'); return; }
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
        const any = qa(bar, '.txm-fa-advice, .txm-fa-limits, .txm-fa-warn, .txm-fa-hold')
            .some(el => !el.hasAttribute('hidden'));
        setShown(q(bar, '.txm-fa-info'), any);
    }

    function renderAdvice() {
        const { own, def } = weaponSlotBuckets();
        const advice = settings.advisor && Analysis.display('advice')?.advice;
        // Each part is read on its own, so an answer missing one still paints the rest and clears stale marks.
        const tags = advice && advice.tags && typeof advice.tags === 'object' ? advice.tags : {};
        const disarm = advice && Array.isArray(advice.disarmSlots) ? advice.disarmSlots : [];
        const chips = advice && Array.isArray(advice.chips)
            ? advice.chips.filter(c => c && typeof c.text === 'string' && typeof c.level === 'string') : [];
        Object.entries(own).forEach(([id, el]) => {
            const tag = tags[id];
            tagSlot(el, tag && tag.level, tag && tag.tag);
            tagDisarm(el, disarm.includes(id));
        });
        def.forEach(el => tagSlot(el, null));
        // Request failures are reported once in the shared warning row.
        renderAdviceRow(chips);
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
            } else if (kind === 'escape') { out.escape = q(el, 'button'); }
        });

        const back = q(head, `${sel('linksContainer')} a[href]`);
        if (back) { out.backHref = back.getAttribute('href'); out.backText = back.textContent.trim(); }

        // Torn's header is only hidden once we have proved we can reproduce it;
        // an empty header mid-remount still counts as mirrored.
        out.mirror = (out.seen > 0 || out.total === 0) && (!back || !!out.backHref);
        return out;
    }

    // Both bar modes share one shell. data-txm-mirror starts at 0 (fail closed: Torn's header stays until
    // it is mirrored), and the bar MUST precede the header because the hide rules use a sibling combinator.
    // The gear listens to mousedown and click (some PDA webviews drop the click); openSettings() ignores
    // the second event for the same mounted modal.
    function makeBar(mode, html, head, mount) {
        const bar = document.createElement('div');
        bar.className = 'txm-fa-bar';
        bar.setAttribute('data-txm-mode', mode);
        bar.setAttribute('data-txm-mirror', '0');
        bar.innerHTML = html;                               // set before insertion: one childList record
        mount.insertBefore(bar, head || mount.firstChild);
        const gear = q(bar, '.txm-fa-gear');
        const onGear = (e) => { e.preventDefault(); e.stopPropagation(); safe('settings', () => openSettings(gear)); };
        gear.addEventListener('mousedown', onGear);
        gear.addEventListener('click', onGear);
        return bar;
    }

    function buildBar(head, mount) {
        const opts = (names, current) => Object.entries(names)
            .map(([v, label]) => `<option value="${v}"${Number(v) === current ? ' selected' : ''}>${label}</option>`)
            .join('');

        const bar = makeBar('full', `
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
                <div class="txm-fa-hold" hidden></div>
            </div>
        `, head, mount);

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

        barSig = '';                                         // fresh DOM - force a full repaint
        limitsSig = '';                                      // ditto - the limits/warn rows were rebuilt empty
        adviceSig = '';
        return bar;
    }

    function authStatusText() {
        if (!validKey(apiKey())) return 'API key required';
        if (Session.state === 'denied') return 'Access restricted';
        const hold = Hold.state === 'warn' ? notEnforcedText() : Hold.state === 'hold' ? HOLD_TEXT
            : Hold.remembered ? 'Start Fight blocked: ' + Hold.remembered : '';
        return (Session.nextTryAt > nowMs() ? 'Authorization unavailable' : 'Verifying access…') + (hold ? ' · ' + hold : '');
    }

    function buildAuthBar(head, mount) {
        const bar = makeBar('auth', `
            <div class="txm-fa-row">
                <span class="txm-fa-brand">RR ATTACK ADVISOR <small>v${VERSION}</small></span>
                <span class="txm-fa-auth-state"></span>
                <button type="button" class="txm-fa-gear" title="Settings">&#9881;</button>
            </div>
        `, head, mount);
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
        if (bar && bar.getAttribute('data-txm-mode') !== mode) { bar.remove(); bar = null; }

        if (!bar) {
            bar = Session.pass() ? buildBar(head, mount) : buildAuthBar(head, mount);
        } else if (head && head.parentNode && !(bar.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING)) {
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
            if (tgt) { setAttr(back, 'href', FACTION_URL(tgt.oppId)); setText(back, 'Back to faction'); } else { setAttr(back, 'href', h.backHref); setText(back, h.backText); }
        }
    }

    // #endregion

    // #region Networking & Data Services

    // War data comes from Torn with the member's own key, so war targets are known even while the RR
    // server is unreachable. localStorage shares it between tabs and attack pages (every attack is one).
    const War = {
        state: 'idle',                                      // idle | nowar | war | error
        factionId: null,                                    // our faction, from the session or the saved record
        ranked: null,
        roster: null,                                       // Set of enemy user ids
        rosterId: null,
        startAt: 0,                                         // ms; ranked war start time
        inFlight: false,
        retryAt: 0,
        failedAt: 0,                                        // last failed Torn lookup, 0 once one succeeds
        errorCode: null,                                    // Torn's error code from that failure, if any
        gen: 0                                              // bumped on key change; stale responses are discarded
    };

    const Limits = {
        payload: null,
        at: 0,                                              // when the figure was fetched
        nextAt: 0,                                          // when to poll again
        validUntil: 0,                                      // the figure may allow a hit until then
        dataAt: 0,                                          // when ZZCraft made the figure (its lastUpdated), on nowMs()
        failed: false,                                      // the last fetch failed; the figure is kept (hits only rise)
        inFlight: false,
        authFailed: false,                                  // ZZCraft refused the key: retried only after REJECTED_RETRY
        rejects: 0,                                         // consecutive resource 401s; 3 strikes marks authFailed
        gen: 0
    };

    function retryDelay(response, fallback = RETRY_NET) {
        const headers = response && response.headers;
        const value = headerValue(headers, 'retry-after');
        if (!value) return fallback;
        const seconds = Number(value);
        // A date is measured against the same reply's clock, never this PC's.
        const stamp = replyTime(headers), from = Number.isFinite(stamp) ? stamp : ServerTime.estimate();
        const delay = Number.isFinite(seconds) ? seconds * 1000 : from == null ? NaN : Date.parse(value) - from;
        return Number.isFinite(delay) ? Math.max(1000, delay) : fallback;
    }

    // Only a key change or a denial forgets the member's war data; a lapsed session keeps it.
    function forgetMember() {
        storeDel(STORAGE_WAR);
        secureDelete(LIMITS_STORAGE_KEY).catch(() => {});
        Verdict.forget();
        Object.assign(War, { state: 'idle', factionId: null, ranked: null, roster: null, rosterId: null, startAt: 0, inFlight: false, retryAt: 0,
            failedAt: 0, errorCode: null, gen: War.gen + 1 });
        Object.assign(Limits, { payload: null, at: 0, nextAt: 0, validUntil: 0, dataAt: 0, failed: false, inFlight: false, authFailed: false, rejects: 0, gen: Limits.gen + 1 });
        WarRoom.reset();
    }

    // Records stored before the PC clock was set back carry times from the old setting.
    function afterClockSetBack() {
        secureDelete(SESSION_STORAGE_KEY).catch(() => {});
        secureDelete(LIMITS_STORAGE_KEY).catch(() => {});
        storeDel(STORAGE_WAR);
    }

    // After the clock jumps forward the session may look spent: renew now rather than at the next timer.
    function afterClockSetForward() { if (apiKeyLoaded) void Session.refresh(); }

    async function keyFingerprint(key) {
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
        return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
    }

    const Session = {
        state: 'unknown', token: null, expiresAt: 0, renewAt: 0, factionId: null,
        nextTryAt: 0, inFlight: false, gen: 0, refreshTimer: null,
        pass() { return this.state === 'ok' && !!this.token && nowMs() < this.expiresAt; },
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
            if (warmUp && (!(War.state === 'war' && War.ranked) || document.hidden)) { this.refreshTimer = null; return; }
            this.refreshTimer = setTimeout(() => void this.refresh(), Math.max(1000, this.renewAt - nowMs()));
        },
        deferRetry(response) {
            if (!this.pass()) { this.token = null; this.expiresAt = 0; this.state = 'unknown'; }
            // While the current session still works, try a failed renewal once more before it
            // runs out; waiting the full cooldown would drop authorization first.
            const renewBy = this.pass() ? this.expiresAt - AUTH_EXPIRY_SKEW_MS - nowMs() : 0;
            const wait = retryDelay(response, response ? RETRY_NET : RETRY_QUICK);
            const delay = renewBy > 0 ? Math.min(wait, Math.max(5000, renewBy)) : wait;
            this.nextTryAt = nowMs() + delay;
            if (this.refreshTimer) clearTimeout(this.refreshTimer);
            this.refreshTimer = setTimeout(() => void this.refresh(), delay);
            onSessionChange();
        },
        // fresh: log in at the RR server even if a session is held or saved; its reply is what teaches ServerTime.
        async refresh(fresh = false) {
            const key = apiKey();
            if (!validKey(key)) {
                if (this.state !== 'denied' || this.token) { this.reset(); this.state = 'denied'; onSessionChange(); }
                return;
            }
            if (!fresh && this.pass() && nowMs() < this.renewAt) return;
            if (this.inFlight || nowMs() < this.nextTryAt) return;
            const gen = this.gen;
            this.inFlight = true;
            const run = async () => {
                const keyHash = await keyFingerprint(key);
                if (gen !== this.gen || key !== apiKey()) return;
                stepEnd(LOCK_STEP);
                stepStart('reading the saved login');
                const savedText = await secureGet(SESSION_STORAGE_KEY);
                stepEnd('reading the saved login');
                let saved = null;
                try { saved = typeof savedText === 'string' ? JSON.parse(savedText) : null; } catch (_) { /* invalid record is not a session */ }
                if (gen !== this.gen || key !== apiKey()) return;
                if (saved && typeof saved === 'object') saved = { ...saved, expiresAt: fromStored(saved.expiresAt), renewAt: fromStored(saved.renewAt) };
                if (!fresh && saved && saved.keyHash === keyHash && saved.version === VERSION &&
                    typeof saved.token === 'string' && saved.token.length > 0 && saved.token.length <= 8192 &&
                    Number.isFinite(saved.expiresAt) && saved.expiresAt > nowMs() + AUTH_EXPIRY_SKEW_MS &&
                    saved.expiresAt <= nowMs() + AUTH_MAX_TTL_MS &&
                    Number.isFinite(saved.renewAt) && saved.renewAt > nowMs() && saved.renewAt < saved.expiresAt &&
                    Number.isSafeInteger(saved.playerId) && saved.playerId > 0 && Number.isSafeInteger(saved.factionId) && saved.factionId > 0) {
                    this.accept(saved); return;
                }
                const sentAt = nowMs();
                stepStart('RR server login');
                const response = await crossOriginFetch(AUTH_API, 'POST', '/v1/session',
                    { 'Content-Type': 'application/json' }, JSON.stringify({ apiKey: key, app: 'attack-advisor', clientVersion: VERSION }));
                if (gen !== this.gen || key !== apiKey()) return;
                if (response.status === 200) {
                    // Time the session by the seconds the server says remain, counted from the request.
                    // Comparing the server's end time with this PC's clock rejected every fresh session
                    // whenever the clock ran even slightly slow.
                    const data = JSON.parse(response.text);
                    // The server's current second is expiresAt - expiresIn.
                    if (Number.isFinite(data.expiresAt) && Number.isFinite(data.expiresIn)) ServerTime.observe((data.expiresAt - data.expiresIn) * 1000, response.sentAt, response.receivedAt);
                    const serverNow = ServerTime.estimate();
                    const lifetime = Number.isFinite(data.expiresIn) ? data.expiresIn * 1000 : serverNow == null ? NaN : Number(data.expiresAt) * 1000 - serverNow;
                    const expiresAt = sentAt + Math.min(lifetime, AUTH_MAX_TTL_MS);
                    if (typeof data.token !== 'string' || !data.token || data.token.length > 8192 ||
                        !Number.isFinite(expiresAt) || expiresAt <= nowMs() + AUTH_EXPIRY_SKEW_MS || expiresAt > nowMs() + AUTH_MAX_TTL_MS ||
                        !Number.isSafeInteger(data.playerId) || data.playerId < 1 || !Number.isSafeInteger(data.factionId) || data.factionId < 1) throw new Error('Invalid authorization response');
                    const record = { token: data.token, expiresAt, renewAt: Math.min(nowMs() + AUTH_REFRESH_MS, expiresAt - AUTH_EXPIRY_SKEW_MS),
                        playerId: data.playerId, factionId: data.factionId, keyHash, version: VERSION };
                    this.accept(record);
                    // Shared with other tabs and later pages; a store that refuses the write only costs them a login.
                    await secureSet(SESSION_STORAGE_KEY, JSON.stringify({ ...record, expiresAt: toStored(record.expiresAt), renewAt: toStored(record.renewAt) })).catch(() => {});
                } else if (response.status === 401 || response.status === 403) {
                    await secureDelete(SESSION_STORAGE_KEY);
                    if (gen !== this.gen || key !== apiKey()) return;
                    this.token = null; this.expiresAt = 0; this.state = 'denied';
                    this.nextTryAt = nowMs() + retryDelay(response); forgetMember(); onSessionChange();
                } else this.deferRetry(response);
            };
            try {
                // Web Locks serialize renewals between tabs; a lock not granted in time is not waited for.
                // PDA without this browser API still reuses protected storage within this script instance.
                if (typeof navigator !== 'undefined' && navigator.locks) {
                    const wait = new AbortController(), timer = setTimeout(() => wait.abort(), LOCK_TIMEOUT);
                    stepStart(LOCK_STEP);
                    try { await navigator.locks.request('rr-attack-session', { signal: wait.signal }, () => { clearTimeout(timer); return run(); }); }
                    catch (e) { if (!e || e.name !== 'AbortError') throw e; await run(); }
                    finally { clearTimeout(timer); }
                } else await run();
            } catch (_) { if (gen === this.gen && key === apiKey()) this.deferRetry(); }
            finally {
                [LOCK_STEP, 'reading the saved login', 'RR server login'].forEach(stepEnd);
                if (gen === this.gen) this.inFlight = false;
            }
        }
    };

    const zzToken = t => typeof t === 'string' && t.length > 0 && t.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(t);

    // The ZZCraft login is kept between attack pages, bound to the key it was made with, so a
    // paused war hit waits for one limits request rather than a login as well.
    const WarRoom = {
        token: null,
        inFlight: false,
        nextTryAt: 0,
        refused: false,                                     // ZZCraft refused the key at login: retried after REJECTED_RETRY
        gen: 0,
        reset() { this.gen++; this.token = null; this.inFlight = false; this.nextTryAt = 0; this.refused = false; secureDelete(ZZ_STORAGE_KEY).catch(() => {}); },
        async ensure() {
            if (!Session.pass() || !validKey(apiKey())) return null;
            if (this.token) return this.token;
            if (this.inFlight || nowMs() < this.nextTryAt) return null;

            const gen = this.gen, key = apiKey();
            this.inFlight = true;
            try {
                const keyHash = await keyFingerprint(key);
                let saved = null;
                try { saved = JSON.parse(await secureGet(ZZ_STORAGE_KEY) || 'null'); } catch (_) { /* not a login */ }
                if (gen !== this.gen || !Session.pass()) return null;
                if (saved && saved.keyHash === keyHash && zzToken(saved.token)) return (this.token = saved.token);
                const response = await crossOriginFetch(ZZCRAFT_API, 'POST', '/auth/login',
                    { 'Content-Type': 'application/json', 'User-Agent': ZZCRAFT_USERAGENT }, JSON.stringify({ apikey: key }));
                if (gen !== this.gen || !Session.pass()) return null;
                if (!response.ok) {
                    this.refused = response.status === 401 || response.status === 403;
                    this.nextTryAt = nowMs() + (this.refused ? REJECTED_RETRY : retryDelay(response));
                    return null;
                }
                const data = JSON.parse(response.text);
                if (!zzToken(data.token)) throw new Error('invalid WarRoom token');
                this.token = data.token;
                this.nextTryAt = 0; this.refused = false;
                secureSet(ZZ_STORAGE_KEY, JSON.stringify({ keyHash, token: data.token })).catch(() => {});
                return this.token;
            } catch (e) { if (gen === this.gen) this.nextTryAt = nowMs() + RETRY_QUICK; return null; } finally { if (gen === this.gen) this.inFlight = false; }
        }
    };

    // The fight screen is read once per synchronous pass (a sync, a tick, a click): the hold, the checks and the
    // drawing all ask for it several times, and nothing in one pass can change it. A reply handled later is a new
    // task, outside the pass, and reads afresh.
    let inputPass = 0, inputSnapshot = null;
    function analysisInput() {
        if (!inputPass) return readAnalysisInput();
        return inputSnapshot || (inputSnapshot = readAnalysisInput());
    }
    function inOnePass(fn) {
        inputPass++;
        try { return fn(); } finally { if (--inputPass === 0) inputSnapshot = null; }
    }

    function readAnalysisInput() {
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
            war: { state: War.state, ranked: War.ranked, factionId: Session.factionId || War.factionId,
                roster: War.roster ? { oppId: War.rosterId, ids: Array.from(War.roster).sort((a, b) => a - b) } : null },
            limits: Limits.payload ? { currentLimit: Limits.payload.currentLimit, member: Limits.payload.member,
                warStart: Limits.payload.warStart, updatedAt: Limits.payload.updatedAt } : null
        };
    }

    let unauthorizedAt = -Infinity;                         // last 401 from a protected request

    // Faction page (where members launch war hits): with nothing drawn, keep ready what the first attack page would
    // otherwise wait for - the RR login, the war and enemy roster, ZZCraft's figure and the war-limits answer. All of it
    // is shared with attack pages through the same storage, so the first attack decides Start Fight at once. Only
    // while a ranked war has started; otherwise it only refreshes the war data now and then (Torn, member's own key).
    const WARM_EVERY = 15 * 1000;
    let warmBusy = false;
    async function warmTick() {
        if (warmBusy || !apiKeyLoaded || !validKey(apiKey()) || Session.state === 'denied') return;
        warmBusy = true;
        try {
            if (!War.factionId && !Session.pass()) await Session.refresh();          // once, to learn our faction
            await loadWar();
            if (!(War.state === 'war' && War.ranked) || !ServerTime.reached(War.ranked.start * 1000) && ServerTime.usable()) return;
            if (!Session.pass()) { await Session.refresh(); if (!Session.pass()) return; }
            // A session reused from storage made no request here, so server time is still unknown: one login teaches it.
            if (!ServerTime.usable()) { await Session.refresh(true); if (!Session.pass()) return; }
            if (!ServerTime.reached(War.ranked.start * 1000)) return;                // nothing to remember before the war starts
            await loadLimits();
            await warmVerdict();
        } finally { warmBusy = false; }
    }

    // Asks the RR server once per ZZCraft figure for the war-target answer (it is the same for every enemy) and
    // remembers it exactly as an attack page would.
    async function warmVerdict() {
        const factionId = Session.factionId || War.factionId, opp = War.ranked && War.ranked.factions.find(f => f.id !== factionId);
        if (!Session.pass() || !opp || !War.roster || War.rosterId !== opp.id || !War.roster.size || !Limits.payload || !(nowMs() < Limits.validUntil)) return;
        const ids = Array.from(War.roster).sort((a, b) => a - b);
        const input = { helmet: null, bonuses: [], temp: null, labels: [], attackType: 1, defenderId: ids[0],
            war: { state: War.state, ranked: War.ranked, factionId, roster: { oppId: War.rosterId, ids } },
            limits: { currentLimit: Limits.payload.currentLimit, member: Limits.payload.member, warStart: Limits.payload.warStart, updatedAt: Limits.payload.updatedAt } };
        if (Verdict.match(input)) return;
        const response = await crossOriginFetch(AUTH_API, 'POST', '/v1/attack/analyse',
            { Authorization: 'Bearer ' + Session.token, 'Content-Type': 'application/json' }, JSON.stringify(input));
        if (!response.ok) return;
        const result = JSON.parse(response.text);
        if (result && result.war && result.war.target && result.limits && !result.limits.pending) Verdict.save(input, result);
    }

    // Only a visible faction tab warms up, and only one at a time: the first visible tab holds the 'rr-attack-warm'
    // Web Lock until it is hidden or closed, and the others leave the shared storage to it. Without Web Locks (TornPDA,
    // one tab) every visible tick runs.
    let warmLease = null, warmAsking = false;
    function warmStep() {
        const run = () => void warmTick().catch(() => {});
        if (document.hidden) { if (warmLease) { warmLease(); warmLease = null; } return; }
        if (warmLease || typeof navigator === 'undefined' || !navigator.locks) { run(); return; }
        if (warmAsking) return;
        warmAsking = true;
        navigator.locks.request('rr-attack-warm', { ifAvailable: true }, lock => {
            warmAsking = false;
            if (!lock || document.hidden) return null;
            return new Promise(release => { warmLease = release; run(); });
        }).catch(() => { warmAsking = false; });
    }

    function startWarmUp() {
        warmUp = true;
        void loadApiKey()
            .then(() => { apiKeyLoaded = true; Session.reset(); hydrateWar(); Verdict.load(); hydrateLimits(); warmStep(); })
            .catch(() => {});
        setInterval(() => { if (apiKeyLoaded) warmStep(); }, WARM_EVERY);
        document.addEventListener('visibilitychange', () => { if (apiKeyLoaded) warmStep(); });
    }

    // The last war-limits answer for this key. For a war target the server's answer depends only on the war and the
    // ZZCraft figure, not on which enemy it is, so it decides Start Fight at once on every later attack page with the
    // same war and figure, without waiting for the RR server or ZZCraft. ZZCraft's figure is trusted as it stands: an
    // "allowed" lasts until that figure is due to be refreshed (its nextUpdate, plus LIMITS_KEEP); a cap block lasts
    // for the war, since hits only rise. Any newer, different figure or a live answer replaces it.
    const warKey = war => war.ranked ? JSON.stringify([war.factionId, war.ranked.start, war.ranked.factions.map(f => f.id)]) : '';
    const figureKey = limits => JSON.stringify(limits && [limits.currentLimit, limits.member, limits.warStart]);
    const Verdict = {
        rec: null,
        load() {
            const hash = authKeyHash;
            secureGet(VERDICT_STORAGE_KEY).then(text => {
                const rec = JSON.parse(text || 'null');
                if (!rec || rec.keyHash !== hash || hash !== authKeyHash || !['allowed', 'blocked'].includes(rec.decision) ||
                    typeof rec.war !== 'string' || typeof rec.limits !== 'string' || !Number.isFinite(rec.validUntil)) return;
                if (!this.rec) { this.rec = { ...rec, validUntil: fromStored(rec.validUntil) }; schedule(); }
            }).catch(() => {});
        },
        save(input, result) {
            if (!authKeyHash || !input.limits || !input.war.ranked) return;
            const decision = result.limits.decision;
            if (decision !== 'allowed' && decision !== 'blocked') { this.forget(); return; }
            this.rec = { keyHash: authKeyHash, war: warKey(input.war), limits: figureKey(input.limits), updatedAt: input.limits.updatedAt,
                decision, reason: String(result.limits.reason || ''), validUntil: Limits.validUntil };
            secureSet(VERDICT_STORAGE_KEY, JSON.stringify({ ...this.rec, validUntil: toStored(this.rec.validUntil) })).catch(() => {});
        },
        forget() { this.rec = null; secureDelete(VERDICT_STORAGE_KEY).catch(() => {}); },
        // The remembered answer that applies to this war target now, or null.
        match(input) {
            const r = this.rec;
            if (!r || r.keyHash !== authKeyHash || r.war !== warKey(input.war)) return null;
            // A figure on this page that is not the remembered one (or older) means the answer may have changed.
            if (input.limits && (figureKey(input.limits) !== r.limits || !(input.limits.updatedAt >= r.updatedAt || r.updatedAt == null))) return null;
            return r.decision === 'blocked' || nowMs() < r.validUntil ? r : null;
        }
    };

    // What an allowed verdict depends on: this defender, war and limits, apart from ZZCraft's update time.
    const clearContext = input => JSON.stringify([input.defenderId, input.war, input.limits && { ...input.limits, updatedAt: null }]);

    const Analysis = {
        result: null, signature: '', observed: '', pending: false, gen: 0, nextTryAt: 0, expiresAt: 0, renewAt: 0,
        block: null,                                        // a known prohibition: hit cap, no hits, or war not started
        clear: null,                                        // a complete verdict that allows Start Fight
        unknown: null,                                      // a complete verdict that could not decide, and why
        rejected: '', rejectedUntil: 0,                     // the request the server refused as invalid, and until when
        reset() {
            this.gen++; this.result = null; this.signature = ''; this.observed = ''; this.pending = false; this.nextTryAt = 0;
            this.expiresAt = 0; this.renewAt = 0; this.block = null; this.clear = null; this.unknown = null; this.rejected = ''; this.rejectedUntil = 0;
        },
        current() { return Session.pass() && !!this.result && this.signature === this.observed && nowMs() < this.expiresAt; },
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
            // until is the war's start in server time: lift the block only once the server clock has
            // certainly passed it, never on this PC's clock.
            if (!Session.pass() || this.block.sessionGen !== Session.gen || this.block.search !== location.search ||
                ServerTime.reached(this.block.until) || this.block.context !== JSON.stringify([input.defenderId, input.war])) {
                this.block = null;
                return false;
            }
            return true;
        },
        // True while a complete "allowed" verdict still matches this defender, war and limits. It keeps
        // covering Start Fight for HOLD_GRACE past its expiry while its own renewal is in flight.
        // A newer ZZCraft update with the same figures (only lastUpdated moved on) still allows: hits only rise.
        cleared(input = analysisInput()) {
            const c = this.clear;
            if (!c || !Session.pass() || c.sessionGen !== Session.gen || c.search !== location.search ||
                c.context !== clearContext(input) || !((input.limits && input.limits.updatedAt) >= c.updatedAt || c.updatedAt == null)) return false;
            return nowMs() < c.until || (this.pending && nowMs() < c.until + HOLD_GRACE);
        },
        // Why the server could not decide this defender, war and limits, or ''.
        undecided(input = analysisInput()) {
            const u = this.unknown;
            if (!u || !Session.pass() || u.sessionGen !== Session.gen || u.search !== location.search ||
                u.context !== JSON.stringify([input.defenderId, input.war, input.limits])) return '';
            return u.reason || 'unknown';
        },
        async refresh() {
            if (!Session.pass()) return;
            const input = analysisInput(), signature = JSON.stringify(input);
            this.observed = signature;
            // A decision is renewed shortly before it runs out, so an allowed Start Fight never lapses in between.
            if ((this.current() && nowMs() < this.renewAt) || this.pending || nowMs() < this.nextTryAt ||
                (signature === this.rejected && nowMs() < this.rejectedUntil)) return;
            const gen = this.gen, sessionGen = Session.gen, token = Session.token, search = location.search;
            this.pending = true;
            stepStart('RR server check');
            schedule();
            try {
                const response = await crossOriginFetch(AUTH_API, 'POST', '/v1/attack/analyse',
                    { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, signature);
                if (gen !== this.gen || sessionGen !== Session.gen || token !== Session.token || search !== location.search || !Session.pass()) return;
                if (response.status === 401 || response.status === 403) {
                    // A 401 means the session ended early (e.g. a server update): log in again at once, but
                    // only once a minute and only once the refused session is deleted. A 403 means not a member.
                    const again = response.status === 401 && nowMs() - unauthorizedAt > RETRY_NET;
                    if (response.status === 401) unauthorizedAt = nowMs();
                    Session.reset(); Session.state = response.status === 403 ? 'denied' : 'unknown';
                    Session.nextTryAt = nowMs() + retryDelay(response);
                    const cleared = Session.gen;
                    await secureDelete(SESSION_STORAGE_KEY).catch(() => {});
                    if (again && cleared === Session.gen) Session.nextTryAt = 0;
                    if (response.status === 403) forgetMember();
                    onSessionChange();
                    return;
                }
                if (response.status === 400 || response.status === 413) {
                    // A request the server refused is not resent unchanged for a while; a changed one goes at once.
                    this.result = null; this.rejected = signature; this.rejectedUntil = nowMs() + REJECTED_RETRY;
                    return;
                }
                if (!response.ok) { this.result = null; this.nextTryAt = nowMs() + retryDelay(response); return; }
                const result = JSON.parse(response.text);
                if (!result || !result.advice || !result.buttons || !result.war || !result.limits || !Number.isFinite(result.revalidateAt) ||
                    !['blocked', 'allowed', 'unknown'].includes(result.limits.decision)) throw new Error('Invalid analysis response');
                // revalidateAt is server time: keep this decision until the server clock may reach it,
                // or for 10 s while server time is not yet known.
                const revalidate = ServerTime.deadline(result.revalidateAt);
                const until = Math.min(Math.max(nowMs() + 1000, revalidate ?? nowMs() + 10000), Session.expiresAt);
                this.verdict(input, result, until, sessionGen, search);
                War.startAt = result.war.startAt;
                // Advice for gear that changed meanwhile is out of date and asked for again; the verdict stands.
                if (signature !== JSON.stringify(analysisInput())) return;
                this.result = result; this.signature = signature; this.expiresAt = until; this.nextTryAt = 0;
                this.renewAt = until - Math.min(RENEW_LEAD, (until - nowMs()) / 2);
            } catch (_) { if (gen === this.gen) { this.result = null; this.nextTryAt = nowMs() + RETRY_QUICK; } }
            finally { stepEnd('RR server check'); if (gen === this.gen) { this.pending = false; schedule(); } }
        },
        // Only a complete verdict may set or lift the block, or allow Start Fight: any verdict on a war target
        // (the server answers "unknown" rather than "allowed" when the limits are missing), or "not a target"
        // decided with the roster (or with no war). A known prohibition therefore survives equipment and
        // advice renewal for the same war target.
        verdict(input, result, until, sessionGen, search) {
            const now = analysisInput(), context = i => JSON.stringify([i.defenderId, i.war, i.limits]);
            if (context(now) !== context(input)) return;
            const pending = !!result.limits.pending, decision = result.limits.decision;
            if (!(result.war.target || input.war.state === 'nowar' || input.war.roster !== null)) return;
            this.block = decision === 'blocked' ? { sessionGen, search, context: JSON.stringify([input.defenderId, input.war]),
                until: pending ? result.war.startAt : Infinity } : null;
            this.clear = decision === 'allowed' ? { sessionGen, search, until, context: clearContext(input), updatedAt: input.limits ? input.limits.updatedAt : null } : null;
            this.unknown = decision === 'unknown' ? { sessionGen, search, context: context(input), reason: String(result.limits.unknownReason || '') } : null;
            if (result.war.target && !pending) Verdict.save(input, result);
        }
    };

    function apiKey() { return authApiKey; }

    // The API only accepts 16- or 50-char alphanumeric keys - catch typos
    // before transmitting the key anywhere.
    function validKey(k) { return /^[A-Za-z0-9]{16}$/.test(k) || /^[A-Za-z0-9]{50}$/.test(k); }

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

    // Whether this defender is an enemy in the current war, by the same rule the server uses.
    function warTargetKind(input) {
        const war = input.war;
        if (!input.defenderId || war.state === 'nowar') return 'none';
        if (war.state !== 'war' || !war.ranked || !war.factionId) return 'unknown';
        const opp = war.ranked.factions.find(f => f.id !== war.factionId);
        if (!opp || !war.roster || war.roster.oppId !== opp.id) return 'unknown';
        return war.roster.ids.includes(input.defenderId) ? 'target' : 'none';
    }

    // Faction rule: a known prohibition (hit cap, no hits allowed, war not started) always blocks Start Fight.
    // A war target that cannot be checked is paused while the check runs, for at most HOLD_MAX_MS and only
    // until a failure is known; then Start Fight opens with a red warning that the limits are NOT enforced.
    // A failure or the time limit keeps this page's target in "warn" until a decision arrives or the target
    // changes, so retries during an outage never flip Start Fight between paused and open.
    // Members with no key, denied members and installs with no sign of faction membership (no session and
    // no saved war data) keep Torn's controls.
    const Hold = { reason: '', state: '', cause: '', unlocked: false, context: '', since: 0, failure: '', remembered: '' };
    const HOLD_TEXT = 'Checking war limits… Start Fight paused';
    const UNKNOWN_CAUSE = {
        'limits-other-war': 'Limits not set for this war yet',
        'hits-stale': 'ZZCraft has no hits for this war yet',
        'hits-missing': 'ZZCraft has no hits for this war yet'
    };
    const tornFailure = () => 'Torn war lookup failed' + (War.errorCode != null ? ' (error ' + War.errorCode + ')' : '');
    const notEnforcedText = () => 'War limits unavailable: NOT enforced. Check your hits.' + (Hold.cause ? ' (' + Hold.cause + ')' : '');

    // A known failure that stops this target being checked, or ''.
    function holdFailure(input, kind) {
        if (Session.pass() ? Analysis.nextTryAt > nowMs() : Session.nextTryAt > nowMs()) return 'RR server unavailable';
        if (Session.pass() && Analysis.rejected && Analysis.rejected === Analysis.observed) return 'RR server refused this check: update the script';
        if (kind === 'unknown') return War.failedAt ? tornFailure() : '';
        if (!Session.pass()) return '';
        const why = Analysis.undecided(input);
        const limitsMissing = !Limits.payload || nowMs() >= Limits.validUntil;
        if (limitsMissing && (WarRoom.refused || Limits.authFailed)) return 'ZZCraft rejected your key: save it in Settings';
        if (limitsMissing && Limits.failed) return 'ZZCraft unavailable';
        if (why && why !== 'limits-missing') {
            // Limits from another war or hit counts not yet covering it: a figure fetched before this target was
            // reached may simply be old (a war just changed), so ask ZZCraft again and decide on its answer.
            if (Limits.at >= Hold.since || Limits.failed) return UNKNOWN_CAUSE[why] || 'War limits could not be checked';
            if (!Limits.inFlight && Limits.nextAt > nowMs()) { Limits.nextAt = 0; schedule(); }
        }
        return '';
    }

    // What is still running when the time limit passes without a known failure.
    function holdTimeout(kind) {
        // The step running longest is what holds things up; its time shows whether it is slow or stuck.
        let slowest = null;
        for (const [name, since] of Steps) if (!slowest || since < slowest[1]) slowest = [name, since];
        if (slowest) return slowest[0] + ' still waiting (' + Math.round((nowMs() - slowest[1]) / 1000) + ' s)';
        if (kind === 'unknown') return 'Torn war lookup not answering';
        if (!Session.pass() || Analysis.pending) return 'RR server not answering';
        if (!Limits.payload || Limits.inFlight) return 'ZZCraft not answering';
        return 'check did not finish';
    }

    // limit | pending (known prohibitions) | hold | warn | '' and, for warn, why.
    function holdState() {
        const none = { state: '', cause: '' };
        if (apiKeyLoaded ? !validKey(apiKey()) || Session.state === 'denied' : !War.factionId) return none;
        if (Analysis.blocked()) return { state: Analysis.block.until === Infinity ? 'limit' : 'pending', cause: '' };
        const input = analysisInput(), kind = warTargetKind(input);
        if (kind === 'none' || (!Session.pass() && !War.factionId)) return none;
        // An allowed verdict counts only while its limits are current: kept figures may block, never allow.
        if (kind === 'target' && Analysis.cleared(input) && !(input.limits && nowMs() >= Limits.validUntil)) return none;
        // No live answer yet: the remembered one for this war and figure decides at once.
        const remembered = kind === 'target' && Verdict.match(input);
        if (remembered) return remembered.decision === 'blocked' ? { state: 'limit', cause: '', remembered: remembered.reason } : none;
        const context = JSON.stringify([location.search, input.defenderId, input.war]);
        if (Hold.context !== context) Object.assign(Hold, { context, since: nowMs(), failure: '' });
        const failure = holdFailure(input, kind);
        if (failure) Hold.failure = failure;
        if (Hold.failure) return { state: 'warn', cause: failure || Hold.failure };
        if (nowMs() - Hold.since >= HOLD_MAX_MS) return { state: 'warn', cause: holdTimeout(kind) };
        return { state: 'hold', cause: '' };
    }

    function holdReason() {
        const h = holdState();
        if (h.state !== 'hold' && h.state !== 'warn') Hold.context = '';   // a decision ends this target's episode
        Hold.state = h.state; Hold.cause = h.cause; Hold.remembered = h.remembered || '';
        return h.state === 'warn' ? '' : h.state;
    }

    // Applied to every button row, independently of the bar, before anything that could fail or return early.
    function guardStartFight() {
        // Should the check itself fail, a defender on the saved enemy roster stays held.
        let reason = safe('hold', holdReason);
        if (typeof reason !== 'string') { reason = War.roster && War.roster.has(Number(defenderId())) ? 'hold' : ''; Hold.state = reason; Hold.cause = ''; }
        let unlocked = false;
        qa(document, sel('dialogButtons')).forEach(box => {
            setAttr(box, 'translate', 'no');                // browser translation must not rename the buttons matched here
            const buttons = qa(box, 'button');
            const labels = buttons.map(b => b.textContent.replace(/\s+/g, ' ').trim().toLowerCase());
            const other = t => OUTCOME_LABELS.includes(t) || t === 'continue';
            buttons.forEach((b, i) => {
                // While paused, a lone button that is not an outcome or Continue is Start Fight in any wording.
                const start = START_LABELS.includes(labels[i]) || (reason && buttons.length === 1 && !other(labels[i]));
                if (reason && start) setAttr(b, 'data-txm-block', reason); else delAttr(b, 'data-txm-block');
            });
            if (reason && buttons.length > 1 && !labels.some(t => START_LABELS.includes(t) || other(t))) unlocked = true;
        });
        Hold.reason = reason; Hold.unlocked = unlocked;
    }

    // Limits are needed once a decision shows them, or as soon as the defender is a known target in a
    // war that has started, so the first check can already include them.
    function limitsWanted() {
        if (Analysis.current() && Analysis.result.limits.visible) return true;
        const input = analysisInput();
        return warTargetKind(input) === 'target' && ServerTime.reached(input.war.ranked.start * 1000);
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

    // Torn answers 200 with an {error:{code,error}} envelope, so an ok status is not enough on its own.
    // Sent through the userscript transport like every other request: Torn's API only accepts the
    // torn.com origin, which a page fetch from some browser extensions does not send.
    async function tornGet(path) {
        const key = apiKey();
        if (!validKey(key)) return { error: 'nokey' };
        const res = await crossOriginFetch(TORN_API, 'GET', path, { Authorization: `ApiKey ${key}` });
        let body = null;
        try { body = JSON.parse(res.text); } catch (e) { /* not JSON */ }
        if (body && body.error) return { error: body.error.error || 'api', code: Number.isSafeInteger(body.error.code) ? body.error.code : null };
        if (!res.ok) return { error: 'http ' + res.status };
        if (body == null) return { error: 'bad response' };
        return { data: body };
    }

    function readWarCache() {
        const rec = jsonGet(STORAGE_WAR);
        if (rec === null) return null;
        const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
        const id = value => Number.isSafeInteger(value) && value > 0;
        const timestamp = value => Number.isFinite(value) && value > 0 && fromStored(value) <= nowMs();
        const ranked = rec && rec.war && rec.war.ranked;
        if (!object(rec) || !id(rec.factionId) || !object(rec.war) || !timestamp(rec.war.at) ||
            !(ranked === null || (object(ranked) && Number.isFinite(ranked.start) && ranked.start >= 0 &&
                (ranked.end == null || Number.isFinite(ranked.end)) &&
                Array.isArray(ranked.factions) && ranked.factions.length === 2 &&
                ranked.factions.every(f => object(f) && id(f.id) && typeof f.name === 'string' && f.name.length <= 200))) ||
            !(rec.roster == null || (object(rec.roster) && id(rec.roster.oppId) && timestamp(rec.roster.at) &&
                Array.isArray(rec.roster.ids) && rec.roster.ids.length <= 500 && rec.roster.ids.every(id)))) {
            storeDel(STORAGE_WAR);
            return null;
        }
        return rec;
    }

    // Our faction comes from the session, or from the saved record while there is none. Saved data stays
    // usable for WAR_KEEP (refreshed after TTL_WAR / TTL_ROSTER), so a failed refresh never drops the war.
    function applyWarCache(rec) {
        const factionId = Session.factionId || (rec && rec.factionId);
        if (!rec || !factionId || rec.factionId !== factionId || !fresh(rec.war, WAR_KEEP)) return false;
        const before = JSON.stringify([War.state, War.ranked, War.rosterId, War.roster && Array.from(War.roster)]);
        // A war whose end has certainly passed on the server clock is over.
        const ranked = rec.war.ranked && !(rec.war.ranked.end > 0 && ServerTime.reached(rec.war.ranked.end * 1000)) ? rec.war.ranked : null;
        War.factionId = factionId;
        War.ranked = ranked;
        War.state = ranked ? 'war' : 'nowar';
        War.roster = null; War.rosterId = null;
        if (ranked && rec.roster && fresh(rec.roster, WAR_KEEP)) { War.roster = new Set(rec.roster.ids); War.rosterId = rec.roster.oppId; }
        const changed = before !== JSON.stringify([War.state, War.ranked, War.rosterId, War.roster && Array.from(War.roster)]);
        if (changed) schedule();
        return changed;
    }

    function hydrateWar() { applyWarCache(readWarCache()); }

    async function loadWar() {
        const factionId = Session.factionId || War.factionId, key = apiKey();
        if (!validKey(key) || Session.state === 'denied' || !factionId || War.inFlight || nowMs() < War.retryAt) return;
        const gen = War.gen;
        const rec = readWarCache() || {};
        if (rec.factionId !== factionId) { rec.war = null; rec.roster = null; }
        rec.factionId = factionId;
        War.inFlight = true;
        stepStart('Torn war lookup');
        try {
            if (!fresh(rec.war, TTL_WAR)) {
                const r = await tornGet('/faction/wars');
                if (gen !== War.gen || key !== apiKey()) return;
                if (r.error) throw Object.assign(new Error('wars: ' + r.error), { code: r.code });
                const w = r.data.wars && r.data.wars.ranked;
                const ranked = w ? { start: w.start, end: w.end || null, factions: w.factions.map(f => ({ id: f.id, name: f.name })) } : null;
                // The same war keeps its roster, so the block's context does not change under it.
                const same = ranked && rec.war && rec.war.ranked && rec.war.ranked.start === ranked.start &&
                    JSON.stringify(rec.war.ranked.factions) === JSON.stringify(ranked.factions);
                rec.war = { ranked, at: toStored(nowMs()) };
                if (!same) rec.roster = null;
                jsonSet(STORAGE_WAR, rec);
            }
            // War data is current here (fetched now, or by another tab), so a past failure no longer applies.
            // A changed observation must reach analysis before its opponent's roster is fetched.
            if (applyWarCache(rec) || !War.ranked) { War.failedAt = 0; War.errorCode = null; return; }
            // The opponent is the other faction in our ranked war, as the server decides it.
            const opp = War.ranked.factions.find(f => f.id !== factionId);
            if (opp && (!fresh(rec.roster, TTL_ROSTER) || rec.roster.oppId !== opp.id)) {
                const r = await tornGet('/faction/' + opp.id + '/members');
                if (gen !== War.gen || key !== apiKey()) return;
                if (r.error) throw Object.assign(new Error('members: ' + r.error), { code: r.code });
                rec.roster = { oppId: opp.id, ids: (r.data.members || []).map(m => m.id), at: toStored(nowMs()) };
                jsonSet(STORAGE_WAR, rec); applyWarCache(rec);
            }
            War.failedAt = 0; War.errorCode = null;
        } catch (e) {
            if (gen !== War.gen) return;
            War.failedAt = nowMs(); War.errorCode = e && e.code != null ? e.code : null;
            // The last good war data stays; only with none at all is the war state unknown.
            if (War.state !== 'war' && War.state !== 'nowar') War.state = 'error';
            War.retryAt = nowMs() + RETRY_NET; schedule();
        } finally { stepEnd('Torn war lookup'); if (gen === War.gen) War.inFlight = false; }
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
        const sentAt = nowMs();
        const reply = r => {
            const response = {
                ok: r.status >= 200 && r.status < 300, status: r.status, text: r.responseText || '', headers: r.responseHeaders || r.headers || '',
                sentAt, receivedAt: nowMs()
            };
            if (baseUrl === AUTH_API) ServerTime.observe(replyTime(response.headers), sentAt, response.receivedAt);
            return response;
        };

        if (isPda()) {
            const call = method === 'POST'
                ? PAGE.flutter_inappwebview.callHandler('PDA_httpPost', url, headers || {}, body || null)
                : PAGE.flutter_inappwebview.callHandler('PDA_httpGet', url, headers || {});
            let timer;
            const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), timeoutMs); });
            return Promise.race([Promise.resolve(call), timeout]).then(reply).finally(() => clearTimeout(timer));
        }

        const x = gmx();
        if (!x) return Promise.reject(new Error('no GM_xmlhttpRequest - CSP blocks a direct fetch'));

        return new Promise((resolve, reject) => {
            x({
                method, url,
                headers: headers || {},
                data: body || null,
                timeout: timeoutMs,
                anonymous: true,                            // none of these services uses cookies
                redirect: 'manual',                         // lets Tampermonkey send requests side by side (its issue #2215)
                onload: r => resolve(reply(r)),
                onerror: () => reject(new Error('network')),
                ontimeout: () => reject(new Error('timeout'))
            });
        });
    }

    // Restores this player's last limits, so a fresh attack page (every attack is one) can be checked at once.
    // A figure past its validity is restored too: hits only rise, so it can still block, and an "allowed"
    // made with it counts as unchecked until ZZCraft answers.
    function hydrateLimits() {
        if (!Session.pass() && !authKeyHash) return;
        const player = Session.pass() ? playerId : null, hash = authKeyHash;
        secureGet(LIMITS_STORAGE_KEY).then(text => {
            const rec = JSON.parse(text || 'null'), payload = rec && rec.payload;
            // Only a whole record for this player counts; anything else is ignored, never read as "no limits".
            const stamp = v => v === null || (Number.isSafeInteger(v) && v >= 0);
            if (!payload || typeof payload !== 'object' || !('currentLimit' in payload) || !('member' in payload) ||
                !stamp(payload.warStart) || !stamp(payload.updatedAt) || (player ? rec.playerId !== player || player !== playerId : rec.keyHash !== hash || hash !== authKeyHash) || Limits.payload ||
                !Number.isFinite(rec.validUntil) || !Number.isFinite(rec.nextAt) || !Number.isFinite(rec.at)) return;
            const currentLimit = sanitizeCurrentLimit(payload.currentLimit), member = sanitizeMember(payload.member);
            if (currentLimit === undefined || member === undefined) return;
            Object.assign(Limits, { payload: { currentLimit, member, nextUpdate: null, warStart: payload.warStart, updatedAt: payload.updatedAt },
                at: fromStored(rec.at), dataAt: Number.isFinite(rec.dataAt) ? fromStored(rec.dataAt) : 0,
                nextAt: fromStored(rec.nextAt), validUntil: fromStored(rec.validUntil) });
            schedule();
        }).catch(() => {});
    }

    // ZZCraft's figures: each null or a non-negative number, or the record is refused (undefined).
    function figures(value, fields) {
        if (value == null) return null;
        if (typeof value !== 'object' || Array.isArray(value)) return undefined;
        const out = {};
        for (const field of fields) {
            const v = value[field];
            if (v != null && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) return undefined;
            out[field] = v == null ? null : v;
        }
        return out;
    }

    function sanitizeCurrentLimit(value) {
        const limit = figures(value, ['minHits', 'maxHits', 'minTotalRespect', 'maxTotalRespect', 'averageRespectGoal']);
        if (!limit) return limit;
        const noHitsAllowed = value.noHitsAllowed == null ? false : value.noHitsAllowed;
        return typeof noHitsAllowed === 'boolean' ? { ...limit, noHitsAllowed } : undefined;
    }

    const sanitizeMember = value => figures(value, ['nbWarHits', 'averageRespect', 'nbHitsNotAllowed']);

    function sanitizeLimitsPayload(value, ownPlayerId) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const currentLimit = sanitizeCurrentLimit(value.currentLimit);
        if (currentLimit === undefined || !Array.isArray(value.members) || value.members.length > 500) { return null; }
        const rawMember = value.members.find(member =>
            member && typeof member === 'object' && Number(member.id) === ownPlayerId
        );
        const member = sanitizeMember(rawMember || null);
        if (member === undefined) return null;

        // ZZCraft's /rankedwars/last has no war id: its limits belong to this war only if currentLimit.startTime
        // equals Torn's war start, and its hit counts cover this war only if lastUpdated is at or after it. The
        // server decides both; an unreadable time is sent as null (unknown), never guessed.
        const seconds = v => { const ms = parseZzTime(v); return ms === null ? null : Math.floor(ms / 1000); };
        const startTime = value.currentLimit && typeof value.currentLimit === 'object' ? value.currentLimit.startTime : null;
        // An unreadable nextUpdate only means "poll again soon"; it never discards the limits.
        return { currentLimit, member, nextUpdate: parseZzTime(value.nextUpdate) === null ? null : value.nextUpdate,
            warStart: seconds(startTime), updatedAt: seconds(value.lastUpdated) };
    }

    // ZZCraft's times: ISO YYYY-MM-DD[T ]HH:MM:SS[.frac][Z|±hh:mm]. No zone means UTC (iPhone Safari cannot parse
    // a space or a missing zone itself). Returns milliseconds, or null for anything else.
    function parseZzTime(value) {
        if (typeof value !== 'string') return null;
        const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(value.trim());
        if (!m) return null;
        const ms = Date.parse(`${m[1]}T${m[2]}${m[3] ? m[3].slice(0, 4) : ''}${m[4] || 'Z'}`);
        return Number.isFinite(ms) ? ms : null;
    }

    function fetchWarRoomLimits(token) {
        return crossOriginFetch(ZZCRAFT_API, 'GET', '/rankedwars/last', { Authorization: `Bearer ${token}`, 'User-Agent': ZZCRAFT_USERAGENT });
    }

    async function loadLimits() {
        if (!Session.pass() || Limits.inFlight || nowMs() < Limits.nextAt) return;

        const gen = Limits.gen;                             // a key change mid-flight voids this response
        const sessionGen = Session.gen, ownPlayerId = playerId;
        const stale = () => gen !== Limits.gen || sessionGen !== Session.gen || !Session.pass();
        // On a failure the last figure is kept: war hits only rise, so a block made with it stays right, and an
        // "allowed" made with it counts as unchecked once it is past its validity (holdState).
        const lapse = retry => { Limits.failed = true; Limits.nextAt = nowMs() + retry; };
        Limits.inFlight = true;
        stepStart('ZZCraft');
        try {
            let token = await WarRoom.ensure();
            if (stale()) return;
            if (!ownPlayerId || !token) throw new Error('WarRoom unavailable');

            let res = await fetchWarRoomLimits(token);
            if (res.status === 401) {
                if (stale()) return;
                WarRoom.reset();
                token = await WarRoom.ensure();
                if (gen !== Limits.gen || sessionGen !== Session.gen) return;
                if (token) res = await fetchWarRoomLimits(token);
            }
            if (stale()) return;

            if (res.status === 401 || res.status === 403) {
                Limits.rejects++;
                Limits.authFailed = Limits.rejects >= 3;
                WarRoom.reset();
                lapse(Limits.authFailed ? REJECTED_RETRY : RETRY_NET);
                return;
            }
            if (!res.ok) { lapse(retryDelay(res, RETRY_QUICK)); return; }
            Limits.rejects = 0;
            Limits.authFailed = false;

            const payload = sanitizeLimitsPayload(JSON.parse(res.text), ownPlayerId);
            if (!payload) throw new Error('invalid limits response');
            // Honour the service's own nextUpdate, clamped so a bad value cannot spin us. It is
            // ZZCraft's time, so measure the wait with ZZCraft's clock from the same reply.
            const nx = parseZzTime(payload.nextUpdate);
            const stamp = replyTime(res.headers), from = Number.isFinite(stamp) ? stamp : ServerTime.estimate();
            const wait = nx !== null && from != null ? nx - from : POLL_MIN;
            // The figure's age is ZZCraft's lastUpdated read against the same reply's clock.
            const made = parseZzTime(JSON.parse(res.text).lastUpdated);
            const dataAt = made !== null && from != null ? nowMs() - Math.max(0, from - made) : 0;
            Object.assign(Limits, { payload, at: nowMs(), dataAt, failed: false, nextAt: nowMs() + Math.max(POLL_MIN, Math.min(POLL_MAX, wait)) });
            Limits.validUntil = Limits.nextAt + LIMITS_KEEP;
            secureSet(LIMITS_STORAGE_KEY, JSON.stringify({ playerId: ownPlayerId, keyHash: authKeyHash, payload, at: toStored(Limits.at),
                dataAt: dataAt ? toStored(dataAt) : 0, nextAt: toStored(Limits.nextAt), validUntil: toStored(Limits.validUntil) })).catch(() => {});
        } catch (e) {
            if (gen === Limits.gen) lapse(RETRY_QUICK);
        } finally { stepEnd('ZZCraft'); if (gen === Limits.gen) { Limits.inFlight = false; schedule(); } }
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
        guardStartFight();                                  // first, and whether or not the bar is drawn
        const bar = q(document, '.txm-fa-bar');
        if (!bar) return;
        const hold = Hold.unlocked ? 'Start Fight could not be found to pause it. Do not attack until the war limits show.' : Hold.state === 'hold' ? HOLD_TEXT : '';
        setShown(q(bar, '.txm-fa-hold'), !!hold); setLiveText(q(bar, '.txm-fa-hold'), hold);
        const row = q(bar, '.txm-fa-limits'), warnRow = q(bar, '.txm-fa-warn');
        const result = Analysis.display('limits');
        const view = result && result.limits;
        const unavailable = !!(view && view.visible && !Limits.payload);
        const analysisFailed = Analysis.nextTryAt > 0 || (!!Analysis.rejected && Analysis.rejected === Analysis.observed);
        const tornNote = War.failedAt ? tornFailure() + ': war status may be out of date' : '';
        const signature = JSON.stringify([view, unavailable, Limits.failed, Limits.inFlight, analysisFailed, hold, Hold.state, Hold.cause, Hold.remembered, tornNote]);
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
            if (Hold.state === 'warn') warning = notEnforcedText();
            else if (!result && Hold.remembered) warning = 'Warning: ' + Hold.remembered;
            else if (!result) warning = analysisFailed ? 'Advice and war checks unavailable' : '';
            else if (view.pending) warning = 'The war' + (result.war.oppName ? ' with ' + result.war.oppName : '') + ' starts on ' + warStartText() + '. Start Fight has been disabled until then.';
            // No figure to show: say so once a fetch has failed, not while the first one is still running.
            else if (unavailable) warning = Limits.failed && !Limits.inFlight ? 'War limits unavailable. Retrying…' : '';
            else if (view.reason) warning = 'Warning: ' + view.reason;
            // A failed Torn lookup is never silent, even while a known block holds or the target is allowed.
            if (tornNote && !(Hold.state === 'warn' && Hold.cause.startsWith('Torn'))) warning = warning ? warning + ' · ' + tornNote : tornNote;
            setShown(warnRow, !!warning); setLiveText(warnRow, warning);
        }
        const age = q(row, '.txm-fa-age');
        // ZZCraft's own data age (RR-13), amber once the figure is overdue or the last fetch failed.
        setLiveText(age, !Limits.payload ? 'no data' : Limits.dataAt ? 'data ' + Math.max(0, Math.round((nowMs() - Limits.dataAt) / 1000)) + 's old' : 'data age unknown');
        setAttr(age, 'data-stale', !Limits.payload || !Limits.dataAt || Limits.failed || nowMs() >= Limits.validUntil ? '1' : '0');
    }

    // #endregion

    // #region Settings

    // Settings panel (structure derived from Smart Stock Vault's settings cog)

    async function applyApiKey(v) {
        Session.reset();
        Analysis.reset();
        await secureDelete(SESSION_STORAGE_KEY);
        await saveApiKey(v);
        // A new key invalidates everything derived from the old one, including any response still in
        // flight (generation bump); onSessionChange tears down what the old key showed and redraws.
        forgetMember();
        playerId = null;
        Session.reset();
        onSessionChange();
        void Session.refresh();
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
        if (existing) { q(existing, '.txm-fa-set-input')?.focus(); return; }
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
                            <button type="button" class="txm-fa-api" data-act="remove">Remove</button>
                        </div>
                    </div>
                    <div class="txm-fa-set-section">
                        <div class="txm-fa-set-title">How your API key is used</div>
                        <div class="txm-fa-set-note"><b>Storage:</b> your key stays on this device. The RR server keeps only a one-way fingerprint of it, for at most 4 minutes, and never stores or logs the key itself.</div>
                        <div class="txm-fa-set-note"><b>Sharing:</b> sent to the RR server (to confirm you're in the faction), to ZZCraft (to log in for war limits), and to Torn's official API (war and roster lookups).</div>
                        <div class="txm-fa-set-note"><b>Purpose:</b> Ruthless Reborn faction war tooling: attack advice and war hit limits.</div>
                        <div class="txm-fa-set-note"><b>Key storage:</b> your userscript manager's storage, or TornPDA's storage.</div>
                        <div class="txm-fa-set-note"><b>Access level:</b> Public Access key only.</div>
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
        const setStatus = (text, state) => { status.textContent = text; setAttr(status, 'data-state', state || ''); };
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
            try { await applyApiKey(v); setStatus(v ? '✓ Key saved' : 'No API key set', v ? 'ok' : ''); } catch (e) { setAttr(input, 'data-bad', '1'); setStatus('✗ Protected storage unavailable', 'bad'); }
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
            }
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

    // A lapsed session removes the protected presentation. War data, limits and the ZZCraft login
    // outlive it: only a key change or a denial forgets them, and the war hold still decides Start Fight.
    function teardownAuthorized() {
        Analysis.reset();
        ['data-txm-hide', 'data-txm-warn', 'data-txm-label', 'data-txm-disarm', 'data-txm-disarm-label', 'data-txm-dialog']
            .forEach(attribute => qa(document, `[${attribute}]`).forEach(element => element.removeAttribute(attribute)));
        qa(document, 'a.txm-fa-namelink').forEach(anchor => anchor.replaceWith(...anchor.childNodes));
        const bar = q(document, '.txm-fa-bar');
        if (bar) setAttr(bar, 'data-txm-mirror', '0');
        lastHelmet = null;
        lastBonuses = null;
        barSig = '';
        adviceSig = '';
        limitsSig = '';
        guardStartFight();
    }

    function onSessionChange() {
        const authorized = Session.pass();
        if (authorized && !wasAuthorized) { hydrateLimits(); hydrateWar(); } else if (!authorized && wasAuthorized) { teardownAuthorized(); }
        wasAuthorized = authorized;
        styleKey = '';
        schedule();
    }

    // TornPDA navigates in place, so every page-scoped cache keys off the URL.
    let lastSearch = location.search;

    function sync() { inOnePass(syncPass); }

    function syncPass() {
        if (!apiKeyLoaded) return;
        if (location.search !== lastSearch) {               // new opponent, same script instance
            lastSearch = location.search;
            lastHelmet = null;
            lastBonuses = null;
            defNameCache = { id: null, name: null };
            Analysis.reset();
        }
        safe('guard', guardStartFight);                     // first: nothing below may delay the war hold
        refreshStyle();                                     // before the bar, so the hide rules exist when it lands
        safe('topbar', renderTopBar);
        if (!refreshData()) return;
        safe('buttons', filterOutcomeButtons);
        safe('dialog', classifyDialog);
        safe('advice', renderAdvice);
        safe('limits', renderLimits);                       // after buttons - it may block START FIGHT
        safe('inforow', syncInfoRow);
        safe('links', linkDefenderNames);
    }

    // War data first (war targets are known even without a session), then login or the checks. Returns
    // whether the session passes.
    function refreshData() {
        safe('war-load', () => void loadWar());
        if (!Session.pass()) {
            if (wasAuthorized) onSessionChange();
            safe('auth', () => void Session.refresh());
            return false;
        }
        safe('analysis', () => void Analysis.refresh());
        if (safe('limits-want', limitsWanted)) safe('limits-load', () => void loadLimits());
        return true;
    }

    let queued = false;

    function schedule() {
        if (warmUp || queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; safe('sync', sync); });
    }

    safe('hydrate', hydrateLimits);
    if (location.pathname === '/factions.php') { safe('warm-up', startWarmUp); return; }
    safe('war', hydrateWar);                                // saved war data holds a target even while the key loads

    // pointer-events:none stops mouse and touch; this capture listener, added before anything that can
    // fail, also covers keyboard activation, synthetic clicks and a click before the page was checked.
    document.addEventListener('click', (e) => {
        safe('click-guard', () => inOnePass(guardStartFight));
        const t = e.target;
        const blocked = t && t.closest && t.closest('[data-txm-block]');
        if (blocked) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    void loadApiKey()
        .then(() => { apiKeyLoaded = true; Session.reset(); safe('war', hydrateWar); safe('verdict', () => Verdict.load()); safe('hydrate-key', hydrateLimits); safe('sync', sync); safe('setup', promptForApiKey); })
        .catch(() => {
            apiKeyLoaded = true;
            authApiKey = '';
            Session.reset();
            Session.state = 'denied';
            onSessionChange();
            safe('setup', promptForApiKey);
        });

    // The attack UI is entirely client-rendered - observe rather than race it. attributeFilter catches
    // React className churn and the mobile tab switch. Waits for <body> when injected early.
    const watch = () => { new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] }); schedule(); };
    if (document.body) watch(); else document.addEventListener('DOMContentLoaded', watch, { once: true });

    window.addEventListener('resize', schedule);

    // React ticks the header timers via characterData, which the observer never
    // sees (watching characterData on body would fire on every damage number).
    // One bounded poll instead, signature-guarded to zero writes when unchanged.
    setInterval(() => {
        nowMs();                                            // notices a PC clock change even while the tab is hidden
        if (document.hidden || !apiKeyLoaded) return;
        inOnePass(() => {
            safe('tick-guard', guardStartFight);
            if (!refreshData()) { safe('tick-authbar', renderTopBar); return; }
            safe('tick', updateBar);
            safe('tick-limits', renderLimits);              // drives the nextUpdate-paced poll
            safe('tick-inforow', syncInfoRow);
        });
    }, 1000);

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) safe('visibility-auth', () => void Session.refresh());
        schedule();
    });

    // #endregion

})();
