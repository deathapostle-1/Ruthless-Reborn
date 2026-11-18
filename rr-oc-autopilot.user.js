// ==UserScript==
// @name         RR OC Autopilot
// @namespace    txm.private.oc-autopilot
// @version      2.3.0
// @author       TXM [1712536]
// @description  Private OC planning assistant
// @updateURL    https://raw.githubusercontent.com/deathapostle-1/Ruthless-Reborn/main/rr-oc-autopilot.user.js
// @downloadURL  https://raw.githubusercontent.com/deathapostle-1/Ruthless-Reborn/main/rr-oc-autopilot.user.js
// @match        https://www.torn.com/factions.php*
// @noframes
// @run-at       document-idle
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      api.torn.zzcraft.net
// @connect      tornprobability.com
// @connect      rr-script-auth.deathapostle1.workers.dev
// ==/UserScript==

(function() {
	"use strict";

	const VERSION = "2.3.0";
	const AUTH_API = "https://rr-script-auth.deathapostle1.workers.dev";
	const ZZCRAFT_API = "https://api.torn.zzcraft.net";
	const ZZCRAFT_USERAGENT = `rr-oc-userscript/${VERSION}`; // Per-user ZZCraft logging
	// Session timings follow the RR Script Auth server: a session ends five minutes after the
	// membership check, and the server reuses that check for four minutes, so renewing sooner
	// would only return a session with the same end time.
	const AUTH_MAX_TTL_MS = 5 * 60 * 1000;
	const AUTH_REFRESH_MS = 4 * 60 * 1000;
	const AUTH_EXPIRY_SKEW_MS = 15 * 1000;
	const GATE_RETRY_MS = 60 * 1000; // server's failure cooldown and Retry-After
	const API_KEY_STORAGE = "rr_oc_api_key_v2";
	const LEGACY_API_KEY_STORAGE = "rr_oc_api_key"; // pre-2.1 copy the page could read; deleted on load
	// Crest look: the faction skull (64px webp, embedded so nothing else is loaded) and the Crest font, with a system fallback.
	const SKULL = "data:image/webp;base64,UklGRuwPAABXRUJQVlA4WAoAAAAwAAAAPwAAPwAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZBTFBIHAUAAA3wRdu2adu2taVcW9fwXF7btm3btm3btm3btrFs2/aweq8lPzT1vvQcERPAlVelzmCPXWZ6aP2SCxa3c1y6lDqDez78TmvLW0NianZ+6V9/OG6Uw5ee6fs+8s6jnHOEEd3BtR70sKm9fvePkS8d2nHPN61vjzJgLIShuObdH3Gt9+y1EpNLc098xOooZzsEyFSnIl3vrbPf/dPGhNS9/mvXR5EtI9NSafpWz73g82fFJFQ86ck5spEpW40QTD/tIR88JHt882+ZG4VxMpVyM5C7N3n7N/45HFea/fRajgAZq9TeIu35kT/8YjietPDRzRwGGeTxyEizbzr8l8NxaPazwxzGiAkawZ5v/sXeeQzFG7YjjJOZqIw0+/6PnelWesTVcwCyPDYLBbKK673y7Ytt0nVeMAoDRkzSkmUX99j1t8M2z9iMYNIyMljy9Gt/eHKzdI2H5MAC2RpbrYx8lUd/bdSo95JRmEqZequdkwGs4n6HndfoKrfKtiosCyMLuZUFYISudZtfu0Fxi40wyICwJSzT3pIBYeg+/zsbrus8PodFtaUQ47REiLJMuubOhzS4yg3CcoWFzNgtq4Shc8f9ou5O6wFYYIFJoXHITuAK4XSLIxrcZliqlAUhozZGyNRa4von1XWukgNkcDKAAFuNnDANnYyuek5dby4MliVjUS1bFUbINLRk0E552VWdbmDJCoFCVaAQ4IRprhBAd9dza1IKZCfLgIxRCRmQaS2XmFuh2ghLxqJSGCwjJpqiZrQ9TaVcValIuMJqZQFeSTVbi7tJpbYyVkluJWNtnaea0bE3KeQxTNQizhhQ/8d7TzNmeVwycWivwfFHPjqNx2KC+e9Fg+0vPnm3YhxOHpflOPsgNfBx7/jotdXOAsvCaiXHPl+l8eiwP75uupUl53c87a8vnpJbwdnvKpoRx1233wo5Tvn73td86i6M86cDmqtzz/VoB/lXxQm9/R/ZzuL+h1zsJuo89ao5wKqxTDKreyWGn3tpX2A1kbnpEz666Qb9x9wyhwGrCmTwGYvgi6ZmAAWqMojuE677hUXXvebaOQyWDBhhyQwP7gNbf39wAchYperBi274qlGdp8KAMGVZGDjnSwD5h08pBCiSS7IMKja7rvv9A3tYAJZJtgBir14p/j9zm0RjGSD/qaD+tMVbklySkZFLm79SyfGpV/RLclWlVw5Rg7W3vvaaqAQyteecSaUPvOrVsGi5+TXRMI7+2vtnUUVD/66HZl7xpUWWL7q25BajvY6l8fAf/3nrbCOLOMNdFc+dWfreaGufu3XAauB85PfUjNH3zn3lICEswMl4r6vvun3be+QH3ehzG/+9RR9kq8rbp34k0Xb7s3/8+O0MMjgZdPNv/fjBmxG3fsBT33bKZgBOxghW3nKwaO/D3/qy+xV5mPpJIaGbv2EtRyDt/p7VXFJs5aJbxMbXumKcefmVo4WLz+3e7el/fPYOkO6dwwCaIgz5fwsfObN7tz3in33GHMv/vQi2/verm70kA8iUjcCy//nxxNZ/zkliwsPV+a4NOIUAYZCVHvJdwMHkOw/IYQHINNW1L142l8rigWEZi3oj0GDXMy8tu4VFrUV95ypncCld7RUkVSlUEXZEupSsPeH6d7zJDWcXdwi8PC/Ip1/r9AtO/6a4tC79cv/jFh+49fyrdHvDd7+zO4ylr8feRa/gUusc+fxfFV8aLezo7PrT4cXDYe80cWmPYO28C8+HA4LLdVZQOCDaCAAAsCYAnQEqQABAAD4tEIVCoaEN/vwMAWJbAC44cDRnnh908xOqf0n7w/knyipR+zH8r+VXYO+5X3AP0i/sv209wDzAfrR+tPtC/sB7uPQH/pH+A9Xv/b+xv6AH69elr+2HwP/2n/X/tb8BX7Cf9TOAP47+EHex/c/A3xAehfZr0zsEfSZ/QdxD8n5G94PAC9Tf4bw59ivXb0AvYP6p/wuNHvR/0D/a+kHemUAP5b/Uv9/7L38p/7P8x5svoD/sf5H4A/5b/Uv+D/f/at9ev7i+xx+wDb0gsdXOqZcJxy15lZ/0DavQTp/Y8wohT5nPRe/l/rQPIvDgrVl9Uj8vV7yZTwp7WqhKtg8raMENL3S+khMLZmBCGl0sr67xMmSMbZr6vEMG19nTGTkgckLqNZyXKbtb12I3mBF7X/zUP50AAP79yHfoBJ7c15BwlkZ4Qv/7/AIqI540/ZSCf8EIPnnpw73FurN4kw0H6V3l0sV/lesO/9fNE1zxj1tnGiJ4XqfTqPZLqQuYz35iP0ovmbNOpQRziV+nIB5eQtDYbr9XNw6vzVbZYj0hj3f8LhrX8PGK16drmd06ZiURaLbabMigZcLPeDWo3p8x09ev9k54uzKwJ3fMg/d5H0dIZjpTLXuWXa8RnN6p2RY2PdmgNGfvYzL9nj69dmZXQpy7NEMpSLrwWKArrf0k8X7St00JvutPfywdQ6GE/NMjoBa1WG/wEKhD2r3PpVQekflfz4zdiSFAPnJF/55nSwqOFoKi0spTNzlrrZOz4JfnUXBSBQ/u5YMV56OyGQhxEhG1TXYS5siZ4KlXi/CCUQKQieVTUB+8aT6HIyzUkrf9QwsZmu8bL9flanDj71KeHfV0Yom8owl+5PRkb9ZcNRO9hmeNB4gowA4R+pw+zu9/H0pRlquB+Djg/IHJUd5WyM4ytSyIPgIErV33gYTfdyE1jWbD++dbBhzv23VXrF4dzfsOZGI+rfMbhnbfoikAXevBs73E/5u+s/6eATOdsnWF7Dlf3/g1Kd6QhSuvTjCzOrOKYkF/8l2ihI1N39XDNay8mDvG2AvEwv9jg4GPAjOjxVTxDdX+boDkCAyut/9z21uL35YKMG7UzYrFT7Ir923N07tfa30xQvCnr853z28ZEDjkdR9ZweCzKU0Kpt99PfK/qI08ktjjeAnGFh9W2LCAgcVVjKU7hG1ZiVtduPrOgMewhLSaqdisbVIQe+DSb7HwUM4gEk1WQPw1OGxzXb/r0siZ7ECBeqIchGDGY71AVN/gnzumV+BHeSFQeWaXr7E2jE4lBq/2vCqXpfQfPAfIbX/UX2pk8OkcLAU/riHM4BtSAHVIxm8cY3pwqc1dhRWnS4uf6S3ui79bFY/v1T7XxiKy+FmcWGl/BGh1l7afHfva6WqSntOz1zJEuIAVqxDl9ZP0gXKo7YvIhQjizRTdvmXmsSfkUZQfyuvPefE+XPMg6rmJyZBIRbxfXeTaZgFYcRSJuekE8WaP+aPi2PElsTyjyZn+5HVfdxVp+zbeIHQ4ct8+ddppy1u89iUOVAbThASM8PpGZ8Fj/MAw5M/z/lLJ/0yfPiVCa7tN+PTvfVe/iz/NWJxSi9B/s4nTiWMiVMOXSbrTJ1wdiPWl8F9A1uJMAJLbwo4xaLbdoyzMKr+K/tzaqd5bNRoQnILw+Tl1cuR+ItQWDWxIIcy2kqbWCOriDDQGwDefqSYH5iTySCEtPUsqlfvuCey8qvy7n6flo+4Qd1q11SfgT7L66aINj1+We/v7pQd5/T6z4GkMVs+L0FXF6ITrr+mw6vGHIFquTWp9k1YnT7GB6Nxq95Piub6pmFGDEaeAt+YdDLUyv+cW8g7ex7qRW87b26tSNv2xFXLvLc3Mm4bBZk6SwOdY/u5l0JHfkMtgmI7wVidpBXAC2hsO+0alb+xsvXOVsBGfEflak4anOvS0VsvNmhr4FHOMf8r422eMuAGb/0ghnkvbqXtApWJvyqV29EdTNa39MnOG18OcWOlS5s4LhzxZkH28UpxCCZeJQHG/NZnnVS+UO1oQ7yphFziEOczMwMiCGjYagOR97xavxQOVDJYqhacgclkMn+RLB4lfUf8xNCcQCeePYsvnSGXC9jEfhOsPn7/BlcEoQFXZ08Jg4PC3b19i1X8w3ZG69o87DXu5OmnRssytQZCFEgvZiG2BD5m2ev/tnw+v+7K0X4dSQ22q2IvGD1TH4K+Xov2Aj9Kb+GMEpUssPkpfxfjFQrd25WqCe41tLYXuf4EG44yn2mY2OldYlshpURpXmMGmhtn+tjZD8R+hz1X4gazw14JAzUNcI4QmNCKNPd4wmBiVL4l87LTy7sQSZjHMVtv7NSvP7guBp2nNDPJAz9fG65WBnObiXdDa5/3MP2BMDesjFdFvcmAoMCWNen/AnehnClZkx24W2SZuDd28nmdUKnwlcmWgtHHdSbiwvY4gpO8in2FZ33d5k8qLxjy/6dP7t4oFR3KNqUgs+iSQHCTyXJn9FUVWjJXIFkf/kR3bViujthw2R/87iEmgc/AkITIK1pNSOQbhSuPrYnsVm4nLFZ6AWTTc9ihOiFtn6rUKfZZUaGKZ7euX1mImprznfrT2Wcq9xkOg1B7SWDRad0HNtQCafw5LEn/r038W0jh9aDn8Wm7e1/ktaCMQPUgN1P7uJcyqwoYw04VD8mh7RwPD3fJdn3PCuq9jLJaN4/i0e/lrMo2ohbOBBPPzj4gulIgnDnEyUSpu+lngMihDxz5sNEPj8FplDeT91sXJez42mOXrxHyYvd8168SDjYmdZi8sAL3DlKsz+BZj6+y4Ndo8yH4ecehaMBdOlFzzkjeIsxgH8plPVkDQ3CkjhmYs0pRJt0jrPHi88BOhsRlwqEvrsVMiVjai9C/VLgHnJEOqJHC+emOlpR1X7c2s2r5Xfmk5enNmiso0BDuam7XAiUrDCtz8sWZYrpQjcULhA8UTMp9OaRUNOoveoPAClL2DJjEEUZH8KBbG9qW1i6LRwWPjfogAAA==";
	const CREST_FONT_URL = "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&display=swap";
	const MEMBERS_REFRESH_MS = 60 * 1000; // server refreshes member status every 60 s
	const CRIMES_REFRESH_MS = 30 * 1000; // server refreshes crime data every 30 s
	const RETRY_MS = 30 * 1000; // retry window after a failed fetch; a longer Retry-After wins
	const RENDER_DEBOUNCE_MS = 120; // renderAll() debounce
	const PUMP_DELAY_MS = 250; // Success queue pacing between requests
	const SUCCESS_RETRY_MS = 5 * 1000; // a failed success chance is tried again after 5 s, then 10 s
	const SUCCESS_FAILED_MS = 5 * 60 * 1000; // one that still failed is asked for again after this
	const PROBABILITY_BATCH_MS = 2000; // success chances arriving together are sent to the server at most this often
	const MAX_PANELS = 100; // the server takes at most 100 OCs per request
	const MAX_REQUEST_BYTES = 120 * 1024; // and at most 128 KB; this leaves headroom
	const REJECTED_RETRY_MS = 10 * 60 * 1000; // a request the server refused as invalid waits this long
	const STORAGE_TIMEOUT_MS = 10 * 1000; // protected storage that does not answer counts as failed
	const LOCK_TIMEOUT_MS = 3 * 1000; // another tab's login is not waited for longer than this

	const sel = (prefix) => `[class*="${prefix}___"]`;
	const q = (root, s) => root.querySelector(s);
	const qa = (root, s) => Array.from(root.querySelectorAll(s));
	const el = (tag, cls, html) => {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (html != null) e.innerHTML = html;
		return e;
	};
	const safe = (label, fn, fallback = undefined) => {
		try { return fn(); } catch (e) { console.warn(`[RR OC Autopilot] ${label}:`, e); return fallback; }
	};
	// Settles as p does, or fails after ms, so a store or lock that never answers cannot hold a flag.
	function withTimeout(p, ms, what) {
		let timer;
		const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(what + " timeout")), ms); });
		return Promise.race([p, late]).finally(() => clearTimeout(timer));
	}

	// Debug logger, opt-in via localStorage `rr_oc_debug` = "1" (useful for mobile bug reports)
	let DEBUG = false;
	try { DEBUG = localStorage.getItem("rr_oc_debug") === "1"; } catch (e) {}
	const log = (...a) => { if (DEBUG) console.log("[RR OC Autopilot]", ...a); };

	// The PC clock is used only as a stopwatch, so it does not matter how wrong it is. Times from
	// other computers are read against the server's clock (ServerTime), never against the PC's.

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
	};

	// Milliseconds on the PC clock, kept running forward if the clock is set back mid-page.
	const monoNow = typeof performance === "object" && performance && typeof performance.now === "function" ?
		() => performance.now() : () => Date.now();
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
		wallSeen = wall;
		monoSeen = mono;
		return wall + wallCorrection;
	}
	// Stored times use the plain PC clock so other tabs and later pages read them the same way.
	const toStored = (t) => t - wallCorrection;
	const fromStored = (t) => t + wallCorrection;

	function headerValue(headers, name) {
		if (typeof headers === "string") return headers.match(new RegExp(`^${name}:[ \\t]*(.+?)[ \\t]*$`, "im"))?.[1] || null;
		if (!headers || typeof headers !== "object") return null;
		const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
		return key && headers[key] != null ? String(headers[key]) : null;
	}
	// A reply's own clock reading, from its Date header.
	const replyTime = (headers) => Date.parse(headerValue(headers, "date") || "");

	// The sort choice is written to the script manager's store and localStorage, so it survives either one failing or
	// being cleared; the manager's copy is read first.
	function storeGet(k) {
		try { if (typeof GM_getValue === "function") { const v = GM_getValue(k, null); if (v != null) return v; } } catch (e) {}
		try { return localStorage.getItem(k); } catch (e) { return null; }
	}

	function storeSet(k, v) {
		try { if (typeof GM_setValue === "function") GM_setValue(k, v); } catch (e) {}
		try { localStorage.setItem(k, v); } catch (e) {}
	}

	// Protected storage: TornPDA's own store, else the script manager's (GM_* or GM.*). A store that
	// does not answer within STORAGE_TIMEOUT_MS counts as failed.
	function protectedStore() {
		if (typeof window.flutter_inappwebview !== "undefined") {
			if (typeof PDA_storage === "undefined") throw new Error("TornPDA 3.15 or newer is required");
			return { get: k => PDA_storage.get(k, null), set: (k, v) => PDA_storage.set(k, v), del: k => PDA_storage.delete(k) };
		}
		if (typeof GM_getValue === "function") {
			return { get: k => GM_getValue(k, null), set: (k, v) => GM_setValue(k, v), del: k => typeof GM_deleteValue === "function" && GM_deleteValue(k) };
		}
		if (typeof GM !== "undefined" && GM && typeof GM.getValue === "function") {
			return { get: k => GM.getValue(k, null), set: (k, v) => GM.setValue(k, v), del: k => GM.deleteValue(k) };
		}
		return null;
	}
	const timedStore = (op) => withTimeout(Promise.resolve().then(op), STORAGE_TIMEOUT_MS, "storage");

	async function secureGet(k) { const store = protectedStore(); return store ? timedStore(() => store.get(k)) : null; }

	async function secureSet(k, v) {
		const store = protectedStore();
		if (!store) throw new Error("Protected userscript storage unavailable");
		await timedStore(() => store.set(k, v));
	}

	async function secureDelete(k) {
		let store = null;
		try { store = protectedStore(); } catch (e) { return; }
		if (store) await timedStore(() => store.del(k));
	}

	const validApiKey = (value) =>
		typeof value === "string" && /^(?:[A-Za-z0-9]{16}|[A-Za-z0-9]{50})$/.test(value);

	let authApiKey = "";
	let apiKeyLoaded = false;
	let apiKeyChanging = false;

	// Only read here, never rewritten, so one failed storage write cannot lose a saved key.
	async function loadApiKey() {
		const candidate = await secureGet(API_KEY_STORAGE);
		authApiKey = validApiKey(candidate) ? candidate : "";
		secureDelete(LEGACY_API_KEY_STORAGE).catch(() => {}); try { localStorage.removeItem(LEGACY_API_KEY_STORAGE); } catch (e) {}
	}

	async function saveApiKey(value) {
		if (value && !validApiKey(value)) throw new Error("Invalid Torn API key");
		if (value) {
			await secureSet(API_KEY_STORAGE, value);
			if ((await secureGet(API_KEY_STORAGE)) !== value) { throw new Error("API key save could not be verified"); }
		} else { await secureDelete(API_KEY_STORAGE); }
		authApiKey = value;
	}

	function apiKey() { return authApiKey; }

	function requestRaw({ method = "GET", url, body, headers }) {
		const hdrs = Object.assign(body ? { "Content-Type": "application/json" } : {}, headers || {});
		const data = body ? JSON.stringify(body) : null;
		const fromServer = new URL(url).origin === AUTH_API;
		const timeoutMs = fromServer ? 25000 : 15000;
		const sentAt = nowMs();
		const reply = (r) => {
			const response = {
				ok: r.status >= 200 && r.status < 300,
				status: r.status,
				text: r.responseText || "",
				headers: r.responseHeaders || r.headers || "",
				sentAt,
				receivedAt: nowMs(),
			};
			if (fromServer) ServerTime.observe(replyTime(response.headers), sentAt, response.receivedAt);
			return response;
		};

		if (
			typeof window.flutter_inappwebview !== "undefined" &&
			window.flutter_inappwebview &&
			typeof window.flutter_inappwebview.callHandler === "function"
		) {
			const handler = method === "POST" ? "PDA_httpPost" : "PDA_httpGet";
			const call = method === "POST" ?
				window.flutter_inappwebview.callHandler(handler, url, hdrs, data) :
				window.flutter_inappwebview.callHandler(handler, url, hdrs);
			let timeoutId;
			const timeout = new Promise((_, reject) => {
				timeoutId = setTimeout(() => reject(new Error("timeout")), timeoutMs);
			});
			return Promise.race([Promise.resolve(call), timeout]).finally(() => clearTimeout(timeoutId)).then(reply);
		}

		const gmx =
			(typeof GM_xmlhttpRequest === "function" && GM_xmlhttpRequest) ||
			(typeof GM !== "undefined" && GM && typeof GM.xmlHttpRequest === "function" &&
				GM.xmlHttpRequest.bind(GM)) ||
			null;
		if (!gmx) return Promise.reject(new Error("GM_xmlhttpRequest unavailable"));
		return new Promise((resolve, reject) => {
			gmx({
				method,
				url,
				headers: hdrs,
				data,
				timeout: timeoutMs,
				// Lets Tampermonkey send requests side by side (its issue #2215); none of these services redirects.
				redirect: "manual",
				onload: (r) => resolve(reply(r)),
				onerror: reject,
				ontimeout: () => reject(new Error("timeout")),
			});
		});
	}

	async function requestJson(options) {
		const response = await requestRaw(options);
		let data;
		try { data = JSON.parse(response.text); } catch (e) { if (response.ok) throw new Error("Invalid JSON response"); }
		if (!response.ok) {
			const error = new Error("HTTP " + response.status);
			error.status = response.status;
			error.body = data;
			error.retryAfter = retryAfterMs(response.headers);
			throw error;
		}
		return data;
	}

	const SESSION_STORAGE = "rr_oc_session_v1";
	// Saved as JSON text, which every store keeps (TornPDA's included); a record saved as an object by 2.2.2 or older still reads.
	function parseSession(v) {
		if (typeof v === "string") { try { v = JSON.parse(v); } catch (e) { return null; } }
		return v && typeof v === "object" ? v : null;
	}
	function retryAfterMs(headers) {
		const raw = headerValue(headers, "retry-after");
		if (!raw) return 0;
		const seconds = Number(raw);
		if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
		// A date is measured against the same reply's clock, never this PC's.
		const stamp = replyTime(headers), from = Number.isFinite(stamp) ? stamp : ServerTime.estimate();
		return from == null ? 0 : Math.max(0, Date.parse(raw) - from) || 0;
	}
	async function keyFingerprint(key) {
		const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
		return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
	}
	const Gate = {
		state: "unknown", token: null, expiresAt: 0, renewedAt: 0, playerId: null, factionId: null,
		nextTryAt: 0, busy: false, gen: 0, refreshTimer: null, expiryTimer: null,
		pass() { return this.state === "ok" && !!this.token && nowMs() < this.expiresAt; },
		reset() {
			this.gen++;
			if (this.refreshTimer) clearTimeout(this.refreshTimer);
			if (this.expiryTimer) clearTimeout(this.expiryTimer);
			this.expiryTimer = null;
			Object.assign(this, { refreshTimer: null, busy: false, state: "unknown", token: null, expiresAt: 0, renewedAt: 0, playerId: null, factionId: null, nextTryAt: 0 });
		},
		scheduleRefresh() {
			if (this.refreshTimer) clearTimeout(this.refreshTimer);
			const delay = Math.max(1000, Math.min(this.renewedAt + AUTH_REFRESH_MS, this.expiresAt - AUTH_EXPIRY_SKEW_MS) - nowMs());
			this.refreshTimer = setTimeout(() => void this.refresh(true), delay);
		},
		deferRetry(delay = GATE_RETRY_MS) {
			this.state = this.token && nowMs() < this.expiresAt ? "ok" : "unknown";
			// While the current session still works, try a failed renewal once more before it
			// runs out; waiting the full cooldown would clear the page first.
			const renewBy = this.state === "ok" ? this.expiresAt - AUTH_EXPIRY_SKEW_MS - nowMs() : 0;
			const wait = Math.max(GATE_RETRY_MS, delay);
			this.nextTryAt = nowMs() + (renewBy > 0 ? Math.min(wait, Math.max(5000, renewBy)) : wait);
			if (this.refreshTimer) clearTimeout(this.refreshTimer);
			this.refreshTimer = setTimeout(() => void this.refresh(true), this.nextTryAt - nowMs());
			onGateChange();
		},
		accept(saved) {
			const now = nowMs();
			if (!saved || typeof saved.token !== "string" || !saved.token.length || saved.token.length > 4096 ||
				!Number.isFinite(saved.expiresAt) || saved.expiresAt <= now + AUTH_EXPIRY_SKEW_MS || saved.expiresAt > now + AUTH_MAX_TTL_MS ||
				!Number.isFinite(saved.renewedAt) || saved.renewedAt > now || saved.renewedAt < now - AUTH_MAX_TTL_MS ||
				!Number.isSafeInteger(saved.playerId) || saved.playerId < 1 || !Number.isSafeInteger(saved.factionId) || saved.factionId < 1) return false;
			Object.assign(this, { token: saved.token, expiresAt: saved.expiresAt, renewedAt: saved.renewedAt, playerId: saved.playerId, factionId: saved.factionId, state: "ok", nextTryAt: 0 });
			if (this.expiryTimer) clearTimeout(this.expiryTimer);
			this.expiryTimer = setTimeout(() => {
				if (nowMs() >= this.expiresAt) { this.token = null; this.state = "unknown"; onGateChange(); }
			}, this.expiresAt - nowMs() + 10);
			this.scheduleRefresh();
			onGateChange();
			return true;
		},
		async refresh(force = false) {
			if (apiKeyChanging) return;
			const key = apiKey();
			if (!key) { if (this.state !== "denied") { this.reset(); this.state = "denied"; onGateChange(); } return; }
			if ((!force && this.pass() && nowMs() < this.expiresAt - AUTH_EXPIRY_SKEW_MS) || this.busy || nowMs() < this.nextTryAt) return;
			const gen = this.gen;
			this.busy = true;
			try {
				const fingerprint = await keyFingerprint(key);
				const renew = async () => {
					if (gen !== this.gen || key !== apiKey()) return;
					// A key saved or removed in another tab replaces this tab's.
					const current = await secureGet(API_KEY_STORAGE);
					if (gen !== this.gen || key !== apiKey()) return;
					if (current !== key) { adoptKey(current); return; }
					const saved = parseSession(await secureGet(SESSION_STORAGE));
					if (gen !== this.gen || key !== apiKey()) return;
					const stored = saved ? { ...saved, expiresAt: fromStored(saved.expiresAt), renewedAt: fromStored(saved.renewedAt) } : null;
					if (stored?.keyFingerprint === fingerprint && (!force || stored.renewedAt + AUTH_REFRESH_MS > nowMs()) && this.accept(stored)) return;
					const sentAt = nowMs();
					const response = await requestRaw({ method: "POST", url: AUTH_API + "/v1/session", body: { apiKey: key, app: "oc-autopilot", clientVersion: VERSION } });
					if (gen !== this.gen || key !== apiKey() || await secureGet(API_KEY_STORAGE) !== key) return;
					if (response.status === 200) {
						const data = JSON.parse(response.text);
						// The server's current second is expiresAt - expiresIn.
						if (Number.isFinite(data.expiresAt) && Number.isFinite(data.expiresIn)) ServerTime.observe((data.expiresAt - data.expiresIn) * 1000, response.sentAt, response.receivedAt);
						// Time the session by the seconds the server says remain, counted from the request.
						// Comparing the server's end time with this PC's clock rejected every fresh session
						// whenever the clock ran even slightly slow.
						const serverNow = ServerTime.estimate();
						const lifetime = Number.isFinite(data.expiresIn) ? data.expiresIn * 1000 : serverNow == null ? NaN : Number(data.expiresAt) * 1000 - serverNow;
						const session = { token: data.token, expiresAt: sentAt + Math.min(lifetime, AUTH_MAX_TTL_MS), renewedAt: nowMs(), playerId: data.playerId, factionId: data.factionId, keyFingerprint: fingerprint };
						if (!this.accept(session)) throw new Error("Invalid authorization response");
						// Shared with other tabs and later pages; a store that refuses the write only costs them a login.
						await secureSet(SESSION_STORAGE, JSON.stringify({ ...session, expiresAt: toStored(session.expiresAt), renewedAt: toStored(session.renewedAt) })).catch(() => {});
					} else if (response.status === 401 || response.status === 403) {
						await secureDelete(SESSION_STORAGE);
						if (gen !== this.gen) return;
						this.token = null; this.expiresAt = 0; this.state = "denied"; this.nextTryAt = nowMs() + GATE_RETRY_MS; onGateChange();
					} else this.deferRetry(retryAfterMs(response.headers));
				};
				// Web Locks keep tabs from logging in at once; a lock not granted in time is not waited for.
				if (navigator.locks?.request) {
					const wait = new AbortController(), timer = setTimeout(() => wait.abort(), LOCK_TIMEOUT_MS);
					try { await navigator.locks.request("rr-oc-session", { signal: wait.signal }, () => { clearTimeout(timer); return renew(); }); }
					catch (e) { if (e?.name !== "AbortError") throw e; await renew(); }
					finally { clearTimeout(timer); }
				} else await renew();
			} catch (e) { if (gen === this.gen) this.deferRetry(); }
			finally { if (gen === this.gen) this.busy = false; }
		},
	};

	// A session stored before the PC clock was set back carries times from the old setting.
	function afterClockSetBack() { secureDelete(SESSION_STORAGE).catch(() => {}); }

	// After the clock jumps forward the session may look spent: renew now rather than at the next timer.
	function afterClockSetForward() { if (apiKeyLoaded) void Gate.refresh(); }

	// A 403 means no longer a member. A 401 means the session ended early (e.g. a server update): log in
	// again at once, but only once a minute, and only after the refused session is deleted.
	let unauthorizedAt = -Infinity;
	async function denyProtected(status, gen, token) {
		if (gen !== Gate.gen || token !== Gate.token) return;
		const again = status === 401 && nowMs() - unauthorizedAt > GATE_RETRY_MS;
		if (status === 401) unauthorizedAt = nowMs();
		Gate.reset();
		const deniedGen = Gate.gen;
		Gate.state = status === 403 ? "denied" : "unknown";
		Gate.nextTryAt = nowMs() + GATE_RETRY_MS;
		onGateChange();
		await secureDelete(SESSION_STORAGE).catch(() => {});
		if (deniedGen !== Gate.gen) return;
		if (again) { Gate.nextTryAt = 0; void Gate.refresh(); } else Gate.refreshTimer = setTimeout(() => void Gate.refresh(), GATE_RETRY_MS);
	}

	// Another tab saved or removed the key: this tab follows it.
	function adoptKey(value) {
		authApiKey = validApiKey(value) ? value : "";
		Gate.reset();
		onGateChange();
	}

	function onGateChange() {
		if (!Gate.pass() && document.body.classList.contains("rr-oc-authorized")) document.body.classList.remove("rr-oc-authorized");
		else if (Gate.pass() && Analysis.result && !document.body.classList.contains("rr-oc-authorized")) document.body.classList.add("rr-oc-authorized");
		if (settingsGateHook) { try { settingsGateHook(); } catch (e) {} }
		if (!Gate.pass()) {
			Analysis.reset();
			Object.assign(Config, { data: null, at: 0, loading: null });
			Object.assign(TornApi, { members: null, fetchedAt: 0 });
			Object.assign(FactionCrimes, { byId: null, fetchedAt: 0 });
			Object.assign(Success, { roles: null, loading: null, nextRolesAt: 0 });
			Success.cache.clear();
			Success.failedAt.clear();
			Success.queue.length = 0;
		}
		renderAll(true);
	}

	// Strips every injected element/class so a denied user sees a completely stock page.
	function teardownAll() {
		if (document.body.classList.contains("rr-oc-authorized")) document.body.classList.remove("rr-oc-authorized");
		const bar = document.querySelector(".rr-toolbar");
		if (bar && bar.dataset.mode !== "gate") bar.remove();
		qa(document, ".rr-meta, .rr-cp, .rr-info, .rr-stat, .rr-lock").forEach((n) => n.remove());
		qa(document, ".rr-role").forEach((h) => h.classList.remove("rr-role", "rr-item-missing"));
		qa(document, FILL_SELECTOR).forEach((w) => w.classList.remove(...FILL));
		qa(document, ".rr-slot").forEach((w) => w.classList.remove("rr-slot"));
		for (const p of qa(document, "div[data-oc-id]")) {
			p.removeAttribute("aria-busy");
			delete p.dataset.rrFp;
			p.style.order = "";
		}
		infoRows.clear();
		restoreNativeEdits(document);
		const list = listContainer();
		if (list) { list.style.display = ""; list.style.flexDirection = ""; }
	}

	// A changed observation invalidates only this panel, not the toolbar or other OCs.
	function clearPanelDecision(panel, keepRequirements = false) {
		// Keep layout nodes while their replacement decision is in flight. Do not
		// keep stale eligibility, occupant status or probability as a current result.
		if (panel.getAttribute("aria-busy") !== "true") panel.setAttribute("aria-busy", "true");
		qa(panel, ".rr-stat, .rr-lock, .rr-item").forEach(n => n.remove());
		qa(panel, ".rr-role.rr-item-missing").forEach(h => h.classList.remove("rr-item-missing"));
		qa(panel, FILL_SELECTOR).forEach(w => {
			for (const fill of FILL) if (w.classList.contains(fill) !== (fill === "rr-fill-grey")) w.classList.toggle(fill, fill === "rr-fill-grey");
			const foot = w.querySelector(".rr-meta");
			if (foot) renderFill(foot, "pending");
		});
		if (!keepRequirements) qa(panel, ".rr-meta .rr-v").forEach(n => { if (n.textContent !== "…") n.textContent = "…"; });
		const pill = panel.querySelector(".rr-success");
		if (pill) setPill(pill, "none", "Success", Analysis.error ? "unavailable" : "…");
		delete panel.dataset.rrFp;
	}

	// Crest icons: 24px stroke paths, drawn in the text colour.
	const ICON_PATHS = {
		settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
		close: '<path d="M6 6l12 12M18 6L6 18"/>',
		chevron: '<path d="M6 9l6 6 6-6"/>',
		check: '<path d="M5 12l5 5 9-10"/>',
		lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
		sort: '<path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/>',
		key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2"/>',
		info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
		warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
		hosp: '<path d="M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z"/>',
		jail: '<path d="M5 3v18M10 3v18M15 3v18M20 3v18M3 8h19M3 16h19"/>',
		plane: '<path d="M2 15l20-7-3 9-6-2-2 5-2-6z"/>',
		globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
	};
	const icon = (name, size = 14, cls = "", attrs = "") =>
		`<svg class="rr-ico${cls ? " " + cls : ""}"${attrs} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name]}</svg>`;

	const TIMED_STATES = ["Hospital", "Jail", "Federal"]; // states with a release time
	// Used on the slot's status chip and in Torn's slot tooltip; data-st picks the colour.
	const statusIcon = (state, name) => icon(name, 12, "rr-st-ico", ` data-st="${state}"`);
	const STATUS_ICON = {
		Okay: statusIcon("Okay", "check"),            // a tick in a rounded box, like every other status
		Hospital: statusIcon("Hospital", "hosp"),
		Jail: statusIcon("Jail", "jail"),
		Federal: statusIcon("Federal", "jail"),
		Traveling: statusIcon("Traveling", "plane"),
		Abroad: statusIcon("Abroad", "globe"),
	};
	const STATUS_WORD = { Okay: "Available", Hospital: "In hospital", Jail: "In jail", Federal: "In federal jail", Traveling: "Traveling", Abroad: "Abroad" };

	// Member status and crime data share one poll: once per interval, and after a failure no sooner
	// than RETRY_MS (or the server's Retry-After). A 401/403 for the current session ends it.
	async function pollProtected(state, path, interval, accept) {
		if (!Gate.pass() || nowMs() - state.fetchedAt < interval) return;
		const gen = Gate.gen, token = Gate.token;
		state.fetchedAt = nowMs();
		try {
			const r = await requestJson({ url: AUTH_API + path, headers: { Authorization: `Bearer ${token}` } });
			if (gen === Gate.gen && Gate.pass() && r && accept(r)) renderAll();
		} catch (e) {
			if (gen !== Gate.gen) return;
			if (e.status === 401 || e.status === 403) {
				if (token !== Gate.token) { state.fetchedAt = 0; scheduleRender(); return; }
				await denyProtected(e.status, gen, token); return;
			}
			state.fetchedAt = nowMs() - interval + Math.max(RETRY_MS, e.retryAfter || 0);
			log(path + " refresh failed", e);
		}
	}

	const TornApi = {
		members: null,
		fetchedAt: 0,
		refresh() {
			return pollProtected(this, "/v1/faction/members", MEMBERS_REFRESH_MS, r => {
				if (!Array.isArray(r.members)) return false;
				this.members = {};
				for (const m of r.members) this.members[m.id] = { state: m.status?.state || "", until: m.status?.until || 0, description: m.status?.description || "" };
				return true;
			});
		},
		statusFor(xid) { return this.members?.[xid] || null; },
	};

	const FactionCrimes = {
		byId: null,
		fetchedAt: 0,
		refresh() {
			return pollProtected(this, "/v1/oc/crimes", CRIMES_REFRESH_MS, r => {
				if (!Array.isArray(r.crimes)) return false;
				this.byId = Object.fromEntries(r.crimes.map(c => [c.id, c]));
				return true;
			});
		},
	};

	// Third-party data is trimmed to what the server accepts before it is sent: names up to 160
	// characters, at most 100 scenarios of 20 roles, and thresholds from 0 to 100.
	const name160 = (v) => typeof v === "string" && v.length <= 160;
	const percent = (v) => (typeof v === "number" || (typeof v === "string" && /^\d+(?:\.\d+)?$/.test(v))) && Number(v) >= 0 && Number(v) <= 100 ? v : null;
	const cleanConfig = (data) => data.filter(c => c && name160(c.name) && Array.isArray(c.roles)).slice(0, 100)
		.map(c => ({ name: c.name, roles: c.roles.filter(r => r && name160(r.label)).slice(0, 20)
			.map(r => ({ label: r.label, minimumSuccessChance: percent(r.minimumSuccessChance), weight: percent(r.weight) })) }));
	function cleanRoles(r) {
		const out = {};
		if (!r || typeof r !== "object" || Array.isArray(r)) return out;
		for (const [scenario, roles] of Object.entries(r)) {
			if (Object.keys(out).length >= 100) break;
			if (!name160(scenario) || !roles || typeof roles !== "object" || Array.isArray(roles)) continue;
			out[scenario] = Object.fromEntries(Object.entries(roles).filter(([k, v]) => name160(k) && name160(v)).slice(0, 20));
		}
		return out;
	}

	const Success = {
		api: "https://tornprobability.com:3000/api/",
		roles: null,
		loading: null,
		nextRolesAt: 0,
		cache: new Map(),
		failedAt: new Map(), // key -> when a chance that could not be fetched is asked for again
		queue: [],
		busy: false,
		busyJob: null,
		timer: null,
		ensureRoles() {
			if (this.roles || this.loading || !Gate.pass() || nowMs() < this.nextRolesAt) return;
			const gen = Gate.gen, job = (this.loading = {});
			requestJson({ url: this.api + "GetRoleNames" })
				.then((r) => {
					if (gen !== Gate.gen || !Gate.pass()) return;
					this.roles = cleanRoles(r);
					renderAll(true);
				})
				.catch(() => {
					if (gen !== Gate.gen) return;
					this.nextRolesAt = nowMs() + RETRY_MS;
					setTimeout(scheduleRender, RETRY_MS);
				})
				.finally(() => { if (this.loading === job) this.loading = null; });
		},
		// More chances are on their way now (one in flight or one due), not merely waiting out a retry delay.
		draining() { const now = nowMs(); return this.busy || this.queue.some((j) => j.retryAt <= now); },
		due(key) { return !this.cache.has(key) || (this.cache.get(key) === null && nowMs() >= this.failedAt.get(key)); },
		get(scenario, params, cb) {
			const key = scenario + "|" + params.join(",");
			if (!this.due(key)) { cb(this.cache.get(key)); return; }
			const pending =
				this.queue.find((j) => j.key === key && j.gen === Gate.gen) ||
				(this.busyJob?.key === key && this.busyJob.gen === Gate.gen ? this.busyJob : null);
			if (pending) { pending.cbs.push(cb); return; }
			this.queue.push({ scenario, params, key, cbs: [cb], tries: 0, retryAt: 0, gen: Gate.gen });
			this.pump();
		},
		pump() {
			if (this.busy || !Gate.pass()) return;
			const now = nowMs(), i = this.queue.findIndex((j) => j.retryAt <= now);
			if (i < 0) {
				// Only retries are waiting: come back when the first is due.
				if (this.queue.length && !this.timer) {
					this.timer = setTimeout(() => { this.timer = null; this.pump(); }, Math.min(...this.queue.map((j) => j.retryAt)) - now);
				}
				return;
			}
			this.busy = true;
			const job = (this.busyJob = this.queue.splice(i, 1)[0]);
			requestJson({
					method: "POST",
					url: this.api + "CalculateSuccess",
					body: { scenario: job.scenario, parameters: job.params },
				})
				.then((r) => {
					if (job.gen !== Gate.gen || !Gate.pass()) return;
					if (!r || !Number.isFinite(r.successChance) || r.successChance < 0 || r.successChance > 1) {
						throw new Error("bad response");
					}
					this.cache.set(job.key, r.successChance);
					job.cbs.forEach((cb) => cb(r.successChance));
				})
				.catch(() => {
					if (job.gen !== Gate.gen || !Gate.pass()) return;
					if (++job.tries < 3) { job.retryAt = nowMs() + SUCCESS_RETRY_MS * job.tries; this.queue.push(job); return; }
					this.cache.set(job.key, null);
					this.failedAt.set(job.key, nowMs() + SUCCESS_FAILED_MS);
					job.cbs.forEach((cb) => cb(null));
				})
				.finally(() =>
					setTimeout(() => { this.busy = false; this.busyJob = null; this.pump(); }, PUMP_DELAY_MS),
				);
		},
	};

	const Config = {
		data: null,
		loading: null,
		at: 0,
		ttl: 6 * 60 * 60 * 1000,
		ensure() { if (nowMs() - this.at > this.ttl) this.fetch(); },
		async fetch() {
			const key = apiKey();
			if (!key || this.loading || !Gate.pass()) return;
			const gen = Gate.gen, job = (this.loading = {});
			try {
				const data = await requestJson({
					url: `${ZZCRAFT_API}/Factions/${Gate.factionId}/OrganizedCrimes/thresholds`,
					headers: { "X-Api-Key": key, "User-Agent": ZZCRAFT_USERAGENT },
				});
				if (gen !== Gate.gen || !Gate.pass()) return;
				if (!Array.isArray(data)) throw new Error("bad config");
				this.data = cleanConfig(data);
				this.at = nowMs();
				renderAll(true);
			} catch (error) {
				if (gen !== Gate.gen) return;
				this.at = nowMs() - this.ttl + RETRY_MS;
				log("config refresh failed", error);
			} finally { if (this.loading === job) this.loading = null; }
		},
	};

	// Crest. Colours are tokens on <body>: light by default, dark when Torn's body has dark-mode. Teal #029E7A is
	// primary (actions, go states, the toolbar's top strip); gold #C9A95C is the brand accent (outlines, small labels).
	const STYLE = `
		body {
			--rr-font: 'Bricolage Grotesque', system-ui, -apple-system, 'Segoe UI', sans-serif;
			--rr-primary: #029E7A; --rr-accent: #C9A95C;
			--rr-surface: #ffffff; --rr-surface-2: #f6f4ef; --rr-sunken: #eeebe4; --rr-line: #dcd8ce;
			--rr-text: #1c1d1f; --rr-muted: #5e5b54; --rr-primary-fg: #026e56; --rr-on-primary: #04211a; --rr-accent-fg: #7f6427;
			--rr-ok: #11704f; --rr-close: #a14a07; --rr-below: #b42318; --rr-none: #63666c;
			--rr-shadow: 0 12px 32px rgba(20, 20, 20, .16); --rr-scheme: light;
		}
		body.dark-mode {
			--rr-surface: #1b1c1e; --rr-surface-2: #232427; --rr-sunken: #141516; --rr-line: #33363a;
			--rr-text: #eceae4; --rr-muted: #a8a59d; --rr-primary-fg: #2fc29d; --rr-on-primary: #04211a; --rr-accent-fg: #d4b56c;
			--rr-ok: #4cc38a; --rr-close: #f0913e; --rr-below: #f06a5f; --rr-none: #9a9ca1;
			--rr-shadow: 0 12px 32px rgba(0, 0, 0, .5); --rr-scheme: dark;
		}

		/* Base for the toolbar and the settings panel; Torn's page CSS still reaches them. */
		.rr-toolbar, .rr-set { box-sizing: border-box; font-family: var(--rr-font); font-size: 12px; font-weight: 400; line-height: 1.35; color: var(--rr-text); text-align: left; letter-spacing: normal; text-transform: none; -webkit-font-smoothing: antialiased; color-scheme: var(--rr-scheme); }
		.rr-toolbar *, .rr-toolbar *::before, .rr-toolbar *::after, .rr-set *, .rr-set *::before, .rr-set *::after,
		.rr-meta *, .rr-meta *::before, .rr-meta *::after, .rr-info * { box-sizing: border-box; }
		.rr-toolbar button, .rr-toolbar input, .rr-set button, .rr-set input { font: inherit; color: inherit; margin: 0; letter-spacing: inherit; text-transform: none; }
		.rr-toolbar button, .rr-set button { cursor: pointer; }
		.rr-toolbar :where(p, ul, li, label), .rr-set :where(p, h2, h3, h4, dl, dt, dd, label, details, summary) { margin: 0; padding: 0; font-family: inherit; letter-spacing: normal; text-transform: none; }
		.rr-toolbar ul { list-style: none; }
		.rr-toolbar [hidden], .rr-set [hidden], .rr-meta [hidden] { display: none !important; }
		.rr-toolbar :focus-visible, .rr-set :focus-visible { outline: 2px solid var(--rr-accent); outline-offset: 2px; }
		.rr-vh { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
		.rr-ico { display: block; flex: none; pointer-events: none; }
		.rr-skull { display: block; flex: none; max-width: none; }
		.rr-st-ico { color: var(--rr-close); }
		.rr-st-ico[data-st="Okay"] { color: var(--rr-ok); }

		/* Toolbar. It is its own size container: one row wide, the legend folds to 2x2 under 900px, drops to its own line
		   under 760px, and the phone layout (three rows, 44px targets) starts at 640px. Min-heights match the full bar at
		   each width, so the gated bar never makes the page jump. */
		.rr-toolbar { container-type: inline-size; container-name: rroc; position: relative; z-index: 50; margin: 8px 0 12px; }
		.rr-bar { display: flex; flex-wrap: wrap; align-items: center; align-content: center; gap: 8px 12px; min-height: 54px; margin: 0; padding: 8px 12px; background: var(--rr-surface); color: var(--rr-text); border: 1px solid var(--rr-line); border-radius: 6px; box-shadow: inset 0 2px 0 #029E7A; }
		.rr-brand { display: flex; align-items: center; gap: 8px; flex: none; }
		.rr-brand .rr-skull { width: 24px; height: 24px; }
		.rr-titles { display: flex; flex-direction: column; }
		.rr-kicker { font-size: 10px; font-weight: 600; line-height: 12px; color: var(--rr-accent-fg); white-space: nowrap; }
		.rr-name { font-size: 14px; font-weight: 700; line-height: 18px; color: var(--rr-text); white-space: nowrap; }
		.rr-cell { align-self: stretch; padding-left: 12px; border-left: 1px solid var(--rr-line); }
		.rr-count { display: flex; flex-direction: column; justify-content: center; flex: none; min-width: 0; }
		.rr-main { font-size: 12px; line-height: 16px; white-space: nowrap; }
		.rr-main.rr-quiet { color: var(--rr-muted); white-space: normal; }
		.rr-main.rr-warn { color: var(--rr-below); font-weight: 600; white-space: normal; }
		.rr-num { font-weight: 700; font-variant-numeric: tabular-nums; }
		.rr-num.rr-go { color: var(--rr-primary-fg); }
		.rr-sub { font-size: 11px; line-height: 14px; color: var(--rr-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
		.rr-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; flex: none; margin: 0; list-style: none; }
		.rr-lkey { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; line-height: 1.3; color: var(--rr-fill); white-space: nowrap; }
		.rr-lkey[data-fill="ok"], .rr-fill-green { --rr-fill: var(--rr-ok); }
		.rr-lkey[data-fill="close"], .rr-fill-amber { --rr-fill: var(--rr-close); }
		.rr-lkey[data-fill="below"], .rr-fill-red { --rr-fill: var(--rr-below); }
		.rr-lkey[data-fill="none"], .rr-fill-grey { --rr-fill: var(--rr-none); }
		/* Markers are small rounded squares, the same shape as the ringed slots they stand for. */
		.rr-mark { display: block; flex: none; width: 8px; height: 8px; border-radius: 2px; background: var(--rr-fill); }
		.rr-lkey[data-fill="none"] .rr-mark, .rr-fill-grey .rr-mark { background: transparent; box-shadow: inset 0 0 0 1.5px var(--rr-fill); }
		.rr-tools { display: flex; align-items: center; gap: 8px; flex: none; margin-left: auto; }
		.rr-sort { position: relative; }
		.rr-trigger { position: relative; display: inline-flex; align-items: center; gap: 6px; min-height: 36px; margin: 0; padding: 4px 8px; border: 1px solid var(--rr-line); border-radius: 4px; background: var(--rr-surface-2); color: var(--rr-text); text-align: left; }
		.rr-trigger:hover, .rr-trigger[aria-expanded="true"] { border-color: var(--rr-accent); }
		.rr-trigger[aria-expanded="true"] .rr-chev { transform: rotate(180deg); }
		.rr-ticon, .rr-chev { color: var(--rr-muted); }
		.rr-ttext { display: flex; flex-direction: column; }
		.rr-tlabel { font-size: 10px; font-weight: 600; line-height: 12px; color: var(--rr-muted); white-space: nowrap; }
		.rr-tvalue { font-size: 12px; font-weight: 700; line-height: 14px; white-space: nowrap; }
		.rr-list { position: absolute; top: calc(100% + 4px); right: 0; z-index: 50; min-width: 220px; max-width: calc(100vw - 24px); padding: 4px; background: var(--rr-surface); border: 1px solid var(--rr-line); border-radius: 6px; box-shadow: var(--rr-shadow); }
		.rr-list-head { padding: 4px 8px 6px; font-size: 10px; font-weight: 600; line-height: 12px; color: var(--rr-muted); }
		.rr-options { display: flex; flex-direction: column; gap: 2px; }
		.rr-option { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 32px; padding: 6px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; line-height: 16px; color: var(--rr-text); white-space: nowrap; cursor: pointer; }
		.rr-option:hover { background: var(--rr-surface-2); }
		.rr-option:focus-within { outline: 2px solid var(--rr-accent); outline-offset: -2px; }
		.rr-tick { color: var(--rr-primary-fg); visibility: hidden; }
		.rr-option input:checked ~ .rr-tick { visibility: visible; }
		.rr-gear { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 36px; height: 36px; margin: 0; padding: 0; border: 1px solid var(--rr-accent); border-radius: 4px; background: transparent; color: var(--rr-accent-fg); }
		.rr-gear:hover { background: var(--rr-surface-2); }
		.rr-gate { display: flex; align-items: center; gap: 8px; flex: 1 1 auto; min-width: 0; font-size: 12px; font-weight: 600; line-height: 16px; color: var(--rr-text); }
		.rr-gate-icon { color: var(--rr-muted); }
		.rr-gate--nokey .rr-gate-icon { color: var(--rr-accent-fg); }
		.rr-gate--denied .rr-gate, .rr-gate--denied .rr-gate-icon { color: var(--rr-below); }
		.rr-gate--unavailable .rr-gate-icon { color: var(--rr-close); }
		@container rroc (max-width: 900px) {
			.rr-legend { display: grid; grid-template-columns: repeat(2, auto); align-content: center; justify-content: start; gap: 2px 12px; }
		}
		@container rroc (max-width: 760px) {
			.rr-bar { min-height: 86px; }
			.rr-bar.rr-short { min-height: 54px; }
			.rr-legend { order: 2; display: flex; flex-basis: 100%; min-height: 24px; padding: 8px 0 0; border-left: 0; border-top: 1px solid var(--rr-line); }
			.rr-tools { order: 1; }
		}
		@container rroc (max-width: 640px) {
			.rr-bar { min-height: 132px; }
			.rr-bar.rr-short { min-height: 86px; }
			.rr-legend, .rr-tools { order: 0; }
			.rr-gate { order: 3; flex-basis: 100%; padding-left: 0; border-left: 0; }
			.rr-trigger { min-height: 44px; }
			.rr-tlabel { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); border: 0; }
			.rr-gear { width: 44px; height: 44px; }
			.rr-option { min-height: 44px; }
		}

		/* Slots: the scenario colouring. Each analysed slot is ringed in its fit colour and its role header is tinted the same
		   hue, so a crime reads at a glance (2.2.4's rings, in Crest form). The footer holds the fit word, member status, Min
		   and Weight as two ruled cells, planning progress, and the lock and missing-item lines. Slots are 95-150px wide: rows
		   wrap between word groups, never inside a word. Ring colours are the server's own fit colours. */
		body.rr-oc-authorized #faction-crimes-root [class*="slotIcon___"] { display: none !important; }
		.rr-fill-green { --rr-ring: #029E7A; }
		.rr-fill-amber { --rr-ring: #DB7B2B; }
		.rr-fill-red { --rr-ring: #CC3232; }
		.rr-fill-grey { --rr-ring: #8A8D93; }
		.rr-slot.rr-fill-green, .rr-slot.rr-fill-amber, .rr-slot.rr-fill-red, .rr-slot.rr-fill-grey { border-radius: 6px; box-shadow: 0 0 0 2px var(--rr-ring) !important; }
		body.dark-mode .rr-slot.rr-fill-green, body.dark-mode .rr-slot.rr-fill-amber, body.dark-mode .rr-slot.rr-fill-red, body.dark-mode .rr-slot.rr-fill-grey { box-shadow: 0 0 0 2px var(--rr-ring), 0 0 10px -3px var(--rr-ring) !important; }
		.rr-fill-green > .rr-role, .rr-fill-amber > .rr-role, .rr-fill-red > .rr-role, .rr-fill-grey > .rr-role { background: var(--rr-surface-2) !important; background: color-mix(in srgb, var(--rr-ring) 24%, var(--rr-surface)) !important; box-shadow: none !important; border-radius: 6px 6px 0 0 !important; }
		body.dark-mode .rr-fill-green > .rr-role, body.dark-mode .rr-fill-amber > .rr-role, body.dark-mode .rr-fill-red > .rr-role, body.dark-mode .rr-fill-grey > .rr-role { background: color-mix(in srgb, var(--rr-ring) 32%, var(--rr-surface)) !important; }
		/* Role names and the member's CPR in the Crest font, not Torn's capitals. */
		body.rr-oc-authorized #faction-crimes-root .rr-role [class*="title___"] { color: var(--rr-text) !important; font-family: var(--rr-font) !important; font-size: 12px !important; font-weight: 700 !important; letter-spacing: normal !important; text-transform: none !important; }
		body.rr-oc-authorized #faction-crimes-root .rr-role [class*="successChance___"] { font-family: var(--rr-font) !important; font-weight: 800 !important; font-variant-numeric: tabular-nums; }
		body.rr-oc-authorized #faction-crimes-root .rr-role.rr-item-missing [class*="title___"] { color: var(--rr-below) !important; }
		/* One Crest surface inside the ring: Torn's beige member area takes the panel colour, and its inner box takes the
		   same 4px corners as the Min and Weight cells. */
		.rr-slot > [class*="slotBody___"] { background: var(--rr-surface) !important; border-bottom-left-radius: 0 !important; border-bottom-right-radius: 0 !important; }
		.rr-slot [class*="slotMenu___"] { background: var(--rr-surface) !important; border-color: var(--rr-line) !important; border-radius: 4px !important; }
		.rr-meta { box-sizing: border-box; display: flex; flex: 1 0 auto; flex-direction: column; gap: 4px; min-width: 0; margin: 0; padding: 4px 6px 6px; border: 0; border-top: 1px solid var(--rr-line); border-radius: 0 0 6px 6px; background: var(--rr-surface-2); color: var(--rr-text); font-family: var(--rr-font); font-size: 11px; font-weight: 400; font-style: normal; line-height: 1.3; text-align: left; text-transform: none; text-shadow: none; letter-spacing: normal; white-space: normal; overflow-wrap: normal; word-break: normal; cursor: default; }
		.rr-top { order: 1; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px; min-height: 18px; }
		.rr-kv { order: 2; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border: 1px solid var(--rr-line); border-radius: 4px; overflow: hidden; background: var(--rr-surface); }
		.rr-cp { order: 3; display: flex; align-items: center; gap: 6px; }
		.rr-lock { order: 4; }
		.rr-item { order: 5; }
		.rr-fillword { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
		.rr-word { font-size: 11px; font-weight: 700; line-height: 1.3; color: var(--rr-fill); white-space: nowrap; }
		/* Member status: every state is the same small rounded box; problems are orange, "Available" a quiet teal. */
		.rr-stat { position: relative; display: inline-flex; flex: none; align-items: center; justify-content: center; width: 20px; height: 18px; margin-left: auto; padding: 0; border-radius: 3px; background: var(--rr-sunken); background: color-mix(in srgb, var(--rr-close) 18%, transparent); color: var(--rr-close); }
		.rr-stat[data-st="Okay"] { background: var(--rr-sunken); background: color-mix(in srgb, var(--rr-ok) 14%, transparent); color: var(--rr-ok); }
		.rr-kvi { display: flex; flex-direction: column; align-items: center; min-width: 0; padding: 2px 4px 3px; white-space: nowrap; }
		.rr-kvi + .rr-kvi { border-left: 1px solid var(--rr-line); }
		.rr-l { font-size: 9.5px; font-weight: 600; line-height: 12px; color: var(--rr-muted); }
		.rr-v { font-size: 12px; font-weight: 700; line-height: 15px; color: var(--rr-text); font-variant-numeric: tabular-nums; }
		.rr-track { flex: 1 1 auto; min-width: 0; height: 4px; border-radius: 2px; overflow: hidden; background: var(--rr-line); background: color-mix(in srgb, var(--rr-text) 12%, transparent); }
		.rr-track > i { display: block; height: 100%; border-radius: 2px; background: var(--rr-primary); }
		.rr-cp.rr-amber .rr-track > i { background: var(--rr-close); }
		.rr-cp.rr-fail .rr-track > i { background: var(--rr-below); }
		.rr-pct { flex: none; min-width: 4ch; font-size: 10px; font-weight: 600; line-height: 1.3; text-align: right; color: var(--rr-primary-fg); font-variant-numeric: tabular-nums; white-space: nowrap; }
		.rr-cp.rr-amber .rr-pct { color: var(--rr-muted); }
		.rr-cp.rr-fail .rr-pct { color: var(--rr-below); }
		.rr-lock, .rr-item { display: flex; align-items: flex-start; gap: 4px; font-weight: 600; line-height: 1.3; }
		.rr-lock .rr-ico, .rr-item .rr-ico { margin-top: 1px; }
		.rr-lock { color: var(--rr-below); cursor: not-allowed; }
		.rr-item { color: var(--rr-close); }
		.rr-keep { white-space: nowrap; }
		/* A slot you cannot join stays covered, as before, so Torn's Join button cannot be pressed. */
		.rr-lock::before { content: ""; position: absolute; top: 0; right: 0; bottom: 0; left: 0; z-index: 40; cursor: not-allowed; }

		/* After the crime title: the success pill, filled in its band colour (on Completed, the result), and a teal
		   "Open to you" tag when the crime has a slot you can join now. */
		.rr-info { display: inline-flex; align-items: center; gap: 6px; flex: none; min-width: 0; margin: 0 6px 0 4px; }
		/* Torn's crime header may shrink, so its title ellipsises to make room for the pill instead of widening the page. */
		body.rr-oc-authorized #faction-crimes-root div[data-oc-id] [class*="panel___"] { min-width: 0; }
		.rr-success { order: 1; position: relative; box-sizing: border-box; display: inline-flex; flex: none; align-items: center; gap: 4px; margin: 0; padding: 2px 7px; border: 1px solid var(--rr-ring, var(--rr-accent)); border-radius: 3px; background: var(--rr-surface); background: color-mix(in srgb, var(--rr-ring, var(--rr-accent)) 16%, var(--rr-surface)); color: var(--rr-muted) !important; font-family: var(--rr-font); font-size: 11px; font-weight: 600; font-style: normal; line-height: 1.3; text-align: left; text-transform: none; text-shadow: none; letter-spacing: normal; white-space: nowrap; vertical-align: middle; cursor: default; }
		.rr-success[data-band="ok"] { --rr-band: var(--rr-ok); --rr-ring: #029E7A; }
		.rr-success[data-band="close"] { --rr-band: var(--rr-close); --rr-ring: #DB7B2B; }
		.rr-success[data-band="below"] { --rr-band: var(--rr-below); --rr-ring: #CC3232; }
		.rr-success[data-band="none"] { --rr-band: var(--rr-none); --rr-ring: #8A8D93; }
		.rr-pv { color: var(--rr-band, var(--rr-none)); font-size: 12px; font-weight: 800; font-variant-numeric: tabular-nums; }
		.rr-success .rr-ico { color: var(--rr-band, var(--rr-none)); }
		.rr-join { order: 2; box-sizing: border-box; display: inline-flex; flex: none; align-items: center; gap: 6px; margin: 0; padding: 2px 7px; border-radius: 3px; background: #029E7A; color: #04211a !important; font-family: var(--rr-font); font-size: 11px; font-weight: 700; font-style: normal; line-height: 1.3; text-transform: none; letter-spacing: normal; white-space: nowrap; vertical-align: middle; }
		.rr-join .rr-mark { background: currentColor; }
		/* Phones: the pill drops the word "Success" and the tag shortens to "Open" (both kept for screen readers). */
		@media (max-width: 480px) { .rr-pl, .rr-join-more { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; } }

		/* Settings: a side panel on the right. The header stays put and the body scrolls. */
		.rr-set-backdrop { position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 999990; background: rgba(0, 0, 0, .5); }
		.rr-set-layer { position: fixed; top: 64px; bottom: 64px; right: 0; z-index: 999991; display: flex; width: min(380px, 100%); }
		.rr-panel { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; max-height: 100%; overflow: hidden; background: var(--rr-surface); border-left: 1px solid var(--rr-line); box-shadow: var(--rr-shadow), inset 0 1px 0 rgba(201, 169, 92, .35); color: var(--rr-text); }
		.rr-panel-head { flex: none; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px; border-bottom: 1px solid var(--rr-line); }
		.rr-panel-crest { display: flex; align-items: center; gap: 8px; min-width: 0; }
		.rr-panel-crest .rr-skull { width: 32px; height: 32px; }
		.rr-panel-titles { display: flex; flex-direction: column; min-width: 0; line-height: 1.15; }
		.rr-panel-brand { font-size: 10.5px; font-weight: 600; letter-spacing: .02em; color: var(--rr-accent-fg); }
		.rr-set h2.rr-panel-title { margin: 0; font-size: 15px; font-weight: 800; line-height: 1.2; color: var(--rr-text); }
		.rr-panel-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 16px 16px; }
		.rr-set .rr-sec { display: grid; gap: 12px; padding: 16px 0; border-top: 1px solid var(--rr-line); }
		.rr-set .rr-sec:first-child { border-top: 0; }
		.rr-set h3.rr-sec-head { margin: 0; font-size: 13px; font-weight: 700; line-height: 1.3; color: var(--rr-text); }
		.rr-group { display: grid; gap: 8px; }
		.rr-set h4.rr-eyebrow { margin: 0; font-size: 10.5px; font-weight: 600; line-height: 1.3; letter-spacing: .02em; color: var(--rr-accent-fg); }
		.rr-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 32px; padding: 0 12px; border: 1px solid transparent; border-radius: 4px; font-size: 12px; font-weight: 700; line-height: 1; white-space: nowrap; }
		.rr-btn--primary { background: var(--rr-primary); color: var(--rr-on-primary) !important; }
		.rr-btn--primary:hover { filter: brightness(1.08); }
		.rr-btn--ghost { background: transparent; border-color: var(--rr-line); color: var(--rr-text); }
		.rr-btn--ghost:hover { border-color: var(--rr-accent); }
		.rr-btn--icon { flex: none; width: 32px; height: 32px; padding: 0; background: transparent; border-color: var(--rr-accent); color: var(--rr-accent-fg); }
		.rr-btn--icon:hover { background: var(--rr-surface-2); }
		.rr-set .rr-key { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--rr-line); border-radius: 6px; background: var(--rr-surface-2); }
		.rr-set .rr-set-status { --rr-dot: var(--rr-none); display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; color: var(--rr-text); }
		.rr-set-status::before { content: ""; flex: none; width: 8px; height: 8px; border-radius: 999px; background: var(--rr-dot); box-shadow: 0 0 0 3px var(--rr-line); box-shadow: 0 0 0 3px color-mix(in srgb, var(--rr-dot) 22%, transparent); }
		.rr-set-status[data-state="ok"] { --rr-dot: var(--rr-ok); }
		.rr-set-status[data-state="bad"] { --rr-dot: var(--rr-below); }
		.rr-set-status[data-state="wait"] { --rr-dot: var(--rr-close); }
		.rr-set .rr-key-label { margin-top: 4px; font-size: 11px; font-weight: 600; color: var(--rr-muted); }
		.rr-set .rr-key-input { display: block; width: 100%; min-width: 0; height: 32px; margin: 0; padding: 0 12px; border: 1px solid var(--rr-line); border-radius: 4px; background: var(--rr-surface); color: var(--rr-text); font-size: 12px; font-variant-numeric: tabular-nums; box-shadow: none; }
		.rr-key-input::placeholder { color: var(--rr-muted); opacity: 1; }
		.rr-key-input:hover, .rr-key-input:focus { border-color: var(--rr-accent); }
		.rr-set .rr-key-input[data-bad="1"] { border-color: var(--rr-below); }
		.rr-key-actions { display: flex; flex-wrap: wrap; gap: 8px; }
		/* Phones zoom into inputs smaller than 16px when they take focus. */
		@media (pointer: coarse) { .rr-set .rr-key-input { font-size: 16px; } }
		.rr-choices { display: grid; padding: 4px; border: 1px solid var(--rr-line); border-radius: 6px; background: var(--rr-surface); }
		.rr-set .rr-choice { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) 16px; align-items: center; gap: 8px; min-height: 40px; padding: 4px 8px; border-radius: 4px; cursor: pointer; }
		.rr-choice:hover { background: var(--rr-surface-2); }
		.rr-choice input { position: absolute; width: 1px; height: 1px; margin: 0; opacity: 0; pointer-events: none; }
		.rr-choice:focus-within { outline: 2px solid var(--rr-accent); outline-offset: -2px; }
		.rr-choice-name { font-size: 12.5px; font-weight: 700; color: var(--rr-text); }
		.rr-choice-check { display: flex; color: var(--rr-primary-fg); visibility: hidden; }
		.rr-choice input:checked ~ .rr-choice-check { visibility: visible; }
		.rr-set .rr-version { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12px; font-weight: 600; color: var(--rr-muted); }
		.rr-chip { flex: none; padding: 0 4px; border: 1px solid var(--rr-accent); border-radius: 3px; color: var(--rr-accent-fg); font-size: 10.5px; font-weight: 600; line-height: 18px; font-variant-numeric: tabular-nums; white-space: nowrap; }
		.rr-set .rr-keyuse { display: block; padding: 8px 0; }
		.rr-set .rr-keyuse-sum { display: flex; align-items: center; gap: 8px; min-height: 40px; border-radius: 4px; list-style: none; cursor: pointer; font-size: 13px; font-weight: 700; color: var(--rr-text); }
		.rr-keyuse-sum::-webkit-details-marker { display: none; }
		.rr-keyuse-sum .rr-ico { color: var(--rr-muted); }
		.rr-keyuse-sum:hover .rr-keyuse-chev { color: var(--rr-accent-fg); }
		.rr-keyuse-chev { margin-left: auto; transition: transform .15s ease; }
		.rr-keyuse[open] .rr-keyuse-chev { transform: rotate(180deg); }
		.rr-set .rr-keyuse-notes { display: grid; gap: 8px; margin-top: 8px; padding: 12px; border-radius: 6px; background: var(--rr-sunken); }
		.rr-keyuse-note { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 4px 12px; }
		.rr-set .rr-keyuse-term { font-size: 12px; font-weight: 600; color: var(--rr-text); }
		.rr-set .rr-keyuse-text { font-size: 11px; line-height: 1.45; color: var(--rr-muted); }
		@media (prefers-reduced-motion: reduce) { .rr-toolbar *, .rr-set * { transition: none !important; } }
	`;

	// The Torn id of the member in a slot, from its profile link.
	const xidOf = (wrap) => q(wrap, 'a[href*="profiles.php?XID="]')?.href.match(/XID=(\d+)/)?.[1] || null;

	function parsePanel(panel) {
		const title = q(panel, sel("panelTitle"))?.textContent.trim() || "";
		const slugEl = q(panel, '[style*="organizedCrimes/scenario"]');
		const slug =
			slugEl?.getAttribute("style")?.match(/scenario\/([a-z0-9_]+)\//)?.[1] ||
			null;
		const level = parseInt(q(panel, sel("levelValue"))?.textContent || "0", 10);

		const slots = qa(panel, sel("slotHeader")).map((header) => {
			const wrap = header.parentElement;
			const role = q(header, sel("title"))?.textContent.trim() || "";
			const chance = parseFloat(q(header, sel("successChance"))?.textContent || "");
			return { wrap, header, role, chance: isNaN(chance) ? null : chance, xid: xidOf(wrap) };
		});
		return { panel, ocId: panel.getAttribute("data-oc-id"), title, level, slug, slots };
	}

	const infoRows = new Map(); // ocId -> its success row, put back under the title if React moves it out
	const nativeContents = new Map();
	const nativePositions = new Map();
	const sameChildren = (node, children) => node.childNodes.length === children.length && children.every((child, i) => node.childNodes[i] === child);
	const ownsNativeContents = (node, record) => sameChildren(node, record.applied) && node.innerHTML === record.markup;

	function editNativeContents(node, update) {
		let record = nativeContents.get(node);
		if (!record || !ownsNativeContents(node, record)) record = { original: Array.from(node.childNodes) };
		update();
		record.applied = Array.from(node.childNodes);
		record.markup = node.innerHTML;
		nativeContents.set(node, record);
	}

	function restoreNativeEdits(root) {
		for (const [node, record] of nativeContents) {
			if (root !== document && root !== node && !root.contains(node)) continue;
			if (ownsNativeContents(node, record)) { node.textContent = ""; node.append(...record.original); } // replaceChildren needs iOS 14
			nativeContents.delete(node);
		}
		for (const [node, original] of nativePositions) {
			if (root !== document && root !== node && !root.contains(node)) continue;
			if (node.style.position === "relative" && !node.style.getPropertyPriority("position")) {
				if (original.value) node.style.setProperty("position", original.value, original.priority);
				else node.style.removeProperty("position");
			}
			nativePositions.delete(node);
		}
	}

	function guardPresence() {
		for (const [ocId, row] of infoRows) {
			const panel = document.querySelector(`div[data-oc-id="${ocId}"]`);
			const titleEl = panel && q(panel, sel("panelTitle"));
			if (titleEl && !panel.contains(row)) titleEl.after(row);
		}
	}

	// Server values reach innerHTML below, so each is reduced to a finite number or a fixed colour first: a bad or
	// compromised answer then shows "--" or grey, never markup.
	const finite = (v) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "")) && Number.isFinite(Number(v)) ? Number(v) : null;
	const safeColour = (v) => typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v) ? v : "#868e96";

	const FILL_KEY = { green: "ok", amber: "close", red: "below", grey: "none" }; // the server's fill -> Crest's label
	const FILL_WORD = { ok: "Eligible", close: "Close", below: "Below", none: "No data" };
	const BAND = { "#029e7a": "ok", "#db7b2b": "close", "#cc3232": "below" }; // the server's success colour -> Crest's band

	// The footer under a slot that holds every decoration, made on first use. Its rows are ordered by CSS, so each
	// part can be added or removed on its own.
	function footer(wrap) {
		let foot = wrap.querySelector(".rr-meta");
		if (!foot) {
			foot = el("div", "rr-meta", `<div class="rr-top"><span class="rr-fillword" hidden><span class="rr-mark" aria-hidden="true"></span><span class="rr-word"></span></span></div><div class="rr-kv"></div>`);
			wrap.appendChild(foot);
		}
		if (!wrap.classList.contains("rr-slot")) wrap.classList.add("rr-slot");
		return foot;
	}

	// key: ok | close | below | none, "pending" while a new decision is on its way, or nothing for a slot with no fill.
	function renderFill(foot, key) {
		const label = q(foot, ".rr-fillword");
		if (!label || label.dataset.k === String(key)) return;
		label.dataset.k = key;
		const word = FILL_WORD[key] || (key === "pending" ? "…" : "");
		label.hidden = !word;
		q(label, ".rr-word").textContent = word;
	}

	function renderMeta(slot, decision) {
		const w = finite(decision.weight);
		const req = finite(decision.required);
		const html =
			`<span class="rr-kvi"><span class="rr-l">Min</span><span class="rr-v">${req == null ? "--" : req}</span></span>` +
			`<span class="rr-kvi"><span class="rr-l">Weight</span><span class="rr-v">${w == null ? "--.--%" : w.toFixed(2) + "%"}</span></span>`;
		const kv = q(footer(slot.wrap), ".rr-kv");
		if (kv.innerHTML !== html) kv.innerHTML = html;
	}

	// failed is the server's decision for this slot; callers look their OC up once, not once per slot.
	function renderCheckpoint(slot, failed = false) {
		const ring = slot.wrap.querySelector(sel("planning"));
		const deg = ring && (ring.getAttribute("style") || "").match(/([\d.]+)deg/);
		failed = failed === true;
		let bar = slot.wrap.querySelector(".rr-cp");
		if (!failed && !deg) { bar?.remove(); return; }
		if (!bar) {
			bar = el("div", "rr-cp", `<div class="rr-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="Planning progress"><i></i></div><span class="rr-pct" aria-hidden="true"></span>`);
			footer(slot.wrap).appendChild(bar);
		}
		const pctNum = failed ?
			100 :
			Math.max(0, Math.min(100, Math.round(parseFloat(deg[1]) / 3.6)));
		bar.classList.toggle("rr-fail", failed);
		bar.classList.toggle("rr-amber", !failed && pctNum < 100);
		const pct = pctNum + "%", label = failed ? "Failed" : pct;
		const track = bar.firstChild, text = bar.lastChild;
		if (track.firstChild.style.width !== pct) track.firstChild.style.width = pct;
		if (track.getAttribute("aria-valuetext") !== label) { track.setAttribute("aria-valuenow", pctNum); track.setAttribute("aria-valuetext", label); }
		if (text.textContent !== label) text.textContent = label;
	}

	// One pill, keyed so an unchanged pill is never rewritten (a rewrite inside the crimes root triggers a render).
	function setPill(pill, band, label, value, result = null) {
		const key = [band, label, value, result].join("|");
		if (pill.dataset.k === key && pill.querySelector(".rr-pv")) return;
		pill.dataset.k = key;
		pill.dataset.band = band;
		pill.innerHTML = result ?
			`<span class="rr-vh">Result: </span>${icon(result === "Success" ? "check" : "close", 12)}<span class="rr-pv">${result}</span>` :
			`<span class="rr-pl">${label}<span class="rr-vh"> chance</span></span><span class="rr-pv">${value}</span>`;
	}

	// A completed crime's outcome: Torn's crime status, the server's failed flag, or the result Torn shows on the panel.
	function crimeResult(info, decision) {
		const status = String(FactionCrimes.byId?.[info.ocId]?.status || "");
		const scenario = q(info.panel, sel("scenario"));
		if (/fail/i.test(status) || decision.slots.some((s) => s.failed === true) || (scenario && q(scenario, sel("failed")))) return "Failure";
		if (/success/i.test(status) || (scenario && q(scenario, sel("success")))) return "Success";
		return null;
	}

	function renderInfoRow(info, decision) {
		const { panel, ocId } = info;
		const result = activeTab() === "Completed" ? crimeResult(info, decision) : null;
		// A slot you can join now: open (no member), not locked to you, and the server says you fit it.
		const open = !result && info.slots.some((s, i) => !s.xid && !decision.slots[i].locked && decision.slots[i].fill === "green");
		if (!decision.probability && !result && !open) { panel.querySelector(".rr-info")?.remove(); infoRows.delete(ocId); return; }
		let row = panel.querySelector(".rr-info") || el("div", "rr-info");
		const tag = row.querySelector(".rr-join");
		if (open && !tag) row.appendChild(el("span", "rr-join", `<span class="rr-mark" aria-hidden="true"></span><span>Open<span class="rr-join-more"> to you</span></span>`));
		else if (!open) tag?.remove();
		if (!decision.probability && !result) {
			row.querySelector(".rr-success")?.remove();
			if (!panel.contains(row)) q(panel, sel("panelTitle"))?.after(row);
			infoRows.set(ocId, row);
			return;
		}
		let pill = row.querySelector(".rr-success") || el("span", "rr-success");
		const success = finite(decision.success);
		const value = Analysis.error ? "unavailable" : success == null ? (decision.probability && Success.cache.has(decision.probability.key) ? "n/a" : "…") : (success * 100).toFixed(2) + "%";
		const band = result ? (result === "Success" ? "ok" : "below") : BAND[safeColour(decision.successColour).toLowerCase()] || "none";
		setPill(pill, band, "Success", value, result);
		// On Completed the result word replaces the chance; the chance stays in the pill's tooltip.
		const title = result && success != null ? `Success chance ${value}` : "";
		if (pill.title !== title) pill.title = title;
		if (!row.contains(pill)) row.appendChild(pill);
		if (!panel.contains(row)) q(panel, sel("panelTitle"))?.after(row);
		infoRows.set(ocId, row);
		const query = decision.probability;
		if (query && Success.due(query.key)) Success.get(query.scenario, query.params, scheduleRender);
	}

	const relative = (e) => {
		if (getComputedStyle(e).position === "static") {
			nativePositions.set(e, { value: e.style.position, priority: e.style.getPropertyPriority("position") });
			e.style.position = "relative";
		}
	};
	const FILL = ["rr-fill-green", "rr-fill-amber", "rr-fill-red", "rr-fill-grey"];
	const FILL_SELECTOR = FILL.map((c) => "." + c).join(", ");

	function renderStatusIcon(s, onCompleted) {
		let chip = s.wrap.querySelector(".rr-stat");
		const st = !onCompleted && s.xid && TornApi.members ?
			TornApi.statusFor(s.xid) :
			null;
		const svg = st && STATUS_ICON[st.state];
		if (!svg) { chip?.remove(); return; }
		if (!chip) { chip = el("span", "rr-stat"); q(footer(s.wrap), ".rr-top").appendChild(chip); }
		if (chip.dataset.st !== st.state) {
			chip.dataset.st = st.state;
			chip.title = STATUS_WORD[st.state];
			chip.innerHTML = svg + `<span class="rr-vh">${STATUS_WORD[st.state]}</span>`;
		}
	}

	function humanLeft(secs) {
		const d = Math.floor(secs / 86400),
			h = Math.floor((secs % 86400) / 3600),
			m = Math.floor((secs % 3600) / 60);
		if (d) return `${d}d ${h}h`;
		if (h) return `${h}h ${m}m`;
		if (m) return `${m}m`;
		return `${secs}s`;
	}

	function slotWrapOf(elm) {
		for (let e = elm; e && e !== document.body; e = e.parentElement) {
			if (e.querySelector?.(`:scope > ${sel("slotHeader")}`)) return e;
		}
		return null;
	}

	function tooltipNode(node) {
		if (!(node instanceof Element)) return null;
		if (node.matches('[class*="tooltip___"]') || node.hasAttribute("data-floating-ui-focusable")) { return node; }
		return node.querySelector?.('[class*="tooltip___"]') || null;
	}

	function tooltipTrigger(tip) {
		if (tip.id) { const ref = document.querySelector(`[aria-describedby~="${tip.id}"]`); if (ref) return ref; }
		const opened = document.querySelector(`${sel("slotHeader")}[data-is-tooltip-opened="true"]`);
		if (opened) return opened;
		return [...document.querySelectorAll(":hover")].pop() || null;
	}

	function statusText(st) {
		if (!st || !STATUS_ICON[st.state]) return null;
		if (st.state === "Okay") return "Available";
		if (TIMED_STATES.includes(st.state) && st.until) {
			// Torn's release time is read against the server's clock, not this PC's.
			const serverNow = ServerTime.estimate();
			if (serverNow == null) return st.state;
			const left = st.until - Math.floor(serverNow / 1000);
			return left > 0 ? `${st.state} — out in ${humanLeft(left)}` : st.state;
		}
		if (st.state === "Traveling" || st.state === "Abroad") { return st.description || st.state; }
		return null;
	}

	function applyTooltipStatus(tip) {
		if (!tip.isConnected || !Gate.pass() || !TornApi.members) return;
		const wrap = slotWrapOf(tooltipTrigger(tip));
		if (!wrap) return;
		const xid = xidOf(wrap);
		const st = xid && TornApi.statusFor(xid);
		const text = st && statusText(st);
		if (!text) return;
		const top = qa(tip, sel("section"))[0];
		if (!top) return;
		const iconDiv = q(top, sel("icon"));
		const textEl = [...top.children].find((c) => c !== iconDiv) || top;
		if (textEl.textContent === text) return; // idempotent — icon set alongside, avoids a loop
		// overwrite Torn's planning row with our status icon + text
		editNativeContents(textEl, () => { textEl.textContent = text; });
		if (iconDiv && STATUS_ICON[st.state]) editNativeContents(iconDiv, () => { iconDiv.innerHTML = STATUS_ICON[st.state]; });
	}

	// Tooltip is React-managed and re-renders (e.g. live planning %); reapplying inside the observer callback runs pre-paint, so there's no flicker.
	function augmentTooltip(tip) {
		const apply = () => safe("tooltip", () => applyTooltipStatus(tip));
		if (tip.__rrObs) { apply(); return; }
		tip.__rrObs = new MutationObserver(apply);
		apply();
		tip.__rrObs.observe(tip, { childList: true, subtree: true, characterData: true });
	}

	function renderSlotState(info, decision, tab) {
		info.slots.forEach((s, i) => {
			const d = decision.slots[i];
			s.header.classList.add("rr-role");
			s.header.classList.toggle("rr-item-missing", d.itemMissing);
			renderStatusIcon(s, tab === "Completed");
			for (const fill of FILL) s.wrap.classList.toggle(fill, fill === "rr-fill-" + d.fill);
			const foot = footer(s.wrap);
			renderFill(foot, FILL_KEY[d.fill]);
			let lock = s.wrap.querySelector(".rr-lock");
			if (d.locked) {
				relative(s.wrap); // the lock line's cover spans the whole slot, as before
				const required = finite(d.required), need = String(required == null ? "--" : required);
				if (!lock) { lock = el("div", "rr-lock"); foot.appendChild(lock); }
				if (lock.dataset.need !== need) {
					lock.dataset.need = need;
					lock.innerHTML = `${icon("lock", 12)}<span>Not eligible: <span class="rr-keep">needs ${need}+</span></span>`;
				}
			} else lock?.remove();
			const item = foot.querySelector(".rr-item");
			if (d.itemMissing && !item) foot.appendChild(el("div", "rr-item", `${icon("warn", 12)}<span>Missing item</span>`));
			else if (!d.itemMissing) item?.remove();
		});
	}

	function activeTab() {
		const btn = document.querySelector(`${sel("buttonsContainer")} button${sel("active")}`);
		return btn ? q(btn, sel("tabName"))?.textContent.trim() || null : null;
	}

	function listContainer() { return document.querySelector("div[data-oc-id]")?.parentElement || null; }

	const SORT_LABELS = { default: "Torn order", "success-desc": "Best success first", "success-asc": "Lowest success first", "level-desc": "Highest level first", "level-asc": "Lowest level first" };
	const SORT_OPTIONS = Object.keys(SORT_LABELS);
	const GATE = {
		nokey: ["key", "Add your Torn API key to start"],
		denied: ["lock", "Access restricted to Ruthless Reborn members"],
		unavailable: ["warn", "Authorization unavailable"],
		verifying: ["info", "Verifying access…"],
	};
	// The script's own words on how the key is used, shown behind a closed disclosure in settings.
	const KEY_NOTES = [
		["Storage", "Your key stays on this device. The RR server keeps only a one-way fingerprint of it, for at most 4 minutes, and never stores or logs the key itself."],
		["Sharing", "Sent to the RR server (membership check) and to ZZCraft (OC thresholds, sent as an X-Api-Key header)."],
		["Purpose", "Ruthless Reborn faction organised crime planning."],
		["Key storage", "Your userscript manager's storage, or TornPDA's storage."],
		["Access level", "Public Access key only."],
	];
	const sortRows = (name, rowCls, nameCls, tickHtml) => SORT_OPTIONS.map((v) =>
		`<label class="${rowCls}"><input type="radio" class="rr-vh" name="${name}" value="${v}"${v === Toolbar.state.sort ? " checked" : ""}>` +
		`<span${nameCls ? ` class="${nameCls}"` : ""}>${SORT_LABELS[v]}</span>${tickHtml}</label>`).join("");

	// The toolbar's Sort pop-up and the settings list both drive the same sort choice, storage and re-render.
	function setSort(value) {
		if (!SORT_OPTIONS.includes(value)) return;
		Toolbar.state.sort = value;
		storeSet("rr_oc_sort", value);
		qa(document, ".rr-tvalue").forEach((n) => { if (n.textContent !== SORT_LABELS[value]) n.textContent = SORT_LABELS[value]; });
		qa(document, 'input[name^="rr-oc-sort"]').forEach((r) => { r.checked = r.value === value; });
		scheduleRender();
	}

	async function applyApiKey(value) {
		if (apiKeyChanging) throw new Error("API key change already in progress");
		apiKeyChanging = true;
		try {
			Gate.reset();
			onGateChange();
			await secureDelete(SESSION_STORAGE);
			await saveApiKey(value);
		} finally { apiKeyChanging = false; }
		onGateChange();
		void Gate.refresh();
	}

	let settingsEscapeHandler = null;
	let settingsTrigger = null;
	let settingsGateHook = null;
	let setupPrompted = false;

	function closeSettings() {
		document.getElementById("rr-oc-settings")?.remove();
		settingsGateHook = null;
		if (settingsEscapeHandler) {
			document.removeEventListener("keydown", settingsEscapeHandler);
			settingsEscapeHandler = null;
		}
		const trigger = settingsTrigger;
		settingsTrigger = null;
		if (trigger && trigger.isConnected) trigger.focus();
	}

	function openSettings(trigger) {
		const existing = document.getElementById("rr-oc-settings");
		if (existing) { q(existing, ".rr-key-input")?.focus(); return; }
		settingsTrigger = trigger || document.activeElement;

		const root = el("div", "rr-set", `
			<div class="rr-set-backdrop"></div>
			<div class="rr-set-layer" role="dialog" aria-modal="true" aria-labelledby="rr-oc-settings-title">
				<section class="rr-panel">
					<header class="rr-panel-head">
						<div class="rr-panel-crest"><img class="rr-skull" src="${SKULL}" width="32" height="32" alt="" draggable="false">
							<span class="rr-panel-titles"><span class="rr-panel-brand">Ruthless Reborn</span><h2 class="rr-panel-title" id="rr-oc-settings-title">OC Autopilot settings</h2></span></div>
						<button type="button" class="rr-btn rr-btn--icon rr-set-close" aria-label="Close settings">${icon("close", 16)}</button>
					</header>
					<div class="rr-panel-body">
						<section class="rr-sec" aria-labelledby="rr-oc-set-access">
							<h3 class="rr-sec-head" id="rr-oc-set-access">Access</h3>
							<div class="rr-key">
								<p class="rr-set-status" id="rr-oc-key-status" role="status">No API key set</p>
								<label class="rr-key-label" for="rr-oc-key">Torn API key</label>
								<input type="password" class="rr-key-input" id="rr-oc-key" placeholder="Public Access key" autocomplete="off" spellcheck="false" title="16 or 50 alphanumeric characters" aria-describedby="rr-oc-key-status">
								<div class="rr-key-actions">
									<button type="button" class="rr-btn rr-btn--primary" data-action="save">${icon("check", 14)}Save key</button>
									<button type="button" class="rr-btn rr-btn--ghost" data-action="remove">Remove key</button>
								</div>
							</div>
						</section>
						<section class="rr-sec" aria-labelledby="rr-oc-set-oc">
							<h3 class="rr-sec-head" id="rr-oc-set-oc">OC Autopilot</h3>
							<div class="rr-group"><h4 class="rr-eyebrow" id="rr-oc-set-sort">Sort crimes by</h4>
								<div class="rr-choices" role="radiogroup" aria-labelledby="rr-oc-set-sort">${sortRows("rr-oc-sort-set", "rr-choice", "rr-choice-name", `<span class="rr-choice-check">${icon("check", 16)}</span>`)}</div></div>
						</section>
						<p class="rr-sec rr-version"><span>OC Autopilot</span><span class="rr-chip">v${VERSION}</span></p>
						<details class="rr-sec rr-keyuse">
							<summary class="rr-keyuse-sum">${icon("key", 16)}<span>How your API key is used</span>${icon("chevron", 16, "rr-keyuse-chev")}</summary>
							<dl class="rr-keyuse-notes">${KEY_NOTES.map(([term, text]) => `<div class="rr-keyuse-note"><dt class="rr-keyuse-term">${term}</dt><dd class="rr-keyuse-text">${text}</dd></div>`).join("")}</dl>
						</details>
					</div>
				</section>
			</div>
		`);
		root.id = "rr-oc-settings";
		const backdrop = q(root, ".rr-set-backdrop");
		const input = q(root, ".rr-key-input");
		const status = q(root, ".rr-set-status");
		input.value = apiKey();

		const setStatus = (text, state = "") => { status.textContent = text; status.dataset.state = state; };
		settingsGateHook = () => {
			if (!input.isConnected || !validApiKey(input.value.trim())) return;
			if (Gate.pass()) setStatus("Valid and authorised", "ok");
			else if (Gate.state === "denied") setStatus("Access restricted", "bad");
			else if (Gate.nextTryAt > nowMs()) setStatus("Authorization unavailable", "wait");
			else setStatus("Verifying access…", "wait");
		};
		if (validApiKey(apiKey())) {
			setStatus(Gate.pass() ? "Valid and authorised" : "API key configured", Gate.pass() ? "ok" : "");
		}

		input.addEventListener("input", () => input.removeAttribute("data-bad"));
		const save = async () => {
			const value = input.value.trim();
			if (value && !validApiKey(value)) {
				input.dataset.bad = "1";
				setStatus("Keys are 16 or 50 alphanumeric characters", "bad");
				return;
			}
			setStatus("Saving…", "wait");
			try {
				await applyApiKey(value);
				if (!value) setStatus("No API key set", "");
				else if (!Gate.pass() && Gate.state !== "denied") { setStatus("Key saved; verifying…", "wait"); }
			} catch (e) { input.dataset.bad = "1"; setStatus("Protected storage unavailable", "bad"); }
		};

		root.addEventListener("click", event => {
			const action = event.target?.closest?.("[data-action]")?.getAttribute("data-action");
			if (action === "save") void save();
			else if (action === "remove") {
				input.value = "";
				setStatus("Removing…", "wait");
				void applyApiKey("")
					.then(() => setStatus("Key removed", ""))
					.catch(() => setStatus("Protected storage unavailable", "bad"));
			}
		});
		root.addEventListener("change", event => { if (event.target.name === "rr-oc-sort-set") setSort(event.target.value); });
		input.addEventListener("keydown", event => { if (event.key === "Enter") void save(); });
		q(root, ".rr-set-close").addEventListener("click", closeSettings);

		// Only a click that starts and ends on the backdrop closes, so selecting text in the panel never does.
		let downOnBackdrop = false;
		root.addEventListener("mousedown", event => { downOnBackdrop = event.target === backdrop; });
		backdrop.addEventListener("click", () => { if (downOnBackdrop) closeSettings(); });
		settingsEscapeHandler = event => { if (event.key === "Escape") closeSettings(); };
		document.addEventListener("keydown", settingsEscapeHandler);

		document.body.appendChild(root);
		input.focus();
	}

	function promptForApiKey() {
		if (setupPrompted || validApiKey(apiKey())) return;
		setupPrompted = true;
		openSettings(document.querySelector(".rr-gear"));
	}

	// The Sort pop-up: native radios behind a compact trigger; outside click and Esc close it.
	function wireSortPicker(bar) {
		const trigger = q(bar, ".rr-trigger"), list = q(bar, ".rr-list"), picker = q(bar, ".rr-sort");
		const close = (focus) => {
			if (list.hidden) return;
			list.hidden = true;
			trigger.setAttribute("aria-expanded", "false");
			document.removeEventListener("click", outside, true);
			document.removeEventListener("keydown", onKey, true);
			if (focus && trigger.isConnected) trigger.focus();
		};
		const outside = (event) => { if (!picker.contains(event.target)) close(false); };
		const onKey = (event) => { if (event.key === "Escape") { event.stopPropagation(); close(true); } };
		trigger.addEventListener("click", () => {
			if (!list.hidden) { close(false); return; }
			list.hidden = false;
			trigger.setAttribute("aria-expanded", "true");
			q(list, "input:checked")?.focus({ preventScroll: true });
			document.addEventListener("click", outside, true);
			document.addEventListener("keydown", onKey, true);
		});
		list.addEventListener("change", (event) => { setSort(event.target.value); close(true); });
	}

	const Toolbar = {
		state: { sort: ((s) => SORT_OPTIONS.includes(s) ? s : "default")(storeGet("rr_oc_sort")) },
		gateKind() {
			if (!apiKey()) return "nokey";
			return Gate.state === "denied" ? "denied" : Gate.nextTryAt > nowMs() ? "unavailable" : "verifying";
		},
		// The gated bar follows the access state; on Completed it keeps the shorter Completed height.
		updateGate(bar, tab) {
			const kind = this.gateKind();
			const cls = `rr-bar rr-gate--${kind}${tab === "Completed" ? " rr-short" : ""}`;
			const section = bar.firstElementChild;
			if (section.className !== cls) section.className = cls;
			const msg = q(bar, ".rr-gate");
			if (msg.dataset.kind !== kind) {
				msg.dataset.kind = kind;
				msg.innerHTML = `${icon(GATE[kind][0], 16, "rr-gate-icon")}<span class="rr-auth-state">${GATE[kind][1]}</span>`;
			}
		},
		ensure(tab, gateOnly = false) {
			const mode = gateOnly ? "gate" : tab === "Completed" ? "completed" : "full";
			let bar = document.querySelector(".rr-toolbar");
			if (bar && bar.dataset.mode !== mode) { bar.remove(); bar = null; }
			const allowed = gateOnly ?
				!!listContainer() :
				tab === "Recruiting" || tab === "Planning" || tab === "Completed";
			if (!allowed) { bar?.remove(); return; }
			if (bar) {
				if (gateOnly) this.updateGate(bar, tab);
				return;
			}
			const list = listContainer();
			if (!list) return;
			bar = el("div", "rr-toolbar");
			bar.dataset.mode = mode;
			const brand = `<div class="rr-brand"><img class="rr-skull" src="${SKULL}" width="24" height="24" alt="" draggable="false">` +
				`<span class="rr-titles"><span class="rr-kicker">Ruthless Reborn</span><span class="rr-name">OC Autopilot</span></span></div>`;
			const gear = `<button class="rr-gear" type="button" title="Settings" aria-label="Open settings">${icon("settings", 18)}</button>`;
			const sort = `<div class="rr-sort"><button type="button" class="rr-trigger" aria-controls="rr-oc-sort-list" aria-expanded="false">${icon("sort", 16, "rr-ticon")}` +
				`<span class="rr-ttext"><span class="rr-tlabel">Sort</span><span class="rr-tvalue">${SORT_LABELS[this.state.sort]}</span></span>${icon("chevron", 14, "rr-chev")}</button>` +
				`<div class="rr-list" id="rr-oc-sort-list" hidden><p class="rr-list-head" id="rr-oc-sort-head">Sort crimes</p>` +
				`<div class="rr-options" role="radiogroup" aria-labelledby="rr-oc-sort-head">${sortRows("rr-oc-sort-bar", "rr-option", "", icon("check", 14, "rr-tick"))}</div></div></div>`;
			const legend = `<ul class="rr-cell rr-legend" aria-label="Slot colours">` +
				Object.keys(FILL_WORD).map((k) => `<li class="rr-lkey" data-fill="${k}"><span class="rr-mark" aria-hidden="true"></span>${FILL_WORD[k]}</li>`).join("") + `</ul>`;
			// The count line also says how many OCs were left out of the analysis, on every tab.
			bar.innerHTML = `<section class="rr-bar${mode === "completed" ? " rr-short" : ""}" aria-label="OC Autopilot">${brand}` + (mode === "gate" ?
				`<p class="rr-cell rr-gate" role="status"></p><div class="rr-tools">${gear}</div>` :
				`<div class="rr-cell rr-count"></div>` + (mode === "completed" ? `<div class="rr-tools">${gear}</div>` : `${legend}<div class="rr-tools">${sort}${gear}</div>`)) +
				`</section>`;
			list.before(bar);
			if (mode === "gate") this.updateGate(bar, tab);
			else if (mode === "full") wireSortPicker(bar);
			const gearBtn = bar.querySelector(".rr-gear");
			const onGear = event => { event.preventDefault(); event.stopPropagation(); openSettings(gearBtn); };
			gearBtn.addEventListener("mousedown", onGear);
			gearBtn.addEventListener("click", onGear);
		},
	};

	function applyVisibility() {
		const panels = qa(document, "div[data-oc-id]");
		const list = listContainer();
		const sorting = Toolbar.state.sort !== "default";
		if (list) { list.style.display = sorting ? "flex" : ""; list.style.flexDirection = sorting ? "column" : ""; }
		for (const panel of panels) {
			if (sorting && panel.getAttribute("aria-busy") === "true") continue;
			const i = Analysis.result?.order.indexOf(panel.getAttribute("data-oc-id")) ?? -1;
			panel.style.order = sorting ? String(i >= 0 ? i : MAX_PANELS) : "";
		}
		const countEl = document.querySelector(".rr-count");
		if (countEl) {
			const n = Analysis.result?.joinable, total = panels.length, skipped = Analysis.skipped;
			const plain = (text, cls) => `<p class="rr-main ${cls}">${text}</p>`;
			const html = Analysis.rejected ? plain("Analysis rejected – update the script", "rr-warn") :
				!Analysis.result ? plain(Analysis.nextTryAt > nowMs() ? "Analysis unavailable; retrying..." : "Loading decisions...", "rr-quiet") :
				Analysis.error ? plain("Decision refresh unavailable; retrying...", "rr-quiet") :
				`<p class="rr-main">${countEl.closest(".rr-toolbar")?.dataset.mode === "completed" || !Number.isFinite(n) ?
					`<b class="rr-num">${total}</b> ${total === 1 ? "crime" : "crimes"}` :
					`<b class="rr-num${n > 0 ? " rr-go" : ""}">${n}</b> of <b class="rr-num">${total}</b> open to you`}</p>` +
				(skipped > 0 ? `<p class="rr-sub">${skipped} not analysed</p>` : "");
			if (countEl.rrHtml !== html) { countEl.rrHtml = html; countEl.innerHTML = html; }
		}
	}

	const clip = (v) => typeof v === "string" ? v.slice(0, 160) : "";
	const digits = (v) => typeof v === "string" && /^\d{1,20}$/.test(v) ? v : null;
	const byteLength = (text) => new TextEncoder().encode(text).length;

	// One OC as the server reads it, trimmed to the server's limits so one odd panel cannot void the
	// whole request. The slot icon is sent only as the failure marker the server looks for.
	function panelInput(info) {
		if (!digits(info.ocId)) return null;
		const crime = FactionCrimes.byId?.[info.ocId];
		const item = (r) => r && typeof r === "object" ? { is_available: typeof r.is_available === "boolean" ? r.is_available : null } : null;
		return { ocId: info.ocId, title: clip(info.title), slug: info.slug ? clip(info.slug) : null,
			level: Number.isFinite(info.level) && info.level >= 0 && info.level <= 100 ? info.level : 0,
			crime: crime ? { status: clip(String(crime.status ?? "")), slots: (Array.isArray(crime.slots) ? crime.slots : []).slice(0, 20)
				.map(s => ({ position: clip(String(s?.position ?? "")), item_requirement: item(s?.item_requirement) })) } : null,
			hasCrimes: FactionCrimes.byId !== null,
			slots: info.slots.slice(0, 20).map(s => {
				const icon = s.xid && !s.wrap.querySelector(sel("planning")) ? s.wrap.querySelector(sel("slotIcon"))?.innerHTML || "" : "";
				return { role: clip(s.role), chance: s.chance !== null && s.chance >= 0 && s.chance <= 100 ? s.chance : null, xid: digits(s.xid),
					domFailed: !!s.wrap.closest(sel("failed")), glyph: /#ff794c/i.test(icon) && /3\.729/.test(icon) ? "#ff794c 3.729" : "" };
			}) };
	}

	// A request fingerprint without its success chances: equal fingerprints here differ only in chances.
	const sansChances = (input) => JSON.stringify({ ...input, probabilities: {} });

	const Analysis = {
		fingerprint: null, sans: null, result: null, pending: null, nextTryAt: 0, error: false,
		sentAt: -Infinity, batchTimer: null, // last request sent; a pending batch of success chances
		context: null, observations: new Map(),
		rejected: null, // the request the server refused as invalid; it is not sent again
		skipped: 0, // OCs on the page left out of the request (past the server's limits)
		// The last decisions for each tab (context) seen on this page. Switching back to a tab redraws them at once;
		// OCs whose page data changed since lose theirs and are asked for again, as on any refresh.
		remembered: new Map(),
		reset() {
			this.fingerprint = null; this.sans = null; this.result = null; this.pending = null; this.nextTryAt = 0; this.error = false;
			this.context = null; this.observations = new Map(); this.rejected = null; this.skipped = 0; this.remembered.clear();
		},
		remember() {
			if (!this.result || !this.context) return;
			this.remembered.delete(this.context);
			this.remembered.set(this.context, { result: this.result, observations: new Map(this.observations), fingerprint: this.fingerprint, sans: this.sans });
			while (this.remembered.size > 6) this.remembered.delete(this.remembered.keys().next().value);
		},
		recall(input) {
			const context = this.contextFor(input);
			if (this.context === context) return false;
			const saved = this.remembered.get(context);
			if (!saved) return false;
			this.result = saved.result; this.observations = new Map(saved.observations); this.fingerprint = saved.fingerprint; this.sans = saved.sans;
			this.context = context; this.error = false;
			return true;
		},
		// Thresholds and role names are not part of the context: when they arrive, the decisions already drawn stay up
		// until the answer that uses them replaces them, rather than every OC blanking at once.
		contextFor(input) { return JSON.stringify([location.href, input.tab]); },
		// What the page itself shows for an OC. Crime data arriving or changing re-asks the server, but does not
		// blank the OC meanwhile.
		pageView(panel) { return JSON.stringify({ ...panel, crime: null, hasCrimes: null }); },
		// What an OC needs, apart from who fills it: when this changes its drawn requirements are blanked too.
		requirements(p) { return JSON.stringify([p.title, p.slug, p.level, p.slots.map(s => s.role)]); },
		// Kept per OC once answered, as strings, so each render compares without re-reading JSON.
		observe(panel) { return { view: this.pageView(panel), requirements: this.requirements(panel) }; },
		input(infos, tab) {
			const panels = [], seen = new Set();
			for (const info of infos) {
				const panel = panelInput(info);
				if (panel && !seen.has(panel.ocId) && panels.length < MAX_PANELS) { seen.add(panel.ocId); panels.push(panel); }
			}
			const input = { tab: tab === null ? null : clip(tab), sort: Toolbar.state.sort, config: Config.data, roles: Success.roles, probabilities: {}, panels: [] };
			if (this.context === this.contextFor(input)) {
				for (const panel of panels) {
					const before = this.observations.get(panel.ocId);
					if (!before || before.view !== this.pageView(panel)) continue;
					const key = this.result?.panels.find(p => p.ocId === panel.ocId)?.probability?.key;
					if (key && Success.cache.has(key)) input.probabilities[key] = Success.cache.get(key);
				}
			}
			// Within the server's size limit the first OCs are sent; any after them are left undecided.
			let room = MAX_REQUEST_BYTES - byteLength(JSON.stringify(input));
			for (const panel of panels) {
				room -= byteLength(JSON.stringify(panel)) + 1;
				if (room < 0) break;
				input.panels.push(panel);
			}
			this.skipped = infos.length - input.panels.length;
			return input;
		},
		reconcile(infos, input) {
			if (!this.result) return;
			const sameContext = this.context === this.contextFor(input);
			const keep = new Set();
			for (const panel of input.panels) {
				const before = this.observations.get(panel.ocId);
				if (sameContext && before && before.view === this.pageView(panel)) { keep.add(panel.ocId); continue; }
				const same = sameContext && !!before && before.requirements === this.requirements(panel);
				for (const info of infos) if (info.ocId === panel.ocId) clearPanelDecision(info.panel, same);
			}
			const panels = this.result.panels.filter(p => keep.has(p.ocId));
			if (panels.length !== this.result.panels.length) {
				this.result = panels.length ? { ...this.result, panels, order: this.result.order.filter(id => keep.has(id)), joinable: null } : null;
				this.fingerprint = null;
			}
		},
		async ensure(infos, tab) {
			if (!Gate.pass()) return;
			let input = this.input(infos, tab);
			// Back on a tab seen before: its remembered decisions are drawn now, before any request.
			if (this.recall(input)) { input = this.input(infos, tab); this.reconcile(infos, input); this.draw(infos, tab); }
			const fp = JSON.stringify(input);
			this.reconcile(infos, input);
			// Decisions already held stay drawn while a request is out, cooling down or refused.
			if ((this.result && fp === this.fingerprint) || this.pending || nowMs() < this.nextTryAt || fp === this.rejected) {
				this.draw(infos, tab);
				return;
			}
			// Success chances land one at a time as their queue drains. While it is still draining and only they changed,
			// they are sent together at most every PROBABILITY_BATCH_MS instead of re-sending the whole page for each
			// one; chances already known (nothing left to fetch) go at once.
			const wait = this.sentAt + PROBABILITY_BATCH_MS - nowMs();
			if (this.result && this.fingerprint && wait > 0 && Success.draining() && sansChances(input) === this.sans) {
				this.draw(infos, tab);
				if (!this.batchTimer) this.batchTimer = setTimeout(() => { this.batchTimer = null; scheduleRender(); }, wait);
				return;
			}
			const gen = Gate.gen;
			const token = Gate.token;
			const page = location.href;
			const job = {};
			this.pending = job;
			this.sentAt = nowMs();
			try {
				const result = await requestJson({ method: "POST", url: AUTH_API + "/v1/oc/analyse", headers: { Authorization: `Bearer ${token}` }, body: input });
				if (gen !== Gate.gen || !Gate.pass() || page !== location.href) return;
				if (!result || !Array.isArray(result.panels) || !Array.isArray(result.order)) throw new Error("Invalid analysis response");
				this.fingerprint = fp; this.sans = sansChances(input); this.result = result; this.error = false; this.nextTryAt = 0; this.rejected = null;
				this.context = this.contextFor(input);
				this.observations = new Map(input.panels.map(p => [p.ocId, this.observe(p)]));
				this.remember();
				// OCs that changed while the request was out lose their decision and are asked for again. A drawing
				// error is the page's, not the server's: it must not mark this good answer as unavailable.
				safe("draw", () => {
					const current = qa(document, "div[data-oc-id]").map(parsePanel), tabNow = activeTab();
					this.reconcile(current, this.input(current, tabNow));
					this.draw(current, tabNow);
				});
			} catch (error) {
				if (gen !== Gate.gen || page !== location.href) return;
				if ((error.status === 401 || error.status === 403) && token !== Gate.token) return;
				// A request the server refused as invalid is not sent again, and nothing is sent for a while.
				const refused = error.status === 400 || error.status === 413;
				this.nextTryAt = nowMs() + (refused ? REJECTED_RETRY_MS : Math.max(RETRY_MS, error.retryAfter || 0));
				this.rejected = refused ? fp : null;
				this.fingerprint = null; this.error = true;
				if (error.status === 401 || error.status === 403) {
					await denyProtected(error.status, gen, token);
				} else {
					const current = qa(document, "div[data-oc-id]").map(parsePanel);
					this.reconcile(current, this.input(current, activeTab()));
					for (const info of current) {
						const pill = info.panel.getAttribute("aria-busy") === "true" && info.panel.querySelector(".rr-success");
						if (pill && pill.textContent !== "Success: unavailable") pill.textContent = "Success: unavailable";
					}
					this.draw(current, activeTab());
					log("analysis unavailable", error); setTimeout(scheduleRender, this.nextTryAt - nowMs());
				}
			} finally { if (this.pending === job) { this.pending = null; if (gen === Gate.gen) scheduleRender(); } }
		},
		draw(infos, tab) {
			if (!this.result || !Gate.pass()) return;
			if (!document.body.classList.contains("rr-oc-authorized")) document.body.classList.add("rr-oc-authorized");
			for (const info of infos) safe("draw-panel", () => {
				const decision = this.result.panels.find(p => p.ocId === info.ocId);
				if (!decision || decision.slots.length !== info.slots.length) return;
				info.panel.removeAttribute("aria-busy");
				const fp = JSON.stringify([decision, this.error, info.slots.map(s => s.xid && TornApi.statusFor(s.xid))]);
				const present = info.slots.every((s, i) => {
					const d = decision.slots[i];
					return s.header.classList.contains("rr-role") && s.wrap.querySelector(".rr-meta") &&
						s.header.classList.contains("rr-item-missing") === Boolean(d.itemMissing) &&
						Boolean(s.wrap.querySelector(".rr-lock")) === Boolean(d.locked) &&
						FILL.every(fill => s.wrap.classList.contains(fill) === (fill === "rr-fill-" + d.fill));
				}) && (!decision.probability || info.panel.querySelector(".rr-info .rr-success"));
				if (info.panel.dataset.rrFp === fp && present) return;
				info.slots.forEach((s, i) => { renderCheckpoint(s, decision.slots[i].failed); renderMeta(s, decision.slots[i]); });
				renderInfoRow(info, decision); renderSlotState(info, decision, tab);
				info.panel.dataset.rrFp = fp;               // only once fully drawn, so a failed panel is tried again
			});
			applyVisibility();
		},
	};

	function renderAll(force = false) {
		if (!apiKeyLoaded) return;
		const tab = safe("tab", activeTab, null);
		safe("gate", () => void Gate.refresh());
		if (!Gate.pass()) {
			// Not verified (or denied): strip all injected UI, keep only the API-entry bar.
			safe("teardown", teardownAll);
			safe("toolbar", () => Toolbar.ensure(tab, true));
			return;
		}
		safe("config", () => Config.ensure()); // proprietary config only fetched once verified
		const crimesRoot = document.querySelector("#faction-crimes-root");
		if (crimesRoot && crimesRoot.getAttribute("translate") !== "no") crimesRoot.setAttribute("translate", "no");
		const panels = qa(document, "div[data-oc-id]");
		if (force) { panels.forEach((p) => delete p.dataset.rrFp); }
		const live = new Set(panels.map((p) => p.getAttribute("data-oc-id")));
		for (const [ocId, row] of infoRows) if (!live.has(ocId) && !row.isConnected) infoRows.delete(ocId);
		Success.ensureRoles();
		void Analysis.ensure(panels.map(parsePanel), tab);
		safe("toolbar", () => Toolbar.ensure(tab));
		safe("visibility", applyVisibility);
		safe("torn-api", () => TornApi.refresh());
		safe("faction-crimes", () => FactionCrimes.refresh());
	}

	function tickLive() {
		nowMs(); // notices a PC clock change even while the tab is hidden
		if (document.hidden || !Gate.pass() || !Analysis.result) return;
		const tab = safe("tab", activeTab, null);
		if (tab !== "Planning" && tab !== "Recruiting" && tab !== "Completed") { return; }
		// Keep member status and crime data on the server's cadence even while Torn's page is still.
		safe("torn-api", () => TornApi.refresh());
		safe("faction-crimes", () => FactionCrimes.refresh());
		const onCompleted = tab === "Completed";
		const decisions = new Map(Analysis.result.panels.map(p => [p.ocId, p]));
		for (const panel of qa(document, "div[data-oc-id]")) {
			const decision = decisions.get(panel.getAttribute("data-oc-id"));
			qa(panel, sel("slotHeader")).forEach((header, i) => {
				const s = { wrap: header.parentElement, xid: xidOf(header.parentElement) };
				safe("tick-cp", () => renderCheckpoint(s, decision?.slots[i]?.failed));
				safe("tick-icon", () => renderStatusIcon(s, onCompleted));
			});
		}
	}

	let scheduled = false;

	function scheduleRender() {
		if (scheduled) return;
		scheduled = true;
		setTimeout(() => { scheduled = false; safe("render", renderAll); }, RENDER_DEBOUNCE_MS);
	}

	safe("init", () => {
		if (window.__rrOcAutopilot) return; // guard against double injection (PDA re-navigation)
		const start = () => {
			if (window.__rrOcAutopilot || !document.body || !document.head) return;
			const style = document.createElement("style");
			style.id = "rr-oc-style";
			style.textContent = STYLE;
			document.head.appendChild(style);
			if (!document.getElementById("rr-oc-font")) {
				const font = document.createElement("link");
				font.id = "rr-oc-font";
				font.rel = "stylesheet";
				font.href = CREST_FONT_URL;
				document.head.appendChild(font);
			}
			const rootObserver = new MutationObserver((muts) => {
				// A slot header losing its rr-role marker means React rewrote its class in place; invalidate the fingerprint so the next render reapplies it.
				for (const mut of muts) {
					if (mut.type !== "attributes") continue;
					const t = mut.target;
					if (t.matches?.(sel("slotHeader")) && !t.classList.contains("rr-role")) { t.closest("div[data-oc-id]")?.removeAttribute("data-rr-fp"); }
				}
				safe("guard", guardPresence);
				scheduleRender();
			});
			// Torn can replace the crimes root when the faction page changes tab: the watcher follows it.
			let watched = null;
			const watchRoot = () => {
				const root = document.querySelector("#faction-crimes-root") || document.body;
				if (root === watched) return;
				rootObserver.disconnect();
				rootObserver.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
				if (watched) scheduleRender();
				watched = root;
			};
			watchRoot();
			new MutationObserver((muts) => {
				for (const mut of muts) {
					for (const n of mut.removedNodes) { if (n instanceof Element && !n.isConnected) restoreNativeEdits(n); }
					for (const n of mut.addedNodes) {
						const tip = tooltipNode(n);
						if (tip) safe("tooltip", () => augmentTooltip(tip));
					}
				}
			}).observe(document.body, { childList: true, subtree: true });
			window.addEventListener("hashchange", () => setTimeout(() => safe("render", () => renderAll(true)), 300));
			setInterval(() => { safe("watch", watchRoot); safe("tick", tickLive); }, 1000);
			window.__rrOcAutopilot = true;
			void loadApiKey()
				.then(() => { apiKeyLoaded = true; Gate.reset(); renderAll(); safe("setup", promptForApiKey); })
				.catch(() => {
					apiKeyLoaded = true;
					authApiKey = "";
					Gate.reset();
					Gate.state = "denied";
					onGateChange();
					safe("setup", promptForApiKey);
				});
		};
		// Some script managers run scripts before the page has a <body>: start once it has one.
		if (document.body && document.head) start();
		else document.addEventListener("DOMContentLoaded", () => safe("init", start), { once: true });
	});

})();
