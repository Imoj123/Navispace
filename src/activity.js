"use strict";

/**
 * "Live on the floor": the last few things that happened at each library's
 * seats, for the home page's activity feed.
 *
 * Kept in memory only. It's a feed of the last few hours, not a record: a
 * restart just starts it fresh, and it costs no database reads or writes.
 * Events carry the seat and what happened, never who did it.
 */

const MAX_EVENTS = 40;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

// What the feed reports, by scan action. stillHere is left out: it's a
// routine "keep my seat" tap and would crowd out everything else.
const ACTION_EVENTS = {
  checkIn: "taken",
  stepAway: "away",
  imBack: "back",
  leaving: "freed",
};

const feeds = new Map(); // libraryId -> [{ type, seatId, at }], newest first

function record(libraryId, type, seatId, at = Date.now()) {
  const list = feeds.get(libraryId) || [];
  list.unshift({ type, seatId, at });
  list.length = Math.min(list.length, MAX_EVENTS);
  feeds.set(libraryId, list);
}

function recordScan(libraryId, action, seatId, at) {
  const type = ACTION_EVENTS[action];
  if (type) record(libraryId, type, seatId, at);
}

function recordReclaimed(libraryId, seatIds, at = Date.now()) {
  for (const seatId of seatIds) record(libraryId, "expired", seatId, at);
}

function recent(libraryId, now = Date.now()) {
  return (feeds.get(libraryId) || []).filter((e) => now - e.at < MAX_AGE_MS);
}

function clear() {
  feeds.clear();
}

module.exports = { recordScan, recordReclaimed, recent, clear };
