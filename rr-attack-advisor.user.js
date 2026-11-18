// ==UserScript==
// @name         RR Attack Advisor
// @namespace    txm.fastattack
// @version      4.3.0
// @description  Attack Page QOL Changes & RR War Condition Integration
// @author       TXM [1712536]
// @updateURL    https://raw.githubusercontent.com/deathapostle-1/Ruthless-Reborn/main/rr-attack-advisor.user.js
// @downloadURL  https://raw.githubusercontent.com/deathapostle-1/Ruthless-Reborn/main/rr-attack-advisor.user.js
// @match        https://www.torn.com/page.php?sid=attack*
// @match        https://www.torn.com/page.php?*&sid=attack*
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

    // unsafeWindow is the real page window in both the sandbox and page modes,
    // which keeps the double-injection guard working across PDA re-navigation.
    const PAGE = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;

    if (PAGE.__txmFastAttack) return;
    PAGE.__txmFastAttack = true;

    const STORAGE_SLOT = 'torn-attack-slot';
    const STORAGE_TYPE = 'torn-attack-type';
    const STORAGE_BAR_HEIGHT = 'rr-attack-bar-height';      // last full bar + header height in px, so the verifying bar can match it
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

    const VERSION = '4.3.0';                                // keep in step with @version above

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
    const LIMITS_AHEAD = POLL_MAX + LIMITS_KEEP + 1000;     // a stored figure or answer is never valid further ahead than this
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

    // The RR server refuses a whole check that breaks its input limits, so what is sent is trimmed to them first.
    const MAX_BONUSES = 32;                                 // opponent bonuses per check
    const MAX_NAME = 200;                                   // helmet, weapon and bonus names
    const MAX_DESC = 2000;                                  // bonus descriptions
    const clip = (value, max) => typeof value === 'string' ? value.slice(0, max) : value;

    // DOM slot identifiers, not advice rules.
    const WEAPON_SLOT_IDS = new Set(['weapon_main', 'weapon_second', 'weapon_melee', 'weapon_temp']);

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
    let keyChanging = false;                                // a key save is running: nothing logs in with the old key meanwhile

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

    function compact() {
        // Torn's "Desktop View" setting forces the desktop tree on a phone AND
        // strips width=device-width from the viewport meta, so innerWidth
        // reports the UA fallback (~980) - under the threshold. The html class
        // is set before React mounts and never removed.
        if (document.documentElement.classList.contains('html-manual-desktop')) return false;
        return window.innerWidth <= COMPACT_WIDTH;
    }

    // The moved buttons sit beside the chosen weapon: 100px per slot, Primary at the top.
    function getTopStyle(slotId) { return (35 + (slotId - SLOT.PRIMARY) * 100) + 'px'; }

    // Crest display: the faction skull (64px webp), the Crest font and the few stroke icons the bar and panel use.
    const SKULL = 'data:image/webp;base64,UklGRuwPAABXRUJQVlA4WAoAAAAwAAAAPwAAPwAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZBTFBIHAUAAA3wRdu2adu2taVcW9fwXF7btm3btm3btm3btrFs2/aweq8lPzT1vvQcERPAlVelzmCPXWZ6aP2SCxa3c1y6lDqDez78TmvLW0NianZ+6V9/OG6Uw5ee6fs+8s6jnHOEEd3BtR70sKm9fvePkS8d2nHPN61vjzJgLIShuObdH3Gt9+y1EpNLc098xOooZzsEyFSnIl3vrbPf/dPGhNS9/mvXR5EtI9NSafpWz73g82fFJFQ86ck5spEpW40QTD/tIR88JHt882+ZG4VxMpVyM5C7N3n7N/45HFea/fRajgAZq9TeIu35kT/8YjietPDRzRwGGeTxyEizbzr8l8NxaPazwxzGiAkawZ5v/sXeeQzFG7YjjJOZqIw0+/6PnelWesTVcwCyPDYLBbKK673y7Ytt0nVeMAoDRkzSkmUX99j1t8M2z9iMYNIyMljy9Gt/eHKzdI2H5MAC2RpbrYx8lUd/bdSo95JRmEqZequdkwGs4n6HndfoKrfKtiosCyMLuZUFYISudZtfu0Fxi40wyICwJSzT3pIBYeg+/zsbrus8PodFtaUQ47REiLJMuubOhzS4yg3CcoWFzNgtq4Shc8f9ou5O6wFYYIFJoXHITuAK4XSLIxrcZliqlAUhozZGyNRa4von1XWukgNkcDKAAFuNnDANnYyuek5dby4MliVjUS1bFUbINLRk0E552VWdbmDJCoFCVaAQ4IRprhBAd9dza1IKZCfLgIxRCRmQaS2XmFuh2ghLxqJSGCwjJpqiZrQ9TaVcValIuMJqZQFeSTVbi7tJpbYyVkluJWNtnaea0bE3KeQxTNQizhhQ/8d7TzNmeVwycWivwfFHPjqNx2KC+e9Fg+0vPnm3YhxOHpflOPsgNfBx7/jotdXOAsvCaiXHPl+l8eiwP75uupUl53c87a8vnpJbwdnvKpoRx1233wo5Tvn73td86i6M86cDmqtzz/VoB/lXxQm9/R/ZzuL+h1zsJuo89ao5wKqxTDKreyWGn3tpX2A1kbnpEz666Qb9x9wyhwGrCmTwGYvgi6ZmAAWqMojuE677hUXXvebaOQyWDBhhyQwP7gNbf39wAchYperBi274qlGdp8KAMGVZGDjnSwD5h08pBCiSS7IMKja7rvv9A3tYAJZJtgBir14p/j9zm0RjGSD/qaD+tMVbklySkZFLm79SyfGpV/RLclWlVw5Rg7W3vvaaqAQyteecSaUPvOrVsGi5+TXRMI7+2vtnUUVD/66HZl7xpUWWL7q25BajvY6l8fAf/3nrbCOLOMNdFc+dWfreaGufu3XAauB85PfUjNH3zn3lICEswMl4r6vvun3be+QH3ehzG/+9RR9kq8rbp34k0Xb7s3/8+O0MMjgZdPNv/fjBmxG3fsBT33bKZgBOxghW3nKwaO/D3/qy+xV5mPpJIaGbv2EtRyDt/p7VXFJs5aJbxMbXumKcefmVo4WLz+3e7el/fPYOkO6dwwCaIgz5fwsfObN7tz3in33GHMv/vQi2/verm70kA8iUjcCy//nxxNZ/zkliwsPV+a4NOIUAYZCVHvJdwMHkOw/IYQHINNW1L142l8rigWEZi3oj0GDXMy8tu4VFrUV95ypncCld7RUkVSlUEXZEupSsPeH6d7zJDWcXdwi8PC/Ip1/r9AtO/6a4tC79cv/jFh+49fyrdHvDd7+zO4ylr8feRa/gUusc+fxfFV8aLezo7PrT4cXDYe80cWmPYO28C8+HA4LLdVZQOCDaCAAAsCYAnQEqQABAAD4tEIVCoaEN/vwMAWJbAC44cDRnnh908xOqf0n7w/knyipR+zH8r+VXYO+5X3AP0i/sv209wDzAfrR+tPtC/sB7uPQH/pH+A9Xv/b+xv6AH69elr+2HwP/2n/X/tb8BX7Cf9TOAP47+EHex/c/A3xAehfZr0zsEfSZ/QdxD8n5G94PAC9Tf4bw59ivXb0AvYP6p/wuNHvR/0D/a+kHemUAP5b/Uv9/7L38p/7P8x5svoD/sf5H4A/5b/Uv+D/f/at9ev7i+xx+wDb0gsdXOqZcJxy15lZ/0DavQTp/Y8wohT5nPRe/l/rQPIvDgrVl9Uj8vV7yZTwp7WqhKtg8raMENL3S+khMLZmBCGl0sr67xMmSMbZr6vEMG19nTGTkgckLqNZyXKbtb12I3mBF7X/zUP50AAP79yHfoBJ7c15BwlkZ4Qv/7/AIqI540/ZSCf8EIPnnpw73FurN4kw0H6V3l0sV/lesO/9fNE1zxj1tnGiJ4XqfTqPZLqQuYz35iP0ovmbNOpQRziV+nIB5eQtDYbr9XNw6vzVbZYj0hj3f8LhrX8PGK16drmd06ZiURaLbabMigZcLPeDWo3p8x09ev9k54uzKwJ3fMg/d5H0dIZjpTLXuWXa8RnN6p2RY2PdmgNGfvYzL9nj69dmZXQpy7NEMpSLrwWKArrf0k8X7St00JvutPfywdQ6GE/NMjoBa1WG/wEKhD2r3PpVQekflfz4zdiSFAPnJF/55nSwqOFoKi0spTNzlrrZOz4JfnUXBSBQ/u5YMV56OyGQhxEhG1TXYS5siZ4KlXi/CCUQKQieVTUB+8aT6HIyzUkrf9QwsZmu8bL9flanDj71KeHfV0Yom8owl+5PRkb9ZcNRO9hmeNB4gowA4R+pw+zu9/H0pRlquB+Djg/IHJUd5WyM4ytSyIPgIErV33gYTfdyE1jWbD++dbBhzv23VXrF4dzfsOZGI+rfMbhnbfoikAXevBs73E/5u+s/6eATOdsnWF7Dlf3/g1Kd6QhSuvTjCzOrOKYkF/8l2ihI1N39XDNay8mDvG2AvEwv9jg4GPAjOjxVTxDdX+boDkCAyut/9z21uL35YKMG7UzYrFT7Ir923N07tfa30xQvCnr853z28ZEDjkdR9ZweCzKU0Kpt99PfK/qI08ktjjeAnGFh9W2LCAgcVVjKU7hG1ZiVtduPrOgMewhLSaqdisbVIQe+DSb7HwUM4gEk1WQPw1OGxzXb/r0siZ7ECBeqIchGDGY71AVN/gnzumV+BHeSFQeWaXr7E2jE4lBq/2vCqXpfQfPAfIbX/UX2pk8OkcLAU/riHM4BtSAHVIxm8cY3pwqc1dhRWnS4uf6S3ui79bFY/v1T7XxiKy+FmcWGl/BGh1l7afHfva6WqSntOz1zJEuIAVqxDl9ZP0gXKo7YvIhQjizRTdvmXmsSfkUZQfyuvPefE+XPMg6rmJyZBIRbxfXeTaZgFYcRSJuekE8WaP+aPi2PElsTyjyZn+5HVfdxVp+zbeIHQ4ct8+ddppy1u89iUOVAbThASM8PpGZ8Fj/MAw5M/z/lLJ/0yfPiVCa7tN+PTvfVe/iz/NWJxSi9B/s4nTiWMiVMOXSbrTJ1wdiPWl8F9A1uJMAJLbwo4xaLbdoyzMKr+K/tzaqd5bNRoQnILw+Tl1cuR+ItQWDWxIIcy2kqbWCOriDDQGwDefqSYH5iTySCEtPUsqlfvuCey8qvy7n6flo+4Qd1q11SfgT7L66aINj1+We/v7pQd5/T6z4GkMVs+L0FXF6ITrr+mw6vGHIFquTWp9k1YnT7GB6Nxq95Piub6pmFGDEaeAt+YdDLUyv+cW8g7ex7qRW87b26tSNv2xFXLvLc3Mm4bBZk6SwOdY/u5l0JHfkMtgmI7wVidpBXAC2hsO+0alb+xsvXOVsBGfEflak4anOvS0VsvNmhr4FHOMf8r422eMuAGb/0ghnkvbqXtApWJvyqV29EdTNa39MnOG18OcWOlS5s4LhzxZkH28UpxCCZeJQHG/NZnnVS+UO1oQ7yphFziEOczMwMiCGjYagOR97xavxQOVDJYqhacgclkMn+RLB4lfUf8xNCcQCeePYsvnSGXC9jEfhOsPn7/BlcEoQFXZ08Jg4PC3b19i1X8w3ZG69o87DXu5OmnRssytQZCFEgvZiG2BD5m2ev/tnw+v+7K0X4dSQ22q2IvGD1TH4K+Xov2Aj9Kb+GMEpUssPkpfxfjFQrd25WqCe41tLYXuf4EG44yn2mY2OldYlshpURpXmMGmhtn+tjZD8R+hz1X4gazw14JAzUNcI4QmNCKNPd4wmBiVL4l87LTy7sQSZjHMVtv7NSvP7guBp2nNDPJAz9fG65WBnObiXdDa5/3MP2BMDesjFdFvcmAoMCWNen/AnehnClZkx24W2SZuDd28nmdUKnwlcmWgtHHdSbiwvY4gpO8in2FZ33d5k8qLxjy/6dP7t4oFR3KNqUgs+iSQHCTyXJn9FUVWjJXIFkf/kR3bViujthw2R/87iEmgc/AkITIK1pNSOQbhSuPrYnsVm4nLFZ6AWTTc9ihOiFtn6rUKfZZUaGKZ7euX1mImprznfrT2Wcq9xkOg1B7SWDRad0HNtQCafw5LEn/r038W0jh9aDn8Wm7e1/ktaCMQPUgN1P7uJcyqwoYw04VD8mh7RwPD3fJdn3PCuq9jLJaN4/i0e/lrMo2ohbOBBPPzj4gulIgnDnEyUSpu+lngMihDxz5sNEPj8FplDeT91sXJez42mOXrxHyYvd8168SDjYmdZi8sAL3DlKsz+BZj6+y4Ndo8yH4ecehaMBdOlFzzkjeIsxgH8plPVkDQ3CkjhmYs0pRJt0jrPHi88BOhsRlwqEvrsVMiVjai9C/VLgHnJEOqJHC+emOlpR1X7c2s2r5Xfmk5enNmiso0BDuam7XAiUrDCtz8sWZYrpQjcULhA8UTMp9OaRUNOoveoPAClL2DJjEEUZH8KBbG9qW1i6LRwWPjfogAAA==';
    const FONT_URL = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&display=swap';
    const ICONS = {
        timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2"/><path d="M9 2h6"/>',
        escape: '<path d="M10 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h4"/><path d="M14 8l4 4-4 4M18 12H9"/>',
        back: '<path d="M10 6l-6 6 6 6"/><path d="M4 12h11a5 5 0 0 1 5 5v1"/>',
        settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
        close: '<path d="M6 6l12 12M18 6L6 18"/>',
        chevron: '<path d="M6 9l6 6 6-6"/>',
        check: '<path d="M5 12l5 5 9-10"/>',
        lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
        key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2"/>',
        rifle: '<path d="M2 10h13l2-2h5v3h-4l-1 2H9l-1 4H5l1-4H2z"/>',
        pistol: '<path d="M3 7h16v4h-7l-1 2H9l-1 5H5l1-7H3z"/>',
        blade: '<path d="M20 4L9 15"/><path d="M20 4h-3l-9 9 3 3 9-9z"/><path d="M7 14l3 3"/><path d="M4 20l3-3"/>',
        grenade: '<circle cx="11" cy="14" r="6"/><path d="M11 8V5h4"/><path d="M15 5l2-2"/>',
        leave: '<path d="M13 4h5v16h-5"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h9"/>',
        mug: '<path d="M6 8h12l-1 12H7z"/><path d="M9 8a3 3 0 0 1 6 0"/>',
        hosp: '<path d="M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z"/>',
        info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
        warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>'
    };
    const icon = (name, size = 14, cls = '') => `<svg class="rra-icon${cls ? ' ' + cls : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
    const skull = size => `<img class="rra-skull" src="${SKULL}" width="${size}" height="${size}" alt="" draggable="false">`;
    const htmlEsc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const SLOT_ICON = { [SLOT.PRIMARY]: 'rifle', [SLOT.SECONDARY]: 'pistol', [SLOT.MELEE]: 'blade', [SLOT.TEMP]: 'grenade' };
    const SLOT_TILE = { [SLOT.PRIMARY]: 'weapon_main', [SLOT.SECONDARY]: 'weapon_second', [SLOT.MELEE]: 'weapon_melee', [SLOT.TEMP]: 'weapon_temp' };
    const ATTACK_ICON = { [ATTACK.LEAVE]: 'leave', [ATTACK.MUG]: 'mug', [ATTACK.HOSP]: 'hosp' };
    const ATTACK_FULL = { [ATTACK.LEAVE]: 'Leave', [ATTACK.MUG]: 'Mug', [ATTACK.HOSP]: 'Hospitalize' };

    // Everything Crest draws sits under .rra (the bar host, the settings overlay) or on the weapon tiles the script
    // marks, so neither Torn's CSS nor this one reaches the other. Light and dark follow Torn's body.dark-mode.
    const CREST_CSS = `
        .rra, [data-txm-warn], [data-txm-disarm] { --rra-font: 'Bricolage Grotesque', system-ui, -apple-system, 'Segoe UI', sans-serif; --rra-primary: #029E7A; --rra-accent: #C9A95C; }
        body.dark-mode :is(.rra, [data-txm-warn], [data-txm-disarm]) { --rra-surface: #1b1c1e; --rra-surface-2: #232427; --rra-sunken: #141516; --rra-line: #33363a; --rra-text: #eceae4; --rra-muted: #a8a59d; --rra-primary-fg: #2fc29d; --rra-on-primary: #04211a; --rra-accent-fg: #d4b56c; --rra-ok: #4cc38a; --rra-close: #f0913e; --rra-below: #f06a5f; --rra-none: #9a9ca1; --rra-shadow: 0 12px 32px rgba(0, 0, 0, .5); }
        body:not(.dark-mode) :is(.rra, [data-txm-warn], [data-txm-disarm]) { --rra-surface: #ffffff; --rra-surface-2: #f6f4ef; --rra-sunken: #eeebe4; --rra-line: #dcd8ce; --rra-text: #1c1d1f; --rra-muted: #5e5b54; --rra-primary-fg: #026e56; --rra-on-primary: #04211a; --rra-accent-fg: #7f6427; --rra-ok: #11704f; --rra-close: #a14a07; --rra-below: #b42318; --rra-none: #63666c; --rra-shadow: 0 12px 32px rgba(20, 20, 20, .16); }
        body.dark-mode .rra { color-scheme: dark; }
        body:not(.dark-mode) .rra { color-scheme: light; }

        .rra { box-sizing: border-box; font-family: var(--rra-font); font-size: 12px; line-height: 1.35; color: var(--rra-text); text-align: left; letter-spacing: normal; text-transform: none; font-weight: 400; -webkit-font-smoothing: antialiased; }
        .rra *, .rra *::before, .rra *::after { box-sizing: border-box; }
        .rra :is(button, input) { font: inherit; color: inherit; margin: 0; letter-spacing: inherit; }
        .rra button { cursor: pointer; }
        .rra button:disabled { cursor: default; }
        .rra :is(p, h2, h3, ul, dl, dt, dd) { margin: 0; padding: 0; }
        .rra ul { list-style: none; }
        .rra img { display: block; max-width: none; }
        .rra [hidden] { display: none !important; }
        .rra :focus-visible { outline: 2px solid var(--rra-accent); outline-offset: 2px; }
        .rra .rra-vh { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

        /* The bar host is a size container, so the phone layout follows the bar's own width; it gets a layer to keep its pop-ups above the fight. */
        .txm-fa-bar { position: relative; z-index: 50; margin: 8px 0; container: rra / inline-size; }
        .txm-fa-bar[data-pop-open] { z-index: 1001; }
        .txm-fa-bar[data-txm-mode="auth"] { display: flex; flex-direction: column; }
        .rra .rra-bar { position: relative; display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto; grid-template-areas: "brand readouts . controls" "band band band band"; grid-template-rows: minmax(52px, auto) auto; column-gap: 12px; align-items: center; margin: 0; padding: 0 12px; border: 1px solid var(--rra-line); border-radius: 6px; background: var(--rra-surface); box-shadow: inset 0 2px 0 #029E7A; color: var(--rra-text); font-family: var(--rra-font); font-size: 12px; font-weight: 400; line-height: 1.35; text-align: left; }
        .rra .rra-bar--gated { flex: 1 1 auto; grid-template-rows: minmax(52px, auto) 1fr; }

        .rra .rra-brand { grid-area: brand; display: flex; align-items: center; gap: 8px; min-width: 0; }
        .rra .rra-brand .rra-skull { flex: none; width: 30px; height: 30px; }
        .rra .rra-title { display: flex; flex-direction: column; line-height: 1.15; white-space: nowrap; }
        .rra .rra-eyebrow { font-size: 10.5px; font-weight: 600; letter-spacing: .02em; color: var(--rra-accent-fg); }
        .rra .rra-name { font-size: 15px; font-weight: 800; color: var(--rra-text); }

        .rra .rra-readouts { grid-area: readouts; align-self: stretch; display: flex; min-width: 0; margin: 0; padding: 0; border-right: 1px solid var(--rra-line); }
        .rra .rra-cell { display: flex; flex-direction: column; justify-content: center; min-width: 0; padding: 0 12px; border-left: 1px solid var(--rra-line); }
        .rra .rra-label { margin: 0; font-size: 10.5px; font-weight: 400; line-height: 1.3; color: var(--rra-muted); white-space: nowrap; }
        .rra .rra-value { display: flex; align-items: baseline; gap: 4px; margin: 0; font-size: 14px; font-weight: 700; line-height: 1.25; color: var(--rra-text); font-variant-numeric: tabular-nums; white-space: nowrap; }
        .rra .rra-value b { font-weight: inherit; }
        .rra .rra-sub { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 500; color: var(--rra-muted); }
        .rra .rra-sub:empty { display: none; }
        .rra .rra-cell[data-low="1"] .rra-sub { font-weight: 700; color: var(--rra-close); }
        .rra .rra-cell:not([data-low="1"]) .rra-low { display: none; }
        .rra .rra-status { display: inline-flex; flex: none; align-self: flex-start; align-items: center; gap: 4px; min-height: 24px; margin: 0; padding: 0 8px; border: 1px solid color-mix(in srgb, var(--rra-primary) 55%, transparent); border-radius: 3px; font-size: 11px; font-weight: 700; color: var(--rra-primary-fg); white-space: nowrap; }

        .rra .rra-nav { display: flex; flex: none; min-width: 0; padding-right: 16px; border-right: 1px solid var(--rra-line); }
        .rra .rra-back { display: inline-flex; align-items: center; gap: 4px; min-width: 0; min-height: 20px; border-radius: 4px; font-size: 11px; font-weight: 500; color: var(--rra-muted); text-decoration: none; }
        .rra .rra-back .rra-icon { flex: none; }
        .rra .rra-back span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .rra .rra-back:hover { color: var(--rra-text); }
        .rra .rra-back:hover span { text-decoration: underline; text-underline-offset: 2px; }

        .rra .rra-controls { grid-area: controls; display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-width: 0; }
        .rra .rra-btn { display: inline-flex; flex: none; align-items: center; justify-content: center; gap: 8px; height: 32px; margin: 0; padding: 0 12px; border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--rra-text); font-family: inherit; font-size: 12px; font-weight: 700; line-height: 1; white-space: nowrap; appearance: none; }
        .rra .rra-btn .rra-icon { flex: none; }
        .rra .rra-btn--primary { border-color: var(--rra-primary); background: var(--rra-primary); color: var(--rra-on-primary); }
        .rra .rra-btn--primary:not(:disabled):hover { filter: brightness(1.08); }
        .rra .rra-btn--primary:disabled { border-color: var(--rra-line); background: var(--rra-surface-2); color: var(--rra-muted); filter: none; }
        .rra .rra-btn--ghost { border-color: var(--rra-line); }
        .rra .rra-btn--ghost:hover { border-color: var(--rra-accent); }
        .rra .rra-btn--icon { width: 32px; padding: 0; border-color: color-mix(in srgb, var(--rra-accent) 55%, transparent); color: var(--rra-accent-fg); }
        .rra .rra-btn--icon:hover { background: color-mix(in srgb, var(--rra-accent) 12%, transparent); }

        .rra .rra-pick { position: relative; min-width: 0; }
        .rra .rra-trigger { display: flex; align-items: center; gap: 4px; height: 32px; margin: 0; padding: 0 8px; border: 1px solid var(--rra-line); border-radius: 4px; background: var(--rra-surface-2); color: var(--rra-text); font-family: inherit; font-size: 12px; font-weight: 400; line-height: 1.15; text-align: left; appearance: none; }
        .rra .rra-trigger:hover { border-color: color-mix(in srgb, var(--rra-accent) 55%, transparent); }
        .rra .rra-trigger[aria-expanded="true"] { border-color: var(--rra-accent); }
        .rra .rra-trigger__lead { display: flex; flex: none; margin-right: 4px; color: var(--rra-muted); }
        .rra .rra-trigger__text { display: flex; flex-direction: column; min-width: 0; }
        .rra .rra-trigger__over { font-size: 10.5px; color: var(--rra-muted); white-space: nowrap; }
        .rra .rra-trigger__value { max-width: 112px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 700; }
        .rra .rra-trigger__chev { flex: none; color: var(--rra-muted); transition: transform .15s ease; }
        .rra .rra-trigger[aria-expanded="true"] .rra-trigger__chev { transform: rotate(180deg); }
        .rra .rra-slot[data-empty="1"] .rra-trigger__value { color: var(--rra-muted); }
        .rra .rra-show { display: none; }
        .rra .rra-slot[data-cur="1"] .rra-show--1, .rra .rra-slot[data-cur="2"] .rra-show--2, .rra .rra-slot[data-cur="3"] .rra-show--3, .rra .rra-slot[data-cur="4"] .rra-show--4 { display: block; }

        .rra .rra-pop { position: absolute; top: calc(100% + 4px); left: 0; z-index: 30; display: flex; flex-direction: column; width: max-content; min-width: 220px; max-width: min(320px, calc(100cqw - 16px)); margin: 0; padding: 4px; border: 1px solid var(--rra-line); border-radius: 6px; background: var(--rra-surface); box-shadow: inset 0 1px 0 color-mix(in srgb, var(--rra-accent) 35%, transparent), var(--rra-shadow); }
        .rra .rra-pop__row { position: relative; display: grid; grid-template-columns: 16px minmax(0, 1fr) 14px; align-items: center; gap: 8px; min-height: 40px; margin: 0; padding: 4px 8px; border-radius: 4px; color: var(--rra-text); font-weight: 400; cursor: pointer; }
        .rra .rra-pop__row:hover { background: var(--rra-surface-2); }
        .rra .rra-pop__row input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
        .rra .rra-pop__row:has(input:focus-visible) { outline: 2px solid var(--rra-accent); outline-offset: -2px; }
        .rra .rra-pop__icon { color: var(--rra-muted); }
        .rra .rra-pop__text { display: flex; flex-direction: column; min-width: 0; }
        .rra .rra-pop__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 700; line-height: 1.25; }
        .rra .rra-pop__sub { font-size: 10.5px; line-height: 1.25; color: var(--rra-muted); white-space: nowrap; }
        .rra .rra-pop__check { color: var(--rra-primary-fg); visibility: hidden; }
        .rra .rra-pop__row input:checked ~ .rra-pop__check { visibility: visible; }
        .rra .rra-pop__row[data-empty="1"] .rra-pop__name { font-weight: 600; color: var(--rra-muted); }

        /* Row 2, the sunken band: back link, advice, notices and war limits; a banner while Start Fight is paused, blocked or unchecked. */
        .rra .rra-band { grid-area: band; display: flex; flex-direction: column; justify-content: center; gap: 8px; min-width: 0; min-height: 36px; margin: 0 -12px; padding: 8px 12px; border-top: 1px solid var(--rra-line); border-radius: 0 0 5px 5px; background: var(--rra-sunken); }
        .rra .rra-bar--gated .rra-band { align-self: stretch; }
        .rra .rra-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; min-width: 0; }
        .rra .rra-row:not(:has(> :not([hidden]))) { display: none; }
        .rra .rra-advice-list { display: flex; flex: 1 1 320px; flex-wrap: wrap; align-items: center; gap: 4px 16px; min-width: 0; margin: 0; padding: 0; list-style: none; font-size: 12px; }
        .rra .rra-band[data-alert] .rra-advice-list { flex-basis: 240px; font-size: 11px; }
        .rra .rra-adv { display: flex; align-items: center; gap: 4px; min-width: 0; margin: 0; padding: 0; color: var(--rra-text); }
        .rra .rra-adv[title] { cursor: help; }
        .rra .rra-adv--none { font-size: 11px; color: var(--rra-muted); }
        .rra .rra-adv[data-level="avoid"] { --rra-level: var(--rra-below); }
        .rra .rra-adv[data-level="caution"] { --rra-level: var(--rra-close); }
        .rra .rra-adv[data-level="ok"] { --rra-level: var(--rra-ok); }
        .rra .rra-adv[data-level="unknown"] { --rra-level: var(--rra-none); }
        .rra .rra-diamond { flex: none; width: 7px; height: 7px; margin-right: 4px; background: var(--rra-level, var(--rra-muted)); transform: rotate(45deg); }
        .rra .rra-adv[data-level="unknown"] .rra-diamond { background: transparent; box-shadow: inset 0 0 0 1.5px var(--rra-level); }
        .rra .rra-adv__icon { flex: none; color: var(--rra-level, var(--rra-muted)); }
        .rra .rra-adv__text { min-width: 0; }
        .rra .rra-notice { display: flex; align-items: center; gap: 4px; min-width: 0; margin: 0; font-size: 11px; font-weight: 700; color: var(--rra-below); }
        .rra .rra-notice .rra-icon { flex: none; }

        .rra .rra-limits { display: flex; flex: 0 1 auto; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 4px 12px; margin: 0 0 0 auto; font-size: 11px; line-height: 1.35; color: var(--rra-muted); font-variant-numeric: tabular-nums; }
        .rra .rra-lim { white-space: nowrap; }
        .rra .rra-limits b { font-weight: 700; color: var(--rra-text); }
        .rra .rra-limits b[data-ok="0"] { color: var(--rra-below); }
        .rra .rra-age { font-size: 10.5px; white-space: nowrap; }
        .rra .rra-age[data-stale="1"] { color: var(--rra-close); }
        .rra .rra-left { display: inline-flex; align-items: center; gap: 4px; font-size: 12.5px; font-weight: 600; color: var(--rra-primary-fg); white-space: nowrap; }
        .rra .rra-limits .rra-left b { font-weight: 800; color: inherit; }
        .rra .rra-left .rra-icon { flex: none; }
        .rra .rra-left--none { color: var(--rra-below); }
        .rra .rra-left--quiet { color: var(--rra-text); }

        .rra .rra-banner { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-height: 36px; margin: 0; padding: 8px 12px; border: 1px solid var(--rra-accent); border-radius: 6px; background: color-mix(in srgb, var(--rra-accent) 10%, var(--rra-surface)); }
        .rra .rra-banner[data-kind="blocked"] { --rra-banner: var(--rra-below); border-color: var(--rra-below); background: color-mix(in srgb, var(--rra-below) 14%, var(--rra-surface)); }
        .rra .rra-banner[data-kind="warn"] { --rra-banner: var(--rra-close); border-color: var(--rra-close); background: color-mix(in srgb, var(--rra-close) 14%, var(--rra-surface)); }
        .rra .rra-banner__icon { display: flex; flex: none; color: var(--rra-banner, var(--rra-accent-fg)); }
        .rra .rra-banner__msg { flex: 1 1 240px; min-width: 0; margin: 0; font-size: 12.5px; font-weight: 700; line-height: 1.3; color: var(--rra-text); }
        .rra .rra-banner .rra-limits { margin-left: auto; }

        .rra .rra-gate { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 12.5px; font-weight: 600; line-height: 1.3; color: var(--rra-text); }
        .rra .rra-gate__icon { display: flex; flex: none; color: var(--rra-accent-fg); }
        .rra .rra-bar[data-access="denied"] .rra-gate__icon { color: var(--rra-below); }

        /* Desktop and tablet: the Outcome list shows inline as a segmented control. */
        @container rra (min-width: 641px) {
            .rra .rra-outcome__trigger { display: none; }
            .rra .rra-bar .rra-outcome__list[hidden] { display: grid !important; }
            .rra .rra-outcome__list { position: static; display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; width: auto; min-width: 0; max-width: none; padding: 0; overflow: hidden; border-radius: 4px; background: var(--rra-surface-2); box-shadow: none; }
            .rra .rra-outcome__opt { display: flex; justify-content: center; gap: 4px; min-height: 30px; padding: 0 8px; border-radius: 0; }
            .rra .rra-outcome__opt + .rra-outcome__opt { border-left: 1px solid var(--rra-line); }
            .rra .rra-outcome__opt:hover { background: color-mix(in srgb, var(--rra-accent) 10%, var(--rra-surface-2)); }
            .rra .rra-outcome__opt .rra-pop__name { font-size: 12px; font-weight: 500; }
            .rra .rra-outcome__opt .rra-pop__check { display: none; }
            .rra .rra-outcome__full { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
            .rra .rra-outcome__opt:has(input:checked) { background: var(--rra-primary); color: var(--rra-on-primary); }
            .rra .rra-outcome__opt:has(input:checked) .rra-pop__icon { color: var(--rra-on-primary); }
            .rra .rra-outcome__opt:has(input:checked) .rra-pop__name { font-weight: 700; }
        }
        /* Narrow desktop and tablet: the controls take their own row. */
        @container rra (min-width: 641px) and (max-width: 919px) {
            .rra .rra-bar { grid-template-columns: auto auto minmax(0, 1fr); grid-template-areas: "brand readouts ." "controls controls controls" "band band band"; grid-template-rows: minmax(52px, auto) auto auto; }
            .rra .rra-controls { justify-self: end; padding-bottom: 8px; }
            .rra .rra-bar--gated .rra-controls { padding-bottom: 0; }
        }
        /* Desktop and tablet: Torn's header still shows under the gated bar, so it is one compact row (the message in
           a ruled cell) that holdBarSpace pads to the full bar's height less that header. */
        @container rra (min-width: 641px) {
            .rra .rra-bar.rra-bar--gated { grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: "brand band controls"; grid-template-rows: minmax(42px, 1fr); }
            .rra .rra-bar--gated .rra-band { min-height: 0; margin: 0; padding: 0 12px; border-top: 0; border-left: 1px solid var(--rra-line); border-radius: 0; background: none; }
        }
        /* Phone: compact readouts beside the skull, then 44px pickers, Escape and settings, then the band. */
        @container rra (max-width: 640px) {
            .rra .rra-bar { grid-template-columns: auto minmax(0, 1fr); grid-template-areas: "brand readouts" "controls controls" "band band"; grid-template-rows: minmax(48px, auto) auto auto; column-gap: 8px; padding: 0 8px; }
            .rra .rra-bar--gated { grid-template-areas: "brand controls" "band band"; grid-template-rows: minmax(48px, auto) 1fr; }
            .rra .rra-bar[data-readouts="some"] .rra-title { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
            .rra .rra-readouts { border-right: 0; }
            .rra .rra-cell { flex: 1 1 auto; padding: 0 8px; }
            .rra .rra-value { font-size: 13px; }
            .rra .rra-controls { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; padding-bottom: 8px; }
            .rra .rra-bar--gated .rra-controls { display: flex; padding-bottom: 0; }
            .rra .rra-pick { position: static; }
            .rra .rra-trigger { height: 44px; }
            .rra .rra-slot__trigger { width: 100%; }
            .rra .rra-slot__trigger .rra-trigger__text { flex: 1 1 auto; }
            .rra .rra-trigger__value { max-width: none; }
            .rra .rra-escape { gap: 4px; height: 44px; padding: 0 8px; }
            .rra .rra-settings { width: 44px; height: 44px; }
            .rra .rra-pop { top: calc(100% - 4px); right: 0; width: auto; min-width: 0; max-width: none; }
            .rra .rra-pop__row { min-height: 44px; }
            .rra .rra-outcome__short { display: none; }
            .rra .rra-nav { flex: 1 1 100%; padding-right: 0; border-right: 0; }
            .rra .rra-back { min-height: 32px; font-size: 12px; }
            .rra .rra-band { margin: 0 -8px; padding: 4px 8px 8px; }
            .rra .rra-row { gap: 4px 12px; }
            .rra .rra-advice-list { flex: 1 1 100%; gap: 4px 12px; }
            .rra .rra-limits { flex: 1 1 100%; justify-content: flex-start; margin-left: 0; }
            .rra .rra-banner .rra-limits { margin-left: 0; padding-left: 24px; }
            .rra .rra-bar--gated .rra-band { align-items: center; padding: 8px; }
            .rra .rra-bar--gated .rra-gate { flex-direction: column; text-align: center; }
        }
        @container rra (max-width: 359px) {
            .rra .rra-slot__trigger .rra-trigger__lead { display: none; }
            .rra .rra-escape .rra-icon { display: none; }
        }

        /* Weapon tags sit on Torn's tiles as pseudo-elements, so nothing is added inside React's markup. */
        [data-txm-warn], [data-txm-disarm] { position: relative; }
        [data-txm-warn]::after, [data-txm-disarm]::before { position: absolute; right: 5px; bottom: 26px; z-index: 6; pointer-events: none; display: block; margin: 0; padding: 2px 6px; border: 1px solid currentColor; border-radius: 3px; background: var(--rra-surface); box-shadow: 0 1px 2px rgba(0, 0, 0, .25); font-family: var(--rra-font); font-size: 10.5px; font-style: normal; font-weight: 700; line-height: 14px; letter-spacing: normal; text-transform: none; white-space: nowrap; }
        [data-txm-warn]::after { content: "\\25C6\\2002" attr(data-txm-label); color: var(--rra-muted); }
        [data-txm-warn="avoid"]::after { color: var(--rra-below); }
        [data-txm-warn="caution"]::after { color: var(--rra-close); }
        [data-txm-disarm]::before { content: "\\25C6\\2002" attr(data-txm-disarm-label); color: var(--rra-close); }
        [data-txm-warn][data-txm-disarm]::before { bottom: 49px; }
        [data-txm-sel] { outline: 2px solid #029E7A; outline-offset: -2px; }

        /* Settings: the right-side panel over a dimmed page. */
        .rra-overlay { position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 999999; background: rgba(0, 0, 0, .5); }
        .rra .rra-panel { position: absolute; top: 64px; bottom: 64px; right: 0; display: flex; flex-direction: column; width: min(380px, 100%); overflow: hidden; background: var(--rra-surface); border: 1px solid var(--rra-line); border-right: 0; box-shadow: inset 0 1px 0 color-mix(in srgb, var(--rra-accent) 35%, transparent), var(--rra-shadow); color: var(--rra-text); }
        .rra .rra-panel :where(h2, h3, p, dl, dt, dd) { margin: 0; padding: 0; font-family: inherit; letter-spacing: normal; text-transform: none; }
        .rra .rra-panel__head { flex: none; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px; border-bottom: 1px solid var(--rra-line); }
        .rra .rra-panel__crest { display: flex; align-items: center; gap: 8px; min-width: 0; }
        .rra .rra-panel__crest .rra-skull { flex: none; width: 32px; height: 32px; }
        .rra .rra-panel__titles { display: flex; flex-direction: column; min-width: 0; line-height: 1.15; }
        .rra .rra-panel__eyebrow { font-size: 10.5px; font-weight: 600; letter-spacing: .02em; color: var(--rra-accent-fg); }
        .rra .rra-panel__title { font-size: 15px; font-weight: 800; line-height: 1.2; color: var(--rra-text); }
        .rra .rra-panel__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 16px 16px; }
        .rra .rra-panel__section { display: grid; gap: 12px; padding: 16px 0; border-top: 1px solid var(--rra-line); }
        .rra .rra-panel__section:first-child { border-top: 0; }
        .rra .rra-panel__heading { font-size: 13px; font-weight: 700; line-height: 1.3; color: var(--rra-text); }
        .rra .rra-key { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--rra-line); border-radius: 6px; background: var(--rra-surface-2); }
        .rra .rra-key__status { --rra-dot: var(--rra-none); display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; color: var(--rra-text); }
        .rra .rra-key__status::before { content: ''; flex: none; width: 8px; height: 8px; border-radius: 999px; background: var(--rra-dot); box-shadow: 0 0 0 3px color-mix(in srgb, var(--rra-dot) 22%, transparent); }
        .rra .rra-key__status[data-state="ok"] { --rra-dot: var(--rra-ok); }
        .rra .rra-key__status[data-state="bad"] { --rra-dot: var(--rra-below); }
        .rra .rra-key__status[data-state="wait"] { --rra-dot: var(--rra-accent); }
        .rra .rra-key__label { margin-top: 4px; font-size: 11px; font-weight: 600; color: var(--rra-muted); }
        .rra .rra-key__input { display: block; width: 100%; min-width: 0; height: 32px; padding: 0 12px; border: 1px solid var(--rra-line); border-radius: 4px; background: var(--rra-surface); color: var(--rra-text); font-size: 12px; font-variant-numeric: tabular-nums; box-shadow: none; }
        .rra .rra-key__input::placeholder { color: var(--rra-muted); opacity: 1; }
        .rra .rra-key__input:hover { border-color: color-mix(in srgb, var(--rra-accent) 55%, transparent); }
        .rra .rra-key__input:focus-visible { border-color: var(--rra-accent); }
        .rra .rra-key__input[data-bad="1"] { border-color: var(--rra-below); }
        .rra .rra-key__actions { display: flex; flex-wrap: wrap; gap: 8px; }
        @media (pointer: coarse) { .rra .rra-key__input { font-size: 16px; } }
        .rra .rra-setting { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-top: 1px solid var(--rra-line); }
        .rra .rra-setting:first-child { padding-top: 0; border-top: 0; }
        .rra .rra-setting:last-child { padding-bottom: 0; }
        .rra .rra-setting__name { min-width: 0; font-size: 12.5px; font-weight: 600; color: var(--rra-text); cursor: pointer; }
        .rra .rra-switch { position: relative; flex: none; width: 34px; height: 20px; padding: 0; border: 0; border-radius: 999px; background: var(--rra-line); }
        .rra .rra-switch::after { content: ''; position: absolute; top: -6px; right: -6px; bottom: -6px; left: -6px; }
        .rra .rra-switch > span { position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: var(--rra-muted); transition: transform .15s ease; }
        .rra .rra-switch[aria-checked="true"] { background: var(--rra-primary); }
        .rra .rra-switch[aria-checked="true"] > span { transform: translateX(14px); background: #ffffff; }
        .rra .rra-panel__version { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12px; font-weight: 600; color: var(--rra-muted); }
        .rra .rra-chip { flex: none; padding: 0 4px; border: 1px solid color-mix(in srgb, var(--rra-accent) 55%, transparent); border-radius: 3px; color: var(--rra-accent-fg); font-size: 10.5px; font-weight: 600; line-height: 18px; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .rra .rra-keyuse { display: block; padding: 8px 0; }
        .rra .rra-keyuse__summary { display: flex; align-items: center; gap: 8px; min-height: 40px; border-radius: 4px; list-style: none; cursor: pointer; font-size: 13px; font-weight: 700; color: var(--rra-text); }
        .rra .rra-keyuse__summary::-webkit-details-marker { display: none; }
        .rra .rra-keyuse__summary .rra-icon { flex: none; color: var(--rra-muted); }
        .rra .rra-keyuse__summary:hover .rra-keyuse__chevron { color: var(--rra-accent-fg); }
        .rra .rra-keyuse__chevron { margin-left: auto; transition: transform .15s ease; }
        .rra .rra-keyuse[open] .rra-keyuse__chevron { transform: rotate(180deg); }
        .rra .rra-keyuse__notes { display: grid; gap: 8px; margin-top: 8px; padding: 12px; border-radius: 6px; background: var(--rra-sunken); }
        .rra .rra-keyuse__note { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 4px 12px; }
        .rra .rra-keyuse__term { font-size: 12px; font-weight: 600; color: var(--rra-text); }
        .rra .rra-keyuse__text { font-size: 11px; line-height: 1.45; color: var(--rra-muted); }
        @media (prefers-reduced-motion: reduce) { .rra *, .rra *::before, .rra *::after { transition: none !important; } }
    `;

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
    // - The bar's phone layout is a container query on its own width, so phone
    //   rotation reacts without a stylesheet rebuild.
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
            [data-txm-block] { pointer-events: none !important; opacity: .45 !important; cursor: not-allowed !important; filter: grayscale(1); }
            .txm-fa-bar[data-txm-mirror="1"] ~ ${sel('appHeaderWrapper')} > ${sel('topSection')}, .txm-fa-bar[data-txm-mirror="1"] ~ ${sel('appHeaderWrapper')} > ${sel('delimiter')}, .txm-fa-bar[data-txm-mirror="1"] ~ ${sel('appHeaderWrapper')} > ${sel('bottomSection')} { display: none !important; }
            .txm-fa-bar[data-txm-mirror="1"] ~ ${sel('appHeaderWrapper')} { margin: 0 !important; padding: 0 !important; border: 0 !important; min-height: 0 !important; }
            ${CREST_CSS}
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
            if (!document.getElementById('txm-fa-font')) {         // the Crest font, once; system-ui stands in until it loads
                const font = document.createElement('link');
                font.id = 'txm-fa-font';
                font.rel = 'stylesheet';
                font.href = FONT_URL;
                (document.head || document.documentElement).appendChild(font);
            }
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

    // Attack buttons

    // Button text as every check matches it: whitespace collapsed, lower case.
    const buttonLabels = buttons => buttons.map(b => b.textContent.replace(/\s+/g, ' ').trim().toLowerCase());

    function filterOutcomeButtons() {
        const selected = OUTCOME_LABELS[attackType - 1];
        qa(document, sel('dialogButtons')).forEach(box => {
            const buttons = qa(box, 'button'), labels = buttonLabels(buttons);
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
        const labels = buttonLabels(qa(box, 'button'));
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
        return el.matches(sel('emptySlot')) ? { empty: true } : { empty: false, name: weaponName(el) };
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
                out.push({ title: clip(title, MAX_NAME), desc: clip(desc, MAX_DESC) });   // plain data only - element refs go stale
            });
        });
        return { state: 'known', bonuses: out.slice(0, MAX_BONUSES) };
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

    // A weapon tile's tag is drawn by CSS from these attributes (Crest tag style); the avoid level reads "Avoid".
    function tagSlot(el, level, tag) {
        if (!el) return;
        if (!level) { delAttr(el, 'data-txm-warn'); delAttr(el, 'data-txm-label'); return; }
        setAttr(el, 'data-txm-warn', level);
        setAttr(el, 'data-txm-label', level === 'avoid' ? 'Avoid' : String(tag || '').replace(/^./, c => c.toUpperCase()));
    }

    // Separate attribute pair (and ::before, not ::after) so a slot can carry
    // a verdict tag and the disarm tag at the same time.
    function tagDisarm(el, on) {
        if (!el) return;
        if (!on) { delAttr(el, 'data-txm-disarm'); delAttr(el, 'data-txm-disarm-label'); return; }
        setAttr(el, 'data-txm-disarm', '1');
        setAttr(el, 'data-txm-disarm-label', 'Disarm');
    }

    // Advice levels differ by marker and icon as well as colour; screen readers hear the level word.
    const ADVICE_LEVEL = { avoid: ['warn', 'Avoid'], caution: ['info', 'Caution'], ok: ['check', 'Good'], unknown: ['', 'Unknown'] };

    function advChip(c) {
        const level = ADVICE_LEVEL[c.level] ? c.level : 'unknown';
        const [ic, word] = ADVICE_LEVEL[level];
        return `<li class="rra-adv" data-level="${level}"${c.desc ? ` title="${htmlEsc(c.desc)}"` : ''}><span class="rra-diamond" aria-hidden="true"></span>`
            + (ic ? icon(ic, 12, 'rra-adv__icon') : '')
            + `<span class="rra-adv__text"><span class="rra-vh">${word}: </span>${htmlEsc(c.text)}${c.desc ? `<span class="rra-vh">. ${htmlEsc(c.desc)}</span>` : ''}</span></li>`;
    }

    // known: an answer is in, so an empty list means this target has no bonus notes.
    function renderAdviceRow(chips, known) {
        const row = q(document, '.txm-fa-bar .txm-fa-advice');
        if (!row) return;                                    // bar not built yet - sig untouched
        const sig = (known ? 'k:' : '') + chips.map(c => `${c.level}|${c.text}|${c.desc || ''}`).join('~');
        if (sig === adviceSig) return;
        adviceSig = sig;
        row.innerHTML = chips.length ? chips.map(advChip).join('')
            : known ? '<li class="rra-adv rra-adv--none">No bonus notes for this target</li>' : '';
        setShown(row, chips.length > 0 || known);
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
            if (id === SLOT_TILE[slot]) setAttr(el, 'data-txm-sel', ''); else delAttr(el, 'data-txm-sel');   // the chosen slot's tile
        });
        def.forEach(el => tagSlot(el, null));
        // Request failures are reported once in the shared warning row.
        renderAdviceRow(chips, !!advice);
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
        bar.className = 'txm-fa-bar rra';
        bar.setAttribute('data-txm-mode', mode);
        bar.setAttribute('data-txm-mirror', '0');
        bar.innerHTML = `<section class="rra-bar${mode === 'auth' ? ' rra-bar--gated' : ''}" aria-label="Attack Advisor">`
            + `<div class="rra-brand">${skull(30)}<span class="rra-title"><span class="rra-eyebrow">Ruthless Reborn</span><span class="rra-name">Attack Advisor</span></span></div>`
            + html + '</section>';                          // set before insertion: one childList record
        mount.insertBefore(bar, head || mount.firstChild);
        const gear = q(bar, '.txm-fa-gear');
        const onGear = (e) => { e.preventDefault(); e.stopPropagation(); safe('settings', () => openSettings(gear)); };
        gear.addEventListener('mousedown', onGear);
        gear.addEventListener('click', onGear);
        return bar;
    }

    const settingsButton = () => `<button type="button" class="rra-btn rra-btn--icon rra-settings txm-fa-gear" aria-label="Open settings">${icon('settings', 16)}</button>`;

    // Slot and Outcome pop-up lists: one open at a time; an outside click, Esc or a pick closes it.
    function setPop(trigger, open) {
        const pop = document.getElementById(trigger.getAttribute('aria-controls'));
        if (pop) pop.hidden = !open;
        trigger.setAttribute('aria-expanded', String(open));
        const host = trigger.closest('.txm-fa-bar');
        if (open) setAttr(host, 'data-pop-open', ''); else delAttr(host, 'data-pop-open');
    }

    function closePops() { qa(document, '.txm-fa-bar .rra-trigger[aria-expanded="true"]').forEach(t => setPop(t, false)); }

    // The pickers are native radios: Slot behind a compact trigger, Outcome a segmented control on desktop and a
    // pop-up on phone. A pick runs exactly what the old <select>s ran.
    function buildBar(head, mount) {
        const slots = Object.entries(SLOT_NAMES);
        const slotRows = slots.map(([v, name]) => `<label class="rra-pop__row" data-slot="${v}"><input type="radio" name="txm-fa-slot" value="${v}"${Number(v) === slot ? ' checked' : ''}>`
            + `${icon(SLOT_ICON[v], 16, 'rra-pop__icon')}<span class="rra-pop__text"><span class="rra-pop__name"></span><span class="rra-pop__sub">${name}</span></span>${icon('check', 14, 'rra-pop__check')}</label>`).join('');
        const outRows = Object.entries(ATTACK_NAMES).map(([v, name]) => {
            const full = ATTACK_FULL[v];
            const text = full === name ? name : `<span class="rra-outcome__short" aria-hidden="true">${name}</span><span class="rra-outcome__full">${full}</span>`;
            return `<label class="rra-pop__row rra-outcome__opt"${full === name ? '' : ` title="${full}"`}><input type="radio" name="txm-fa-outcome" value="${v}"${Number(v) === attackType ? ' checked' : ''}>`
                + `${icon(ATTACK_ICON[v], 14, 'rra-pop__icon')}<span class="rra-pop__text"><span class="rra-pop__name">${text}</span></span>${icon('check', 14, 'rra-pop__check')}</label>`;
        }).join('');

        const bar = makeBar('full', `
            <dl class="rra-readouts" hidden>
                <div class="rra-cell" data-kind="status" hidden><dt class="rra-vh">Step</dt><dd class="rra-status">${icon('check', 12)}<span>Ready to start</span></dd></div>
                <div class="rra-cell" data-kind="turns" hidden><dt class="rra-label">Turns</dt><dd class="rra-value"><b></b><span class="rra-sub"></span></dd></div>
                <div class="rra-cell" data-kind="timer" hidden><dt class="rra-label">Time left</dt><dd class="rra-value"><b></b></dd></div>
                <div class="rra-cell" data-kind="chain" hidden><dt class="rra-label">Chain</dt><dd class="rra-value"><b></b><span class="rra-sub"><span class="rra-chaintime"></span>${icon('timer', 12, 'rra-low')}<span class="rra-vh rra-low">, chain timer running low</span></span></dd></div>
            </dl>
            <div class="rra-controls">
                <div class="rra-pick rra-slot" data-cur="${slot}">
                    <span class="rra-vh" id="txm-fa-slot-label">Slot</span>
                    <button type="button" class="rra-trigger rra-slot__trigger" aria-controls="txm-fa-slot-pop" aria-expanded="false" aria-labelledby="txm-fa-slot-label txm-fa-slot-value">
                        <span class="rra-trigger__lead" aria-hidden="true">${slots.map(([v]) => icon(SLOT_ICON[v], 16, 'rra-show rra-show--' + v)).join('')}</span>
                        <span class="rra-trigger__text"><span class="rra-trigger__over" aria-hidden="true">${slots.map(([v, name]) => `<span class="rra-show rra-show--${v}">${name}</span>`).join('')}</span><span class="rra-trigger__value" id="txm-fa-slot-value"></span></span>
                        ${icon('chevron', 14, 'rra-trigger__chev')}
                    </button>
                    <div class="rra-pop rra-slot__list" id="txm-fa-slot-pop" role="radiogroup" aria-labelledby="txm-fa-slot-label" hidden>${slotRows}</div>
                </div>
                <div class="rra-pick rra-outcome">
                    <span class="rra-vh" id="txm-fa-outcome-label">Outcome</span>
                    <button type="button" class="rra-trigger rra-outcome__trigger" aria-controls="txm-fa-outcome-pop" aria-expanded="false" aria-labelledby="txm-fa-outcome-label txm-fa-outcome-value">
                        <span class="rra-trigger__text"><span class="rra-trigger__over" aria-hidden="true">Outcome</span><span class="rra-trigger__value" id="txm-fa-outcome-value">${ATTACK_NAMES[attackType]}</span></span>
                        ${icon('chevron', 14, 'rra-trigger__chev')}
                    </button>
                    <div class="rra-pop rra-outcome__list" id="txm-fa-outcome-pop" role="radiogroup" aria-labelledby="txm-fa-outcome-label" hidden>${outRows}</div>
                </div>
                <button type="button" class="rra-btn rra-btn--primary rra-escape" disabled>${icon('escape', 14)}<span>Escape</span></button>
                ${settingsButton()}
            </div>
            <div class="rra-band">
                <div class="rra-banner txm-fa-hold" hidden><span class="rra-banner__icon"></span><p class="rra-banner__msg" role="status"></p></div>
                <div class="rra-row">
                    <div class="rra-nav" hidden><a class="rra-back" href="#">${icon('back', 14)}<span></span></a></div>
                    <ul class="rra-advice-list txm-fa-advice" aria-label="Bonus advice" hidden></ul>
                    <p class="rra-notice txm-fa-warn" hidden>${icon('warn', 12)}<span></span></p>
                    <p class="rra-limits txm-fa-limits" hidden></p>
                </div>
            </div>
        `, head, mount);

        bar.addEventListener('click', e => {
            const trigger = e.target.closest && e.target.closest('.rra-trigger');
            if (!trigger) return;
            const open = trigger.getAttribute('aria-expanded') !== 'true';
            closePops();
            if (!open) return;
            setPop(trigger, true);
            const pop = document.getElementById(trigger.getAttribute('aria-controls'));
            const first = q(pop, 'input:checked') || q(pop, 'input');
            if (first) first.focus({ preventScroll: true });
        });

        bar.addEventListener('change', e => {
            const r = e.target;
            if (r.name === 'txm-fa-slot') {
                slot = Number(r.value) || SLOT.MELEE;
                storeSet(STORAGE_SLOT, String(slot));
                refreshStyle();
            } else if (r.name === 'txm-fa-outcome') {
                attackType = Number(r.value) || ATTACK.MUG;
                storeSet(STORAGE_TYPE, String(attackType));
            } else return;
            const trigger = q(r.closest('.rra-pick'), '.rra-trigger');
            if (trigger && trigger.getAttribute('aria-expanded') === 'true') { setPop(trigger, false); trigger.focus({ preventScroll: true }); }
            schedule();                                      // repaints the triggers, the chosen tile and the outcome filter
        });

        // Proxy, never move: reparenting a React-managed node breaks its unmount
        // and takes the whole attack app down. Resolved at click time.
        q(bar, '.rra-escape').addEventListener('click', () => {
            const btn = q(document, `${sel('appHeaderWrapper')} button[aria-label="escape"]`);
            if (btn && !btn.disabled) btn.click();
        });

        barSig = '';                                         // fresh DOM - force a full repaint
        limitsSig = '';                                      // ditto - the limits/warn rows were rebuilt empty
        adviceSig = '';
        return bar;
    }

    const GATE_ICON = { nokey: 'key', denied: 'lock', verifying: 'timer', unavailable: 'warn' };

    function authState() {
        if (!validKey(apiKey())) return 'nokey';
        if (Session.state === 'denied') return 'denied';
        return Session.nextTryAt > nowMs() ? 'unavailable' : 'verifying';
    }

    function authStatusText() {
        const state = authState();
        if (state === 'nokey') return 'Add your Torn API key to start';
        if (state === 'denied') return 'Access restricted to Ruthless Reborn members';
        const hold = Hold.state === 'warn' ? notEnforcedText() : Hold.state === 'hold' ? HOLD_TEXT
            : Hold.remembered ? 'Start Fight blocked: ' + Hold.remembered : '';
        return (state === 'unavailable' ? 'Authorization unavailable' : 'Verifying access…') + (hold ? ' · ' + hold : '');
    }

    function buildAuthBar(head, mount) {
        const bar = makeBar('auth', `<div class="rra-controls">${settingsButton()}</div>`
            + '<div class="rra-band"><p class="rra-gate" role="status"><span class="rra-gate__icon"></span><span class="txm-fa-auth-state"></span></p></div>', head, mount);
        renderAuthState(bar);
        return bar;
    }

    // The gated bar's icon and message, redrawn every second, so written only on change.
    function renderAuthState(bar) {
        const state = authState(), shell = q(bar, '.rra-bar');
        if (shell && shell.getAttribute('data-access') !== state) {
            shell.setAttribute('data-access', state);
            q(shell, '.rra-gate__icon').innerHTML = icon(GATE_ICON[state], 16);
        }
        setText(q(bar, '.txm-fa-auth-state'), authStatusText());
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
        else renderAuthState(bar);
        holdBarSpace(bar, head);
    }

    // The full bar replaces Torn's header, so it is taller than the "Verifying access…" bar that sits above
    // that header. The full bar's last height (with any header still showing) is remembered, and the
    // verifying bar is padded to match, so the page does not jump down once access is confirmed.
    // shortcut: the remembered height is the last attack page's, so a first-ever visit or a wrap change can still move it slightly.
    function holdBarSpace(bar, head) {
        const cs = head && head.isConnected ? getComputedStyle(head) : null;   // Torn's header margin counts too
        const headH = cs ? head.offsetHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom) : 0;
        if (bar.getAttribute('data-txm-mode') === 'full') {
            const total = String(bar.offsetHeight + headH);
            if (total !== '0' && storeGet(STORAGE_BAR_HEIGHT) !== total) storeSet(STORAGE_BAR_HEIGHT, total);
            return;
        }
        const want = Math.max(0, Number(storeGet(STORAGE_BAR_HEIGHT)) - headH);
        const css = want ? want + 'px' : '';
        if (bar.style.minHeight !== css) bar.style.minHeight = css;
    }

    // Own weapon names by slot, '' where Torn shows the slot empty.
    function slotWeapons() {
        const { own } = weaponSlotBuckets();
        return Object.keys(SLOT_NAMES).map(v => {
            const el = own[SLOT_TILE[v]];
            return el && !el.matches(sel('emptySlot')) ? weaponName(el) || '' : '';
        });
    }

    function updateBar(bar) {
        bar = bar || q(document, '.txm-fa-bar');
        if (!bar || !bar.isConnected || bar.getAttribute('data-txm-mode') !== 'full') return;

        const h = readHeader();

        // Against a ranked-war opponent the back link retargets to the enemy
        // faction; in the signature so the link repaints when it changes.
        const tgt = warTarget();
        const weapons = slotWeapons();
        // "Ready to start" fills the empty readout place while Start Fight is on screen and nothing holds it.
        const ready = !!h && !h.turns && !h.timer && !Hold.state && !Hold.unlocked
            && buttonLabels(qa(document, `${sel('dialogButtons')} button`)).some(t => START_LABELS.includes(t));

        const sig = JSON.stringify([h && [h.turns, h.timer, h.count, h.time, h.low, h.escape ? h.escape.disabled : null, h.backHref, h.backText, h.mirror],
            tgt ? tgt.oppId : '', weapons, slot, attackType, ready]);
        if (sig === barSig) return;                          // hot path: zero DOM writes
        barSig = sig;

        setAttr(bar, 'data-txm-mirror', h && h.mirror ? '1' : '0');

        // Readout cells show only with a value. The timers tick every second - setLiveText keeps
        // those writes off the observer (characterData, not childList).
        const cell = kind => q(bar, `.rra-cell[data-kind="${kind}"]`);
        const fill = (kind, value, sub) => {
            const c = cell(kind);
            setShown(c, !!value);
            if (!value) return;
            setLiveText(q(c, 'b'), value);
            if (sub != null) setLiveText(q(c, kind === 'chain' ? '.rra-chaintime' : '.rra-sub'), sub);
        };
        const turns = h && /^(\d+)\s*\/\s*(\d+)$/.exec(h.turns);       // "3/25" reads "3 of 25"
        fill('turns', h ? (turns ? turns[1] : h.turns) : '', turns ? 'of ' + turns[2] : '');
        fill('timer', h ? h.timer : '');
        fill('chain', h ? h.count : '', h ? h.time : '');
        setAttr(cell('chain'), 'data-low', h && h.low ? '1' : '0');
        setShown(cell('status'), ready);
        const shown = qa(bar, '.rra-cell').some(c => !c.hasAttribute('hidden'));
        setShown(q(bar, '.rra-readouts'), shown);
        setAttr(q(bar, '.rra-bar'), 'data-readouts', shown ? 'some' : 'none');

        const escape = q(bar, '.rra-escape'), off = !(h && h.escape) || h.escape.disabled;
        if (escape.disabled !== off) escape.disabled = off;

        const back = q(bar, '.rra-back');
        setShown(q(bar, '.rra-nav'), !!(h && h.backHref));
        if (h && h.backHref) {
            if (tgt) { setAttr(back, 'href', FACTION_URL(tgt.oppId)); setText(q(back, 'span'), 'Back to faction'); } else { setAttr(back, 'href', h.backHref); setText(q(back, 'span'), h.backText); }
        }

        // The pickers follow the script's own slot and outcome, with the real weapon names.
        const slotBox = q(bar, '.rra-slot');
        qa(slotBox, '.rra-pop__row').forEach(row => {
            const v = Number(row.getAttribute('data-slot')), name = weapons[v - 1];
            setText(q(row, '.rra-pop__name'), name || 'No weapon');
            setAttr(row, 'data-empty', name ? '0' : '1');
            const input = q(row, 'input');
            if (input.checked !== (v === slot)) input.checked = v === slot;
        });
        setAttr(slotBox, 'data-cur', String(slot));
        setAttr(slotBox, 'data-empty', weapons[slot - 1] ? '0' : '1');
        setText(q(slotBox, '.rra-trigger__value'), weapons[slot - 1] || 'No weapon');
        const outBox = q(bar, '.rra-outcome');
        qa(outBox, 'input').forEach(input => { const on = Number(input.value) === attackType; if (input.checked !== on) input.checked = on; });
        setText(q(outBox, '.rra-trigger__value'), ATTACK_NAMES[attackType]);
    }

    // War data comes from Torn with the member's own key, so war targets are known even while the RR
    // server is unreachable. localStorage shares it between tabs and attack pages (every attack is one).
    const WAR_INIT = {
        state: 'idle',                                      // idle | nowar | war | error
        factionId: null,                                    // our faction, from the session or the saved record
        ranked: null,
        roster: null,                                       // Set of enemy user ids
        rosterId: null,
        startAt: 0,                                         // ms; ranked war start time
        inFlight: false,
        retryAt: 0,
        failedAt: 0,                                        // last failed Torn lookup, 0 once one succeeds
        errorCode: null                                     // Torn's error code from that failure, if any
    };
    const War = { ...WAR_INIT, gen: 0 };                    // gen: bumped on key change; stale responses are discarded

    const LIMITS_INIT = {
        payload: null,
        at: 0,                                              // when the figure was fetched
        nextAt: 0,                                          // when to poll again
        validUntil: 0,                                      // the figure may allow a hit until then
        dataAt: 0,                                          // when ZZCraft made the figure (its lastUpdated), on nowMs()
        failed: false,                                      // the last fetch failed; the figure is kept (hits only rise)
        inFlight: false,
        authFailed: false,                                  // ZZCraft refused the key: retried only after REJECTED_RETRY
        rejects: 0                                          // consecutive resource 401s; 3 strikes marks authFailed
    };
    const Limits = { ...LIMITS_INIT, gen: 0 };

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
        Object.assign(War, WAR_INIT, { gen: War.gen + 1 });
        Object.assign(Limits, LIMITS_INIT, { gen: Limits.gen + 1 });
        WarRoom.reset();
    }

    // Records stored before the PC clock was set back carry times from the old setting.
    function afterClockSetBack() {
        secureDelete(SESSION_STORAGE_KEY).catch(() => {});
        secureDelete(LIMITS_STORAGE_KEY).catch(() => {});
        storeDel(STORAGE_WAR);
        Verdict.forget();
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
        // A session, saved or fresh, is used only if it is whole and its times fit a live session.
        accept(data) {
            const now = nowMs();
            if (!data || typeof data.token !== 'string' || !data.token || data.token.length > 8192 ||
                !Number.isFinite(data.expiresAt) || data.expiresAt <= now + AUTH_EXPIRY_SKEW_MS || data.expiresAt > now + AUTH_MAX_TTL_MS ||
                !Number.isFinite(data.renewAt) || data.renewAt <= now || data.renewAt >= data.expiresAt ||
                !Number.isSafeInteger(data.playerId) || data.playerId < 1 || !Number.isSafeInteger(data.factionId) || data.factionId < 1) return false;
            this.token = data.token; this.expiresAt = data.expiresAt; this.renewAt = data.renewAt;
            this.factionId = data.factionId; playerId = data.playerId;
            this.state = 'ok'; this.nextTryAt = 0;
            this.scheduleRefresh(); onSessionChange();
            return true;
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
            if (keyChanging) return;
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
                if (!fresh && saved && saved.keyHash === keyHash && saved.version === VERSION && this.accept(saved)) return;
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
                    const record = { token: data.token, expiresAt, renewAt: Math.min(nowMs() + AUTH_REFRESH_MS, expiresAt - AUTH_EXPIRY_SKEW_MS),
                        playerId: data.playerId, factionId: data.factionId, keyHash, version: VERSION };
                    if (!this.accept(record)) throw new Error('Invalid authorization response');
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
                if (saved && saved.keyHash === keyHash && zzToken(saved.token)) { this.refused = false; return (this.token = saved.token); }
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

    // The war and limits parts of a check, shared by attack pages and the faction-page warm-up so both ask the same question.
    function warInput() {
        return { state: War.state, ranked: War.ranked, factionId: Session.factionId || War.factionId,
            roster: War.roster ? { oppId: War.rosterId, ids: Array.from(War.roster).sort((a, b) => a - b) } : null };
    }
    const limitsInput = p => p ? { currentLimit: p.currentLimit, member: p.member, warStart: p.warStart, updatedAt: p.updatedAt } : null;

    function readAnalysisInput() {
        const { own, def } = weaponSlotBuckets();
        const helmet = readHelmet();
        if (helmet.state === 'known') lastHelmet = helmet.helmet;
        else if (helmet.state === 'bare') lastHelmet = '';
        const bonuses = readDefenderBonuses(def);
        if (bonuses.state === 'known') lastBonuses = bonuses.bonuses;
        const temp = readOwnTemp(own.weapon_temp);
        return {
            helmet: clip(lastHelmet, MAX_NAME), bonuses: lastBonuses || [],
            temp: temp ? { empty: temp.empty, name: clip(temp.name, MAX_NAME) || null } : null,
            // Required by the deployed API; outcome presentation is now entirely local.
            labels: [], attackType: 1, defenderId: defenderId() ? Number(defenderId()) : null,
            war: warInput(), limits: limitsInput(Limits.payload)
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
        const war = warInput(), opp = War.ranked && War.ranked.factions.find(f => f.id !== war.factionId);
        if (!Session.pass() || !opp || !war.roster || war.roster.oppId !== opp.id || !war.roster.ids.length || !Limits.payload || !(nowMs() < Limits.validUntil)) return;
        const input = { helmet: null, bonuses: [], temp: null, labels: [], attackType: 1, defenderId: war.roster.ids[0], war, limits: limitsInput(Limits.payload) };
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
        gen: 0,                                             // bumped by forget(): a load already reading cannot bring the answer back
        load() {
            const hash = authKeyHash, gen = this.gen;
            secureGet(VERDICT_STORAGE_KEY).then(text => {
                const rec = JSON.parse(text || 'null');
                if (!rec || rec.keyHash !== hash || hash !== authKeyHash || !['allowed', 'blocked'].includes(rec.decision) ||
                    typeof rec.war !== 'string' || typeof rec.limits !== 'string' || !Number.isFinite(rec.validUntil) || gen !== this.gen) return;
                // An answer valid further ahead than any figure can be was stored before the PC clock was set back.
                const validUntil = fromStored(rec.validUntil);
                if (validUntil > nowMs() + LIMITS_AHEAD) return;
                if (!this.rec) { this.rec = { ...rec, validUntil }; schedule(); }
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
        forget() { this.gen++; this.rec = null; secureDelete(VERDICT_STORAGE_KEY).catch(() => {}); },
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
        // A kept decision applies only within its session and page, and to the same context.
        inScope(x, context) { return !!x && Session.pass() && x.sessionGen === Session.gen && x.search === location.search && x.context === context; },
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
            if (!this.inScope(this.block, JSON.stringify([input.defenderId, input.war])) || ServerTime.reached(this.block.until)) {
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
            if (!c || !this.inScope(c, clearContext(input)) || !((input.limits && input.limits.updatedAt) >= c.updatedAt || c.updatedAt == null)) return false;
            return nowMs() < c.until || (this.pending && nowMs() < c.until + HOLD_GRACE);
        },
        // Why the server could not decide this defender, war and limits, or ''.
        undecided(input = analysisInput()) {
            const u = this.unknown;
            if (!u || !this.inScope(u, JSON.stringify([input.defenderId, input.war, input.limits]))) return '';
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
                if (!result || !result.advice || !result.war || !result.limits || !Number.isFinite(result.revalidateAt) ||
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
        return war && war.target ? { oppId: war.oppId } : null;
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
    const Hold = { state: '', cause: '', unlocked: false, context: '', since: 0, failure: '', remembered: '' };
    const HOLD_TEXT = 'Checking war limits. Start Fight is paused.';
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
            const labels = buttonLabels(buttons);
            const other = t => OUTCOME_LABELS.includes(t) || t === 'continue';
            buttons.forEach((b, i) => {
                // While paused, a lone button that is not an outcome or Continue is Start Fight in any wording.
                const start = START_LABELS.includes(labels[i]) || (reason && buttons.length === 1 && !other(labels[i]));
                if (reason && start) setAttr(b, 'data-txm-block', reason); else delAttr(b, 'data-txm-block');
            });
            if (reason && buttons.length > 1 && !labels.some(t => START_LABELS.includes(t) || other(t))) unlocked = true;
        });
        Hold.unlocked = unlocked;
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
        if (keyChanging || !validKey(key) || Session.state === 'denied' || !factionId || War.inFlight || nowMs() < War.retryAt) return;
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
                !Number.isFinite(rec.validUntil) || !Number.isFinite(rec.nextAt) || !Number.isFinite(rec.at) ||
                // Times further ahead than a figure can be were stored before the PC clock was set back.
                fromStored(rec.validUntil) > nowMs() + LIMITS_AHEAD || fromStored(rec.at) > nowMs()) return;
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
                // A re-login ZZCraft refused keeps its refusal and its wait, so the member is told to fix the key.
                if (WarRoom.refused) { lapse(REJECTED_RETRY); return; }
                Limits.rejects++;
                Limits.authFailed = Limits.rejects >= 3;
                WarRoom.reset();
                lapse(Limits.authFailed ? REJECTED_RETRY : RETRY_NET);
                return;
            }
            if (!res.ok) { lapse(retryDelay(res, RETRY_QUICK)); return; }
            Limits.rejects = 0;
            Limits.authFailed = false;

            const body = JSON.parse(res.text);
            const payload = sanitizeLimitsPayload(body, ownPlayerId);
            if (!payload) throw new Error('invalid limits response');
            // Honour the service's own nextUpdate, clamped so a bad value cannot spin us. It is
            // ZZCraft's time, so measure the wait with ZZCraft's clock from the same reply.
            const nx = parseZzTime(payload.nextUpdate);
            const stamp = replyTime(res.headers), from = Number.isFinite(stamp) ? stamp : ServerTime.estimate();
            const wait = nx !== null && from != null ? nx - from : POLL_MIN;
            // The figure's age is ZZCraft's lastUpdated read against the same reply's clock.
            const made = parseZzTime(body.lastUpdated);
            const dataAt = made !== null && from != null ? nowMs() - Math.max(0, from - made) : 0;
            Object.assign(Limits, { payload, at: nowMs(), dataAt, failed: false, nextAt: nowMs() + Math.max(POLL_MIN, Math.min(POLL_MAX, wait)) });
            Limits.validUntil = Limits.nextAt + LIMITS_KEEP;
            secureSet(LIMITS_STORAGE_KEY, JSON.stringify({ playerId: ownPlayerId, keyHash: authKeyHash, payload, at: toStored(Limits.at),
                dataAt: dataAt ? toStored(dataAt) : 0, nextAt: toStored(Limits.nextAt), validUntil: toStored(Limits.validUntil) })).catch(() => {});
        } catch (e) {
            if (gen === Limits.gen) lapse(RETRY_QUICK);
        } finally { stepEnd('ZZCraft'); if (gen === Limits.gen) { Limits.inFlight = false; schedule(); } }
    }

    // War limits in Crest form. Every figure is the RR server's own (view.parts and view.stats, the old LIMITS
    // row): "N of M hits left" leads, M being the cap's maximum ("Number of Hits") and N that less MY HITS;
    // respect and any other figure follow quietly, then ZZCraft's data age.
    function limitsHtml(view) {
        const parts = new Map(view.parts), stats = new Map(view.stats.map(s => [s.label, s]));
        const mine = stats.get('MY HITS'), used = mine && /^\d+$/.test(mine.value) ? Number(mine.value) : null;
        const range = parts.get('Number of Hits') || '', noHits = parts.get('') === 'No hits allowed';
        let m, min = null, max = null;                      // the server writes the range as "1-3", "≥1" or "≤3"
        if ((m = /^(\d+)-(\d+)$/.exec(range))) { min = Number(m[1]); max = Number(m[2]); }
        else if ((m = /^≥(\d+)$/.exec(range))) min = Number(m[1]);
        else if ((m = /^≤(\d+)$/.exec(range))) max = Number(m[1]);
        const b = (value, ok) => `<b${ok ? ` data-ok="${htmlEsc(ok)}"` : ''}>${htmlEsc(value)}</b>`;
        const group = html => `<span class="rra-lim">${html}</span>`;
        const word = label => label === 'UNAUTHORIZED' ? 'Unauthorized hits' : label.charAt(0).toUpperCase() + label.slice(1).toLowerCase();
        const out = [];
        if (noHits) out.push(`<span class="rra-left rra-left--none">${icon('lock', 12)}<span><span class="rra-vh">War limits: </span>No hits allowed</span></span>`);
        else if (max !== null && used !== null) {
            const left = Math.max(0, max - used);
            out.push(`<span class="rra-left${left ? '' : ' rra-left--none'}">${icon(left ? 'check' : 'lock', 12)}<span><span class="rra-vh">War limits: </span><b>${left}</b> of <b>${max}</b> ${max === 1 ? 'hit' : 'hits'} left</span></span>`);
        } else if (max !== null) out.push(`<span class="rra-left rra-left--quiet"><span><span class="rra-vh">War limits: </span><b>?</b> of <b>${max}</b> hits used</span></span>`);
        else if (!view.parts.length) out.push('<span class="rra-left rra-left--quiet">No war limits set</span>');
        if (min !== null) out.push(group(`Min hits ${b(min, used !== null && used < min ? '0' : '')}`));
        if (mine && (noHits || max === null)) out.push(group(`Your hits ${b(mine.value, mine.ok)}`));
        const avg = stats.get('AVG RESPECT'), goal = parts.get('Average Respect');
        if (avg || goal) out.push(group((avg ? `Respect ${b(avg.value, avg.ok)}${goal ? ', min ' : ''}` : 'Min respect ') + (goal ? b(goal.replace(/^≥/, '')) : '')));
        const done = ['Number of Hits', 'Average Respect', '', 'MY HITS', 'AVG RESPECT'];
        view.parts.forEach(([label, value]) => { if (!done.includes(label)) out.push(group(`${htmlEsc(word(label))} ${b(value)}`)); });
        view.stats.forEach(s => { if (!done.includes(s.label)) out.push(group(`${htmlEsc(word(s.label))} ${b(s.value, s.ok)}`)); });
        return out.join('') + '<span class="rra-age txm-fa-age"></span>';
    }

    // The banner wording while Start Fight is blocked: the agreed cap message, else the server's reason.
    function blockedText(reason, pendingText) {
        if (Hold.state === 'pending') return pendingText || 'The war has not started yet. Start Fight has been disabled until then.';
        const cap = /^At hit cap \d+\/(\d+)/.exec(reason || '');
        if (cap) return `War limit reached: you have used all ${cap[1]} hit${cap[1] === '1' ? '' : 's'}. Start Fight is blocked.`;
        return (reason ? reason + '. ' : 'War limit reached. ') + 'Start Fight is blocked.';
    }

    // Row 2 follows Start Fight: a gold banner while it is paused, red while it is blocked, orange while the
    // limits cannot be enforced. The old warning row's other messages stay as a quiet notice in the band.
    function renderLimits() {
        guardStartFight();                                  // first, and whether or not the bar is drawn
        const bar = q(document, '.txm-fa-bar');
        if (!bar) return;
        const hold = Hold.unlocked ? 'Start Fight could not be found to pause it. Do not attack until the war limits show.' : Hold.state === 'hold' ? HOLD_TEXT : '';
        const row = q(bar, '.txm-fa-limits'), notice = q(bar, '.txm-fa-warn'), banner = q(bar, '.txm-fa-hold');
        const result = Analysis.display('limits');
        const view = result && result.limits;
        const unavailable = !!(view && view.visible && !Limits.payload);
        const analysisFailed = Analysis.nextTryAt > 0 || (!!Analysis.rejected && Analysis.rejected === Analysis.observed);
        const tornNote = War.failedAt ? tornFailure() + ': war status may be out of date' : '';
        const signature = JSON.stringify([view, unavailable, Limits.failed, Limits.inFlight, analysisFailed, hold, Hold.state, Hold.cause, Hold.remembered, tornNote]);
        if (row && signature !== limitsSig) {
            limitsSig = signature;
            const shown = !!(view && view.visible && !unavailable);
            setShown(row, shown);
            if (shown) {
                const html = limitsHtml(view);
                if (row.__txmHtml !== html) { row.__txmHtml = html; row.innerHTML = html; }
            }
            // The same warnings, in the same order, as before; "covered" marks the ones a banner already says.
            let main = '', covered = '';
            if (Hold.state === 'warn') { main = notEnforcedText(); covered = 'warn'; }
            else if (!result && Hold.remembered) { main = 'Warning: ' + Hold.remembered; covered = 'blocked'; }
            else if (!result) main = analysisFailed ? 'Advice and war checks unavailable' : '';
            else if (view.pending) { main = 'The war' + (result.war.oppName ? ' with ' + result.war.oppName : '') + ' starts on ' + warStartText() + '. Start Fight has been disabled until then.'; covered = 'blocked'; }
            // No figure to show: say so once a fetch has failed, not while the first one is still running.
            else if (unavailable) main = Limits.failed && !Limits.inFlight ? 'War limits unavailable. Retrying…' : '';
            else if (view.reason) { main = 'Warning: ' + view.reason; covered = 'blocked'; }
            // A failed Torn lookup is never silent, even while a known block holds or the target is allowed.
            const torn = tornNote && !(Hold.state === 'warn' && Hold.cause.startsWith('Torn')) ? tornNote : '';
            const kind = hold ? 'hold' : Hold.state === 'warn' ? 'warn' : Hold.state === 'limit' || Hold.state === 'pending' ? 'blocked' : '';
            const message = kind === 'hold' ? hold : kind === 'warn' ? main
                : kind === 'blocked' ? blockedText((view && view.reason) || Hold.remembered, view && view.pending ? main : '') : '';
            const quiet = [covered === kind ? '' : main, torn].filter(Boolean).join(' · ');
            setShown(banner, !!kind);
            if (kind && banner.getAttribute('data-kind') !== kind) {
                banner.setAttribute('data-kind', kind);
                q(banner, '.rra-banner__icon').innerHTML = icon(kind === 'hold' ? 'timer' : kind === 'warn' ? 'warn' : 'lock', 16);
                q(banner, '.rra-banner__msg').setAttribute('role', kind === 'hold' ? 'status' : 'alert');
            }
            if (kind) setLiveText(q(banner, '.rra-banner__msg'), message);
            const band = q(bar, '.rra-band');
            if (kind) setAttr(band, 'data-alert', kind); else delAttr(band, 'data-alert');
            const home = kind ? banner : q(bar, '.rra-row');   // the limits sit in the banner while it shows
            if (home && row.parentNode !== home) home.appendChild(row);
            setShown(notice, !!quiet); setLiveText(q(notice, 'span'), quiet);
        }
        const age = q(row, '.txm-fa-age');
        // ZZCraft's own data age (RR-13), amber once the figure is overdue or the last fetch failed.
        setLiveText(age, !Limits.payload ? 'no data' : Limits.dataAt ? 'data ' + Math.max(0, Math.round((nowMs() - Limits.dataAt) / 1000)) + 's old' : 'data age unknown');
        setAttr(age, 'data-stale', !Limits.payload || !Limits.dataAt || Limits.failed || nowMs() >= Limits.validUntil ? '1' : '0');
    }

    // Settings panel (structure derived from Smart Stock Vault's settings cog)

    async function applyApiKey(v) {
        if (keyChanging) throw new Error('API key change already in progress');
        keyChanging = true;
        try {
            Session.reset();
            Analysis.reset();
            await secureDelete(SESSION_STORAGE_KEY);
            await saveApiKey(v);
        } finally { keyChanging = false; }
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

    // The right-side panel: Access, the four switches, the version and the key notes. Controls only.
    function openSettings(trigger) {
        const existing = document.getElementById('txm-fa-settings');
        if (existing) { q(existing, '.txm-fa-set-input')?.focus(); return; }
        settingsTrigger = trigger || document.activeElement;
        closePops();

        const FEATURES = [
            ['advisor', 'Bonus advisor'],
            ['buttons', 'Move attack buttons'],
            ['outcome', 'Outcome filter'],
            ['loglinks', 'Log profile links']
        ];
        const KEY_NOTES = [
            ['Storage', 'Your key stays on this device. The RR server keeps only a one-way fingerprint of it, for at most 4 minutes, and never stores or logs the key itself.'],
            ['Sharing', "Sent to the RR server (to confirm you're in the faction), to ZZCraft (to log in for war limits), and to Torn's official API (war and roster lookups)."],
            ['Purpose', 'Ruthless Reborn faction war tooling: attack advice and war hit limits.'],
            ['Key storage', "Your userscript manager's storage, or TornPDA's storage."],
            ['Access level', 'Public Access key only.']
        ];

        const overlay = document.createElement('div');
        overlay.id = 'txm-fa-settings';
        overlay.className = 'rra rra-overlay';
        overlay.innerHTML = `
            <section class="rra-panel" role="dialog" aria-modal="true" aria-labelledby="txm-fa-settings-title">
                <header class="rra-panel__head">
                    <div class="rra-panel__crest">${skull(32)}<span class="rra-panel__titles"><span class="rra-panel__eyebrow">Ruthless Reborn</span><h2 class="rra-panel__title" id="txm-fa-settings-title">Attack Advisor settings</h2></span></div>
                    <button type="button" class="rra-btn rra-btn--icon txm-fa-set-close" aria-label="Close settings">${icon('close', 16)}</button>
                </header>
                <div class="rra-panel__body">
                    <section class="rra-panel__section" aria-labelledby="txm-fa-set-access">
                        <h3 class="rra-panel__heading" id="txm-fa-set-access">Access</h3>
                        <div class="rra-key">
                            <p class="rra-key__status txm-fa-set-status" id="txm-fa-set-status" role="status">No API key set</p>
                            <label class="rra-key__label" for="txm-fa-set-key">Torn API key</label>
                            <input type="password" class="rra-key__input txm-fa-set-input" id="txm-fa-set-key" placeholder="Public Access key"
                                   autocomplete="off" spellcheck="false" aria-describedby="txm-fa-set-status"
                                   title="16 or 50 alphanumeric characters">
                            <div class="rra-key__actions">
                                <button type="button" class="rra-btn rra-btn--primary" data-act="save">${icon('check', 14)}Save key</button>
                                <button type="button" class="rra-btn rra-btn--ghost" data-act="remove">Remove key</button>
                            </div>
                        </div>
                    </section>
                    <section class="rra-panel__section" aria-labelledby="txm-fa-set-features">
                        <h3 class="rra-panel__heading" id="txm-fa-set-features">Attack Advisor</h3>
                        <ul class="rra-settings">${FEATURES.map(([k, name]) => `
                            <li class="rra-setting"><label class="rra-setting__name" for="txm-fa-set-${k}">${name}</label><button type="button" class="rra-switch" id="txm-fa-set-${k}" role="switch" aria-checked="false" data-setting="${k}"><span aria-hidden="true"></span></button></li>`).join('')}
                        </ul>
                    </section>
                    <p class="rra-panel__section rra-panel__version"><span>Attack Advisor</span><span class="rra-chip">v${VERSION}</span></p>
                    <details class="rra-panel__section rra-keyuse">
                        <summary class="rra-keyuse__summary">${icon('key', 16)}<span>How your API key is used</span>${icon('chevron', 16, 'rra-keyuse__chevron')}</summary>
                        <dl class="rra-keyuse__notes">${KEY_NOTES.map(([term, text]) => `<div class="rra-keyuse__note"><dt class="rra-keyuse__term">${term}</dt><dd class="rra-keyuse__text">${htmlEsc(text)}</dd></div>`).join('')}</dl>
                    </details>
                </div>
            </section>
        `;

        const input = q(overlay, '.txm-fa-set-input');
        input.value = apiKey();                             // property write - never interpolated into HTML

        const status = q(overlay, '.txm-fa-set-status');
        const setStatus = (text, state) => { status.textContent = text; setAttr(status, 'data-state', state || ''); };
        if (validKey(apiKey())) setStatus(Session.pass() ? 'Valid and authorised' : Session.state === 'denied' ? 'Access restricted to Ruthless Reborn members' : 'API key configured', Session.state === 'denied' ? 'bad' : 'ok');

        input.addEventListener('input', () => delAttr(input, 'data-bad'));

        const doSave = async () => {
            if (keyChanging) return;                         // the save already running reports its own result
            const v = input.value.trim();
            if (v && !validKey(v)) {                         // reject typos before transmitting anything
                setAttr(input, 'data-bad', '1');
                setStatus('Keys are 16 or 50 alphanumeric characters', 'bad');
                return;
            }
            delAttr(input, 'data-bad');
            setStatus('Saving…', 'wait');
            try { await applyApiKey(v); setStatus(v ? 'Key saved' : 'No API key set', v ? 'ok' : ''); } catch (e) { setAttr(input, 'data-bad', '1'); setStatus('Protected storage unavailable', 'bad'); }
        };

        overlay.addEventListener('click', (e) => {
            const btn = e.target.closest && e.target.closest('[data-act]');
            const act = btn && btn.getAttribute('data-act');
            if (act === 'save') void doSave();
            else if (act === 'remove' && !keyChanging) {
                input.value = '';
                delAttr(input, 'data-bad');
                setStatus('Removing…', 'wait');
                void applyApiKey('')
                    .then(() => setStatus('Key removed', ''))
                    .catch(() => setStatus('Protected storage unavailable', 'bad'));
            }
        });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void doSave(); });

        // Feature switches - applied and persisted immediately, no save step.
        qa(overlay, '[data-setting]').forEach(sw => {
            const k = sw.getAttribute('data-setting');
            sw.setAttribute('aria-checked', String(!!settings[k]));
            sw.addEventListener('click', () => {
                settings[k] = sw.getAttribute('aria-checked') !== 'true';
                sw.setAttribute('aria-checked', String(settings[k]));
                saveSettings();
                refreshStyle();                              // styleKey carries the buttons toggle
                schedule();
            });
        });

        q(overlay, '.txm-fa-set-close').addEventListener('click', closeSettings);
        // Close only when the CLICK began on the backdrop - a text-selection
        // drag from the key input that ends outside the panel must not close it.
        let downOnOverlay = false;
        overlay.addEventListener('mousedown', (e) => { downOnOverlay = e.target === overlay; });
        overlay.addEventListener('click', (e) => { if (e.target === overlay && downOnOverlay) closeSettings(); });
        escClose = (e) => { if (e.key === 'Escape') closeSettings(); };
        document.addEventListener('keydown', escClose);

        document.body.appendChild(overlay);
        input.focus();
    }

    function promptForApiKey() {
        if (setupPrompted || validKey(apiKey())) return;
        setupPrompted = true;
        openSettings(q(document, '.txm-fa-gear'));
    }

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

    // Init

    let wasAuthorized = false;

    // A lapsed session removes the protected presentation. War data, limits and the ZZCraft login
    // outlive it: only a key change or a denial forgets them, and the war hold still decides Start Fight.
    function teardownAuthorized() {
        Analysis.reset();
        ['data-txm-hide', 'data-txm-warn', 'data-txm-label', 'data-txm-disarm', 'data-txm-disarm-label', 'data-txm-dialog', 'data-txm-sel']
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

    // The bar's pop-up lists close on an outside click, and on Esc (focus returns to their trigger).
    document.addEventListener('click', (e) => { if (!(e.target.closest && e.target.closest('.txm-fa-bar .rra-pick'))) closePops(); });
    document.addEventListener('keydown', (e) => {
        const open = e.key === 'Escape' && q(document, '.txm-fa-bar .rra-trigger[aria-expanded="true"]');
        if (open) { setPop(open, false); open.focus(); }
    });

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
        });
    }, 1000);

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) safe('visibility-auth', () => void Session.refresh());
        schedule();
    });

})();
