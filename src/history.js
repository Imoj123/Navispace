"use strict";

const { store } = require("./store");

/**
 * Each device's recent sittings, for "Your week" on the home page. A
 * sitting is written once, when it ends (leaving, a hold running out, or
 * the floor reporting the seat empty), under the device's token, so only
 * that device can ever read it back. Kept for KEEP_DAYS, then dropped.
 */
const KEEP_DAYS = 56;
const MAX_SITTINGS = 400;
const MIN_MS = 60 * 1000; // shorter than a minute is a mis-scan, not a sitting

function historyKey(token) {
  return `history:${token}`;
}

/**
 * Records the sitting a seat is about to end. Call before the seat is
 * reset; end is when the student actually left (for a hold that ran
 * out, when it ran out). Focus time leaves out every step-away.
 */
async function recordSitting(libraryId, seat, end) {
  if (!seat || !seat.holderToken || !seat.sessionStart) return;
  const away = (seat.awayMs || 0) + (seat.awayStart ? Math.max(0, end - seat.awayStart) : 0);
  const ms = Math.max(0, end - seat.sessionStart - away);
  if (ms < MIN_MS) return;

  const key = historyKey(seat.holderToken);
  const keepFrom = end - KEEP_DAYS * 24 * 60 * 60 * 1000;
  const list = ((await store.get(key)) || []).filter((s) => s.end >= keepFrom);
  list.push({ lib: libraryId, seat: seat.id, start: seat.sessionStart, end, ms });
  await store.put(key, list.slice(-MAX_SITTINGS), { expirationTtl: KEEP_DAYS * 24 * 60 * 60 });
}

/** This device's sittings, oldest first. */
async function getSittings(token, now = Date.now()) {
  const keepFrom = now - KEEP_DAYS * 24 * 60 * 60 * 1000;
  return ((await store.get(historyKey(token))) || []).filter((s) => s.end >= keepFrom);
}

module.exports = { recordSitting, getSittings, KEEP_DAYS };
