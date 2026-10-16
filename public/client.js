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
  // Apps added before the start page was always home open on the seat they
  // were added from (only a start URL carries ?handoff=). Check that seat.
  if (isStandaloneApp() && params.has("handoff") && window.location.pathname === "/seat.html") {
    sessionStorage.setItem("navispace_check_start_seat", "1");
  }
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
  // iPadOS 13+ Safari reports a Mac user agent; only the touch screen tells it apart.
  const isIos = (/iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
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
async function enablePushReminders(identity, { quiet = false, fresh = false } = {}) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    if (isIosNotInstalled()) {
      return { ok: false, reason: "ios_not_installed" };
    }
    return { ok: false, reason: "unsupported" };
  }

  // quiet: only refresh an existing permission, never prompt (no tap).
  // (Safari can say "default" for a granted one; see notificationStateLive.)
  if (quiet && Notification.permission === "denied") return { ok: false, reason: "not_granted" };
  const permission = quiet ? "granted" : await Notification.requestPermission();
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
    // fresh: drop this browser's subscription and make a new one (a stale
    // one can be accepted by the push service yet never delivered).
    if (subscription && fresh) {
      await subscription.unsubscribe().catch(() => {});
      subscription = null;
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(cfg.VAPID_PUBLIC_KEY),
      });
    }

    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: identity.token, subscription, quiet }),
    });
    const body = await res.json();
    return { ok: !!body.ok, testSent: !!body.testSent, testReason: body.testReason || null };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  }
}

/** This device and browser, for notification help. */
function deviceKind() {
  const ua = navigator.userAgent;
  const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1; // iPadOS calls itself a Mac
  const os = /iPhone|iPod/.test(ua) ? "iphone" : (/iPad/.test(ua) || touchMac) ? "ipad"
    : /Android/.test(ua) ? "android" : /Macintosh/.test(ua) ? "mac" : /Windows/.test(ua) ? "windows" : "other";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox|FxiOS/.test(ua) ? "Firefox"
    : /Chrome|CriOS|Chromium/.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "your browser";
  const installed = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  return { os, browser, installed };
}

/**
 * Where notifications stand on this device: "on", "off", "blocked",
 * "needs_home_screen" (iPhone/iPad Safari: only a Home Screen copy can
 * get them) or "unsupported".
 */
function notificationState() {
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    return isIosNotInstalled() ? "needs_home_screen" : "unsupported";
  }
  return { granted: "on", denied: "blocked" }[Notification.permission] || "off";
}

/**
 * notificationState(), double-checked: Safari (notably a Home Screen app on
 * iPhone) can report the permission as "default" after moving between
 * pages even though it's granted and notifications still arrive. A live
 * push subscription on this device settles it: then they're on.
 */
async function notificationStateLive() {
  const state = notificationState();
  if (state !== "off") return state;
  try {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    const sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null;
    return sub ? "on" : state;
  } catch {
    return state;
  }
}

/**
 * Step-by-step help for this exact device and browser, for a state:
 * { title, steps: [string] }. Used by the home page's Notifications
 * section and the Lost & Found thread, so both say the same thing.
 */
