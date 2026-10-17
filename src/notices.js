"use strict";

const { store } = require("./store");
const { getLayout } = require("./seats");
const { localParts, toMinutes, openStatus } = require("./hours");

/**
 * What the front desk tells everyone, set from the staff page:
 *
 * - An announcement: one short line shown at the top of the library's
 *   pages ("Level 2 is closed for exams"), until the end of today or for
 *   up to a week. Stored at `notice:<lib>`.
 * - Closing early today: an earlier closing time for today only, with an
 *   optional reason. Everything that follows opening hours follows it:
 *   check-ins stop, the 10-minute closing notice goes out, and held seats
 *   are released after the usual grace. Stored at `earlyclose:<lib>`.
 *
 * Opening hours are read synchronously everywhere (hours.js), so both are
 * kept in memory too: loaded from the store at start-up (ready), refreshed
 * every few minutes, and updated at once by the staff page. One server.
 */
const MAX_TEXT = 200;
const MAX_REASON = 80;
const MAX_DAYS = 7;

const cache = new Map(); // libraryId -> { notice, earlyClose }

const noticeKey = (lib) => `notice:${lib}`;
const earlyKey = (lib) => `earlyclose:${lib}`;

function entry(lib) {
  if (!cache.has(lib)) cache.set(lib, { notice: null, earlyClose: null });
  return cache.get(lib);
}

async function load(libraryIds) {
  for (const lib of libraryIds) {
    const [notice, earlyClose] = await Promise.all([store.get(noticeKey(lib)), store.get(earlyKey(lib))]);
    cache.set(lib, { notice: notice || null, earlyClose: earlyClose || null });
  }
}

let ready = Promise.resolve();
/** Loads every library's notices now and every few minutes. Returns a stop function. */
function startNotices(libraryIds, intervalMs = 5 * 60 * 1000) {
  ready = load(libraryIds).catch((err) => console.error(`[notices] load failed: ${err.message}`));
  const handle = setInterval(() => load(libraryIds).catch(() => { }), intervalMs);
  if (handle.unref) handle.unref();
  return () => clearInterval(handle);
}

/** Resolves once the first load has finished. */
function noticesReady() {
  return ready;
}

/** The current announcement, or null once it has run out. */
function currentNotice(lib, now = Date.now()) {
  const n = entry(lib).notice;
  return n && n.until > now ? n : null;
}

/** Today's early close, or null (also once the day has passed). */
function currentEarlyClose(lib, now = Date.now()) {
  const e = entry(lib).earlyClose;
  return e && e.date === localParts(now).date ? e : null;
}

/** A library's opening hours from its plan, with today's early close, if any. */
function libraryHours(lib, now = Date.now()) {
  const layout = getLayout(lib);
  const base = (layout && layout.hours) || null;
  const early = currentEarlyClose(lib, now);
  return early ? { ...(base || {}), earlyClose: early } : base;
}

/** Local midnight at the end of the day containing ms. */
function endOfDay(now) {
  const p = localParts(now);
  return now - (now % 60000) + (24 * 60 - p.minutes) * 60000;
}

async function setNotice(lib, { text, days }, now = Date.now()) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return { ok: false, reason: "empty" };
  if (clean.length > MAX_TEXT) return { ok: false, reason: "too_long" };
  const n = Math.min(MAX_DAYS, Math.max(0, Math.floor(Number(days) || 0)));
  // 0 days: until the end of today.
  const until = n ? now + n * 24 * 3600 * 1000 : endOfDay(now);
  const notice = { text: clean, at: now, until, days: n };
  await store.put(noticeKey(lib), notice, { expirationTtl: Math.ceil((until - now) / 1000) + 60 });
  entry(lib).notice = notice;
  return { ok: true, notice };
}

async function clearNotice(lib) {
  await store.delete(noticeKey(lib));
  entry(lib).notice = null;
  return { ok: true };
}

/**
 * Closes early today at time ("15:00"), which must be before the usual
 * closing time. A time already past means now: the library closes at once,
 * and held seats go after the usual grace from now.
 */
async function setEarlyClose(lib, { time, reason }, now = Date.now()) {
  if (!/^\d{1,2}:\d{2}$/.test(String(time || ""))) return { ok: false, reason: "bad_time" };
  const p = localParts(now);
  // Compared with the usual hours, so a second early close can move the first.
  const layout = getLayout(lib);
  const status = openStatus((layout && layout.hours) || null, now);
  if (!status.regularOpen) return { ok: false, reason: "closed_now" };
  if (toMinutes(time) >= toMinutes(status.closes)) return { ok: false, reason: "not_earlier" };
  const minutes = Math.max(toMinutes(time), p.minutes + 1);
  const hhmm = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  const early = {
    date: p.date,
    time: hhmm,
    reason: String(reason || "").replace(/\s+/g, " ").trim().slice(0, MAX_REASON) || null,
    usual: status.closes,
    at: now,
  };
  await store.put(earlyKey(lib), early, { expirationTtl: Math.ceil((endOfDay(now) - now) / 1000) + 3600 });
  entry(lib).earlyClose = early;
  return { ok: true, earlyClose: early };
}

async function clearEarlyClose(lib) {
  await store.delete(earlyKey(lib));
  entry(lib).earlyClose = null;
  return { ok: true };
}

/** What the library's pages show: { notice, earlyClose } (either may be null). */
function publicNotices(lib, now = Date.now()) {
  const n = currentNotice(lib, now);
  const e = currentEarlyClose(lib, now);
  return {
    notice: n ? { text: n.text, at: n.at, until: n.until, days: n.days || 0 } : null,
    earlyClose: e ? { time: e.time, reason: e.reason, usual: e.usual } : null,
  };
}

/** Forgets everything in memory (tests). */
function resetNotices() {
  cache.clear();
}

module.exports = {
  MAX_TEXT,
  MAX_REASON,
  startNotices,
  noticesReady,
  libraryHours,
  setNotice,
  clearNotice,
  setEarlyClose,
  clearEarlyClose,
  publicNotices,
  currentEarlyClose,
  resetNotices,
};
