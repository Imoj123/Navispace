"use strict";

const crypto = require("crypto");
const { store } = require("./store");
const push = require("./push");
const { withLock } = require("./lock");
const { getLayout } = require("./seats");
const { localParts, toMinutes, closesOn, closedDayReason } = require("./hours");

/**
 * Discussion rooms: booked by the hour on the rooms page, claimed at the door.
 *
 * - Bookings are whole hours from opening time (the last one may be shorter
 *   when the library closes off the hour), today and the next six days.
 * - One device can book up to two hours a day, never two rooms at once, and
 *   hold at most three bookings ahead.
 * - Each room's door has its own signed QR code (like a seat's sticker). A
 *   booking is claimed by scanning it from 10 minutes before the start until
 *   15 minutes after; unclaimed, the room is released for someone else.
 * - Scanning the door of a room that's free right now books it on the spot,
 *   until the next hour or the one after.
 * - Done early? "Leave the room" frees the rest of the time.
 *
 * Other students see a booking as "Booked", never whose it is; staff see
 * the nickname. One list per library and day, `rooms:<lib>:<YYYY-MM-DD>`:
 *   [{ id, room, date, start, end, token, nickname, at, claimedAt, reminded }]
 * start and end are minutes after the library's local midnight.
 */
const SLOT_MINUTES = 60;
const MAX_MINUTES_PER_DAY = 120;
const DAYS_AHEAD = 7;
const MAX_UPCOMING = 3;
const CLAIM_EARLY_MINUTES = 10;
const CLAIM_LATE_MINUTES = 15;
const REMIND_MINUTES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

const dayKey = (libraryId, date) => `rooms:${libraryId}:${date}`;
const roomsLock = (libraryId) => `rooms:${libraryId}`;
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function defaultHours(libraryId, now) {
  return require("./notices").libraryHours(libraryId, now);
}

/** The rooms students can book in a library: [{ id, label }]. */
function bookableRooms(libraryId) {
  const layout = getLayout(libraryId);
  return ((layout && layout.rooms) || []).filter((r) => r.bookable && r.id).map((r) => ({ id: r.id, label: r.label }));
}

/** ms at a library-local date and minute of that day. */
function msAt(date, minutes) {
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, 0, minutes);
  let ms = wall;
  for (let i = 0; i < 2; i++) {
    const p = localParts(ms);
    const [py, pm, pd] = p.date.split("-").map(Number);
    ms += wall - Date.UTC(py, pm - 1, pd, 0, p.minutes);
  }
  return ms;
}

/**
 * One day's hours and slots: { date, closedFor, opens, closes, slots }.
 * slots: [{ start, end }] in minutes. hours is only right for today (it
 * carries today's early close); other days use the plan's usual hours.
 */
function dayPlan(date, hours, weekday) {
  const parts = { date, weekday, year: Number(date.slice(0, 4)) };
  const always = process.env.ALWAYS_OPEN === "1";
  const closedFor = always ? null : closedDayReason(parts);
  const opens = always ? 0 : toMinutes((hours && hours.opens) || "08:00");
  const closes = always ? 24 * 60 : toMinutes(closesOn(hours, parts), "20:00");
  const slots = [];
  if (!closedFor) {
    for (let s = Math.ceil(opens / SLOT_MINUTES) * SLOT_MINUTES; s < closes; s += SLOT_MINUTES) {
      slots.push({ start: s, end: Math.min(s + SLOT_MINUTES, closes) });
    }
  }
  return { date, weekday, closedFor, opens, closes, slots };
}

/** Today and the next days, as day plans. */
function bookingDays(hours, now = Date.now()) {
  const today = localParts(now);
  const noon = msAt(today.date, 12 * 60);
  const days = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const p = i === 0 ? today : localParts(noon + i * DAY_MS);
    // Today's early close belongs to today only.
    const h = i === 0 ? hours : hours && { ...hours, earlyClose: null };
    days.push(dayPlan(p.date, h, p.weekday));
  }
  return days;
}

/**
 * Whether a booking still stands at now: not over, and not left unclaimed
 * past its claim window (the minute loop removes those too; this keeps a
 * late loop from blocking anyone).
 */