function notificationGuide(state = notificationState()) {
  const { os, browser, installed } = deviceKind();
  const host = window.location.host;
  const where = { mac: "Mac", windows: "Windows computer", android: "Android phone", iphone: "iPhone", ipad: "iPad" }[os] || "device";
  if (state === "needs_home_screen") {
    return {
      title: `On ${os === "ipad" ? "an iPad" : "an iPhone"}, notifications only work from the Home Screen`,
      steps: [
        "In Safari, tap the Share button (the square with an arrow).",
        "Choose Add to Home Screen, then Add.",
        "Open NaviSpace from the new icon on your Home Screen.",
        "Come back to this section and tap Turn on notifications, then Allow.",
      ],
    };
  }
  if (state === "unsupported") {
    return { title: "This browser can't show notifications", steps: ["Open NaviSpace in Chrome, Edge, Safari or Firefox and turn them on there."] };
  }
  if (state === "blocked") {
    if (os === "iphone" || os === "ipad") return { title: "Notifications are blocked for NaviSpace", steps: ["Open the Settings app, then Notifications.", "Tap NaviSpace and turn on Allow Notifications.", "Come back and reload this page."] };
    if (os === "android") return { title: `Notifications are blocked for this site in ${browser}`, steps: ["Tap the icon to the left of the address, then Permissions (or Site settings).", "Set Notifications to Allow.", "Reload this page."] };
    if (browser === "Safari") return { title: "Notifications are blocked for this site in Safari", steps: ["In the menu bar choose Safari → Settings → Websites → Notifications.", `Set ${host} to Allow. If it isn't listed, tick "Allow websites to ask for permission to send notifications".`, "Reload this page and turn them on again."] };
    if (browser === "Firefox") return { title: "Notifications are blocked for this site in Firefox", steps: ["Click the icon to the left of the address.", "Clear the blocked Notifications permission.", "Reload this page and turn them on again."] };
    return { title: `Notifications are blocked for this site in ${browser}`, steps: ["Click the icon to the left of the address, then Site settings.", "Set Notifications to Allow.", "Reload this page."] };
  }
  // On, or about to be turned on: what makes a delivered notification stay hidden.
  const first = state === "off" ? [`Tap Turn on notifications, then Allow when ${browser} asks.`] : [];
  if (os === "mac") {
    const app = browser === "your browser" ? "your browser" : browser === "Chrome" ? "Google Chrome" : browser === "Edge" ? "Microsoft Edge" : browser;
    return {
      title: `If nothing shows on this ${where}`,
      steps: first.concat([
        `Open System Settings → Notifications and click ${app}${browser === "Chrome" ? " (it can be listed twice: do both)" : ""}.`,
        "Turn on Allow notifications and set Alert Style to Persistent.",
        "Turn off Do Not Disturb: Control Centre → Focus.",
      ], browser === "Safari" ? [`In Safari → Settings → Websites → Notifications, make sure ${host} is set to Allow.`] : []),
    };
  }
  if (os === "windows") return { title: `If nothing shows on this ${where}`, steps: first.concat([`Open Settings → System → Notifications and turn on ${browser === "Edge" ? "Microsoft Edge" : browser === "Chrome" ? "Google Chrome" : browser}.`, "Turn off Do not disturb in the same place."]) };
  if (os === "android") return { title: `If nothing shows on this ${where}`, steps: first.concat([`Open Settings → Apps → ${browser} → Notifications and allow them.`, "Turn off Do Not Disturb, and let the browser run in the background if battery saver asks."]) };
  if (os === "iphone" || os === "ipad") return { title: `If nothing shows on this ${where}`, steps: first.concat(["Open the Settings app → Notifications → NaviSpace and turn on Allow Notifications.", "Turn off Focus or Do Not Disturb in Control Centre."]) };
  return { title: "If nothing shows on this device", steps: first.concat(["Allow notifications for your browser in the device's settings, and turn off Do Not Disturb."]) };
}

/** Resolves with the service worker's report when a push arrives, or null after ms. */
function pushArrives(ms) {
  return new Promise((resolve) => {
    if (!navigator.serviceWorker) return resolve(null);
    const done = (v) => { navigator.serviceWorker.removeEventListener("message", on); clearTimeout(timer); resolve(v); };
    const on = (e) => { if (e.data && e.data.type === "navispace-push") done(e.data); };
    const timer = setTimeout(() => done(null), ms);
    navigator.serviceWorker.addEventListener("message", on);
  });
}

/**
 * Sends a test notification and follows it all the way: did the server
 * send it, did this browser receive it, did the system accept it? A
 * browser that never receives it gets a fresh subscription and a second
 * try. Returns { ok, hidden, message }: hidden means it reached the
 * device, so the device's own settings are hiding it.
 */
async function testPushNotifications(identity) {
  for (const fresh of [false, true]) {
    const arrived = pushArrives(15000);
    const r = await enablePushReminders(identity, { fresh });
    if (!r.ok) {
      return { ok: false, message: r.reason === "permission_denied" ? "Notifications are blocked for this site." : "Couldn't sign this device up for notifications." };
    }
    if (!r.testSent) return { ok: false, message: `The server couldn't send it (${r.testReason || "unknown reason"}).` };
    const got = await arrived;
    if (got && got.shown) return { ok: true, hidden: true, message: "Sent and received: it reached this device. If you didn't see it, the device is hiding it. Follow the steps below." };
    if (got) return { ok: false, message: `It reached this browser, but the system refused to show it (${got.error}).` };
  }
  return { ok: false, message: "The server sent it twice, but this browser never received it. Its connection to the push service may be blocked (a VPN or firewall can do this). Try another browser or network." };
}

