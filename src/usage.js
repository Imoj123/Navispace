"use strict";

const { store } = require("./store");
const { localParts } = require("./hours");

/**
 * Daily usage numbers for the staff page: check-ins, how many different
 * students, which seats, and Lost & Found posts. One record per library
 * per local day (usage:<libraryId>:<YYYY-MM-DD>), kept KEEP_DAYS.
 *
 * Students are counted by a one-way hash of their device token (the same
 * short hash the public API uses), never by token or nickname, so these
 * numbers can't be traced back to anyone.
 */
const KEEP_DAYS = 120;
const MAX_DEVICES_PER_DAY = 5000;

function usageKey(libraryId, date) {
  return `usage:${libraryId}:${date}`;
}

async function bump(libraryId, now, change) {
  const key = usageKey(libraryId, localParts(now).date);
  const day = (await store.get(key)) || { checkIns: 0, devices: [], seats: {}, posts: 0 };
  change(day);
  await store.put(key, day, { expirationTtl: KEEP_DAYS * 24 * 60 * 60 });
}

/** A successful check-in, by a device (already hashed) at a seat. */
function recordCheckIn(libraryId, seatId, deviceHash, now = Date.now()) {
  return bump(libraryId, now, (day) => {
    day.checkIns += 1;
    day.seats[seatId] = (day.seats[seatId] || 0) + 1;
    if (deviceHash && !day.devices.includes(deviceHash) && day.devices.length < MAX_DEVICES_PER_DAY) {
      day.devices.push(deviceHash);
    }
  });
}

/** A new Lost & Found post. */
function recordPost(libraryId, now = Date.now()) {
  return bump(libraryId, now, (day) => { day.posts += 1; });
}

/**
 * The last `days` local days, oldest first: [{ date, weekday, checkIns,
 * students, posts }], plus the most-used seats over the period and the
 * number of different students across it.
 */
async function getUsage(libraryId, days = 14, now = Date.now()) {
  const dates = [];
  for (let i = days - 1; i >= 0; i--) dates.push(localParts(now - i * 24 * 60 * 60 * 1000));
  const records = await store.getMany(dates.map((p) => usageKey(libraryId, p.date)));
  const seatTotals = {};
  const everyone = new Set();
  const daily = dates.map((p, i) => {
    const r = records[i] || { checkIns: 0, devices: [], seats: {}, posts: 0 };
    for (const [seat, n] of Object.entries(r.seats)) seatTotals[seat] = (seatTotals[seat] || 0) + n;
    r.devices.forEach((d) => everyone.add(d));
    return { date: p.date, weekday: p.weekday, checkIns: r.checkIns, students: r.devices.length, posts: r.posts };
  });
  const topSeats = Object.entries(seatTotals).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([seat, checkIns]) => ({ seat, checkIns }));
  return { daily, topSeats, students: everyone.size };
}

module.exports = { recordCheckIn, recordPost, getUsage };
