"use strict";

const { store } = require("./store");
const push = require("./push");

/**
 * "Tell me when a seat frees up": when the floor is full or nearly, a
 * student joins this library's wait list instead of walking around
 * looking. The moment a seat frees up (someone checks out, a hold runs out,
 * staff free a seat, or reports correct one), the people waiting for that
 * seat's area, or for any seat, get a notification, oldest first.
 *
 * Several people are told about each freed seat, because not everyone who
 * gets the notification will come (the first to scan it gets it). Anyone
 * told leaves the list: they asked once, for one seat. Waiting lapses after
 * WAIT_HOURS, and nobody is told about a seat once the library has closed.
 *
 * Stored as one list per library, `waitlist:<lib>`:
 *   [{ token, area, at }]  area is a zone letter ("S") or null for any seat.
 */
const WAIT_HOURS = 3;
const TOLD_PER_SEAT = 3;
const MAX_WAITING = 500;

function waitKey(libraryId) {
  return `waitlist:${libraryId}`;
}

/** The area a seat belongs to: the letters its ID starts with ("S" for S12). */
function seatArea(seatId) {
  const m = /^[A-Za-z]+/.exec(String(seatId));
  return m ? m[0].toUpperCase() : null;
}

async function current(libraryId, now) {
  const list = (await store.get(waitKey(libraryId))) || [];
  return list.filter((w) => now - w.at < WAIT_HOURS * 3600 * 1000);
}

async function save(libraryId, list) {
  if (!list.length) return store.delete(waitKey(libraryId));
  await store.put(waitKey(libraryId), list, { expirationTtl: WAIT_HOURS * 3600 });
}

/** Where this device stands: { waiting, area, until, ahead }. */
async function waitStatus(libraryId, token, now = Date.now()) {
  const list = await current(libraryId, now);
  const i = list.findIndex((w) => w.token === token);
  if (i < 0) return { waiting: false, area: null, until: null, ahead: 0 };
  const mine = list[i];
  // People ahead who'd be told about the same seats.
  const ahead = list.slice(0, i).filter((w) => !w.area || !mine.area || w.area === mine.area).length;
  return { waiting: true, area: mine.area, until: mine.at + WAIT_HOURS * 3600 * 1000, ahead };
}

/** Joins (or changes the area of) this device's place on the list. */
async function joinWaitlist(libraryId, token, area, now = Date.now()) {
  const list = await current(libraryId, now);
  const existing = list.find((w) => w.token === token);
  if (existing) {
    existing.area = area || null;
  } else {
    if (list.length >= MAX_WAITING) return { ok: false, reason: "list_full" };
    list.push({ token, area: area || null, at: now });
  }
  await save(libraryId, list);
  return { ok: true, ...(await waitStatus(libraryId, token, now)) };
}

async function leaveWaitlist(libraryId, token, now = Date.now()) {
  const list = await current(libraryId, now);
  await save(libraryId, list.filter((w) => w.token !== token));
  return { ok: true, waiting: false };
}

/** Everyone off the list (closing time). */
async function clearWaitlist(libraryId) {
  await store.delete(waitKey(libraryId));
}

/**
 * Seats just became free: tell the people waiting for them. Each seat goes
 * to up to TOLD_PER_SEAT people waiting for its area or for any seat, oldest
 * first; people waiting for one area are preferred for a seat in it. Never
 * throws. Returns the number of people told.
 *
 * names: area letter -> name ("S" -> "Window carrels"), for the message.
 * holders: tokens that shouldn't be told (they hold a seat already).
 */
async function seatsFreed(libraryId, seatIds, { libraryName = "the library", names = {}, holders = new Set(), now = Date.now() } = {}) {
  try {
    if (!seatIds.length) return 0;
    let list = await current(libraryId, now);
    if (!list.length) return 0;
    list = list.filter((w) => !holders.has(w.token));

    const told = [];
    for (const seatId of seatIds) {
      const area = seatArea(seatId);
      const forArea = list.filter((w) => w.area === area);
      const forAny = list.filter((w) => !w.area);
      const pick = [...forArea, ...forAny].slice(0, TOLD_PER_SEAT);
      for (const w of pick) {
        told.push({ w, seatId, area });
        list = list.filter((x) => x !== w);
      }
    }
    await save(libraryId, list);

    for (const { w, seatId, area } of told) {
      const where = names[area] ? `${names[area]}, seat ${seatId}` : `Seat ${seatId}`;
      await push.sendPush(w.token, {
        title: "A seat just freed up",
        body: `${where} in ${libraryName}. Scan it to take it; whoever scans first gets it.`,
        url: `/library.html?lib=${encodeURIComponent(libraryId)}&seat=${encodeURIComponent(seatId)}`,
        tag: `waitlist-${libraryId}`,
      }, { ttlSeconds: 10 * 60 });
    }
    if (told.length) console.log(`[waitlist] ${libraryId} told ${told.length} waiting`);
    return told.length;
  } catch (err) {
    console.warn(`[waitlist] ${libraryId}: ${err.message}`);
    return 0;
  }
}

/**
 * seatsFreed with everything filled in for a real library: its name, its
 * area names, who already holds a seat, and opening hours (once it has
 * closed, nobody is told and the list is cleared). Fire and forget.
 */
async function announceFreed(libraryId, seatIds, now = Date.now()) {
  try {
    if (!seatIds || !seatIds.length) return 0;
    const { getLibrary } = require("./libraries");
    const { getSeatIds, getLayout } = require("./seats");
    const { getSeats, SeatState } = require("./scan");
    const { openStatus } = require("./hours");
    const layout = getLayout(libraryId) || {};
    if (!openStatus(layout.hours || null, now).open) {
      await clearWaitlist(libraryId);
      return 0;
    }
    const seats = await getSeats(libraryId, getSeatIds(libraryId));
    const holders = new Set(seats.filter((s) => s && s.state !== SeatState.AVAILABLE).map((s) => s.holderToken));
    // A seat taken again in the meantime isn't news.
    const stillFree = new Set(seats.filter((s) => s && s.state === SeatState.AVAILABLE).map((s) => s.id));
    const lib = getLibrary(libraryId);
    return seatsFreed(libraryId, seatIds.filter((id) => stillFree.has(id)), {
      libraryName: lib ? lib.name : "the library",
      names: layout.zoneNames || {},
      holders,
      now,
    });
  } catch (err) {
    console.warn(`[waitlist] ${libraryId}: ${err.message}`);
    return 0;
  }
}

module.exports = {
  WAIT_HOURS,
  announceFreed,
  TOLD_PER_SEAT,
  seatArea,
  waitStatus,
  joinWaitlist,
  leaveWaitlist,
  clearWaitlist,
  seatsFreed,
};
