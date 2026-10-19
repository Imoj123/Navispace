"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

delete process.env.ALWAYS_OPEN;
const { store } = require("../src/store");
const push = require("../src/push");
const rooms = require("../src/rooms");

const HOURS = { opens: "08:00", closes: "20:00", closesOn: { Fri: "17:00" } };
// Johannesburg is UTC+2 all year.
const sast = (y, m, d, h, min = 0) => Date.UTC(y, m - 1, d, h - 2, min);
const LIB = "engineering";
const WED = "2026-10-21";
const at = (h, min = 0) => ({ now: sast(2026, 10, 21, h, min), hours: HOURS });
const H = (h) => h * 60;
const book = (token, room, start, end, when = at(8), date = WED) =>
  rooms.book(LIB, { token, nickname: token, room, date, start: H(start), end: H(end) }, when);

test.beforeEach(() => store.clear());

test("the three discussion rooms come from the floor plan", () => {
  assert.deepEqual(rooms.bookableRooms(LIB), [
    { id: "R1", label: "Room 1" }, { id: "R2", label: "Room 2" }, { id: "R3", label: "Room 3" },
  ]);
});

test("hourly slots within opening hours, a week ahead, none on weekends", () => {
  const days = rooms.bookingDays(HOURS, sast(2026, 10, 21, 9));
  assert.equal(days.length, 7);
  assert.equal(days[0].date, WED);
  assert.equal(days[0].slots.length, 12); // 08:00 to 20:00
  assert.deepEqual(days[0].slots.at(-1), { start: H(19), end: H(20) });
  const fri = days.find((d) => d.date === "2026-10-23");
  assert.equal(fri.slots.at(-1).end, H(17));
  assert.equal(days.find((d) => d.date === "2026-10-24").closedFor, "Weekend");
  assert.equal(days.find((d) => d.date === "2026-10-24").slots.length, 0);
});

test("a room can be booked once per time, and nobody sees who booked it", async () => {
  const a = await book("ann", "R1", 10, 12);
  assert.equal(a.ok, true);
  assert.equal((await book("ben", "R1", 11, 12)).reason, "taken");
  assert.equal((await book("ben", "R2", 11, 12)).ok, true);
  const view = await rooms.viewDay(LIB, WED, "ben", at(9));
  const r1 = view.rooms.find((r) => r.id === "R1");
  assert.deepEqual(r1.bookings.map((b) => [b.start, b.end, b.mine]), [[H(10), H(12), false]]);
  assert.equal(JSON.stringify(view).includes("ann"), false);
  assert.equal(view.rooms.find((r) => r.id === "R2").bookings[0].mine, true);
});

test("limits: two hours a day, no two rooms at once, three bookings ahead, whole slots only", async () => {
  assert.equal((await book("ann", "R1", 10, 13)).reason, "too_long");
  assert.equal((await book("ann", "R1", 10, 11)).ok, true);
  assert.equal((await book("ann", "R2", 10, 11)).reason, "overlap");
  assert.equal((await book("ann", "R2", 14, 15)).ok, true);
  assert.equal((await book("ann", "R3", 16, 17)).reason, "day_limit");
  assert.equal((await book("ann", "R1", 10, 11, at(8), "2026-10-22")).ok, true);
  assert.equal((await book("ann", "R1", 10, 11, at(8), "2026-10-23")).reason, "too_many");
  assert.equal((await rooms.book(LIB, { token: "x", room: "R1", date: WED, start: H(10) + 30, end: H(11) + 30 }, at(8))).reason, "bad_time");
  assert.equal((await book("x", "R1", 19, 21)).reason, "bad_time"); // past closing
  assert.equal((await book("x", "R1", 10, 11, at(8), "2026-10-24")).reason, "library_closed");
  assert.equal((await book("x", "R1", 10, 11, at(8), "2026-10-30")).reason, "bad_day"); // more than a week ahead
  assert.equal((await book("x", "R9", 10, 11)).reason, "unknown_room");
});

