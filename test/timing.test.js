"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

delete process.env.ALWAYS_OPEN;
const { store } = require("../src/store");
const { handleScan, getSeat, SeatState } = require("../src/scan");
const { sweepExpiredSeats } = require("../src/sweep");
const { getLeaderboard } = require("../src/leaderboard");
const { getSittings } = require("../src/history");
const push = require("../src/push");
const { sendExpiryReminders } = require("../src/reminders");

const HOURS = { opens: "08:00", closes: "20:00", closesOn: { Fri: "17:00" } };
// Johannesburg is UTC+2 all year.
const sast = (y, m, d, h, min = 0) => Date.UTC(y, m - 1, d, h - 2, min);
const LIB = "timing-lib";
const who = (name) => ({ token: `tok-${name}`, nickname: name });

test.beforeEach(() => store.clear());

test("the study board is a calendar week: it starts fresh on Monday for everyone", async () => {
  // Pat studies Mon-Fri of the week of 19 Oct; Quinn Wed-Fri.
  for (const [name, days] of [["Pat", [19, 20, 21, 22, 23]], ["Quinn", [21, 22, 23]]]) {
    for (const d of days) {
      await handleScan(LIB, "A1", "checkIn", who(name), sast(2026, 10, d, 9));
      await handleScan(LIB, "A1", "leaving", who(name), sast(2026, 10, d, 10));
    }
  }
  const friday = await getLeaderboard(LIB, 10, sast(2026, 10, 23, 18));
  assert.deepEqual(friday.map((e) => [e.nickname, e.sessionDays]), [["Pat", 5], ["Quinn", 3]]);
  // Monday morning of the next week, before anyone has studied: an empty board.
  assert.deepEqual(await getLeaderboard(LIB, 10, sast(2026, 10, 26, 8, 30)), []);
  // Pat studies on Monday: one point this week, not six.
  await handleScan(LIB, "A1", "checkIn", who("Pat"), sast(2026, 10, 26, 9));
  await handleScan(LIB, "A1", "leaving", who("Pat"), sast(2026, 10, 26, 10));
  const monday = await getLeaderboard(LIB, 10, sast(2026, 10, 26, 10, 30));
  assert.deepEqual(monday.map((e) => [e.nickname, e.sessionDays]), [["Pat", 1]]);
});

test("a sitting that ends on its own still earns its day, if it lasted 15 minutes", async () => {
  await handleScan(LIB, "B1", "checkIn", who("Long"), sast(2026, 10, 21, 9));
  await handleScan(LIB, "B2", "checkIn", who("Brief"), sast(2026, 10, 21, 12));
  await handleScan(LIB, "B2", "stepAway", who("Brief"), sast(2026, 10, 21, 12, 5));
  // Long's hold runs out at 11:00; Brief's step-away at 13:20 (after only 5 minutes seated, but 80 min in all).
  await sweepExpiredSeats(LIB, ["B1", "B2"], sast(2026, 10, 21, 13, 30), { hours: HOURS });
  const board = await getLeaderboard(LIB, 10, sast(2026, 10, 21, 14));
  assert.deepEqual(board.map((e) => e.nickname).sort(), ["Brief", "Long"]);
});

test("after the server slept through closing, the sitting ends at that day's release", async () => {
  await handleScan(LIB, "C1", "checkIn", who("Night"), sast(2026, 10, 19, 19, 30)); // Monday 19:30
  // Nothing ran until Tuesday 08:30.
  await sweepExpiredSeats(LIB, ["C1"], sast(2026, 10, 20, 8, 30), { hours: HOURS });
  const [sitting] = await getSittings("tok-Night");
  assert.equal(sitting.end, sast(2026, 10, 19, 20, 5)); // 20:00 close + 5 min grace
  assert.equal(sitting.ms, 35 * 60 * 1000);
  // Friday: closes at 17:00.
  await handleScan(LIB, "C2", "checkIn", who("Fri"), sast(2026, 10, 23, 16, 30));
  await sweepExpiredSeats(LIB, ["C2"], sast(2026, 10, 26, 8, 30), { hours: HOURS });
  const [fri] = await getSittings("tok-Fri");
  assert.equal(fri.end, sast(2026, 10, 23, 17, 5));
});

test("a seat whose hold has just run out can be taken before the sweep gets to it", async () => {
  await handleScan(LIB, "D1", "checkIn", who("Gone"), sast(2026, 10, 21, 9));
  // 11:00:30: the hold ended at 11:00, the sweep hasn't run.
  const r = await handleScan(LIB, "D1", "checkIn", who("Next"), sast(2026, 10, 21, 11, 0) + 30000, ["D1", "D2"]);
  assert.equal(r.ok, true);
  assert.equal((await getSeat(LIB, "D1")).holderToken, "tok-Next");
  // And the one whose hold ran out isn't "holding" anything any more.
  const again = await handleScan(LIB, "D2", "checkIn", who("Gone"), sast(2026, 10, 21, 11, 1), ["D1", "D2"]);
  assert.equal(again.ok, true);
});

test("each sitting gets its own closing notice, and no 'confirm' reminder for a hold closing will end", async (t) => {
  const sent = [];
  t.mock.method(push, "sendPush", async (token, payload) => { sent.push([token, payload.body]); return { sent: true }; });
  const day = (h, m) => sast(2026, 10, 28, h, m); // a Wednesday
  await handleScan(LIB, "W1", "checkIn", who("X"), day(18, 0));
  await sendExpiryReminders(LIB, ["W1"], day(19, 50), HOURS);
  await handleScan(LIB, "W1", "leaving", who("X"), day(19, 51));
  await handleScan(LIB, "W1", "checkIn", who("Y"), day(19, 52));
  await sendExpiryReminders(LIB, ["W1"], day(19, 53), HOURS);
  assert.deepEqual(sent.map(([tok]) => tok), ["tok-X", "tok-Y"]);
  // E's hold (checked in 18:05) would end at 20:05, the release time: no "frees up in 8 min" at 19:57.
  sent.length = 0;
  await handleScan(LIB, "W2", "checkIn", who("E"), day(18, 5));
  await sendExpiryReminders(LIB, ["W2"], day(19, 51), HOURS); // the closing notice
  await sendExpiryReminders(LIB, ["W2"], day(19, 57), HOURS);
  assert.deepEqual(sent.map(([, body]) => body), ["The library closes at 20:00. Seat W2 is released at 20:05."]);
});