function standing(b, now) {
  const today = localParts(now);
  if (b.date < today.date) return false;
  if (b.date > today.date) return true;
  if (b.end <= today.minutes) return false;
  return Boolean(b.claimedAt) || today.minutes < b.start + CLAIM_LATE_MINUTES;
}

async function readDay(libraryId, date) {
  return (await store.get(dayKey(libraryId, date))) || [];
}

async function saveDay(libraryId, date, list, now) {
  if (!list.length) return store.delete(dayKey(libraryId, date));
  const days = Math.max(1, Math.ceil((msAt(date, 24 * 60) - now) / DAY_MS)) + 2;
  await store.put(dayKey(libraryId, date), list, { expirationTtl: days * 24 * 60 * 60 });
}

/** What a booking looks like to students: no token, no name unless it's theirs. */
function publicBooking(b, token) {
  const mine = Boolean(token) && b.token === token;
  const out = { id: b.id, room: b.room, date: b.date, start: b.start, end: b.end, claimed: Boolean(b.claimedAt), mine };
  if (mine) {
    out.claimBy = b.start + CLAIM_LATE_MINUTES;
    out.claimFrom = b.start - CLAIM_EARLY_MINUTES;
    out.startsAt = msAt(b.date, b.start);
    out.endsAt = msAt(b.date, b.end);
  }
  return out;
}

/** Right now, for one room today: { state: "free"|"booked"|"inUse", until, next }. */
function roomNow(roomId, bookings, day, now) {
  const today = localParts(now);
  const t = today.minutes;
  if (day.closedFor || t < day.opens || t >= day.closes) return { state: "closed", until: null, next: null };
  const mine = bookings.filter((b) => b.room === roomId).sort((a, b) => a.start - b.start);
  const current = mine.find((b) => b.start <= t && t < b.end) ||
    mine.find((b) => b.claimedAt && b.start - CLAIM_EARLY_MINUTES <= t && t < b.end);
  if (current) {
    // Back-to-back bookings: in use until the last of them ends.
    let until = current.end;
    for (const b of mine) if (b.start === until) until = b.end;
    return { state: current.claimedAt ? "inUse" : "booked", until: hhmm(until), next: null };
  }
  const next = mine.find((b) => b.start > t);
  return { state: "free", until: hhmm(next ? next.start : day.closes), next: next ? hhmm(next.start) : null };
}

/**
 * A day's rooms for the rooms page: every room with its bookings that
 * still stand, and (today) what each is doing right now.
 */
async function viewDay(libraryId, date, token, { now = Date.now(), hours = defaultHours(libraryId, now) } = {}) {
  const days = bookingDays(hours, now);
  const day = days.find((d) => d.date === date) || days[0];
  const list = (await readDay(libraryId, day.date)).filter((b) => standing(b, now));
  const isToday = day.date === days[0].date;
  return {
    ok: true,
    date: day.date,
    now: isToday ? localParts(now).minutes : null,
    days: days.map((d) => ({ date: d.date, weekday: d.weekday, closedFor: d.closedFor, opens: hhmm(d.opens), closes: hhmm(d.closes) })),
    day: { closedFor: day.closedFor, opens: hhmm(day.opens), closes: hhmm(day.closes), slots: day.slots },
    rooms: bookableRooms(libraryId).map((r) => ({
      ...r,
      now: isToday ? roomNow(r.id, list, day, now) : null,
      bookings: list.filter((b) => b.room === r.id).sort((a, b) => a.start - b.start).map((b) => publicBooking(b, token)),
    })),
    rules: { maxMinutesPerDay: MAX_MINUTES_PER_DAY, maxUpcoming: MAX_UPCOMING, claimLate: CLAIM_LATE_MINUTES, claimEarly: CLAIM_EARLY_MINUTES },
  };
}

/** This device's bookings that still stand, soonest first, across the days ahead. */
async function myBookings(libraryId, token, { now = Date.now(), hours = defaultHours(libraryId, now) } = {}) {
  const out = [];
  for (const d of bookingDays(hours, now)) {
    for (const b of await readDay(libraryId, d.date)) {
      if (b.token === token && standing(b, now)) out.push(b);
    }
  }
  out.sort((a, b) => (a.date === b.date ? a.start - b.start : a.date < b.date ? -1 : 1));
  const labels = Object.fromEntries(bookableRooms(libraryId).map((r) => [r.id, r.label]));
  return out.map((b) => ({ ...publicBooking(b, token), label: labels[b.room] || b.room }));
}

