"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

delete process.env.ALWAYS_OPEN;
const { store } = require("../src/store");
const { openStatus, publicHolidays, localParts } = require("../src/hours");
const { handleScan, getSeat, SeatState } = require("../src/scan");
const { sweepExpiredSeats } = require("../src/sweep");
const { getSittings } = require("../src/history");
const busy = require("../src/busy");

const HOURS = { opens: "08:00", closes: "20:00" };
// Johannesburg is UTC+2 all year.
const sast = (y, m, d, h, min = 0) => Date.UTC(y, m - 1, d, h - 2, min);

test.beforeEach(() => { store.clear(); busy.reset(); });

test("open on weekdays from 08:00 to 20:00, Johannesburg time", () => {
  assert.equal(openStatus(HOURS, sast(2026, 10, 16, 10)).open, true);       // Friday morning
  assert.equal(openStatus(HOURS, sast(2026, 10, 16, 19, 59)).open, true);
  const evening = openStatus(HOURS, sast(2026, 10, 16, 20));
  assert.equal(evening.open, false);
  assert.equal(evening.nextOpen, "Monday");
  const early = openStatus(HOURS, sast(2026, 10, 19, 7, 59));               // Monday
  assert.equal(early.open, false);
  assert.equal(early.nextOpen, "today");
  assert.equal(openStatus(HOURS, sast(2026, 10, 15, 21)).nextOpen, "tomorrow");
});

test("closes at 17:00 on Fridays", () => {
  const withFriday = { ...HOURS, closesOn: { Fri: "17:00" } };
  assert.equal(openStatus(withFriday, sast(2026, 10, 16, 16, 59)).open, true);
  const friday = openStatus(withFriday, sast(2026, 10, 16, 17));
  assert.equal(friday.open, false);
  assert.equal(friday.nextOpen, "Monday");
  assert.equal(openStatus(withFriday, sast(2026, 10, 15, 19)).closes, "20:00"); // Thursday
  assert.equal(openStatus(withFriday, sast(2026, 10, 16, 12)).closes, "17:00");
});

test("closed on weekends and South African public holidays", () => {
  assert.equal(openStatus(HOURS, sast(2026, 10, 17, 11)).closedFor, "Weekend");
  assert.equal(openStatus(HOURS, sast(2026, 9, 24, 11)).closedFor, "Heritage Day");
  const h = publicHolidays(2026);
  assert.equal(h["2026-04-03"], "Good Friday");
  assert.equal(h["2026-04-06"], "Family Day");
  assert.equal(h["2026-08-10"], "National Women's Day (observed)"); // 9 Aug 2026 is a Sunday
  assert.equal(openStatus(HOURS, sast(2026, 8, 10, 11)).open, false);
  // The day after a holiday is an ordinary day.
  assert.equal(openStatus(HOURS, sast(2026, 9, 25, 11)).open, true);
});

test("CLOSED_DAYS adds closures; ALWAYS_OPEN overrides everything", () => {
  process.env.CLOSED_DAYS = "2026-10-14";
  assert.equal(openStatus(HOURS, sast(2026, 10, 14, 11)).open, false);
  delete process.env.CLOSED_DAYS;
  process.env.ALWAYS_OPEN = "1";
  assert.equal(openStatus(HOURS, sast(2026, 10, 17, 23)).open, true);
  assert.equal(openStatus(HOURS, sast(2026, 10, 17, 23)).regularOpen, false);
  delete process.env.ALWAYS_OPEN;
});

test("peak hours follow the library's clock, not the server's", () => {
  assert.equal(localParts(sast(2026, 10, 16, 10)).hour, 10);
});

test("seats are freed 5 minutes after closing, and the sitting ends then", async () => {
  const lib = "test-lib", seat = "T1", who = { token: "tok-late", nickname: "Late" };
  await handleScan(lib, seat, "checkIn", who, sast(2026, 10, 16, 19, 30));
  await handleScan(lib, seat, "stillHere", who, sast(2026, 10, 16, 19, 50));

  assert.deepEqual(await sweepExpiredSeats(lib, [seat], sast(2026, 10, 16, 19, 55), { hours: HOURS }), []);
  // Closed at 20:00, but the library sometimes closes late: seats hold until 20:05.
  assert.deepEqual(await sweepExpiredSeats(lib, [seat], sast(2026, 10, 16, 20, 1), { hours: HOURS }), []);
  assert.deepEqual(await sweepExpiredSeats(lib, [seat], sast(2026, 10, 16, 20, 6), { hours: HOURS }), [seat]);
  assert.equal((await getSeat(lib, seat)).state, SeatState.AVAILABLE);
  const [sitting] = await getSittings(who.token, sast(2026, 10, 16, 21));
  assert.equal(sitting.ms, 35 * 60 * 1000);
});

