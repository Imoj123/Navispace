"use strict";

/**
 * Shared client-side helpers: device-local identity and small
 * fetch/DOM utilities used by seat.html and leaderboard.html.
 *
 * Identity is a device-local nickname + random token in localStorage
 * — NOT verified login. Good enough for a low-stakes leaderboard;
 * flagged as the first thing to replace with real auth if the reward
 * ever becomes valuable enough to be worth gaming.
 */

/**
 * Registers the service worker (app-shell caching + push support).
 * Safe to call on every page — no-ops quietly if the browser doesn't
 * support service workers at all (e.g. some in-app/embedded webviews).
 */
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return Promise.resolve(null);
  return navigator.serviceWorker.register("/sw.js").catch((err) => {
    console.warn("Service worker registration failed:", err);
    return null;
  });
}
registerServiceWorker();

// When a new service worker takes over (a new deploy), reload once so the
// page shown is the new version rather than the one already on screen.
// Skipped on a device's very first visit, when there was nothing to replace.
if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
  let reloadedForUpdate = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadedForUpdate) return;
    reloadedForUpdate = true;
    window.location.reload();
  });
}

function isStandaloneApp() {
  return (
    window.navigator.standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches
  );
}

/**
 * The installed (Home Screen) app is launched with the identity of the
 * browser it was installed from: ?handoff=<token>&nick=<nickname>, put
 * there by the server's dynamic manifest. Adopting it means the app and
 * the browser that scanned the QR code are the same student — which is
 * what lets a push subscription made in the app reach the seat checked
 * into from the browser. Only honoured inside the installed app, so a
 * shared link can never swap a browser's identity.
 */
function readCookie(name) {
  for (const part of document.cookie.split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

(function adoptHandoffIdentity() {
  const params = new URLSearchParams(window.location.search);
  // Two routes in, because iOS versions differ: the start_url's query
  // (some drop it), or the ns_handoff cookie, which iOS copies from Safari
  // into a Home Screen app when it's installed.
  let source = params.get("handoff") ? params : null;
  if (!source && isStandaloneApp()) {
    const cookie = readCookie("ns_handoff");
    if (cookie) source = new URLSearchParams(cookie);
  }
  if (source && isStandaloneApp()) {
    const token = source.get("handoff") || "";
    if (/^[0-9a-f-]{36}$/i.test(token) && token !== localStorage.getItem("navispace_token")) {
      localStorage.setItem("navispace_token", token);
      const nick = (source.get("nick") || "").trim();
      if (nick) localStorage.setItem("navispace_nickname", nick.slice(0, 24));
      // Just became this student: take them to the seat they hold.
      sessionStorage.setItem("navispace_go_to_seat", "1");
    }
  }
  if (params.has("handoff") || params.has("nick")) {
    params.delete("handoff");
    params.delete("nick");
    const qs = params.toString();
    history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash);
  }
})();

/**
 * Points this page's manifest link at the identity-carrying manifest,
 * so "Add to Home Screen" installs an app that starts as this student.
 * Called on load and whenever the identity is created or renamed.
 */
function updateManifestHandoff() {
  const link = document.querySelector('link[rel="manifest"]');
  const token = localStorage.getItem("navispace_token");
  if (!link || !token) return;
  const params = new URLSearchParams({ handoff: token });
  const nick = localStorage.getItem("navispace_nickname");
  if (nick && nick !== "Anonymous") params.set("nick", nick);
  // On a seat page, the installed app should open on this seat.
  if (window.location.pathname === "/seat.html") {
    const here = new URLSearchParams(window.location.search);
    params.set("lib", getLibraryIdFromUrl());
    params.set("seat", here.get("seat") || "A1");
  }
  // The same fields as a cookie: Safari may fetch the manifest before this
  // script runs, and the link's crossorigin="use-credentials" sends it.
  document.cookie = `ns_handoff=${encodeURIComponent(params)}; path=/; max-age=31536000; SameSite=Lax; Secure`;
  const href = `/manifest.json?${params}`;
  if (link.getAttribute("href") === href) return;
  // A fresh element rather than a new href: some browsers (Safari) only
  // read a manifest link when it's inserted, not when it changes.
  const fresh = link.cloneNode();
  fresh.href = href;
  link.replaceWith(fresh);
}
updateManifestHandoff();

/**
 * Converts a URL-safe base64 VAPID public key (as returned by
 * /api/config) into the Uint8Array PushManager.subscribe expects.
 */
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * iOS Safari only exposes the Push API to a site that's been added to
 * the Home Screen and reopened from there — it's absent from an
 * ordinary browser tab (and from the in-app browser a QR/camera scan
 * opens into) regardless of iOS version. Detecting that case lets the
 * UI point at the actual fix ("Add to Home Screen") instead of a flat
 * "not supported", which reads as a dead end when it isn't one.
 */
function isIosNotInstalled() {
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  return isIos && !isStandaloneApp();
}

/**
 * Requests notification permission (must be called from a user
 * gesture, e.g. a button click — browsers block silent auto-prompts)
 * and subscribes this device to Web Push, then registers the
 * subscription with the server against this identity's token.
 *
 * Returns { ok, reason? } — reason is one of "ios_not_installed",
 * "unsupported", "permission_denied", "no_vapid_key", or an error
 * message.
 */
async function enablePushReminders(identity) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    if (isIosNotInstalled()) {
      return { ok: false, reason: "ios_not_installed" };
    }
    return { ok: false, reason: "unsupported" };
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, reason: "permission_denied" };
  }

  const cfg = await getServerConfig();
  if (!cfg.VAPID_PUBLIC_KEY) {
    return { ok: false, reason: "no_vapid_key" };
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(cfg.VAPID_PUBLIC_KEY),
      });
    }

    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: identity.token, subscription }),
    });
    const body = await res.json();
    return { ok: !!body.ok, testSent: !!body.testSent, testReason: body.testReason || null };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  }
}

