"use strict";

const { store } = require("./store");
const { localParts, openStatus, toMinutes } = require("./hours");

/**
 * Learns each library's busiest hours from how full it really is. The
 * sweep hands over every seat once a minute; while the library is open
 * those readings are averaged per hour of the day in memory, and when
 * the hour rolls over the average is folded into a stored running
 * average for that hour (busy:<libraryId>), so recent weeks count most.
 * That's one store write an hour, not one a minute.
 */
const WINDOW_HOURS = 3;          // "Busiest 11:00–14:00"
const LEARN_RATE = 0.2;          // weight of a full hour of new readings
const FULL_HOUR = 30;            // readings that count as a full hour
const MIN_DAYS = 3;              // hours of data each open hour needs first

const current = new Map();       // libraryId -> { slot, hour, sum, n }

function busyKey(libraryId) {
  return `busy:${libraryId}`;
}

/** Folds one hour's average into the stored running average. */
async function fold(libraryId, hour, mean, n) {
  const stats = (await store.get(busyKey(libraryId))) || { hours: {} };
  const slot = stats.hours[hour] || { avg: 0, weight: 0 };
  const share = Math.min(1, n / FULL_HOUR);
  const rate = slot.weight ? LEARN_RATE * share : 1;
  slot.avg = slot.avg + (mean - slot.avg) * rate;
  slot.weight = Math.round((slot.weight + share) * 100) / 100;
  stats.hours[hour] = slot;
  await store.put(busyKey(libraryId), stats);
}

/** One reading: the share of seats held right now. Call once a minute. */
async function observe(libraryId, seats, now = Date.now(), hours = null) {
  if (!openStatus(hours, now).regularOpen || !seats.length) return;
  const held = seats.filter((s) => s && (s.state === "OCCUPIED" || s.state === "STEPPED_AWAY")).length;
  const p = localParts(now);
  const slot = `${p.date}T${p.hour}`;
  let cur = current.get(libraryId);
  if (cur && cur.slot !== slot) {
    await fold(libraryId, cur.hour, cur.sum / cur.n, cur.n);
    cur = null;
  }
  if (!cur) {
    cur = { slot, hour: p.hour, sum: 0, n: 0 };
    current.set(libraryId, cur);
  }
  cur.sum += held / seats.length;
  cur.n += 1;
}

/**
 * The busiest WINDOW_HOURS-long stretch of opening hours, as
 * "11:00–14:00", once every open hour has a few days of readings;
 * null until then.
 */
async function busiestWindow(libraryId, hours) {
  const stats = await store.get(busyKey(libraryId));
  if (!stats) return null;
  // The usual weekday hours (a shorter Friday doesn't narrow the window).
  const opens = (hours && hours.opens) || "08:00";
  const closes = (hours && hours.closes) || "20:00";
  const first = Math.floor(toMinutes(opens) / 60);
  const last = Math.ceil(toMinutes(closes) / 60); // exclusive
  const slots = [];
  for (let h = first; h < last; h++) {
    const s = stats.hours[h];
    if (!s || s.weight < MIN_DAYS) return null;
    slots.push(s.avg);
  }
  if (slots.length < WINDOW_HOURS) return null;
  let best = 0, bestSum = -1;
  for (let i = 0; i + WINDOW_HOURS <= slots.length; i++) {
    const sum = slots.slice(i, i + WINDOW_HOURS).reduce((a, b) => a + b, 0);
    if (sum > bestSum) { best = i; bestSum = sum; }
  }
  if (bestSum <= 0) return null; // nobody has used it yet
  const hh = (h) => `${String(h).padStart(2, "0")}:00`;
  return `${hh(first + best)}–${hh(first + best + WINDOW_HOURS)}`;
}

/** Tests only. */
function reset() {
  current.clear();
}

module.exports = { observe, busiestWindow, reset };