/**
 * A browser that already allowed notifications re-registers itself with
 * the server once a day, quietly (no prompt, no test notification). This
 * covers a device that allowed them on one page but never signed up its
 * current identity, a subscription the browser renewed, or the server's
 * store being reset.
 */
(function syncPushQuietly() {
  try {
    if (!("Notification" in window) || Notification.permission === "denied") return;
    const token = localStorage.getItem("navispace_token");
    const last = Number(localStorage.getItem("navispace_push_synced")) || 0;
    if (!token || Date.now() - last < 24 * 60 * 60 * 1000) return;
    // Quiet only refreshes a granted permission; a subscription that exists
    // (see notificationStateLive) gets re-sent as it is.
    notificationStateLive().then((state) => (state === "on" ? enablePushReminders({ token }, { quiet: true }) : { ok: false })).then((r) => {
      if (r.ok) localStorage.setItem("navispace_push_synced", String(Date.now()));
    }).catch(() => {});
  } catch { }
})();

/** RFC 4122 v4 id for browsers without crypto.randomUUID (iOS 15.0-15.3). */
function uuidFallback() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function getOrCreateIdentity() {
  let token = localStorage.getItem("navispace_token");
  if (!token) {
    token = crypto.randomUUID ? crypto.randomUUID() : uuidFallback();
    localStorage.setItem("navispace_token", token);
  }
  updateManifestHandoff();
  // The nickname is read live, so a name chosen in the welcome card (or
  // saved on the seat page) is used by the very next scan on this page.
  return {
    token,
    get nickname() {
      return savedNickname() || "Anonymous";
    },
    set nickname(value) {
      setNickname(value);
    },
  };
}

/** The nickname this device chose, or null if it hasn't chosen one yet. */
function savedNickname() {
  const n = (localStorage.getItem("navispace_nickname") || "").trim();
  return n && n !== "Anonymous" ? n : null;
}

/* --- Welcome: ask a new visitor for their NaviSpace nickname ---------------
 * Shown once, the first time someone opens any page, as a card rather than
 * the browser's prompt box. "Not now" lets them look around; they're asked
 * again on their next visit, and can always set it on a seat page. */
function showWelcome() {
  if (document.getElementById("welcome")) return;
  const wrap = document.createElement("div");
  wrap.className = "welcome";
  wrap.id = "welcome";
  wrap.setAttribute("role", "dialog");
  wrap.setAttribute("aria-modal", "true");
  wrap.setAttribute("aria-labelledby", "welcomeTitle");
  wrap.innerHTML = `
    <form class="welcome-card" novalidate>
      <span class="welcome-mark" aria-hidden="true">N</span>
      <p class="welcome-eyebrow">Welcome to NaviSpace</p>
      <h2 id="welcomeTitle">What should we call you?</h2>
      <p class="welcome-text">Your nickname goes on the study board and on any seat you check into. No sign-up, no email. <a href="/privacy.html">What's kept</a>.</p>
      <label class="welcome-label" for="welcomeName">Nickname</label>
      <input id="welcomeName" type="text" maxlength="24" autocomplete="nickname" autocapitalize="words" placeholder="e.g. Lerato" required />
      <p class="welcome-error" id="welcomeError" hidden>Pick a name with at least two letters.</p>
      <button class="btn btn-primary" type="submit">Continue</button>
      <button class="welcome-later" type="button">Not now</button>
    </form>`;
  document.body.appendChild(wrap);
  document.documentElement.classList.add("welcome-open");
  const input = wrap.querySelector("input");
  const close = () => {
    wrap.classList.add("leaving");
    document.documentElement.classList.remove("welcome-open");
    setTimeout(() => wrap.remove(), 250);
  };
  wrap.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (name.replace(/[^\p{L}\p{N}]/gu, "").length < 2) {
      wrap.querySelector("#welcomeError").hidden = false;
      input.focus();
      return;
    }
    setNickname(name.slice(0, 24));
    document.dispatchEvent(new CustomEvent("navispace:nickname", { detail: savedNickname() }));
    close();
  });
  wrap.querySelector(".welcome-later").addEventListener("click", () => {
    try { sessionStorage.setItem("navispace_welcome_later", "1"); } catch { }
    close();
  });
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Escape") wrap.querySelector(".welcome-later").click();
  });
  setTimeout(() => input.focus(), 350);
}