function getOrCreateIdentity() {
  let token = localStorage.getItem("navispace_token");
  let nickname = localStorage.getItem("navispace_nickname");

  if (!token) {
    token = crypto.randomUUID();
    localStorage.setItem("navispace_token", token);
  }
  if (!nickname) {
    // window.prompt() throws (rather than returning null) in some
    // embedded/webview browsers that don't support native dialogs
    // (e.g. VS Code's built-in preview pane). Never let that crash
    // the page — fall back to "Anonymous" and let the nickname
    // banner (below) offer a normal in-page way to set it instead.
    try {
      nickname = (window.prompt("Pick a study nickname for the leaderboard:") || "").trim();
    } catch (err) {
      nickname = "";
    }
    if (!nickname) nickname = "Anonymous";
    localStorage.setItem("navispace_nickname", nickname);
  }

  updateManifestHandoff();
  return { token, nickname };
}

// Public APIs never return another device's raw token, only the first
// 16 hex chars of its SHA-256 (holderHash, reporterHash, claimantHash).
// This device hashes its own token the same way to recognise its seat.
let myTokenHash = null;
let myHashedToken = null;
async function tokenHash(token) {
  if (!token || !(window.crypto && crypto.subtle)) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(token)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
function myHashReady() {
  const token = localStorage.getItem("navispace_token");
  if (!myTokenHash || token !== myHashedToken) {
    myHashedToken = token;
    myTokenHash = tokenHash(token).catch(() => null).then((h) => {
      myHash = h;
      return h;
    });
  }
  return myTokenHash;
}
let myHash = null;
/** True when a public *Hash field belongs to this device. Data from the
 * fetch helpers below has already waited for the hash, so this is sync. */
function isMine(hash) {
  return !!hash && hash === myHash;
}

/** Focus time of a sitting, in ms: since check-in, minus every step-away
 * (including one in progress, so the clock holds still while you're away).
 * Takes a seat or an /api/held answer; both carry the same fields. */
function focusElapsedMs(s, now = Date.now()) {
  if (!s || !s.sessionStart) return 0;
  const away = (s.awayMs || 0) + (s.awayStart ? Math.max(0, now - s.awayStart) : 0);
  return Math.max(0, now - s.sessionStart - away);
}

function setNickname(nickname) {
  const clean = (nickname || "").trim() || "Anonymous";
  localStorage.setItem("navispace_nickname", clean);
  updateManifestHandoff();
  return clean;
}

/**
 * The library a page is showing, read from its own URL (?lib=...).
 * Defaults to "engineering" — NaviSpace's very first QR codes were
 * printed before multi-library support existed and encode URLs with
 * no lib param at all, so this default is what keeps every
 * already-printed Engineering Library code working untouched.
 */
function getLibraryIdFromUrl() {
  return new URLSearchParams(window.location.search).get("lib") || "engineering";
}

/** Builds a page URL that carries the given library id along. */
function libraryUrl(path, libraryId) {
  return `${path}?lib=${encodeURIComponent(libraryId)}`;
}

/**
 * GET a JSON API endpoint, riding out a flaky phone connection: each try
 * times out after 10s, and a network error or 5xx is retried twice
 * (after 0.6s, then 1.5s) before giving up. 4xx answers are returned
 * as-is (they carry a reason, e.g. unknown_seat). Without this, one
 * dropped request left a page stuck on "Loading…" until a manual refresh.
 */
async function apiGet(url) {
  const waits = [600, 1500];
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.status >= 500 && attempt < waits.length) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= waits.length) throw err;
      await new Promise((r) => setTimeout(r, waits[attempt]));
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The seat this device currently holds, if any: { libraryId, seatId, state } or nulls. */
async function getHeldSeat(token) {
  const res = await fetch(`/api/held`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  return res.json();
}

/**
 * Each library's "room": the background and book colours it wears on
 * every page, by its position in the server's LIBRARIES list (cycling if
 * there are more libraries than themes). The home page's book covers use
 * the same entries, so a library looks the same everywhere.
 */
const LIBRARY_THEMES = [
  { inner: "#0b8a78", mid: "#044e3b", outer: "#011411", cover: "#2f8f6f", coverDark: "#1d5c48", foil: "#f1dfae" },
  { inner: "#0b4f8a", mid: "#04294e", outer: "#010c14", cover: "#2a5d9f", coverDark: "#1a3d6b", foil: "#f3e4bd" },
  { inner: "#8a2b4f", mid: "#4e0f2a", outer: "#14010a", cover: "#a03a5c", coverDark: "#66223b", foil: "#f6dfc0" },
  { inner: "#8a5a0b", mid: "#4e3004", outer: "#140c01", cover: "#a8742a", coverDark: "#6b4816", foil: "#fbe9c4" },
];
const LIBS_CACHE_KEY = "navispace_libs_cache";

function cachedLibraries() {
  try {
    const list = JSON.parse(localStorage.getItem(LIBS_CACHE_KEY) || "null");
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

/** Sets a theme's room colours on the page (body CSS variables + browser chrome). */
function paintRoom(theme) {
  const s = document.body.style;
  s.setProperty("--bg-inner", theme.inner);
  s.setProperty("--bg-mid", theme.mid);
  s.setProperty("--bg-outer", theme.outer);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme.outer;
}

function libraryTheme(libraries, libraryId) {
  const i = Math.max(0, (libraries || []).findIndex((l) => l.id === libraryId));
  return LIBRARY_THEMES[i % LIBRARY_THEMES.length];
}

let _librariesPromise = null;
/** The library list — fetched once per page, and cached for the next page's first paint. */
function getLibraries() {
  if (!_librariesPromise) {
    _librariesPromise = apiGet(`/api/libraries`)
      .then((list) => {
        try { localStorage.setItem(LIBS_CACHE_KEY, JSON.stringify(list)); } catch { }
        return list;
      })
      .catch((err) => {
        _librariesPromise = null;
        throw err;
      });
  }
  return _librariesPromise;
}

async function postScan(libraryId, seatId, action, identity) {
  const res = await fetch(`/api/library/${encodeURIComponent(libraryId)}/scan/${encodeURIComponent(seatId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, token: identity.token, nickname: identity.nickname }),
  });
  const [body] = await Promise.all([res.json(), myHashReady()]);
  return { httpOk: res.ok, ...body };
}

async function getSeat(libraryId, seatId) {
  await myHashReady();
  return apiGet(`/api/library/${encodeURIComponent(libraryId)}/seat/${encodeURIComponent(seatId)}`);
}

async function getLeaderboard(libraryId) {
  return apiGet(`/api/library/${encodeURIComponent(libraryId)}/leaderboard`);
}

async function getAllSeats(libraryId) {
  await myHashReady();
  return apiGet(`/api/library/${encodeURIComponent(libraryId)}/seats`);
}

let _configCache = null;
/** Config values that mirror src/config.js — cached for the page's lifetime. */
async function getServerConfig() {
  if (_configCache) return _configCache;
  _configCache = await apiGet(`/api/config`);
  return _configCache;
}

async function reportSeatWrong(libraryId, seatId, identity) {
  const res = await fetch(`/api/library/${encodeURIComponent(libraryId)}/report/${encodeURIComponent(seatId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: identity.token }),
  });
  return res.json();
}

/* --- Lost & Found ------------------------------------------------------- */

async function getLostFoundItems(libraryId) {
  await myHashReady();
  return apiGet(`/api/library/${encodeURIComponent(libraryId)}/lostfound`);
}

async function reportLostFoundItem(libraryId, { description, location, photoDataUrl, identity }) {
  const res = await fetch(`/api/library/${encodeURIComponent(libraryId)}/lostfound`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      description,
      location,
      photoDataUrl,
      token: identity.token,
      nickname: identity.nickname,
    }),
  });
  return res.json();
}