const overlaps = (a, b) => a.start < b.end && b.start < a.end;
const minutesUsed = (list, token) => list.filter((b) => b.token === token).reduce((sum, b) => sum + (b.end - b.start), 0);

/**
 * Books a room. Body: { room, date, start, end } in minutes; or walkIn
 * (from the door, already checked by the route): from now until end.
 * Returns { ok, booking } or { ok: false, reason }.
 */
function book(libraryId, { token, nickname, room, date, start, end, walkIn = false }, { now = Date.now(), hours = defaultHours(libraryId, now) } = {}) {
  return withLock(roomsLock(libraryId), async () => {
    if (!bookableRooms(libraryId).some((r) => r.id === room)) return { ok: false, reason: "unknown_room" };
    const days = bookingDays(hours, now);
    const today = localParts(now);
    if (walkIn) date = today.date;
    const day = days.find((d) => d.date === date);
    if (!day) return { ok: false, reason: "bad_day" };
    if (day.closedFor) return { ok: false, reason: "library_closed" };
    if (!Number.isInteger(end)) return { ok: false, reason: "bad_time" };

    if (walkIn) {
      if (today.minutes < day.opens || today.minutes >= day.closes) return { ok: false, reason: "library_closed" };
      start = today.minutes;
      if (!day.slots.some((s) => s.end === end) || end <= start) return { ok: false, reason: "bad_time" };
    } else {
      if (!Number.isInteger(start)) return { ok: false, reason: "bad_time" };
      if (!day.slots.some((s) => s.start === start) || !day.slots.some((s) => s.end === end) || end <= start) {
        return { ok: false, reason: "bad_time" };
      }
      // Today: a slot can still be booked until its claim window closes.
      if (date === today.date && today.minutes >= start + CLAIM_LATE_MINUTES) return { ok: false, reason: "too_late" };
    }
    if (end - start > MAX_MINUTES_PER_DAY) return { ok: false, reason: "too_long" };

    // The whole day counts towards the two hours, including bookings already
    // used; only ones cancelled or released (not used) are gone from it.
    const all = await readDay(libraryId, date);
    const list = all.filter((b) => standing(b, now));
    const want = { start, end };
    if (list.some((b) => b.room === room && overlaps(b, want))) return { ok: false, reason: "taken" };
    const mineToday = list.filter((b) => b.token === token);
    if (mineToday.some((b) => overlaps(b, want))) return { ok: false, reason: "overlap" };
    const used = minutesUsed(all, token);
    if (used + (end - start) > MAX_MINUTES_PER_DAY) return { ok: false, reason: "day_limit", left: Math.max(0, MAX_MINUTES_PER_DAY - used) };
    let upcoming = mineToday.length;
    for (const d of days) {
      if (d.date === date) continue;
      upcoming += (await readDay(libraryId, d.date)).filter((b) => b.token === token && standing(b, now)).length;
    }
    if (upcoming >= MAX_UPCOMING) return { ok: false, reason: "too_many" };

    const booking = {
      id: `${date}.${crypto.randomBytes(5).toString("hex")}`,
      room, date, start, end, token,
      nickname: nickname || "Student",
      at: now,
      claimedAt: walkIn ? now : null,
      reminded: walkIn,
    };
    all.push(booking);
    await saveDay(libraryId, date, all, now);
    return { ok: true, booking: publicBooking(booking, token) };
  });
}

/** Changes one booking (by id) in its day's list, under the lock. */
function change(libraryId, id, fn, now) {
  return withLock(roomsLock(libraryId), async () => {
    const date = String(id || "").split(".")[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, reason: "not_found" };
    const list = await readDay(libraryId, date);
    const i = list.findIndex((b) => b.id === id && standing(b, now));
    if (i < 0) return { ok: false, reason: "not_found" };
    const result = fn(list[i], list, i);
    if (result.ok) await saveDay(libraryId, date, list, now);
    return result;
  });
}

