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
  const isStandalone =
    window.navigator.standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;
  return isIos && !isStandalone;
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
    return { ok: !!body.ok };
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

  return { token, nickname };
}

function setNickname(nickname) {
  const clean = (nickname || "").trim() || "Anonymous";
  localStorage.setItem("navispace_nickname", clean);
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

async function getLibraries() {
  const res = await fetch(`/api/libraries`);
  return res.json();
}

async function postScan(libraryId, seatId, action, identity) {
  const res = await fetch(`/api/library/${encodeURIComponent(libraryId)}/scan/${encodeURIComponent(seatId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, token: identity.token, nickname: identity.nickname }),
  });
  const body = await res.json();
  return { httpOk: res.ok, ...body };
}

async function getSeat(libraryId, seatId) {
  const res = await fetch(`/api/library/${encodeURIComponent(libraryId)}/seat/${encodeURIComponent(seatId)}`);
  return res.json();
}

async function getLeaderboard(libraryId) {
  const res = await fetch(`/api/library/${encodeURIComponent(libraryId)}/leaderboard`);
  return res.json();
}

async function getAllSeats(libraryId) {
  const res = await fetch(`/api/library/${encodeURIComponent(libraryId)}/seats`);
  return res.json();
}

let _configCache = null;
/** Config values that mirror src/config.js — cached for the page's lifetime. */
async function getServerConfig() {
  if (_configCache) return _configCache;
  const res = await fetch(`/api/config`);
  _configCache = await res.json();
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
  const res = await fetch(`/api/library/${encodeURIComponent(libraryId)}/lostfound`);
  return res.json();
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
