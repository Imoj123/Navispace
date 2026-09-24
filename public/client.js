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
    nickname = (window.prompt("Pick a study nickname for the leaderboard:") || "").trim();
    if (!nickname) nickname = "Anonymous";
    localStorage.setItem("navispace_nickname", nickname);
  }

  return { token, nickname };
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
