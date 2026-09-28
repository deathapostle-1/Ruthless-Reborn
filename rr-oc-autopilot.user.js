// ==UserScript==
// @name         RR OC Autopilot
// @namespace    txm.private.oc-autopilot
// @version      2.1.6
// @author       TXM [1712536]
// @description  Private OC planning assistant
// @updateURL    https://raw.githubusercontent.com/deathapostle-1/Ruthless-Reborn/main/rr-oc-autopilot.user.js
// @downloadURL  https://raw.githubusercontent.com/deathapostle-1/Ruthless-Reborn/main/rr-oc-autopilot.user.js
// @match        https://www.torn.com/factions.php*
// @noframes
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

	// #region Configuration

	// ============================== CONSTANTS ==============================
	const VERSION = "2.1.6";
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
	const LEGACY_API_KEY_STORAGE = "rr_oc_api_key";
	const FACTION_COLOURS = {
		accent: "#029e7a",
		dark: "#1f1f1f"
	};
	const MEMBERS_REFRESH_MS = 60 * 1000; // server refreshes member status every 60 s
	const CRIMES_REFRESH_MS = 30 * 1000; // server refreshes crime data every 30 s
	const RETRY_MS = 30 * 1000; // retry window after a failed fetch; a longer Retry-After wins
	const RENDER_DEBOUNCE_MS = 120; // renderAll() debounce
	const PUMP_DELAY_MS = 250; // Success queue pacing between requests

	// #endregion

	// #region Utilities

	// ============================== UTILITIES ==============================
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
		try {
			return fn();
		} catch (e) {
			console.warn(`[RR OC Autopilot] ${label}:`, e);
			return fallback;
		}
	};

	// Debug logger, opt-in via localStorage `rr_oc_debug` = "1" (useful for mobile bug reports)
	let DEBUG = false;
	try {
		DEBUG = localStorage.getItem("rr_oc_debug") === "1";
	} catch (e) {}
	const log = (...a) => {
		if (DEBUG) console.log("[RR OC Autopilot]", ...a);
	};

	// #endregion

	// #region Storage

	// ============================== STORAGE ==============================
	// Non-sensitive preferences keep their existing compatibility path.
	function storeGet(k) {
		try {
			if (typeof GM_getValue === "function") {
				const v = GM_getValue(k, null);
				if (v != null) return v;
			}
		} catch (e) {}
		try {
			return localStorage.getItem(k);
		} catch (e) {
			return null;
		}
	}

	function storeSet(k, v) {
		try {
			if (typeof GM_setValue === "function") GM_setValue(k, v);
		} catch (e) {}
		try {
			localStorage.setItem(k, v);
		} catch (e) {}
	}

	function storeDel(k) {
		try {
			if (typeof GM_deleteValue === "function") GM_deleteValue(k);
		} catch (e) {}
		try {
			localStorage.removeItem(k);
		} catch (e) {}
	}

	async function secureGet(k) {
		const onPda = typeof window.flutter_inappwebview !== "undefined";
		if (onPda) {
			if (typeof PDA_storage === "undefined") {
				throw new Error("TornPDA 3.15 or newer is required");
			}
			return await PDA_storage.get(k, null);
		}
		if (typeof GM_getValue === "function") {
			return await Promise.resolve(GM_getValue(k, null));
		}
		if (typeof GM !== "undefined" && GM && typeof GM.getValue === "function") {
			return await GM.getValue(k, null);
		}
		return null;
	}

	async function secureSet(k, v) {
		const onPda = typeof window.flutter_inappwebview !== "undefined";
		if (onPda) {
			if (typeof PDA_storage === "undefined") {
				throw new Error("TornPDA 3.15 or newer is required");
			}
			await PDA_storage.set(k, v);
			return;
		}
		if (typeof GM_setValue === "function") {
			await Promise.resolve(GM_setValue(k, v));
			return;
		}
		if (typeof GM !== "undefined" && GM && typeof GM.setValue === "function") {
			await GM.setValue(k, v);
			return;
		}
		throw new Error("Protected userscript storage unavailable");
	}

	async function secureDelete(k) {
		const onPda = typeof window.flutter_inappwebview !== "undefined";
		if (onPda) {
			if (typeof PDA_storage === "undefined") return;
			await PDA_storage.delete(k);
			return;
		}
		if (typeof GM_deleteValue === "function") {
			await Promise.resolve(GM_deleteValue(k));
			return;
		}
		if (typeof GM !== "undefined" && GM && typeof GM.deleteValue === "function") {
			await GM.deleteValue(k);
		}
	}

	const validApiKey = (value) =>
		typeof value === "string" && /^(?:[A-Za-z0-9]{16}|[A-Za-z0-9]{50})$/.test(value);

	let authApiKey = "";
	let apiKeyLoaded = false;
	let apiKeyChanging = false;

	async function loadApiKey() {
		let candidate = await secureGet(API_KEY_STORAGE);
		if (!validApiKey(candidate)) candidate = await secureGet(LEGACY_API_KEY_STORAGE);
		if (!validApiKey(candidate)) {
			try {
				candidate = localStorage.getItem(LEGACY_API_KEY_STORAGE);
			} catch (e) {
				candidate = null;
			}
		}

		if (validApiKey(candidate)) {
			await secureSet(API_KEY_STORAGE, candidate);
			if ((await secureGet(API_KEY_STORAGE)) !== candidate) {
				throw new Error("API key migration could not be verified");
			}
			authApiKey = candidate;
			await secureDelete(LEGACY_API_KEY_STORAGE);
		} else {
			authApiKey = "";
		}

		try {
			localStorage.removeItem(LEGACY_API_KEY_STORAGE);
		} catch (e) {}
	}

	async function saveApiKey(value) {
		if (value && !validApiKey(value)) throw new Error("Invalid Torn API key");
		if (value) {
			await secureSet(API_KEY_STORAGE, value);
			if ((await secureGet(API_KEY_STORAGE)) !== value) {
				throw new Error("API key save could not be verified");
			}
		} else {
			await secureDelete(API_KEY_STORAGE);
		}
		authApiKey = value;
		try {
			localStorage.removeItem(LEGACY_API_KEY_STORAGE);
		} catch (e) {}
	}

	function apiKey() {
		return authApiKey;
	}

	// #endregion

	// #region Networking & Data Services

	// ============================== NETWORKING ==============================
	function requestRaw({
		method = "GET",
		url,
		body,
		headers
	}) {
		const hdrs = Object.assign(
			body ? {
				"Content-Type": "application/json"
			} : {},
			headers || {},
		);
		const data = body ? JSON.stringify(body) : null;
		const timeoutMs = new URL(url).origin === AUTH_API ? 25000 : 15000;

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
			return Promise.race([Promise.resolve(call), timeout]).finally(() => clearTimeout(timeoutId)).then((r) => ({
				ok: r.status >= 200 && r.status < 300,
				status: r.status,
				text: r.responseText || "",
					headers: r.responseHeaders || r.headers || "",
			}));
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
				onload: (r) => resolve({
					ok: r.status >= 200 && r.status < 300,
					status: r.status,
					text: r.responseText || "",
					headers: r.responseHeaders || r.headers || "",
				}),
				onerror: reject,
				ontimeout: () => reject(new Error("timeout")),
			});
		});
	}

	async function requestJson(options) {
		const response = await requestRaw(options);
		let data;
		try {
			data = JSON.parse(response.text);
		} catch (e) {
			if (response.ok) throw new Error("Invalid JSON response");
		}
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
	function retryAfterMs(headers) {
		const raw = typeof headers === "string" ? headers.match(/^retry-after:\s*(.+)$/im)?.[1] : headers?.["retry-after"] || headers?.["Retry-After"];
		if (!raw) return 0;
		const seconds = Number(raw);
		return Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now()) || 0;
	}
	async function keyFingerprint(key) {
		const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
		return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
	}
	const Gate = {
		state: "unknown", token: null, expiresAt: 0, renewedAt: 0, playerId: null, factionId: null,
		nextTryAt: 0, busy: false, gen: 0, refreshTimer: null, expiryTimer: null,
		pass() { return this.state === "ok" && !!this.token && Date.now() < this.expiresAt; },
		reset() {
			this.gen++;
			if (this.refreshTimer) clearTimeout(this.refreshTimer);
			if (this.expiryTimer) clearTimeout(this.expiryTimer);
			this.expiryTimer = null;
			Object.assign(this, { refreshTimer: null, busy: false, state: "unknown", token: null, expiresAt: 0, renewedAt: 0, playerId: null, factionId: null, nextTryAt: 0 });
		},
		scheduleRefresh() {
			if (this.refreshTimer) clearTimeout(this.refreshTimer);
			const delay = Math.max(1000, Math.min(this.renewedAt + AUTH_REFRESH_MS, this.expiresAt - AUTH_EXPIRY_SKEW_MS) - Date.now());
			this.refreshTimer = setTimeout(() => void this.refresh(true), delay);
		},
		deferRetry(delay = GATE_RETRY_MS) {
			this.state = this.token && Date.now() < this.expiresAt ? "ok" : "unknown";
			// While the current session still works, try a failed renewal once more before it
			// runs out; waiting the full cooldown would clear the page first.
			const renewBy = this.state === "ok" ? this.expiresAt - AUTH_EXPIRY_SKEW_MS - Date.now() : 0;
			const wait = Math.max(GATE_RETRY_MS, delay);
			this.nextTryAt = Date.now() + (renewBy > 0 ? Math.min(wait, Math.max(5000, renewBy)) : wait);
			if (this.refreshTimer) clearTimeout(this.refreshTimer);
			this.refreshTimer = setTimeout(() => void this.refresh(true), this.nextTryAt - Date.now());
			onGateChange();
		},
		accept(saved) {
			const now = Date.now();
			if (!saved || typeof saved.token !== "string" || !saved.token.length || saved.token.length > 4096 ||
				!Number.isFinite(saved.expiresAt) || saved.expiresAt <= now + AUTH_EXPIRY_SKEW_MS || saved.expiresAt > now + AUTH_MAX_TTL_MS ||
				!Number.isFinite(saved.renewedAt) || saved.renewedAt > now || saved.renewedAt < now - AUTH_MAX_TTL_MS ||
				!Number.isSafeInteger(saved.playerId) || saved.playerId < 1 || !Number.isSafeInteger(saved.factionId) || saved.factionId < 1) return false;
			Object.assign(this, { token: saved.token, expiresAt: saved.expiresAt, renewedAt: saved.renewedAt, playerId: saved.playerId, factionId: saved.factionId, state: "ok", nextTryAt: 0 });
			if (this.expiryTimer) clearTimeout(this.expiryTimer);
			this.expiryTimer = setTimeout(() => {
				if (Date.now() >= this.expiresAt) {
					this.token = null;
					this.state = "unknown";
					onGateChange();
				}
			}, this.expiresAt - Date.now() + 10);
			this.scheduleRefresh();
			onGateChange();
			return true;
		},
		async refresh(force = false) {
			if (apiKeyChanging) return;
			const key = apiKey();
			if (!key) { if (this.state !== "denied") { this.reset(); this.state = "denied"; onGateChange(); } return; }
			if ((!force && this.pass() && Date.now() < this.expiresAt - AUTH_EXPIRY_SKEW_MS) || this.busy || Date.now() < this.nextTryAt) return;
			const gen = this.gen;
			this.busy = true;
			try {
				const fingerprint = await keyFingerprint(key);
				const renew = async () => {
					if (gen !== this.gen || key !== apiKey() || await secureGet(API_KEY_STORAGE) !== key) return;
					const saved = await secureGet(SESSION_STORAGE);
					if (gen !== this.gen || key !== apiKey()) return;
					if (saved?.keyFingerprint === fingerprint && (!force || saved.renewedAt + AUTH_REFRESH_MS > Date.now()) && this.accept(saved)) return;
					const sentAt = Date.now();
					const response = await requestRaw({ method: "POST", url: AUTH_API + "/v1/session", body: { apiKey: key, app: "oc-autopilot", clientVersion: VERSION } });
					if (gen !== this.gen || key !== apiKey() || await secureGet(API_KEY_STORAGE) !== key) return;
					if (response.status === 200) {
						const data = JSON.parse(response.text);
						// Time the session by the seconds the server says remain, counted from the request.
						// Comparing the server's end time with this PC's clock rejected every fresh session
						// whenever the clock ran even slightly slow.
						const lifetime = Number.isFinite(data.expiresIn) ? data.expiresIn * 1000 : Number(data.expiresAt) * 1000 - sentAt;
						const session = { token: data.token, expiresAt: sentAt + Math.min(lifetime, AUTH_MAX_TTL_MS), renewedAt: Date.now(), playerId: data.playerId, factionId: data.factionId, keyFingerprint: fingerprint };
						if (!this.accept(session)) throw new Error("Invalid authorization response");
						await secureSet(SESSION_STORAGE, session);
					} else if (response.status === 401 || response.status === 403) {
						await secureDelete(SESSION_STORAGE);
						if (gen !== this.gen) return;
						this.token = null; this.expiresAt = 0; this.state = "denied"; this.nextTryAt = Date.now() + GATE_RETRY_MS; onGateChange();
					} else this.deferRetry(retryAfterMs(response.headers));
				};
				if (navigator.locks?.request) await navigator.locks.request("rr-oc-session", renew);
				else await renew();
			} catch (e) { if (gen === this.gen) this.deferRetry(); }
			finally { if (gen === this.gen) this.busy = false; }
		},
	};

	async function denyProtected(status, gen, token) {
		if (gen !== Gate.gen || token !== Gate.token) return;
		Gate.reset();
		const deniedGen = Gate.gen;
		Gate.state = status === 403 ? "denied" : "unknown";
		Gate.nextTryAt = Date.now() + GATE_RETRY_MS;
		onGateChange();
		await secureDelete(SESSION_STORAGE);
		if (deniedGen === Gate.gen) Gate.refreshTimer = setTimeout(() => void Gate.refresh(), GATE_RETRY_MS);
	}

	function onGateChange() {
		if (!Gate.pass() && document.body.classList.contains("rr-oc-authorized")) document.body.classList.remove("rr-oc-authorized");
		else if (Gate.pass() && Analysis.result && !document.body.classList.contains("rr-oc-authorized")) document.body.classList.add("rr-oc-authorized");
		if (settingsGateHook) {
			try {
				settingsGateHook();
			} catch (e) {}
		}
		if (!Gate.pass()) {
			try {
				localStorage.removeItem("rr_oc_config");
			} catch (e) {}
			Config.data = null;
			Analysis.reset();
			Config.at = 0;
			Config.loading = false;
			TornApi.members = null;
			TornApi.fetchedAt = 0;
			TornApi.factionId = null;
			TornApi.factionRequest = null;
			FactionCrimes.byId = null;
			FactionCrimes.fetchedAt = 0;
			Success.roles = null;
			Success.loading = false;
			Success.nextRolesAt = 0;
			Success.cache.clear();
			Success.queue.length = 0;
		}
		renderAll(true);
	}

	// Strips every injected element/class so a denied user sees a completely stock page.
	function teardownAll() {
		if (document.body.classList.contains("rr-oc-authorized")) document.body.classList.remove("rr-oc-authorized");
		const bar = document.querySelector(".rr-toolbar");
		if (bar && bar.dataset.mode !== "gate") bar.remove();
		qa(document, ".rr-meta, .rr-cp, .rr-info, .rr-stat, .rr-lock").forEach(
			(n) => n.remove(),
		);
		qa(document, ".rr-role").forEach((h) =>
			h.classList.remove("rr-role", "rr-item-missing"),
		);
		qa(
			document,
			".rr-fill-green, .rr-fill-amber, .rr-fill-red, .rr-fill-grey",
		).forEach((w) => w.classList.remove(...FILL));
		for (const p of qa(document, "div[data-oc-id]")) {
			p.removeAttribute("aria-busy");
			delete p.dataset.rrFp;
			delete p.dataset.rrLevel;
			delete p.dataset.rrOpen;
			delete p.dataset.rrJoinable;
			delete p.dataset.rrSuccess;
			p.style.order = "";
		}
		panelNodes.clear();
		restoreNativeEdits(document);
		const list = listContainer();
		if (list) {
			list.style.display = "";
			list.style.flexDirection = "";
		}
	}

	// A changed observation invalidates only this panel, not the toolbar or other OCs.
	function clearPanelDecision(panel, keepRequirements = false) {
		// Keep layout nodes while their replacement decision is in flight. Do not
		// keep stale eligibility, occupant status or probability as a current result.
		if (panel.getAttribute("aria-busy") !== "true") panel.setAttribute("aria-busy", "true");
		qa(panel, ".rr-stat, .rr-lock").forEach(n => n.remove());
		qa(panel, ".rr-role.rr-item-missing").forEach(h => h.classList.remove("rr-item-missing"));
		qa(panel, ".rr-fill-green, .rr-fill-amber, .rr-fill-red, .rr-fill-grey").forEach(w => {
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

	// ========================== STATUS DEFINITIONS ==========================
	const STATUS_VIS = {
		Okay: {
			timed: false
		},
		Hospital: {
			timed: true
		},
		Jail: {
			timed: true
		},
		Federal: {
			timed: true
		},
		Traveling: {
			timed: false
		},
		Abroad: {
			timed: false
		},
	};
	const STATUS_ICON = {
		Okay: `<svg width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="#2f9e44"/></svg>`,
		Hospital: `<svg width="14" height="14" viewBox="0 0 24 24" fill="#e03131"><path d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7z"/></svg>`,
		Jail: `<svg width="14" height="14" viewBox="0 0 24 24" fill="#c98a52"><rect x="3.5" y="2" width="3" height="20" rx="1"/><rect x="10.5" y="2" width="3" height="20" rx="1"/><rect x="17.5" y="2" width="3" height="20" rx="1"/></svg>`,
		Traveling: `<svg width="14" height="14" viewBox="0 0 24 24" fill="#74c0fc"><path d="M22 12c0-.7-.6-1.3-1.3-1.3L14 10l-4-7H8l2 7-4 .3L4 8H2.5l1 4-1 4H4l2-2.3 4 .3-2 7h2l4-7 6.7-.7c.7 0 1.3-.6 1.3-1.3z"/></svg>`,
	};
	STATUS_ICON.Federal = STATUS_ICON.Jail;
	STATUS_ICON.Abroad = STATUS_ICON.Traveling;

	// =============== DATA SERVICES: TornApi / FactionCrimes / Success ===============
	const TornApi = {
		members: null,
		fetchedAt: 0,
		factionId: null,
		factionRequest: null,
		ensureFactionId() { return Promise.resolve(Gate.pass() ? Gate.factionId : null); },
		async refresh() {
			const key = apiKey();
			if (!key || !Gate.pass()) return;
			if (Date.now() - this.fetchedAt < MEMBERS_REFRESH_MS) return;
			const gen = Gate.gen;
			const token = Gate.token;
			this.fetchedAt = Date.now();
			try {
				const r = await requestJson({
					url: AUTH_API + "/v1/faction/members",
					headers: {
						Authorization: `Bearer ${token}`,
					},
				});
				if (gen === Gate.gen && Gate.pass() && r && Array.isArray(r.members)) {
					this.members = {};
					for (const m of r.members) {
						this.members[m.id] = {
							state: m.status?.state || "",
							until: m.status?.until || 0,
							description: m.status?.description || "",
						};
					}
					renderAll();
				}
			} catch (e) {
				if (gen !== Gate.gen) return;
				if (e.status === 401 || e.status === 403) {
					if (token !== Gate.token) { this.fetchedAt = 0; scheduleRender(); return; }
					await denyProtected(e.status, gen, token); return;
				}
				this.fetchedAt = Date.now() - MEMBERS_REFRESH_MS + Math.max(RETRY_MS, e.retryAfter || 0);
				log("members refresh failed", e);
			}
		},
		statusFor(xid) {
			return this.members?.[xid] || null;
		},
	};

	const FactionCrimes = {
		byId: null,
		fetchedAt: 0,
		async refresh() {
			if (!Gate.pass()) return;
			if (Date.now() - this.fetchedAt < CRIMES_REFRESH_MS) return;
			const gen = Gate.gen;
			const token = Gate.token;
			this.fetchedAt = Date.now();
			try {
				const r = await requestJson({
					url: AUTH_API + "/v1/oc/crimes",
					headers: {
						Authorization: `Bearer ${token}`,
					},
				});
				if (gen === Gate.gen && Gate.pass() && r && Array.isArray(r.crimes)) {
					this.byId = Object.fromEntries(r.crimes.map(c => [c.id, c]));
					renderAll();
				}
			} catch (e) {
				if (gen !== Gate.gen) return;
				if (e && (e.status === 401 || e.status === 403)) {
					if (token !== Gate.token) { this.fetchedAt = 0; scheduleRender(); return; }
					await denyProtected(e.status, gen, token); return;
				}
				this.fetchedAt = Date.now() - CRIMES_REFRESH_MS + Math.max(RETRY_MS, e.retryAfter || 0);
				log("crimes refresh failed", e);
			}
		},

	};

	const Success = {
		api: "https://tornprobability.com:3000/api/",
		roles: null,
		loading: false,
		nextRolesAt: 0,
		cache: new Map(),
		queue: [],
		busy: false,
		busyJob: null,
		ensureRoles() {
			if (this.roles || this.loading || !Gate.pass() || Date.now() < this.nextRolesAt) return;
			const gen = Gate.gen;
			this.loading = true;
			requestJson({
					url: this.api + "GetRoleNames"
				})
				.then((r) => {
					if (gen !== Gate.gen || !Gate.pass()) return;
					this.roles = r || {};
					this.loading = false;
					renderAll(true);
				})
				.catch(() => {
					if (gen !== Gate.gen) return;
					this.loading = false;
					this.nextRolesAt = Date.now() + RETRY_MS;
					setTimeout(scheduleRender, RETRY_MS);
				});
		},
		get(scenario, params, cb) {
			const key = scenario + "|" + params.join(",");
			if (this.cache.has(key)) {
				cb(this.cache.get(key));
				return;
			}
			const pending =
				this.queue.find((j) => j.key === key && j.gen === Gate.gen) ||
				(this.busyJob?.key === key && this.busyJob.gen === Gate.gen ? this.busyJob : null);
			if (pending) {
				pending.cbs.push(cb);
				return;
			}
			this.queue.push({
				scenario,
				params,
				key,
				cbs: [cb],
				tries: 0,
				gen: Gate.gen
			});
			this.pump();
		},
		pump() {
			if (this.busy || !this.queue.length || !Gate.pass()) return;
			this.busy = true;
			const job = (this.busyJob = this.queue.shift());
			requestJson({
					method: "POST",
					url: this.api + "CalculateSuccess",
					body: {
						scenario: job.scenario,
						parameters: job.params
					},
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
					if (job.gen === Gate.gen && Gate.pass() && ++job.tries < 3) {
						this.queue.push(job);
					} else {
						if (job.gen === Gate.gen && Gate.pass()) {
							this.cache.set(job.key, null);
							job.cbs.forEach((cb) => cb(null));
						}
					}
				})
				.finally(() =>
					setTimeout(() => {
						this.busy = false;
						this.busyJob = null;
						this.pump();
					}, PUMP_DELAY_MS),
				);
		},
	};

	// =================== OC THRESHOLDS / WEIGHTS CONFIG (ZZCRAFT) ===================
	const Config = {
		data: null,
		loading: false,
		at: 0,
		ttl: 6 * 60 * 60 * 1000,
		load() {
			try {
				localStorage.removeItem("rr_oc_config");
			} catch (e) {}
			this.data = null;
			this.at = 0;
		},
		ensure() {
			if (Date.now() - this.at > this.ttl) this.fetch();
		},
		async fetch() {
			const key = apiKey();
			if (!key || this.loading || !Gate.pass()) return;
			const gen = Gate.gen;
			this.loading = true;
			try {
				const factionId = await TornApi.ensureFactionId();
				if (gen !== Gate.gen || !Gate.pass()) return;
				if (!factionId) throw new Error("faction unavailable");
				const data = await requestJson({
					url: `${ZZCRAFT_API}/Factions/${factionId}/OrganizedCrimes/thresholds`,
					headers: { "X-Api-Key": key, 'User-Agent': ZZCRAFT_USERAGENT  },
				});
				if (gen !== Gate.gen || !Gate.pass()) return;
				if (!Array.isArray(data)) throw new Error("bad config");
				this.data = data;
				this.at = Date.now();
				this.loading = false;
				renderAll(true);
			} catch (error) {
				if (gen !== Gate.gen) return;
				this.loading = false;
				this.at = Date.now() - this.ttl + RETRY_MS;
				log("config refresh failed", error);
			}
		},
	};

	// #endregion

	// #region Styles

	// ============================== STYLES (CSS) ==============================
	const STYLE = `.rr-meta {
    box-sizing: border-box;
    display: flex;
    gap: 4px;
    width: calc(100% - 10px);
    margin: 5px auto;
    position: relative;
    z-index: 1
  }

  .rr-meta .rr-cell {
    flex: 1;
    min-width: 0;
    padding: 3px 4px;
    border-radius: 4px;
    text-align: center;
    background:${FACTION_COLOURS.dark};
    border: 1px solid rgba(2, 158, 122, .45)
  }

  .rr-meta .rr-l {
    font-size: 10px;
    letter-spacing: .5px;
    color:${FACTION_COLOURS.accent};
    opacity: .95
  }

  .rr-meta .rr-v {
    font-size: 11px;
    font-weight: 700;
    color: #fff
  }

  .rr-cp {
    box-sizing: border-box;
    width: calc(100% - 10px);
    height: 4px;
    margin: 0 auto 5px;
    border-radius: 2px;
    overflow: hidden;
    background: var(--oc-clock-bg, rgba(255, 255, 255, .12))
  }

  .rr-cp > i {
    display: block;
    height: 100%;
    background:${FACTION_COLOURS.accent}
  }

  .rr-cp.rr-amber > i {
    background: #db7b2b
  }

  .rr-cp.rr-fail > i {
    background: #cc3232
  }

  .rr-role.rr-role {
    box-sizing: border-box;
    width: 100% !important;
    margin: 0 !important;
    border: none !important;
    border-radius: 6px 6px 0 0 !important;
    background:${FACTION_COLOURS.dark} !important;
    padding: 0 6px 0 20px !important
  }

	body.rr-oc-authorized #faction-crimes-root [class*="slotIcon___"] {
    display: none !important
  }

	body.rr-oc-authorized #faction-crimes-root [class*="slotHeader___"] [class*="title___"] {
    color: #fff !important
  }

	body.rr-oc-authorized #faction-crimes-root [class*="slotHeader___"].rr-item-missing [class*="title___"] {
    color: #cc3232 !important
  }

  .rr-info {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    margin: 0 6px;
    min-width: 0
  }

  .rr-success {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 10px;
    border-radius: 10px;
    font-size: 12px;
    font-weight: 700;
    line-height: 1.5;
    white-space: nowrap;
    color: #fff !important;
    background:${FACTION_COLOURS.dark};
    border: 1px solid var(--rr-c, #444);
    box-shadow: 0 0 7px -1px var(--rr-c, transparent);
    cursor: default
  }

  .rr-pip {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, .28)
  }

  .rr-stat {
    position: absolute;
    top: 3px;
    left: 4px;
    width: 14px;
    height: 14px;
    z-index: 5;
    pointer-events: none;
    display: flex
  }

  .rr-stat svg {
    display: block
  }

  .rr-fill-green,
  .rr-fill-amber,
  .rr-fill-red,
  .rr-fill-grey {
    position: relative;
    border-radius: 6px;
    background: #2b2b2b !important
  }

  .rr-fill-green {
    box-shadow: 0 0 0 2px #029e7a, 0 0 9px rgba(2, 158, 122, .5) !important
  }

  .rr-fill-amber {
    box-shadow: 0 0 0 2px #db7b2b, 0 0 8px rgba(219, 123, 43, .45) !important
  }

  .rr-fill-red {
    box-shadow: 0 0 0 2px #cc3232, 0 0 8px rgba(204, 50, 50, .45) !important
  }

  .rr-fill-grey {
    box-shadow: 0 0 0 2px rgba(150, 150, 150, .6), 0 0 8px rgba(150, 150, 150, .3) !important
  }

	body.rr-oc-authorized #faction-crimes-root [class*="slotBody___"] {
    background: transparent !important;
    border-color: transparent !important
  }

  .tt-oc-highlight .rr-fill-green,
  .tt-oc-highlight .rr-fill-amber,
  .tt-oc-highlight .rr-fill-red,
  .tt-oc-highlight .rr-fill-grey {
    outline: 2px solid rgba(0, 0, 0, .6) !important;
    outline-offset: 2px
  }

  .rr-lock {
    position: absolute;
    inset: 0;
    z-index: 40;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    cursor: not-allowed;
    padding: 5px
  }

  .rr-lock span {
    background: rgba(31, 31, 31, .94);
    border: 1px solid rgba(150, 150, 150, .5);
    color: #cfcfcf;
    font-size: 10px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 8px;
    line-height: 1.4;
    text-align: center
  }

  .rr-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin: 8px 0;
    padding: 8px 12px;
    background:${FACTION_COLOURS.dark};
    border: 1px solid rgba(2, 158, 122, .5);
    border-radius: 6px
  }

  .rr-brand {
    color:${FACTION_COLOURS.accent};
    font-weight: 700;
    font-size: 12px;
    letter-spacing: 1.5px
  }

  .rr-brand small {
    color: #8a8a8a;
    font-weight: 600;
    letter-spacing: 1px
  }

  .rr-count {
    font-size: 11px;
    color: #8a8a8a;
    white-space: nowrap
  }

	.rr-auth-state {
		margin-left: auto;
		color: #8a8a8a;
		font-size: 11px
	}

  .rr-right {
    margin-left: auto;
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap
  }

	.rr-toolbar select {
    background: #2a2a2a;
    color: #ddd;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 3px 6px;
    font-size: 12px
  }

  .rr-api {
    background: transparent;
    border:1px solid ${FACTION_COLOURS.accent};
    color:${FACTION_COLOURS.accent};
    border-radius: 4px;
    padding: 3px 10px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 1px;
  }

  .rr-api:hover,
	.rr-api:focus-visible {
    background:${FACTION_COLOURS.accent};
    color: #fff
  }

	.rr-api:disabled { opacity: .5; cursor: default }

	.rr-gear {
		background: none;
		border: none;
		color: #8a8a8a;
	font-size: 15px;
		line-height: 1;
	padding: 0 4px;
		cursor: pointer
	}

	.rr-gear:hover { color:${FACTION_COLOURS.accent} }

	.rr-set-overlay {
		position: fixed;
		inset: 0;
		z-index: 999999;
		background: rgba(0, 0, 0, .8);
		backdrop-filter: blur(4px);
		display: flex;
		justify-content: center;
		align-items: center
	}

	.rr-set-modal {
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
		font-size: 12px
	}

	.rr-set-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 14px;
		background: linear-gradient(180deg, #2c2f37, #23252b);
		border-bottom: 1px solid #34373f
	}

	.rr-set-head b { color:${FACTION_COLOURS.accent}; letter-spacing: 1px }
	.rr-set-close {
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
		cursor: pointer
	}
	.rr-set-close:hover { color: #fff }
	.rr-set-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px }
	.rr-set-section {
		background: #1a1a1a;
		border: 1px solid #34373f;
		border-radius: 6px;
		padding: 12px
	}
	.rr-set-title {
		color: #8a8d96;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: .07em;
		text-transform: uppercase;
		margin-bottom: 10px
	}
	.rr-set-input {
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
		margin-bottom: 10px
	}
	.rr-set-input:focus { border-color:${FACTION_COLOURS.accent}; outline: none }
	.rr-set-input[data-bad="1"] { border-color: #e74c3c }
	.rr-set-status {
		text-align: center;
		padding: 8px;
		background: #15161a;
		border: 1px solid #34373f;
		border-radius: 5px;
		font-size: 11px;
		margin-bottom: 10px
	}
	.rr-set-status[data-state="ok"] { color: #2ecc71 }
	.rr-set-status[data-state="bad"] { color: #e74c3c }
	.rr-set-status[data-state="wait"] { color: #e0a80d }
	.rr-set-actions { display: flex; gap: 8px }
	.rr-set-actions .rr-api { flex: 1 }

	@media (max-width: 560px) {
		.rr-set-overlay { align-items: flex-start; padding: 8px 0; overflow-y: auto }
		.rr-set-modal { margin: auto; max-height: 92vh }
	}

  .rr-legend {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    align-items: center;
    font-size: 11px;
    color: #b9c1bd
  }

  .rr-legend span {
    display: inline-flex;
    align-items: center;
    gap: 4px
  }

  .rr-legend i {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    display: inline-block
  }

  body:not(.dark-mode) .rr-fill-green,
  body:not(.dark-mode) .rr-fill-amber,
  body:not(.dark-mode) .rr-fill-red,
  body:not(.dark-mode) .rr-fill-grey {
    background: #e2e4e6 !important
  }

  body:not(.dark-mode) .rr-role.rr-role {
    background: #d4d7da !important
  }

	body.rr-oc-authorized:not(.dark-mode) #faction-crimes-root [class*="slotHeader___"] [class*="title___"] {
    color: #2a2a2a !important
  }

	body.rr-oc-authorized:not(.dark-mode) #faction-crimes-root [class*="slotHeader___"].rr-item-missing [class*="title___"] {
    color: #cc3232 !important
  }

  body:not(.dark-mode) .rr-meta .rr-cell {
    background: #eef0f1
  }

  body:not(.dark-mode) .rr-meta .rr-v {
    color: #222
  }

  body:not(.dark-mode) .rr-success {
    background: #eef0f1;
    color: #222 !important
  }

  body:not(.dark-mode) .rr-cp {
    background: rgba(0, 0, 0, .12)
  }

  body:not(.dark-mode) .rr-legend i {
    box-shadow: 0 0 0 1px rgba(0, 0, 0, .25)
  }`;

	// #endregion

	// #region DOM Parsing & Rendering

	// ============================== PANEL PARSING ==============================
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
			const chance = parseFloat(
				q(header, sel("successChance"))?.textContent || "",
			);
			const profile = q(wrap, 'a[href*="profiles.php?XID="]');
			const xid = profile ? profile.href.match(/XID=(\d+)/)?.[1] : null;
			return {
				wrap,
				header,
				role,
				chance: isNaN(chance) ? null : chance,
				xid,
			};
		});
		return {
			panel,
			ocId: panel.getAttribute("data-oc-id"),
			title,
			level,
			slug,
			slots,
		};
	}

	const panelNodes = new Map();
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
			if (ownsNativeContents(node, record)) node.replaceChildren(...record.original);
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

	function cacheNode(ocId, kind, node) {
		if (!ocId) return;
		let rec = panelNodes.get(ocId);
		if (!rec) panelNodes.set(ocId, (rec = {}));
		if (node) rec[kind] = node;
		else delete rec[kind];
	}

	function guardPresence() {
		for (const [ocId, rec] of panelNodes) {
			const panel = document.querySelector(`div[data-oc-id="${ocId}"]`);
			const titleEl = panel && q(panel, sel("panelTitle"));
			if (!titleEl) continue;
			const node = rec.info;
			if (node && !panel.contains(node)) titleEl.after(node);
		}
	}

	// ============================== SLOT RENDERING ==============================
	function renderMeta(slot, decision) {
		const w = decision.weight;
		const req = decision.required;
		const html =
			`<div class="rr-cell"><div class="rr-l">Min</div><div class="rr-v">${req == null ? "--" : req}</div></div>` +
			`<div class="rr-cell"><div class="rr-l">Weight</div><div class="rr-v">${w == null ? "--.--%" : Number(w).toFixed(2) + "%"}</div></div>`;
		const old = slot.wrap.querySelector(".rr-meta");
		if (old) {
			if (old.innerHTML !== html) old.innerHTML = html;
		} else slot.wrap.appendChild(el("div", "rr-meta", html));
	}

	function renderCheckpoint(slot) {
		const ocId = slot.wrap
			.closest("div[data-oc-id]")
			?.getAttribute("data-oc-id");
		const ring = slot.wrap.querySelector(sel("planning"));
		const deg = ring && (ring.getAttribute("style") || "").match(/([\d.]+)deg/);
		const index = qa(slot.wrap.closest("div[data-oc-id]"), sel("slotHeader")).findIndex(h => h.parentElement === slot.wrap);
		const failed = Analysis.result?.panels.find(p => p.ocId === ocId)?.slots[index]?.failed || false;
		let bar = slot.wrap.querySelector(".rr-cp");
		if (!failed && !deg) {
			bar?.remove();
			return;
		}
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
		if (!decision.probability) { panel.querySelector(".rr-info")?.remove(); cacheNode(ocId, "info", null); return; }
		let row = panel.querySelector(".rr-info") || el("div", "rr-info");
		let pill = row.querySelector(".rr-success") || el("span", "rr-success");
		const c = decision.successColour || "#868e96";
		pill.style.setProperty("--rr-c", c);
		const result = Analysis.error ? "unavailable" : decision.success == null ? (Success.cache.has(decision.probability.key) ? "n/a" : "…") : (decision.success * 100).toFixed(2) + "%";
		const html = `<span class="rr-pip" style="background:${c}"></span>Success: ${result}`;
		if (pill.innerHTML !== html) pill.innerHTML = html;
		if (!row.contains(pill)) row.appendChild(pill);
		if (!panel.contains(row)) q(panel, sel("panelTitle"))?.after(row);
		cacheNode(ocId, "info", row);
		cacheNode(ocId, "success", pill);
		const query = decision.probability;
		if (!Success.cache.has(query.key)) Success.get(query.scenario, query.params, scheduleRender);
	}

	const relative = (e) => {
		if (getComputedStyle(e).position === "static") {
			nativePositions.set(e, { value: e.style.position, priority: e.style.getPropertyPriority("position") });
			e.style.position = "relative";
		}
	};
	const FILL = [
		"rr-fill-green",
		"rr-fill-amber",
		"rr-fill-red",
		"rr-fill-grey",
	];

	function renderStatusIcon(s, onCompleted) {
		let icon = s.wrap.querySelector(".rr-stat");
		const st = !onCompleted && s.xid && TornApi.members ?
			TornApi.statusFor(s.xid) :
			null;
		const svg = st && STATUS_ICON[st.state];
		if (!svg) {
			icon?.remove();
			return;
		}
		if (!icon) {
			icon = el("span", "rr-stat");
			relative(s.wrap);
			s.wrap.appendChild(icon);
		}
		if (icon.dataset.st !== st.state) {
			icon.dataset.st = st.state;
			icon.innerHTML = svg;
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

	// ============================ TOOLTIP AUGMENTATION ============================
	function slotWrapOf(elm) {
		for (let e = elm; e && e !== document.body; e = e.parentElement) {
			if (e.querySelector?.(`:scope > ${sel("slotHeader")}`)) return e;
		}
		return null;
	}

	function tooltipNode(node) {
		if (!(node instanceof Element)) return null;
		if (
			node.matches('[class*="tooltip___"]') ||
			node.hasAttribute("data-floating-ui-focusable")
		) {
			return node;
		}
		return node.querySelector?.('[class*="tooltip___"]') || null;
	}

	function tooltipTrigger(tip) {
		if (tip.id) {
			const ref = document.querySelector(`[aria-describedby~="${tip.id}"]`);
			if (ref) return ref;
		}
		const opened = document.querySelector(
			`${sel("slotHeader")}[data-is-tooltip-opened="true"]`,
		);
		if (opened) return opened;
		return [...document.querySelectorAll(":hover")].pop() || null;
	}

	function statusText(st) {
		const vis = st && STATUS_VIS[st.state];
		if (!vis) return null;
		if (st.state === "Okay") return "Available";
		if (vis.timed && st.until) {
			const left = st.until - Math.floor(Date.now() / 1000);
			return left > 0 ? `${st.state} — out in ${humanLeft(left)}` : st.state;
		}
		if (st.state === "Traveling" || st.state === "Abroad") {
			return st.description || st.state;
		}
		return null;
	}

	function applyTooltipStatus(tip) {
		if (!tip.isConnected || !Gate.pass() || !TornApi.members) return;
		const wrap = slotWrapOf(tooltipTrigger(tip));
		if (!wrap) return;
		const xid = wrap
			.querySelector('a[href*="profiles.php?XID="]')
			?.href.match(/XID=(\d+)/)?.[1];
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
		tip.__rrObs.observe(tip, {
			childList: true,
			subtree: true,
			characterData: true,
		});
	}

	// ============================== SLOT STATE ==============================
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
				const html = `<span>Not Eligible: Requires: ${d.required}+</span>`;
				if (!lock) s.wrap.appendChild(el("div", "rr-lock", html));
				else if (lock.innerHTML !== html) lock.innerHTML = html;
			} else lock?.remove();
		});
	}

	// #endregion

	// #region Toolbar & Settings

	// ========================= TABS / TOOLBAR / VISIBILITY =========================
	function activeTab() {
		const btn = document.querySelector(
			`${sel("buttonsContainer")} button${sel("active")}`,
		);
		return btn ? q(btn, sel("tabName"))?.textContent.trim() || null : null;
	}

	function listContainer() {
		return document.querySelector("div[data-oc-id]")?.parentElement || null;
	}

	const SORT_OPTIONS = [
		"default",
		"success-desc",
		"success-asc",
		"level-desc",
		"level-asc",
	];

	async function applyApiKey(value) {
		if (apiKeyChanging) throw new Error("API key change already in progress");
		apiKeyChanging = true;
		try {
			Gate.reset();
			onGateChange();
			await secureDelete(SESSION_STORAGE);
			await saveApiKey(value);
			Config.load();
		} finally {
			apiKeyChanging = false;
		}
		onGateChange();
		void Gate.refresh();
	}

	async function validateKey(button, setStatus) {
		const key = apiKey();
		if (!validApiKey(key)) {
			setStatus("No valid key saved - Save first", "bad");
			return;
		}

		button.disabled = true;
		setStatus("Validating…", "wait");
		try {
			await Gate.refresh();
			if (Gate.pass()) setStatus("Valid and authorized", "ok");
			else if (Gate.state === "denied") setStatus("Access restricted", "bad");
			else setStatus("Authorization unavailable", "wait");
		} catch (e) {
			setStatus("Connection error", "bad");
		} finally {
			button.disabled = false;
		}
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
		if (existing) {
			q(existing, ".rr-set-input")?.focus();
			return;
		}
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
            <button type="button" class="rr-api" data-action="validate">Validate</button>
            <button type="button" class="rr-api" data-action="remove">Remove</button>
          </div>
        </div>
      </div>
    `);
		modal.setAttribute("role", "dialog");
		modal.setAttribute("aria-modal", "true");
		modal.setAttribute("aria-labelledby", "rr-oc-settings-title");
		const input = q(modal, ".rr-set-input");
		const status = q(modal, ".rr-set-status");
		input.value = apiKey();

		const setStatus = (text, state = "") => {
			status.textContent = text;
			status.dataset.state = state;
		};
		settingsGateHook = () => {
			if (!input.isConnected || !validApiKey(input.value.trim())) return;
			if (Gate.pass()) setStatus("Valid and authorized", "ok");
			else if (Gate.state === "denied") setStatus("Access restricted", "bad");
			else if (Gate.nextTryAt > Date.now()) setStatus("Authorization unavailable", "wait");
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
				else if (!Gate.pass() && Gate.state !== "denied") {
					setStatus("Key saved; verifying…", "wait");
				}
			} catch (e) {
				input.dataset.bad = "1";
				setStatus("Protected storage unavailable", "bad");
			}
		};

		modal.addEventListener("click", event => {
			const action = event.target?.getAttribute?.("data-action");
			if (action === "save") void save();
			else if (action === "validate") void validateKey(event.target, setStatus);
			else if (action === "remove") {
				input.value = "";
				setStatus("Removing…", "wait");
				void applyApiKey("")
					.then(() => setStatus("Key removed", ""))
					.catch(() => setStatus("Protected storage unavailable", "bad"));
			}
		});
		input.addEventListener("keydown", event => {
			if (event.key === "Enter") void save();
		});
		q(modal, ".rr-set-close").addEventListener("click", closeSettings);

		let downOnOverlay = false;
		overlay.addEventListener("mousedown", event => {
			downOnOverlay = event.target === overlay;
		});
		overlay.addEventListener("click", event => {
			if (event.target === overlay && downOnOverlay) closeSettings();
		});
		settingsEscapeHandler = event => {
			if (event.key === "Escape") closeSettings();
		};
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
		state: {
			sort: SORT_OPTIONS.includes(storeGet("rr_oc_sort")) ?
				storeGet("rr_oc_sort") :
				"default",
		},
		gateMessage() {
			if (!apiKey()) return "Enter your Torn API key to activate";
			return Gate.state === "denied" ?
				"Access restricted" :
				Gate.nextTryAt > Date.now() ? "Authorization unavailable" : "Verifying access…";
		},
		ensure(tab, gateOnly = false) {
			const mode = gateOnly ? "gate" : tab === "Completed" ? "completed" : "full";
			let bar = document.querySelector(".rr-toolbar");
			if (bar && bar.dataset.mode !== mode) {
				bar.remove();
				bar = null;
			}
			const allowed = gateOnly ?
				!!listContainer() :
				tab === "Recruiting" || tab === "Planning" || tab === "Completed";
			if (!allowed) {
				bar?.remove();
				return;
			}
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
			bar.innerHTML = mode === "gate" ?
				`
        <span class="rr-brand">RR <small>· OC AUTOPILOT</small></span>
		<span class="rr-auth-state"></span>
		<button class="rr-gear" type="button" title="Settings" aria-label="Settings">&#9881;</button>
	  ` : mode === "completed" ?
				`
		<span class="rr-brand">RR <small>· OC AUTOPILOT</small></span>
		<span class="rr-right">
		  <button class="rr-gear" type="button" title="Settings" aria-label="Settings">&#9881;</button>
		</span>
	  ` :
				`
        <span class="rr-brand">RR <small>· OC AUTOPILOT</small></span>
        <span class="rr-count"></span>
        <span class="rr-legend">
          <span><i style="background:#029e7a"></i>Eligible</span>
          <span><i style="background:#db7b2b"></i>Close</span>
          <span><i style="background:#cc3232"></i>Below</span>
          <span><i style="background:#6a6a6a"></i>No data</span>
        </span>
        <span class="rr-right">
          <select class="rr-sort">
            <option value="default">Sort: default</option>
            <option value="success-desc">Success ↓</option>
            <option value="success-asc">Success ↑</option>
            <option value="level-desc">Level ↓</option>
            <option value="level-asc">Level ↑</option>
          </select>
		  <button class="rr-gear" type="button" title="Settings" aria-label="Settings">&#9881;</button>
        </span>
      `;
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
			const onGear = event => {
				event.preventDefault();
				event.stopPropagation();
				openSettings(gear);
			};
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
			panel.style.order = sorting && i >= 0 ? String(i) : "";
		}
		const countEl = document.querySelector(".rr-count");
		if (countEl && !Analysis.result) {
			const text = Analysis.nextTryAt > Date.now() ? "Analysis unavailable; retrying..." : "Loading decisions...";
			if (countEl.textContent !== text) countEl.textContent = text;
		}
		if (countEl && Analysis.result) {
			const n = Analysis.result.joinable;
			const txt = Analysis.error ? "Decision refresh unavailable; retrying..." : `${panels.length} OCs${n ? ` · ${n} joinable` : ""}`;
			if (countEl.textContent !== txt) countEl.textContent = txt;
		}
	}

	// #endregion

	// #region Panel Processing

	// ============================ PER-PANEL PROCESSING ============================
	function panelInput(info) {
		const crime = FactionCrimes.byId?.[info.ocId];
		return { ocId: info.ocId, title: info.title, slug: info.slug, level: info.level,
			crime: crime ? { status: crime.status, slots: (crime.slots || []).map(s => ({ position: s.position, item_requirement: s.item_requirement })) } : null,
			hasCrimes: FactionCrimes.byId !== null,
			slots: info.slots.map(s => ({ role: s.role, chance: s.chance, xid: s.xid || null,
				domFailed: !!s.wrap.closest(sel("failed")), glyph: s.xid && !s.wrap.querySelector(sel("planning")) ? s.wrap.querySelector(sel("slotIcon"))?.innerHTML || "" : "" })) };
	}

	const Analysis = {
		fingerprint: null, result: null, pending: null, nextTryAt: 0, error: false,
		context: null, observations: new Map(),
		reset() { this.fingerprint = null; this.result = null; this.pending = null; this.nextTryAt = 0; this.error = false; this.context = null; this.observations.clear(); },
		contextFor(input) { return JSON.stringify([location.href, input.tab, input.config, input.roles]); },
		input(infos, tab) {
			const panels = infos.map(panelInput);
			const input = { tab, sort: Toolbar.state.sort, config: Config.data, roles: Success.roles, probabilities: {}, panels };
			if (this.context === this.contextFor(input)) {
				for (const panel of panels) {
					if (this.observations.get(panel.ocId) !== JSON.stringify(panel)) continue;
					const key = this.result?.panels.find(p => p.ocId === panel.ocId)?.probability?.key;
					if (key && Success.cache.has(key)) input.probabilities[key] = Success.cache.get(key);
				}
			}
			return input;
		},
		reconcile(infos, input) {
			if (!this.result) return;
			const sameContext = this.context === this.contextFor(input);
			const keep = new Set();
			input.panels.forEach((panel, i) => {
				if (sameContext && this.observations.get(panel.ocId) === JSON.stringify(panel)) keep.add(panel.ocId);
				else {
					const before = this.observations.get(panel.ocId);
					const requirements = p => JSON.stringify([p.title, p.slug, p.level, p.slots.map(s => s.role)]);
					clearPanelDecision(infos[i].panel, sameContext && !!before && requirements(JSON.parse(before)) === requirements(panel));
				}
			});
			const panels = this.result.panels.filter(p => keep.has(p.ocId));
			if (panels.length !== this.result.panels.length) {
				this.result = panels.length ? { ...this.result, panels, order: this.result.order.filter(id => keep.has(id)), joinable: null } : null;
				this.fingerprint = null;
			}
		},
		async ensure(infos, tab) {
			if (!Gate.pass()) return;
			const input = this.input(infos, tab);
			const fp = JSON.stringify(input);
			this.reconcile(infos, input);
			if (this.result && fp === this.fingerprint) { this.draw(infos, tab); return; }
			if (this.pending || Date.now() < this.nextTryAt) return;
			const gen = Gate.gen;
			const token = Gate.token;
			const page = location.href;
			const job = {};
			this.pending = job;
			try {
				const result = await requestJson({ method: "POST", url: AUTH_API + "/v1/oc/analyse", headers: { Authorization: `Bearer ${token}` }, body: input });
				if (gen !== Gate.gen || !Gate.pass() || page !== location.href) return;
				const current = qa(document, "div[data-oc-id]").map(parsePanel);
				if (JSON.stringify(this.input(current, activeTab())) !== fp) return;
				this.fingerprint = fp; this.result = result; this.error = false; this.nextTryAt = 0;
				this.context = this.contextFor(input);
				this.observations = new Map(input.panels.map(p => [p.ocId, JSON.stringify(p)]));
				this.draw(current, tab);
			} catch (error) {
				if (gen !== Gate.gen || page !== location.href) return;
				if ((error.status === 401 || error.status === 403) && token !== Gate.token) return;
				this.nextTryAt = Date.now() + Math.max(RETRY_MS, error.retryAfter || 0);
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
					log("analysis unavailable", error); setTimeout(scheduleRender, this.nextTryAt - Date.now());
				}
			} finally {
				if (this.pending === job) { this.pending = null; if (gen === Gate.gen) scheduleRender(); }
			}
		},
		draw(infos, tab) {
			if (!this.result || !Gate.pass()) return;
			if (!document.body.classList.contains("rr-oc-authorized")) document.body.classList.add("rr-oc-authorized");
			for (const info of infos) {
				const decision = this.result.panels.find(p => p.ocId === info.ocId);
				if (!decision || decision.slots.length !== info.slots.length) continue;
				info.panel.removeAttribute("aria-busy");
				const fp = JSON.stringify([decision, this.error, info.slots.map(s => s.xid && TornApi.statusFor(s.xid))]);
				const present = info.slots.every((s, i) => {
					const d = decision.slots[i];
					return s.header.classList.contains("rr-role") && s.wrap.querySelector(".rr-meta") &&
						s.header.classList.contains("rr-item-missing") === Boolean(d.itemMissing) &&
						Boolean(s.wrap.querySelector(".rr-lock")) === Boolean(d.locked) &&
						FILL.every(fill => s.wrap.classList.contains(fill) === (fill === "rr-fill-" + d.fill));
				}) && (!decision.probability || info.panel.querySelector(".rr-info .rr-success"));
				if (info.panel.dataset.rrFp === fp && present) continue;
				info.panel.dataset.rrFp = fp;
				info.slots.forEach((s, i) => { renderCheckpoint(s); renderMeta(s, decision.slots[i]); });
				renderInfoRow(info, decision); renderSlotState(info, decision, tab);
			}
			applyVisibility();
		},
	};

	// #endregion

	// #region Lifecycle

	// ============================ MAIN LOOP / ENTRY POINT ============================
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
		const panels = qa(document, "div[data-oc-id]");
		if (force) {
			panels.forEach((p) => delete p.dataset.rrFp);
		}
		const live = new Set(panels.map((p) => p.getAttribute("data-oc-id")));
		for (const [ocId, rec] of panelNodes) {
			if (!live.has(ocId) && !rec.info?.isConnected) panelNodes.delete(ocId);
		}
		Success.ensureRoles();
		void Analysis.ensure(panels.map(parsePanel), tab);
		safe("toolbar", () => Toolbar.ensure(tab));
		safe("visibility", applyVisibility);
		safe("torn-api", () => TornApi.refresh());
		safe("faction-crimes", () => FactionCrimes.refresh());
	}

	function tickLive() {
		if (document.hidden || !Gate.pass() || !Analysis.result) return;
		const tab = safe("tab", activeTab, null);
		if (tab !== "Planning" && tab !== "Recruiting" && tab !== "Completed") {
			return;
		}
		// Keep member status and crime data on the server's cadence even while Torn's page is still.
		safe("torn-api", () => TornApi.refresh());
		safe("faction-crimes", () => FactionCrimes.refresh());
		const onCompleted = tab === "Completed";
		for (const header of qa(document, `div[data-oc-id] ${sel("slotHeader")}`)) {
			const profile = q(header.parentElement, 'a[href*="profiles.php?XID="]');
			const s = {
				wrap: header.parentElement,
				xid: profile ? profile.href.match(/XID=(\d+)/)?.[1] : null,
			};
			safe("tick-cp", () => renderCheckpoint(s));
			safe("tick-icon", () => renderStatusIcon(s, onCompleted));
		}
	}

	let scheduled = false;

	function scheduleRender() {
		if (scheduled) return;
		scheduled = true;
		setTimeout(() => {
			scheduled = false;
			safe("render", renderAll);
		}, RENDER_DEBOUNCE_MS);
	}

	// Cached server results can restore remounted panels without another request.

	function syncPanels() {
		if (Gate.pass()) scheduleRender();
	}

	safe("init", () => {
		if (window.__rrOcAutopilot) return; // guard against double injection (PDA re-navigation)
		window.__rrOcAutopilot = true;

		const style = document.createElement("style");
		style.id = "rr-oc-style";
		style.textContent = STYLE;
		document.head.appendChild(style);
		const root =
			document.querySelector("#faction-crimes-root") || document.body;
		new MutationObserver((muts) => {
			// A slot header losing its rr-role marker means React rewrote its class in place; invalidate the fingerprint so syncPanels reapplies it this same tick.
			for (const mut of muts) {
				if (mut.type !== "attributes") continue;
				const t = mut.target;
				if (
					t.matches?.(sel("slotHeader")) &&
					!t.classList.contains("rr-role")
				) {
					t.closest("div[data-oc-id]")?.removeAttribute("data-rr-fp");
				}
			}
			safe("guard", guardPresence);
			safe("resync", syncPanels);
			scheduleRender();
		}).observe(root, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["class"],
		});
		new MutationObserver((muts) => {
			for (const mut of muts) {
				for (const n of mut.removedNodes) {
					if (n instanceof Element && !n.isConnected) restoreNativeEdits(n);
				}
				for (const n of mut.addedNodes) {
					const tip = tooltipNode(n);
					if (tip) safe("tooltip", () => augmentTooltip(tip));
				}
			}
		}).observe(document.body, {
			childList: true,
			subtree: true
		});
		window.addEventListener("hashchange", () =>
			setTimeout(() => safe("render", () => renderAll(true)), 300),
		);
		safe("config", () => Config.load());
		setInterval(() => safe("tick", tickLive), 1000);
		void loadApiKey()
			.then(() => {
				apiKeyLoaded = true;
				Gate.reset();
				renderAll();
				safe("setup", promptForApiKey);
			})
			.catch(() => {
				apiKeyLoaded = true;
				authApiKey = "";
				Gate.reset();
				Gate.state = "denied";
				onGateChange();
				safe("setup", promptForApiKey);
			});
	});

	// #endregion
})();
