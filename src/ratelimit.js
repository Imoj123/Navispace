"use strict";

/**
 * Per-device and per-network speed limits, so one prankster can't flood the
 * floor, the board or someone's notifications. Counted in memory over a
 * sliding window: fine for one server, and a restart only forgives a few
 * minutes of counting. Anyone over a limit gets 429 { reason: "slow_down" }
 * with the seconds to wait.
 *
 * Each rule counts by device token (from the request body) and by IP address
 * (Render puts the real one in X-Forwarded-For; see "trust proxy"), so
 * neither a new token nor a new network alone gets around it.
 */
const RULES = {
  //               per device          per network (IP)
  scan:        { token: [20, 60],     ip: [80, 60] },        // seat actions, per minute
  report:      { token: [10, 600],    ip: [30, 600] },       // "this seat is empty" reports
  lfPost:      { token: [5, 3600],    ip: [20, 3600] },      // Lost & Found posts
  lfClaim:     { token: [10, 3600],   ip: [30, 3600] },
  lfMessage:   { token: [30, 600],    ip: [90, 600] },       // thread messages
  lfReport:    { token: [5, 3600],    ip: [20, 3600] },
  push:        { token: [20, 3600],   ip: [60, 3600] },      // notification sign-ups and tests
  forget:      { token: [5, 3600],    ip: [20, 3600] },
  waitlist:    { token: [20, 600],    ip: [60, 600] },       // "tell me when a seat frees up"
  staffLogin:  { ip: [10, 900] },                            // password guesses
};

const hits = new Map(); // "rule|kind|key" -> [timestamps]

function over(key, [max, windowSec], now) {
  const since = now - windowSec * 1000;
  const list = (hits.get(key) || []).filter((t) => t > since);
  if (list.length >= max) {
    hits.set(key, list);
    return Math.ceil((list[0] + windowSec * 1000 - now) / 1000);
  }
  list.push(now);
  hits.set(key, list);
  return 0;
}

/** Express middleware enforcing a rule from RULES. */
function limit(rule) {
  const r = RULES[rule];
  return (req, res, next) => {
    const now = Date.now();
    const token = req.body && typeof req.body.token === "string" ? req.body.token : null;
    let wait = 0;
    if (r.ip) wait = Math.max(wait, over(`${rule}|ip|${req.ip}`, r.ip, now));
    if (r.token && token) wait = Math.max(wait, over(`${rule}|token|${token}`, r.token, now));
    if (!wait) return next();
    res.set("Retry-After", String(wait)).status(429).json({ ok: false, reason: "slow_down", retryAfter: wait });
  };
}

// Forget old counts now and then, so the map can't grow without bound.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, list] of hits) if (!list.length || now - list[list.length - 1] > 3600 * 1000) hits.delete(key);
}, 10 * 60 * 1000);
if (sweep.unref) sweep.unref();

/** Tests only. */
function reset() {
  hits.clear();
}

module.exports = { limit, reset, RULES };