test("a slot that started can be booked until its claim window closes", async () => {
  assert.equal((await book("ann", "R1", 10, 11, at(10, 10))).ok, true);
  assert.equal((await book("ben", "R2", 10, 11, at(10, 15))).reason, "too_late");
});

test("an unclaimed booking is released 15 minutes after it starts, and its booker told", async (t) => {
  const sent = [];
  t.mock.method(push, "sendPush", async (token, payload) => { sent.push([token, payload.title]); return { sent: true }; });
  await book("ann", "R1", 10, 12);
  await rooms.tick(LIB, at(9, 50));
  assert.deepEqual(sent, [["ann", "Room 1 at 10:00"]]);
  await rooms.tick(LIB, at(9, 55)); // reminded once only
  assert.equal(sent.length, 1);
  await rooms.tick(LIB, at(10, 15));
  assert.deepEqual(sent[1], ["ann", "Room 1 released"]);
  assert.equal((await rooms.viewDay(LIB, WED, null, at(10, 16))).rooms[0].bookings.length, 0);
  assert.equal((await book("ben", "R1", 11, 12, at(10, 16))).ok, true);
});

test("claimed at the door from 10 minutes before: the room is in use and stays booked", async (t) => {
  t.mock.method(push, "sendPush", async () => ({ sent: true }));
  await book("ann", "R1", 10, 12);
  assert.equal((await rooms.claim(LIB, "ann", "R1", at(9, 45))).ok, false); // too early
  const ok = await rooms.claim(LIB, "ann", "R1", at(9, 52));
  assert.equal(ok.ok, true);
  await rooms.tick(LIB, at(10, 30));
  const view = await rooms.viewDay(LIB, WED, null, at(10, 30));
  assert.deepEqual(view.rooms[0].now, { state: "inUse", until: "12:00", next: null });
});

test("at the door of a free room: book it now until the next hour or the one after", async () => {
  await book("ann", "R2", 12, 13);
  const door = await rooms.claim(LIB, "ben", "R2", at(10, 20));
  assert.equal(door.reason, "no_booking");
  assert.deepEqual(door.walkIn, [H(11), H(12)]);
  const walk = await rooms.book(LIB, { token: "ben", nickname: "Ben", room: "R2", end: H(12), walkIn: true }, at(10, 20));
  assert.equal(walk.ok, true);
  assert.deepEqual([walk.booking.start, walk.booking.end, walk.booking.claimed], [H(10) + 20, H(12), true]);
  // Right up to someone else's booking, never into it.
  assert.deepEqual((await rooms.claim(LIB, "cat", "R2", at(10, 30))).walkIn, []);
  assert.equal((await rooms.book(LIB, { token: "cat", room: "R1", end: H(10), walkIn: true }, at(10, 30))).reason, "bad_time");
  // Only within what's left of the two hours: Dee has an hour booked later today.
  await rooms.book(LIB, { token: "dee", nickname: "Dee", room: "R1", date: WED, start: H(14), end: H(15) }, at(10, 30));
  assert.deepEqual((await rooms.claim(LIB, "dee", "R3", at(10, 30))).walkIn, [H(11)]);
});

test("cancel before the start frees the slot; leaving early frees the rest", async () => {
  const a = await book("ann", "R1", 10, 12);
  assert.equal((await rooms.cancel(LIB, "ben", a.booking.id, at(9).now)).reason, "not_yours");
  assert.equal((await rooms.cancel(LIB, "ann", a.booking.id, at(9).now)).ended, false);
  assert.equal((await rooms.viewDay(LIB, WED, null, at(9))).rooms[0].bookings.length, 0);

  const b = await book("ann", "R1", 10, 12, at(9));
  await rooms.claim(LIB, "ann", "R1", at(10, 5));
  const left = await rooms.cancel(LIB, "ann", b.booking.id, at(10, 40).now);
  assert.equal(left.ended, true);
  const view = await rooms.viewDay(LIB, WED, null, at(10, 41));
  assert.equal(view.rooms[0].now.state, "free");
  assert.equal((await rooms.claim(LIB, "ben", "R1", at(10, 41))).walkIn[0], H(11));
});

