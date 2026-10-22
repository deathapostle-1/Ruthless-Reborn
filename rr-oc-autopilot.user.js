// ==UserScript==
// @name         RR OC Autopilot
// @namespace    txm.private.oc-autopilot
// @version      2.2.4
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

	const VERSION = "2.2.4";
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
	const FACTION_COLOURS = { accent: "#029e7a", dark: "#1f1f1f" };
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
		qa(panel, ".rr-stat, .rr-lock").forEach(n => n.remove());
		qa(panel, ".rr-role.rr-item-missing").forEach(h => h.classList.remove("rr-item-missing"));
		qa(panel, FILL_SELECTOR).forEach(w => {
			for (const fill of FILL) if (w.classList.contains(fill) !== (fill === "rr-fill-grey")) w.classList.toggle(fill, fill === "rr-fill-grey");
		});
		if (!keepRequirements) qa(panel, ".rr-meta .rr-v").forEach(n => { if (n.textContent !== "…") n.textContent = "…"; });
		const pill = panel.querySelector(".rr-success");
		if (pill) {
			const text = Analysis.error ? "Success: unavailable" : "Success: …";
			if (pill.textContent !== text) pill.textContent = text;
			pill.style.setProperty("--rr-c", "#868e96");
		}
		delete panel.dataset.rrFp;
	}

	const TIMED_STATES = ["Hospital", "Jail", "Federal"]; // states with a release time
	const STATUS_ICON = {
		Okay: `<svg width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="#2f9e44"/></svg>`,
		Hospital: `<svg width="14" height="14" viewBox="0 0 24 24" fill="#e03131"><path d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7z"/></svg>`,
		Jail: `<svg width="14" height="14" viewBox="0 0 24 24" fill="#c98a52"><rect x="3.5" y="2" width="3" height="20" rx="1"/><rect x="10.5" y="2" width="3" height="20" rx="1"/><rect x="17.5" y="2" width="3" height="20" rx="1"/></svg>`,
		Traveling: `<svg width="14" height="14" viewBox="0 0 24 24" fill="#74c0fc"><path d="M22 12c0-.7-.6-1.3-1.3-1.3L14 10l-4-7H8l2 7-4 .3L4 8H2.5l1 4-1 4H4l2-2.3 4 .3-2 7h2l4-7 6.7-.7c.7 0 1.3-.6 1.3-1.3z"/></svg>`,
	};
	STATUS_ICON.Federal = STATUS_ICON.Jail;
	STATUS_ICON.Abroad = STATUS_ICON.Traveling;

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

	const STYLE = `
		.rr-meta { box-sizing: border-box; display: flex; gap: 4px; width: calc(100% - 10px); margin: 5px auto; position: relative; z-index: 1; }
		.rr-meta .rr-cell { flex: 1; min-width: 0; padding: 3px 4px; border-radius: 4px; text-align: center; background:${FACTION_COLOURS.dark}; border: 1px solid rgba(2, 158, 122, .45); }
		.rr-meta .rr-l { font-size: 10px; letter-spacing: .5px; color:${FACTION_COLOURS.accent}; opacity: .95; }
		.rr-meta .rr-v { font-size: 11px; font-weight: 700; color: #fff; }
		.rr-cp { box-sizing: border-box; width: calc(100% - 10px); height: 4px; margin: 0 auto 5px; border-radius: 2px; overflow: hidden; background: var(--oc-clock-bg, rgba(255, 255, 255, .12)); }
		.rr-cp > i { display: block; height: 100%; background:${FACTION_COLOURS.accent}; }
		.rr-cp.rr-amber > i { background: #db7b2b; }
		.rr-cp.rr-fail > i { background: #cc3232; }
		.rr-role.rr-role { box-sizing: border-box; width: 100% !important; margin: 0 !important; border: none !important; border-radius: 6px 6px 0 0 !important; background:${FACTION_COLOURS.dark} !important; padding: 0 6px 0 20px !important; }
		body.rr-oc-authorized #faction-crimes-root [class*="slotIcon___"] { display: none !important; }
		body.rr-oc-authorized #faction-crimes-root [class*="slotHeader___"] [class*="title___"] { color: #fff !important; }
		body.rr-oc-authorized #faction-crimes-root [class*="slotHeader___"].rr-item-missing [class*="title___"] { color: #cc3232 !important; }
		.rr-info { display: flex; align-items: center; flex: 0 0 auto; margin: 0 6px; min-width: 0; }
		.rr-success { position: relative; display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 10px; font-size: 12px; font-weight: 700; line-height: 1.5; white-space: nowrap; color: #fff !important; background:${FACTION_COLOURS.dark}; border: 1px solid var(--rr-c, #444); box-shadow: 0 0 7px -1px var(--rr-c, transparent); cursor: default; }
		.rr-pip { width: 8px; height: 8px; border-radius: 50%; flex: none; box-shadow: 0 0 0 1px rgba(255, 255, 255, .28); }
		.rr-stat { position: absolute; top: 3px; left: 4px; width: 14px; height: 14px; z-index: 5; pointer-events: none; display: flex; }
		.rr-stat svg { display: block; }
		.rr-fill-green, .rr-fill-amber, .rr-fill-red, .rr-fill-grey { position: relative; border-radius: 6px; background: #2b2b2b !important; }
		.rr-fill-green { box-shadow: 0 0 0 2px #029e7a, 0 0 9px rgba(2, 158, 122, .5) !important; }
		.rr-fill-amber { box-shadow: 0 0 0 2px #db7b2b, 0 0 8px rgba(219, 123, 43, .45) !important; }
		.rr-fill-red { box-shadow: 0 0 0 2px #cc3232, 0 0 8px rgba(204, 50, 50, .45) !important; }
		.rr-fill-grey { box-shadow: 0 0 0 2px rgba(150, 150, 150, .6), 0 0 8px rgba(150, 150, 150, .3) !important; }
		body.rr-oc-authorized #faction-crimes-root [class*="slotBody___"] { background: transparent !important; border-color: transparent !important; }
		.tt-oc-highlight .rr-fill-green, .tt-oc-highlight .rr-fill-amber, .tt-oc-highlight .rr-fill-red, .tt-oc-highlight .rr-fill-grey { outline: 2px solid rgba(0, 0, 0, .6) !important; outline-offset: 2px; }
		.rr-lock { position: absolute; top: 0; right: 0; bottom: 0; left: 0; z-index: 40; display: flex; align-items: flex-end; justify-content: center; cursor: not-allowed; padding: 5px; }
		.rr-lock span { background: rgba(31, 31, 31, .94); border: 1px solid rgba(150, 150, 150, .5); color: #cfcfcf; font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 8px; line-height: 1.4; text-align: center; }
		.rr-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0; padding: 8px 12px; background:${FACTION_COLOURS.dark}; border: 1px solid rgba(2, 158, 122, .5); border-radius: 6px; }
		.rr-brand { color:${FACTION_COLOURS.accent}; font-weight: 700; font-size: 12px; letter-spacing: 1.5px; }
		.rr-brand small { color: #8a8a8a; font-weight: 600; letter-spacing: 1px; }
		.rr-count { font-size: 11px; color: #8a8a8a; white-space: nowrap; }
		.rr-auth-state { margin-left: auto; color: #8a8a8a; font-size: 11px; }
		.rr-right { margin-left: auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
		.rr-toolbar select { background: #2a2a2a; color: #ddd; border: 1px solid #444; border-radius: 4px; padding: 3px 6px; font-size: 12px; }
		.rr-api { background: transparent; border:1px solid ${FACTION_COLOURS.accent}; color:${FACTION_COLOURS.accent}; border-radius: 4px; padding: 3px 10px; cursor: pointer; font-size: 11px; font-weight: 700; letter-spacing: 1px; }
		.rr-api:hover { background:${FACTION_COLOURS.accent}; color: #fff; }
		.rr-api:focus-visible { background:${FACTION_COLOURS.accent}; color: #fff; }
		.rr-api:disabled { opacity: .5; cursor: default; }
		.rr-gear { background: none; border: none; color: #8a8a8a; font-size: 15px; line-height: 1; padding: 0 4px; cursor: pointer; }
		.rr-gear:hover { color:${FACTION_COLOURS.accent}; }
		.rr-set-overlay { position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 999999; background: rgba(0, 0, 0, .8); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); display: flex; justify-content: center; align-items: center; }
		.rr-set-modal { display: flex; flex-direction: column; width: min(520px, 94vw); max-height: min(86vh, 700px); overflow: hidden; background: linear-gradient(180deg, #23252b, #1b1d22); border: 1px solid rgba(2, 158, 122, .5); border-radius: 8px; box-shadow: 0 2px 10px rgba(0, 0, 0, .35); color: #d7d9de; font-size: 12px; }
		.rr-set-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; background: linear-gradient(180deg, #2c2f37, #23252b); border-bottom: 1px solid #34373f; }
		.rr-set-head b { color:${FACTION_COLOURS.accent}; letter-spacing: 1px; }
		.rr-set-close { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; background: none; border: none; color: #8a8a8a; font-size: 22px; line-height: 1; cursor: pointer; }
		.rr-set-close:hover { color: #fff; }
		.rr-set-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px; }
		.rr-set-section { background: #1a1a1a; border: 1px solid #34373f; border-radius: 6px; padding: 12px; }
		.rr-set-section + .rr-set-section { margin-top: 12px; }
		.rr-set-note { color: #8a8d96; font-size: 11px; line-height: 1.45; margin-top: 6px; }
		.rr-set-title { color: #8a8d96; font-size: 10px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; margin-bottom: 10px; }
		.rr-set-input { width: 100%; box-sizing: border-box; background: #15161a; color: #d7d9de; border: 1px solid #34373f; border-radius: 5px; padding: 6px 8px; font: inherit; text-align: center; letter-spacing: 2px; margin-bottom: 10px; }
		.rr-set-input:focus { border-color:${FACTION_COLOURS.accent}; outline: none; }
		.rr-set-input[data-bad="1"] { border-color: #e74c3c; }
		.rr-set-status { text-align: center; padding: 8px; background: #15161a; border: 1px solid #34373f; border-radius: 5px; font-size: 11px; margin-bottom: 10px; }
		.rr-set-status[data-state="ok"] { color: #2ecc71; }
		.rr-set-status[data-state="bad"] { color: #e74c3c; }
		.rr-set-status[data-state="wait"] { color: #e0a80d; }
		.rr-set-actions { display: flex; gap: 8px; }
		.rr-set-actions .rr-api { flex: 1; }
		@media (max-width: 560px) {
			.rr-set-overlay { align-items: flex-start; padding: 8px 0; overflow-y: auto; }
			.rr-set-modal { margin: auto; max-height: 92vh; }
		}
		.rr-legend { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; font-size: 11px; color: #b9c1bd; }
		.rr-legend span { display: inline-flex; align-items: center; gap: 4px; }
		.rr-legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
		body:not(.dark-mode) .rr-fill-green, body:not(.dark-mode) .rr-fill-amber, body:not(.dark-mode) .rr-fill-red, body:not(.dark-mode) .rr-fill-grey { background: #e2e4e6 !important; }
		body:not(.dark-mode) .rr-role.rr-role { background: #d4d7da !important; }
		body.rr-oc-authorized:not(.dark-mode) #faction-crimes-root [class*="slotHeader___"] [class*="title___"] { color: #2a2a2a !important; }
		body.rr-oc-authorized:not(.dark-mode) #faction-crimes-root [class*="slotHeader___"].rr-item-missing [class*="title___"] { color: #cc3232 !important; }
		body:not(.dark-mode) .rr-meta .rr-cell { background: #eef0f1; }
		body:not(.dark-mode) .rr-meta .rr-v { color: #222; }
		body:not(.dark-mode) .rr-success { background: #eef0f1; color: #222 !important; }
		body:not(.dark-mode) .rr-cp { background: rgba(0, 0, 0, .12); }
		body:not(.dark-mode) .rr-legend i { box-shadow: 0 0 0 1px rgba(0, 0, 0, .25); }
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

	function renderMeta(slot, decision) {
		const w = finite(decision.weight);
		const req = finite(decision.required);
		const html =
			`<div class="rr-cell"><div class="rr-l">Min</div><div class="rr-v">${req == null ? "--" : req}</div></div>` +
			`<div class="rr-cell"><div class="rr-l">Weight</div><div class="rr-v">${w == null ? "--.--%" : w.toFixed(2) + "%"}</div></div>`;
		const old = slot.wrap.querySelector(".rr-meta");
		if (old) {
			if (old.innerHTML !== html) old.innerHTML = html;
		} else slot.wrap.appendChild(el("div", "rr-meta", html));
	}

	// failed is the server's decision for this slot; callers look their OC up once, not once per slot.
	function renderCheckpoint(slot, failed = false) {
		const ring = slot.wrap.querySelector(sel("planning"));
		const deg = ring && (ring.getAttribute("style") || "").match(/([\d.]+)deg/);
		failed = failed === true;
		let bar = slot.wrap.querySelector(".rr-cp");
		if (!failed && !deg) { bar?.remove(); return; }
		if (!bar) {
			bar = el("div", "rr-cp", "<i></i>");
			slot.wrap.insertBefore(bar, slot.wrap.querySelector(".rr-meta"));
		}
		const pctNum = failed ?
			100 :
			Math.max(0, Math.min(100, Math.round(parseFloat(deg[1]) / 3.6)));
		bar.classList.toggle("rr-fail", failed);
		bar.classList.toggle("rr-amber", !failed && pctNum < 100);
		const pct = pctNum + "%";
		if (bar.firstChild.style.width !== pct) bar.firstChild.style.width = pct;
	}

	function renderInfoRow(info, decision) {
		const { panel, ocId } = info;
		if (!decision.probability) { panel.querySelector(".rr-info")?.remove(); infoRows.delete(ocId); return; }
		let row = panel.querySelector(".rr-info") || el("div", "rr-info");
		let pill = row.querySelector(".rr-success") || el("span", "rr-success");
		const c = safeColour(decision.successColour);
		pill.style.setProperty("--rr-c", c);
		const success = finite(decision.success);
		const result = Analysis.error ? "unavailable" : success == null ? (Success.cache.has(decision.probability.key) ? "n/a" : "…") : (success * 100).toFixed(2) + "%";
		const html = `<span class="rr-pip" style="background:${c}"></span>Success: ${result}`;
		if (pill.innerHTML !== html) pill.innerHTML = html;
		if (!row.contains(pill)) row.appendChild(pill);
		if (!panel.contains(row)) q(panel, sel("panelTitle"))?.after(row);
		infoRows.set(ocId, row);
		const query = decision.probability;
		if (Success.due(query.key)) Success.get(query.scenario, query.params, scheduleRender);
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
		let icon = s.wrap.querySelector(".rr-stat");
		const st = !onCompleted && s.xid && TornApi.members ?
			TornApi.statusFor(s.xid) :
			null;
		const svg = st && STATUS_ICON[st.state];
		if (!svg) { icon?.remove(); return; }
		if (!icon) { icon = el("span", "rr-stat"); relative(s.wrap); s.wrap.appendChild(icon); }
		if (icon.dataset.st !== st.state) { icon.dataset.st = st.state; icon.innerHTML = svg; }
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
			let lock = s.wrap.querySelector(".rr-lock");
			if (d.locked) {
				relative(s.wrap);
				const required = finite(d.required);
				const html = `<span>Not Eligible: Requires: ${required == null ? "--" : required}+</span>`;
				if (!lock) s.wrap.appendChild(el("div", "rr-lock", html));
				else if (lock.innerHTML !== html) lock.innerHTML = html;
			} else lock?.remove();
		});
	}

	function activeTab() {
		const btn = document.querySelector(`${sel("buttonsContainer")} button${sel("active")}`);
		return btn ? q(btn, sel("tabName"))?.textContent.trim() || null : null;
	}

	function listContainer() { return document.querySelector("div[data-oc-id]")?.parentElement || null; }

	const SORT_LABELS = { default: "Sort: default", "success-desc": "Success ↓", "success-asc": "Success ↑", "level-desc": "Level ↓", "level-asc": "Level ↑" };
	const SORT_OPTIONS = Object.keys(SORT_LABELS);
	const LEGEND = [["#029e7a", "Eligible"], ["#db7b2b", "Close"], ["#cc3232", "Below"], ["#6a6a6a", "No data"]];

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
		if (existing) { q(existing, ".rr-set-input")?.focus(); return; }
		settingsTrigger = trigger || document.activeElement;

		const overlay = el("div", "rr-set-overlay");
		overlay.id = "rr-oc-settings";
		const modal = el("div", "rr-set-modal", `
      <div class="rr-set-head">
		<b id="rr-oc-settings-title">RR OC AUTOPILOT</b>
        <button type="button" class="rr-set-close" aria-label="Close settings">&times;</button>
      </div>
      <div class="rr-set-body">
        <div class="rr-set-section">
          <div class="rr-set-title">Torn API key (Public Access)</div>
          <input type="password" class="rr-set-input" placeholder="Paste your Public Access key"
                 autocomplete="off" spellcheck="false" title="16 or 50 alphanumeric characters">
          <div class="rr-set-status">No API key set</div>
          <div class="rr-set-actions">
            <button type="button" class="rr-api" data-action="save">Save</button>
            <button type="button" class="rr-api" data-action="remove">Remove</button>
          </div>
        </div>
        <div class="rr-set-section">
          <div class="rr-set-title">How your API key is used</div>
          <div class="rr-set-note"><b>Storage:</b> your key stays on this device. The RR server keeps only a one-way fingerprint of it, for at most 4 minutes, and never stores or logs the key itself.</div>
          <div class="rr-set-note"><b>Sharing:</b> sent to the RR server (membership check) and to ZZCraft (OC thresholds, sent as an X-Api-Key header).</div>
          <div class="rr-set-note"><b>Purpose:</b> Ruthless Reborn faction organised crime planning.</div>
          <div class="rr-set-note"><b>Key storage:</b> your userscript manager's storage, or TornPDA's storage.</div>
          <div class="rr-set-note"><b>Access level:</b> Public Access key only.</div>
        </div>
      </div>
    `);
		modal.setAttribute("role", "dialog");
		modal.setAttribute("aria-modal", "true");
		modal.setAttribute("aria-labelledby", "rr-oc-settings-title");
		const input = q(modal, ".rr-set-input");
		const status = q(modal, ".rr-set-status");
		input.value = apiKey();

		const setStatus = (text, state = "") => { status.textContent = text; status.dataset.state = state; };
		settingsGateHook = () => {
			if (!input.isConnected || !validApiKey(input.value.trim())) return;
			if (Gate.pass()) setStatus("Valid and authorized", "ok");
			else if (Gate.state === "denied") setStatus("Access restricted", "bad");
			else if (Gate.nextTryAt > nowMs()) setStatus("Authorization unavailable", "wait");
			else setStatus("Verifying access…", "wait");
		};
		if (validApiKey(apiKey())) {
			setStatus(Gate.pass() ? "Valid and authorized" : "API key configured", Gate.pass() ? "ok" : "");
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

		modal.addEventListener("click", event => {
			const action = event.target?.getAttribute?.("data-action");
			if (action === "save") void save();
			else if (action === "remove") {
				input.value = "";
				setStatus("Removing…", "wait");
				void applyApiKey("")
					.then(() => setStatus("Key removed", ""))
					.catch(() => setStatus("Protected storage unavailable", "bad"));
			}
		});
		input.addEventListener("keydown", event => { if (event.key === "Enter") void save(); });
		q(modal, ".rr-set-close").addEventListener("click", closeSettings);

		let downOnOverlay = false;
		overlay.addEventListener("mousedown", event => { downOnOverlay = event.target === overlay; });
		overlay.addEventListener("click", event => { if (event.target === overlay && downOnOverlay) closeSettings(); });
		settingsEscapeHandler = event => { if (event.key === "Escape") closeSettings(); };
		document.addEventListener("keydown", settingsEscapeHandler);

		overlay.appendChild(modal);
		document.body.appendChild(overlay);
		input.focus();
	}

	function promptForApiKey() {
		if (setupPrompted || validApiKey(apiKey())) return;
		setupPrompted = true;
		openSettings(document.querySelector(".rr-gear"));
	}

	const Toolbar = {
		state: { sort: ((s) => SORT_OPTIONS.includes(s) ? s : "default")(storeGet("rr_oc_sort")) },
		gateMessage() {
			if (!apiKey()) return "Enter your Torn API key to activate";
			return Gate.state === "denied" ?
				"Access restricted" :
				Gate.nextTryAt > nowMs() ? "Authorization unavailable" : "Verifying access…";
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
				if (gateOnly) {
					const c = bar.querySelector(".rr-auth-state");
					const msg = this.gateMessage();
					if (c && c.textContent !== msg) c.textContent = msg;
				}
				return;
			}
			const list = listContainer();
			if (!list) return;
			bar = el("div", "rr-toolbar");
			bar.dataset.mode = mode;
			// The count line also says how many OCs were left out of the analysis, on every tab.
			const gearHtml = `<button class="rr-gear" type="button" title="Settings" aria-label="Settings">&#9881;</button>`;
			bar.innerHTML = `<span class="rr-brand">RR <small>· OC AUTOPILOT</small></span>` + (mode === "gate" ? `<span class="rr-auth-state"></span>${gearHtml}` :
				`<span class="rr-count"></span>` + (mode === "completed" ? `<span class="rr-right">${gearHtml}</span>` :
					`<span class="rr-legend">${LEGEND.map(([colour, label]) => `<span><i style="background:${colour}"></i>${label}</span>`).join("")}</span>` +
					`<span class="rr-right"><select class="rr-sort">${SORT_OPTIONS.map(v => `<option value="${v}">${SORT_LABELS[v]}</option>`).join("")}</select>${gearHtml}</span>`));
			list.before(bar);
			if (mode === "gate") {
				bar.querySelector(".rr-auth-state").textContent = this.gateMessage();
			} else if (mode === "full") {
				bar.querySelector(".rr-sort").value = this.state.sort;
				bar.querySelector(".rr-sort").addEventListener("change", (e) => {
					this.state.sort = e.target.value;
					storeSet("rr_oc_sort", this.state.sort);
					scheduleRender();
				});
			}
			const gear = bar.querySelector(".rr-gear");
			const onGear = event => { event.preventDefault(); event.stopPropagation(); openSettings(gear); };
			gear.addEventListener("mousedown", onGear);
			gear.addEventListener("click", onGear);
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
			const n = Analysis.result?.joinable, left = Analysis.skipped ? ` · ${Analysis.skipped} not analysed` : "";
			const text = Analysis.rejected ? "Analysis rejected – update the script" :
				!Analysis.result ? (Analysis.nextTryAt > nowMs() ? "Analysis unavailable; retrying..." : "Loading decisions...") :
				Analysis.error ? "Decision refresh unavailable; retrying..." : `${panels.length} OCs${n ? ` · ${n} joinable` : ""}${left}`;
			if (countEl.textContent !== text) countEl.textContent = text;
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