/**
 * Cancels a booking before it starts, or ends one in use: the room is free
 * from now. Only the device that booked it.
 */
function cancel(libraryId, token, id, now = Date.now()) {
  return change(libraryId, id, (b, list, i) => {
    if (b.token !== token) return { ok: false, reason: "not_yours" };
    const t = localParts(now);
    if (b.date === t.date && b.claimedAt && t.minutes > b.start) {
      b.end = t.minutes;
      if (b.end <= b.start) list.splice(i, 1);
      return { ok: true, ended: true };
    }
    list.splice(i, 1);
    return { ok: true, ended: false };
  }, now);
}

/**
 * At the door (the route has checked the door's code). Claims this
 * device's booking for the room, if it's within its claim window; if the
 * device has none, says what's possible: { ok: false, reason, walkIn }.
 * walkIn: the times the room could be booked until, right now.
 */
async function claim(libraryId, token, room, { now = Date.now(), hours = defaultHours(libraryId, now) } = {}) {
  const result = await withLock(roomsLock(libraryId), async () => {
    const t = localParts(now);
    const list = await readDay(libraryId, t.date);
    const b = list.find((x) => x.token === token && x.room === room && standing(x, now) &&
      x.start - CLAIM_EARLY_MINUTES <= t.minutes && t.minutes < x.end);
    if (!b) return null;
    if (!b.claimedAt) {
      b.claimedAt = now;
      await saveDay(libraryId, t.date, list, now);
    }
    return { ok: true, booking: publicBooking(b, token) };
  });
  if (result) return result;
  return { ok: false, reason: "no_booking", walkIn: await walkInOptions(libraryId, room, { now, hours, token }) };
}

/**
 * Until when a room can be taken from the door right now, as minutes
 * ([660, 720] for 11:00 and 12:00): up to the next booking, and (given a
 * token) within what's left of that device's two hours today.
 */
async function walkInOptions(libraryId, room, { now = Date.now(), hours = defaultHours(libraryId, now), token = null } = {}) {
  const day = bookingDays(hours, now)[0];
  const t = localParts(now).minutes;
  if (day.closedFor || t < day.opens || t >= day.closes) return [];
  const all = await readDay(libraryId, day.date);
  const list = all.filter((b) => standing(b, now));
  const inRoom = list.filter((b) => b.room === room);
  const mine = token ? list.filter((b) => b.token === token) : [];
  const left = MAX_MINUTES_PER_DAY - (token ? minutesUsed(all, token) : 0);
  const out = [];
  for (const s of day.slots) {
    if (s.end <= t) continue;
    const want = { start: t, end: s.end };
    if (s.end - t > left || inRoom.some((b) => overlaps(b, want)) || mine.some((b) => overlaps(b, want))) break;
    out.push(s.end);
  }
  return out;
}

/**
 * Once a minute: reminds people whose booking starts in 10 minutes,
 * releases rooms nobody claimed, and fits today's bookings to an early
 * close (those starting after it are cancelled). Never throws.
 */