(function welcomeNewVisitor() {
  let later = null;
  try { later = sessionStorage.getItem("navispace_welcome_later"); } catch { }
  if (savedNickname() || later) return;
  // Someone reading the privacy notice shouldn't be asked for a name first.
  if (window.location.pathname === "/privacy.html") return;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", showWelcome);
  else showWelcome();
})();

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
 * "Change library" links open the library picker, telling it which
 * library you're in and which page you came from, so a pick lands on the
 * same page for the new library.
 */
document.querySelectorAll("a[data-change-library]").forEach((a) => {
  const q = new URLSearchParams({ lib: getLibraryIdFromUrl(), from: window.location.pathname });
  a.href = `/libraries.html?${q}`;
});

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

/* --- Seat codes -------------------------------------------------------------
 * A seat's QR sticker carries a code (?k=...) that checking in needs, so only
 * someone who scanned the desk can claim it (see src/seatcode.js). The code is
 * kept for this tab and taken out of the address bar, so a seat link copied
 * from the browser doesn't carry it. */
const seatCodeKey = (libraryId, seatId) => `navispace_k_${libraryId}_${seatId}`;

(function rememberSeatCode() {
  const params = new URLSearchParams(location.search);
  const seatId = params.get("seat");
  const code = params.get("k");
  if (!seatId || !code) return;
  try { sessionStorage.setItem(seatCodeKey(getLibraryIdFromUrl(), seatId), code); } catch { }
  params.delete("k");
  const rest = params.toString();
  history.replaceState(history.state, "", location.pathname + (rest ? "?" + rest : "") + location.hash);
})();

function seatCodeFor(libraryId, seatId) {
  try { return sessionStorage.getItem(seatCodeKey(libraryId, seatId)); } catch { return null; }
}

async function postScan(libraryId, seatId, action, identity) {
  const payload = { action, token: identity.token, nickname: identity.nickname };
  if (action === "checkIn") payload.k = seatCodeFor(libraryId, seatId);
  const res = await fetch(`/api/library/${encodeURIComponent(libraryId)}/scan/${encodeURIComponent(seatId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
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

/** Lost & found POSTs that carry this device's token; returns the JSON answer. */
async function lostFoundPost(libraryId, itemId, action, body) {
  const res = await fetch(`/api/library/${encodeURIComponent(libraryId)}/lostfound/${encodeURIComponent(itemId)}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** The finder handed the item to the library's front desk. */
function markLostFoundAtDesk(libraryId, itemId, identity) {
  return lostFoundPost(libraryId, itemId, "desk", { token: identity.token });
}

/** The private finder–owner thread for a claimed item. */
function getLostFoundThread(libraryId, itemId, identity) {
  return lostFoundPost(libraryId, itemId, "thread", { token: identity.token });
}

/** Either person in a thread reports it to library staff. */
function reportLostFoundThread(libraryId, itemId, identity) {
  return lostFoundPost(libraryId, itemId, "thread/report", { token: identity.token });
}

function sendLostFoundMessage(libraryId, itemId, identity, text) {
  return lostFoundPost(libraryId, itemId, "thread/send", { token: identity.token, text });
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
(function leaveStaleStartSeat() {
  if (sessionStorage.getItem("navispace_check_start_seat") !== "1") return;
  sessionStorage.removeItem("navispace_check_start_seat");
  const token = localStorage.getItem("navispace_token");
  const here = new URLSearchParams(window.location.search).get("seat");
  if (!token) { window.location.replace("/"); return; }
  getHeldSeat(token)
    .then((held) => {
      if (held && held.seatId === here) return; // still yours: stay
      window.location.replace(held && held.seatId
        ? `/seat.html?lib=${encodeURIComponent(held.libraryId)}&seat=${encodeURIComponent(held.seatId)}`
        : "/");
    })
    .catch(() => window.location.replace("/"));
})();

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
