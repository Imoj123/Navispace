"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

delete process.env.ALWAYS_OPEN;
const { createApp } = require("../src/server");
const { store } = require("../src/store");
const { getSeatIds } = require("../src/seats");
const { openStatus, releaseDue, closingSoon } = require("../src/hours");
const { sweepExpiredSeats } = require("../src/sweep");
const { handleScan, getSeat, SeatState } = require("../src/scan");
const notices = require("../src/notices");
const push = require("../src/push");

// Johannesburg is UTC+2 all year.
const sast = (y, m, d, h, min = 0) => Date.UTC(y, m - 1, d, h - 2, min);
const WED_NOON = sast(2026, 10, 14, 12);

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const json = (body, headers = {}) => ({ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test.beforeEach(() => { store.clear(); notices.resetNotices(); require("../src/ratelimit").reset(); });
test.afterEach(() => { delete process.env.STAFF_PASSWORD; });

test("closing early moves today's closing time, and only today's", async () => {
  const r = await notices.setEarlyClose("engineering", { time: "15:00", reason: "Staff training" }, WED_NOON);
  assert.equal(r.ok, true);
  const hours = notices.libraryHours("engineering", WED_NOON);
  const now = openStatus(hours, WED_NOON);
  assert.equal(now.open, true);
  assert.equal(now.closes, "15:00");
  assert.deepEqual(now.closesEarly, { time: "15:00", reason: "Staff training" });
  const after = openStatus(hours, sast(2026, 10, 14, 15, 1));
  assert.equal(after.open, false);
  assert.equal(after.closedFor, "Closed early today");
  assert.equal(after.nextOpen, "tomorrow");
  // Seats go after the usual grace, and the 10-minute notice follows the new time.
  assert.equal(releaseDue(hours, sast(2026, 10, 14, 15, 3)), false);
  assert.equal(releaseDue(hours, sast(2026, 10, 14, 15, 6)), true);
  assert.equal(closingSoon(hours, sast(2026, 10, 14, 14, 52)).minutes, 8);
  // Tomorrow is back to normal.
  const thursday = sast(2026, 10, 15, 12);
  assert.equal(openStatus(notices.libraryHours("engineering", thursday), thursday).closes, "20:00");
});

test("an early close must be earlier than usual, on an open day; a past time means now", async () => {
  assert.equal((await notices.setEarlyClose("engineering", { time: "21:00" }, WED_NOON)).reason, "not_earlier");
  assert.equal((await notices.setEarlyClose("engineering", { time: "3pm" }, WED_NOON)).reason, "bad_time");
  assert.equal((await notices.setEarlyClose("engineering", { time: "15:00" }, sast(2026, 10, 17, 12))).reason, "closed_now"); // Saturday
  const r = await notices.setEarlyClose("engineering", { time: "09:00" }, WED_NOON);
  assert.equal(r.earlyClose.time, "12:01");
});

test("the sweep frees every seat after an early close", async () => {
  await notices.setEarlyClose("engineering", { time: "15:00" }, WED_NOON);
  const [seat] = getSeatIds("engineering");
  await handleScan("engineering", seat, "checkIn", { token: "t1", nickname: "Ama" }, sast(2026, 10, 14, 14, 0));
  const hours = notices.libraryHours("engineering", WED_NOON);
  assert.deepEqual(await sweepExpiredSeats("engineering", [seat], sast(2026, 10, 14, 14, 30), { hours }), []);
  assert.deepEqual(await sweepExpiredSeats("engineering", [seat], sast(2026, 10, 14, 15, 6), { hours }), [seat]);
  assert.equal((await getSeat("engineering", seat)).state, SeatState.AVAILABLE);
});

test("an announcement lasts until the end of today, or for some days, and can be removed", async () => {
  const today = await notices.setNotice("engineering", { text: "  Level 2 is   closed for exams. ", days: 0 }, WED_NOON);
  assert.equal(today.notice.text, "Level 2 is closed for exams.");
  assert.equal(today.notice.until, sast(2026, 10, 15, 0));
  assert.equal(notices.publicNotices("engineering", sast(2026, 10, 14, 23, 59)).notice.text, "Level 2 is closed for exams.");
  assert.equal(notices.publicNotices("engineering", sast(2026, 10, 15, 0, 1)).notice, null);
  const week = await notices.setNotice("engineering", { text: "New quiet zone", days: 30 }, WED_NOON);
  assert.equal(week.notice.until, WED_NOON + 7 * 24 * 3600 * 1000); // at most a week
  assert.equal((await notices.setNotice("engineering", { text: "x".repeat(201) }, WED_NOON)).reason, "too_long");
  await notices.clearNotice("engineering");
  assert.equal(notices.publicNotices("engineering", WED_NOON).notice, null);
});

test("staff post announcements and close early from the staff page; everyone sees them", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: WED_NOON });
  const told = [];
  t.mock.method(push, "sendPush", async (token, payload) => { told.push([token, payload.body]); return { sent: true }; });
  process.env.STAFF_PASSWORD = "desk-secret";
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/staff/notice`, json({ text: "Hi" }))).status, 401);
    const login = await fetch(`${base}/api/staff/login`, json({ password: "desk-secret" }));
    const cookie = { Cookie: login.headers.get("set-cookie").split(";")[0] };
    const [seat] = getSeatIds("engineering");
    await handleScan("engineering", seat, "checkIn", { token: "holder", nickname: "Ama" }, WED_NOON);

    const n = await (await fetch(`${base}/api/staff/notice`, json({ text: "Fire drill at 13:00", tell: true }, cookie))).json();
    assert.equal(n.told, 1);
    const e = await (await fetch(`${base}/api/staff/earlyclose`, json({ time: "15:00", reason: "Staff training", tell: true }, cookie))).json();
    assert.equal(e.ok, true);
    assert.deepEqual(told.map(([tok, body]) => [tok, body]), [
      ["holder", "Fire drill at 13:00"],
      ["holder", `The library closes early today at 15:00 (Staff training). Seat ${seat} is released at 15:05.`],
    ]);

    const pub = await (await fetch(`${base}/api/library/engineering/notices`)).json();
    assert.equal(pub.notice.text, "Fire drill at 13:00");
    assert.deepEqual(pub.earlyClose, { time: "15:00", reason: "Staff training", usual: "20:00" });
    const hours = await (await fetch(`${base}/api/library/engineering/hours`)).json();
    assert.equal(hours.closes, "15:00");
    const overview = await (await fetch(`${base}/api/staff/overview`, { headers: cookie })).json();
    assert.equal(overview.hours.closes, "15:00");
    assert.equal(overview.usualHours.closes, "20:00");

    await fetch(`${base}/api/staff/earlyclose/clear`, json({}, cookie));
    await fetch(`${base}/api/staff/notice/clear`, json({}, cookie));
    const cleared = await (await fetch(`${base}/api/library/engineering/notices`)).json();
    assert.equal(cleared.notice, null);
    assert.equal(cleared.earlyClose, null);
  });
});

test("after an early close, check-ins are refused", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: sast(2026, 10, 14, 15, 30) });
  await notices.setEarlyClose("engineering", { time: "15:00" }, sast(2026, 10, 14, 14, 0));
  await withServer(async (base) => {
    const [seat] = getSeatIds("engineering");
    const r = await (await fetch(`${base}/api/library/engineering/scan/${seat}`, json({ action: "checkIn", token: "late", nickname: "Late" }))).json();
    assert.equal(r.reason, "library_closed");
    assert.equal(r.hours.closedFor, "Closed early today");
  });
});