test("an early close cancels bookings after it and shortens one running into it", async (t) => {
  const sent = [];
  t.mock.method(push, "sendPush", async (token, payload) => { sent.push([token, payload.body]); return { sent: true }; });
  await book("ann", "R1", 14, 16);
  await book("ben", "R2", 16, 17);
  const early = { ...HOURS, earlyClose: { date: WED, time: "15:30" } };
  await rooms.tick(LIB, { now: sast(2026, 10, 21, 13), hours: early });
  assert.deepEqual(sent, [["ben", "The library closes at 15:30 today, so your 16:00 booking was cancelled."]]);
  const view = await rooms.viewDay(LIB, WED, "ann", { now: sast(2026, 10, 21, 13), hours: early });
  assert.deepEqual(view.rooms[0].bookings.map((b) => [b.start, b.end]), [[H(14), H(15) + 30]]);
  assert.equal(view.rooms[1].bookings.length, 0);
  assert.equal(view.day.slots.at(-1).end, H(15) + 30);
});

test("staff see who booked, and can cancel a booking", async (t) => {
  const sent = [];
  t.mock.method(push, "sendPush", async (token) => { sent.push(token); return { sent: true }; });
  const a = await book("ann", "R3", 9, 10);
  const day = await rooms.staffDay(LIB, WED, at(8));
  assert.deepEqual(day.rooms[2].bookings.map((b) => [b.start, b.end, b.nickname, b.claimed]), [["09:00", "10:00", "ann", false]]);
  assert.equal((await rooms.staffCancel(LIB, a.booking.id, at(8).now)).ok, true);
  assert.deepEqual(sent, ["ann"]);
});

test("my bookings, soonest first; Delete my data removes them", async () => {
  await book("ann", "R2", 14, 15, at(8), "2026-10-22");
  await book("ann", "R1", 10, 11);
  const mine = await rooms.myBookings(LIB, "ann", at(8));
  assert.deepEqual(mine.map((b) => [b.date, b.label]), [[WED, "Room 1"], ["2026-10-22", "Room 2"]]);
  assert.equal(await rooms.forgetRooms(LIB, "ann"), 2);
  assert.deepEqual(await rooms.myBookings(LIB, "ann", at(8)), []);
});

test("many people booking the same slot at once: exactly one gets it", async () => {
  const results = await Promise.all(["a", "b", "c", "d", "e"].map((tok) => book(tok, "R1", 15, 16)));
  assert.equal(results.filter((r) => r.ok).length, 1);
});

test("two hours a day counts hours already used, not only bookings still to come", async (t) => {
  t.mock.method(push, "sendPush", async () => ({ sent: true }));
  await book("ann", "R1", 9, 11);
  await rooms.claim(LIB, "ann", "R1", at(9, 5));
  await rooms.tick(LIB, at(11, 30));
  assert.equal((await book("ann", "R2", 12, 13, at(11, 30))).reason, "day_limit");
  assert.deepEqual((await rooms.claim(LIB, "ann", "R3", at(11, 30))).walkIn, []);
  // Someone who left after an hour has an hour left.
  const b = await book("ben", "R2", 9, 11);
  await rooms.claim(LIB, "ben", "R2", at(9, 2));
  await rooms.cancel(LIB, "ben", b.booking.id, at(10).now);
  assert.equal((await book("ben", "R3", 14, 15, at(10, 5))).ok, true);
  assert.equal((await book("ben", "R3", 15, 16, at(10, 5))).reason, "day_limit");
});

test("a day closed after bookings were made (CLOSED_DAYS) cancels them, saying why", async (t) => {
  const sent = [];
  t.mock.method(push, "sendPush", async (token, payload) => { sent.push(payload.body); return { sent: true }; });
  await book("ann", "R1", 10, 11, at(8), "2026-10-22");
  process.env.CLOSED_DAYS = "2026-10-22";
  try {
    await rooms.tick(LIB, { now: sast(2026, 10, 22, 7), hours: HOURS });
  } finally {
    delete process.env.CLOSED_DAYS;
  }
  assert.deepEqual(sent, ["The library is closed today, so your 10:00 booking was cancelled."]);
});