test("busiest hours are learned from how full the library is", async () => {
  const lib = "busy-lib";
  assert.equal(await busy.busiestWindow(lib, HOURS), null);
  const seats = (held) => Array.from({ length: 10 }, (_, i) => ({ state: i < held ? "OCCUPIED" : "AVAILABLE" }));
  // Four weekdays, every minute from 08:00 to 20:00, busiest 14:00-17:00.
  for (const day of [12, 13, 14, 15]) {
    for (let m = 8 * 60; m < 20 * 60; m += 1) {
      const h = Math.floor(m / 60);
      await busy.observe(lib, seats(h >= 14 && h < 17 ? 9 : 2), sast(2026, 10, day, h, m % 60), HOURS);
    }
  }
  await busy.observe(lib, seats(0), sast(2026, 10, 16, 8), HOURS); // rolls the last hour over
  assert.equal(await busy.busiestWindow(lib, HOURS), "14:00–17:00");
});

test("weekend readings don't count towards busy hours", async () => {
  const lib = "busy-lib-2";
  await busy.observe(lib, [{ state: "OCCUPIED" }], sast(2026, 10, 17, 11), HOURS);
  await busy.observe(lib, [{ state: "OCCUPIED" }], sast(2026, 10, 17, 12), HOURS);
  assert.equal(await store.get("busy:busy-lib-2"), null);
});

test("check-ins are refused while the library is closed; /hours says why", async () => {
  const { createApp } = require("../src/server");
  const { getSeatIds } = require("../src/seats");
  process.env.CLOSED_DAYS = localParts(Date.now()).date;
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const [id] = getSeatIds("engineering");
    const res = await fetch(`${base}/api/library/engineering/scan/${id}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "checkIn", token: "tok-closed", nickname: "Thandi" }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).reason, "library_closed");
    const hours = await (await fetch(`${base}/api/library/engineering/hours`)).json();
    assert.equal(hours.open, false);
    assert.equal(hours.opens, "08:00");
    assert.equal(hours.busiest, "11:00–14:00"); // the plan's estimate until there's data
    assert.equal(hours.busiestLearned, false);
  } finally {
    delete process.env.CLOSED_DAYS;
    await new Promise((r) => server.close(r));
  }
});

test("ten minutes before closing, everyone holding a seat hears once", async (t) => {
  const push = require("../src/push");
  const { sendExpiryReminders } = require("../src/reminders");
  const sent = [];
  t.mock.method(push, "sendPush", async (token, payload) => { sent.push(payload.body); return { sent: true }; });
  const lib = "close-lib", who = { token: "tok-close", nickname: "Late" };
  await handleScan(lib, "T2", "checkIn", who, sast(2026, 10, 16, 19, 0));
  await sendExpiryReminders(lib, ["T2"], sast(2026, 10, 16, 19, 45), HOURS);
  assert.equal(sent.length, 0);
  await sendExpiryReminders(lib, ["T2"], sast(2026, 10, 16, 19, 51), HOURS);
  await sendExpiryReminders(lib, ["T2"], sast(2026, 10, 16, 19, 55), HOURS);
  assert.deepEqual(sent, ["The library closes at 20:00. Seat T2 is released at 20:05."]);
});

test("CLOSING_GRACE_MINUTES changes the grace", () => {
  const { releaseDue } = require("../src/hours");
  process.env.CLOSING_GRACE_MINUTES = "15";
  assert.equal(releaseDue(HOURS, sast(2026, 10, 16, 20, 10)), false);
  assert.equal(releaseDue(HOURS, sast(2026, 10, 16, 20, 16)), true);
  delete process.env.CLOSING_GRACE_MINUTES;
});