async function claimLostFoundItem(libraryId, itemId, { identity, note }) {
  const res = await fetch(`/api/library/${encodeURIComponent(libraryId)}/lostfound/${encodeURIComponent(itemId)}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: identity.token, nickname: identity.nickname, note }),
  });
  return res.json();
}

async function resolveLostFoundItem(libraryId, itemId, identity) {
  const res = await fetch(`/api/library/${encodeURIComponent(libraryId)}/lostfound/${encodeURIComponent(itemId)}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: identity.token }),
  });
  return res.json();
}

/**
 * Downscales and compresses an image file in the browser before
 * upload, so a phone's multi-megabyte camera photo becomes a small
 * enough base64 string to store as one Redis value (see
 * LOST_FOUND_MAX_PHOTO_CHARS server-side). Returns a JPEG data URL.
 */
function downscaleImageFile(file, maxDimension = 900, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.onload = () => {
      img.onerror = () => reject(new Error("Couldn't read that image."));
      img.onload = () => {
        const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Splits a seat ID like "A1" or "B12" into its leading letters (zone)
 * and trailing number, for laying seats out as rows-by-zone /
 * columns-by-number. Falls back gracefully for IDs that don't follow
 * that pattern (whole ID becomes both zone and a fixed column of 1),
 * so an unusual seat name never crashes the map, just lands in its
 * own row.
 */
function parseSeatId(seatId) {
  const match = /^([A-Za-z]+)(\d+)$/.exec(seatId);
  if (!match) return { zone: seatId, number: 1 };
  return { zone: match[1].toUpperCase(), number: parseInt(match[2], 10) };
}

/**
 * Computes a 0-1 "how stale is this" fraction for an OCCUPIED or
 * STEPPED_AWAY seat, based on how much of its current expiry window
 * has already elapsed since the last confirming scan. AVAILABLE
 * seats have no meaningful staleness (there's nothing to confirm).
 * Returns null when staleness doesn't apply.
 */
function computeStaleness(seat, now = Date.now()) {
  const expiry = seat.state === "OCCUPIED" ? seat.checkInExpiry
    : seat.state === "STEPPED_AWAY" ? seat.stepAwayExpiry
    : null;
  if (!expiry || !seat.lastConfirmTime) return null;

  const totalWindow = expiry - seat.lastConfirmTime;
  if (totalWindow <= 0) return 1; // already past expiry, just not swept yet

  const elapsed = now - seat.lastConfirmTime;
  return Math.max(0, Math.min(1, elapsed / totalWindow));
}

/** "high" | "medium" | "low" | null (null = staleness doesn't apply). */
function confidenceLevel(seat, config, now = Date.now()) {
  const staleness = computeStaleness(seat, now);
  if (staleness === null) return null;
  if (staleness < config.STALENESS_HIGH_MAX) return "high";
  if (staleness < config.STALENESS_MEDIUM_MAX) return "medium";
  return "low";
}

/**
 * Library pages (body data-room="library") wear their library's room:
 * straight away from the cached list, then confirmed from the live one.
 */
(function paintLibraryRoom() {
  if (!document.body || document.body.dataset.room !== "library") return;
  const id = getLibraryIdFromUrl();
  const cached = cachedLibraries();
  if (cached) paintRoom(libraryTheme(cached, id));
  getLibraries().then((list) => paintRoom(libraryTheme(list, id))).catch(() => {});
})();

/**
 * Right after the installed app takes over a student's identity, open
 * the seat they hold — that's where "Enable seat reminders" is.
 */
(function goToHeldSeatAfterHandoff() {
  if (sessionStorage.getItem("navispace_go_to_seat") !== "1") return;
  sessionStorage.removeItem("navispace_go_to_seat");
  const token = localStorage.getItem("navispace_token");
  if (!token) return;
  getHeldSeat(token)
    .then((held) => {
      if (!held || !held.seatId) return;
      const here = new URLSearchParams(window.location.search);
      if (window.location.pathname === "/seat.html" && here.get("seat") === held.seatId) return;
      window.location.replace(`/seat.html?lib=${encodeURIComponent(held.libraryId)}&seat=${encodeURIComponent(held.seatId)}`);
    })
    .catch(() => {});
})();
