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

async function postScan(seatId, action, identity) {
  const res = await fetch(`/api/scan/${encodeURIComponent(seatId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, token: identity.token, nickname: identity.nickname }),
  });
  const body = await res.json();
  return { httpOk: res.ok, ...body };
}

async function getSeat(seatId) {
  const res = await fetch(`/api/seat/${encodeURIComponent(seatId)}`);
  return res.json();
}

async function getLeaderboard() {
  const res = await fetch(`/api/leaderboard`);
  return res.json();
}

async function getAllSeats() {
  const res = await fetch(`/api/seats`);
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

async function reportSeatWrong(seatId, identity) {
  const res = await fetch(`/api/report/${encodeURIComponent(seatId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: identity.token }),
  });
  return res.json();
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