async function tick(libraryId, { now = Date.now(), hours = defaultHours(libraryId, now) } = {}) {
  try {
    const t = localParts(now);
    const day = bookingDays(hours, now)[0];
    const labels = Object.fromEntries(bookableRooms(libraryId).map((r) => [r.id, r.label]));
    const tell = [];
    await withLock(roomsLock(libraryId), async () => {
      const list = await readDay(libraryId, t.date);
      if (!list.length) return;
      let changed = false;
      const keep = [];
      for (const b of list) {
        const name = labels[b.room] || b.room;
        if (day.closedFor) {
          tell.push([b.token, { title: `${name} booking cancelled`, body: `The library is closed today${day.closedFor === "Closed today" ? "" : ` (${day.closedFor})`}, so your ${hhmm(b.start)} booking was cancelled.` }]);
          changed = true;
          continue;
        }
        if (b.start >= day.closes) {
          tell.push([b.token, { title: `${name} booking cancelled`, body: `The library closes at ${hhmm(day.closes)} today, so your ${hhmm(b.start)} booking was cancelled.` }]);
          changed = true;
          continue;
        }
        if (b.end > day.closes) { b.end = day.closes; changed = true; }
        if (!b.claimedAt && b.end > t.minutes && t.minutes >= b.start + CLAIM_LATE_MINUTES) {
          tell.push([b.token, { title: `${name} released`, body: `Nobody scanned the door by ${hhmm(b.start + CLAIM_LATE_MINUTES)}, so the room went back to everyone.` }]);
          changed = true;
          continue;
        }
        if (!b.claimedAt && !b.reminded && t.minutes >= b.start - REMIND_MINUTES && t.minutes < b.start + CLAIM_LATE_MINUTES) {
          b.reminded = true;
          changed = true;
          tell.push([b.token, { title: `${name} at ${hhmm(b.start)}`, body: `Scan the code on the door between ${hhmm(b.start - CLAIM_EARLY_MINUTES)} and ${hhmm(b.start + CLAIM_LATE_MINUTES)}, or the room is released.` }]);
        }
        if (b.end <= t.minutes && !b.claimedAt) { changed = true; continue; }
        keep.push(b);
      }
      if (changed) await saveDay(libraryId, t.date, keep, now);
    });
    for (const [token, msg] of tell) {
      await push.sendPush(token, { ...msg, url: `/rooms.html?lib=${encodeURIComponent(libraryId)}`, tag: `rooms-${libraryId}` }, { ttlSeconds: 15 * 60 });
    }
    return tell.length;
  } catch (err) {
    console.warn(`[rooms] ${libraryId}: ${err.message}`);
    return 0;
  }
}

/** The front desk's view of a day: every booking with its nickname. */
async function staffDay(libraryId, date, { now = Date.now(), hours = defaultHours(libraryId, now) } = {}) {
  const days = bookingDays(hours, now);
  const day = days.find((d) => d.date === date) || days[0];
  const list = (await readDay(libraryId, day.date)).filter((b) => standing(b, now));
  return {
    ok: true,
    date: day.date,
    days: days.map((d) => ({ date: d.date, weekday: d.weekday, closedFor: d.closedFor })),
    rooms: bookableRooms(libraryId).map((r) => ({
      ...r,
      bookings: list.filter((b) => b.room === r.id).sort((a, b) => a.start - b.start)
        .map((b) => ({ id: b.id, start: hhmm(b.start), end: hhmm(b.end), nickname: b.nickname, claimed: Boolean(b.claimedAt) })),
    })),
  };
}

/** Staff take a booking off (the room is needed): its booker is told. */
async function staffCancel(libraryId, id, now = Date.now()) {
  let removed = null;
  const result = await change(libraryId, id, (b, list, i) => {
    removed = b;
    list.splice(i, 1);
    return { ok: true };
  }, now);
  if (result.ok && removed) {
    const label = (bookableRooms(libraryId).find((r) => r.id === removed.room) || {}).label || removed.room;
    await push.sendPush(removed.token, {
      title: `${label} booking cancelled`,
      body: `The library desk cancelled your booking at ${hhmm(removed.start)}. Ask at the desk if you need a room.`,
      url: `/rooms.html?lib=${encodeURIComponent(libraryId)}`,
      tag: `rooms-${libraryId}`,
    }, { ttlSeconds: 60 * 60 });
  }
  return result;
}

/** Every booking a device made, in one library ("Delete my data"). */
async function forgetRooms(libraryId, token) {
  return withLock(roomsLock(libraryId), async () => {
    let removed = 0;
    for (const key of await store.listKeys(`rooms:${libraryId}:`)) {
      const list = (await store.get(key)) || [];
      const keep = list.filter((b) => b.token !== token);
      if (keep.length === list.length) continue;
      removed += list.length - keep.length;
      await saveDay(libraryId, key.slice(`rooms:${libraryId}:`.length), keep, Date.now());
    }
    return removed;
  });
}

module.exports = {
  SLOT_MINUTES,
  MAX_MINUTES_PER_DAY,
  MAX_UPCOMING,
  CLAIM_EARLY_MINUTES,
  CLAIM_LATE_MINUTES,
  bookableRooms,
  bookingDays,
  msAt,
  viewDay,
  myBookings,
  book,
  cancel,
  claim,
  walkInOptions,
  tick,
  staffDay,
  staffCancel,
  forgetRooms,
};
