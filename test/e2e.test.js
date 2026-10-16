"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { store } = require("../src/store");
const { SeatState, getSeat, handleScan } = require("../src/scan");
const { sweepExpiredSeats } = require("../src/sweep");
const { getLeaderboard } = require("../src/leaderboard");
const config = require("../src/config");

const LIB = "test-lib";
const SEAT_ID = "TEST-1";
const alice = { token: "tok-alice", nickname: "Alice" };
const bob = { token: "tok-bob", nickname: "Bob" };

test.beforeEach(() => {
  store.clear();
});

test("full lifecycle: check in -> confirm -> step away -> return -> check out", async () => {
  let seat = await getSeat(LIB, SEAT_ID);
  assert.equal(seat.state, SeatState.AVAILABLE);

  // Check in
  let result = await handleScan(LIB, SEAT_ID, "checkIn", alice);
  assert.equal(result.ok, true);
  assert.equal(result.seat.state, SeatState.OCCUPIED);
  assert.equal(result.seat.holderToken, alice.token);

  // Confirm ("still here") — should credit a session-day
  result = await handleScan(LIB, SEAT_ID, "stillHere", alice);
  assert.equal(result.ok, true);
  assert.equal(result.seat.confirmStreak, 1);

  let board = await getLeaderboard(LIB);
  assert.equal(board.length, 1);
  assert.equal(board[0].nickname, "Alice");
  assert.equal(board[0].sessionDays, 1);

  // A second "stillHere" the same day must NOT double-credit
  await handleScan(LIB, SEAT_ID, "stillHere", alice);
  board = await getLeaderboard(LIB);
  assert.equal(board[0].sessionDays, 1, "same-day confirmations should not double-credit");

  // Step away
  result = await handleScan(LIB, SEAT_ID, "stepAway", alice);
  assert.equal(result.ok, true);
  assert.equal(result.seat.state, SeatState.STEPPED_AWAY);

  // Someone else can't claim the seat mid-step-away
  const stolen = await handleScan(LIB, SEAT_ID, "imBack", bob);
  assert.equal(stolen.ok, false);
  assert.equal(stolen.reason, "not_holder");

  // Return
  result = await handleScan(LIB, SEAT_ID, "imBack", alice);
  assert.equal(result.ok, true);
  assert.equal(result.seat.state, SeatState.OCCUPIED);

  // Check out
  result = await handleScan(LIB, SEAT_ID, "leaving", alice);
  assert.equal(result.ok, true);
  assert.equal(result.seat.state, SeatState.AVAILABLE);
  assert.equal(result.seat.holderToken, null);

  seat = await getSeat(LIB, SEAT_ID);
  assert.equal(seat.state, SeatState.AVAILABLE);
});

test("invalid transitions are rejected, not thrown", async () => {
  // Can't step away before checking in
  let result = await handleScan(LIB, SEAT_ID, "stepAway", alice);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_occupied");

  // Can't check in twice
  await handleScan(LIB, SEAT_ID, "checkIn", alice);
  result = await handleScan(LIB, SEAT_ID, "checkIn", bob);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "seat_not_available");

  // Unknown action
  result = await handleScan(LIB, SEAT_ID, "doTheThing", alice);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unknown_action");
});

test("expiry sweep reclaims a stale OCCUPIED seat", async () => {
  const now = Date.now();
  await handleScan(LIB, SEAT_ID, "checkIn", alice, now);

  // Simulate time passing well beyond the check-in expiry without
  // any confirming scan.
  const later = now + config.CHECK_IN_DURATION_MS + 1000;
  const reclaimed = await sweepExpiredSeats(LIB, [SEAT_ID], later);

  assert.deepEqual(reclaimed, [SEAT_ID]);
  const seat = await getSeat(LIB, SEAT_ID);
  assert.equal(seat.state, SeatState.AVAILABLE);
});

test("expiry sweep reclaims a stale STEPPED_AWAY seat", async () => {
  const now = Date.now();
  await handleScan(LIB, SEAT_ID, "checkIn", alice, now);
  await handleScan(LIB, SEAT_ID, "stepAway", alice, now);

  const later = now + config.STEP_AWAY_DURATION_MS + 1000;
  const reclaimed = await sweepExpiredSeats(LIB, [SEAT_ID], later);

  assert.deepEqual(reclaimed, [SEAT_ID]);
  const seat = await getSeat(LIB, SEAT_ID);
  assert.equal(seat.state, SeatState.AVAILABLE);
});

test("sweep leaves a live seat alone", async () => {
  const now = Date.now();
  await handleScan(LIB, SEAT_ID, "checkIn", alice, now);

  const soon = now + 1000; // well before expiry
  const reclaimed = await sweepExpiredSeats(LIB, [SEAT_ID], soon);

  assert.deepEqual(reclaimed, []);
  const seat = await getSeat(LIB, SEAT_ID);
  assert.equal(seat.state, SeatState.OCCUPIED);
});

test("leaving mid-session still credits today's session-day", async () => {
  await handleScan(LIB, SEAT_ID, "checkIn", alice);
  await handleScan(LIB, SEAT_ID, "leaving", alice);

  const board = await getLeaderboard(LIB);
  assert.equal(board.length, 1);
  assert.equal(board[0].sessionDays, 1);
});

test("one-seat-per-user: can't check into a second seat while already holding one", async () => {
  const seatIds = ["SEAT-A", "SEAT-B"];

  let result = await handleScan(LIB, "SEAT-A", "checkIn", alice, Date.now(), seatIds);
  assert.equal(result.ok, true);

  // Alice tries to also check into SEAT-B while still holding SEAT-A.
  result = await handleScan(LIB, "SEAT-B", "checkIn", alice, Date.now(), seatIds);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "already_holding_seat");
  assert.equal(result.heldSeatId, "SEAT-A");

  // SEAT-B must remain untouched/AVAILABLE.
  const seatB = await getSeat(LIB, "SEAT-B");
  assert.equal(seatB.state, SeatState.AVAILABLE);

  // Bob (a different identity) is unaffected and can still check into SEAT-B.
  result = await handleScan(LIB, "SEAT-B", "checkIn", bob, Date.now(), seatIds);
  assert.equal(result.ok, true);

  // Once Alice checks out of SEAT-A, she's free to check into a seat again.
  await handleScan(LIB, "SEAT-A", "leaving", alice);
  result = await handleScan(LIB, "SEAT-A", "checkIn", alice, Date.now(), seatIds);
  assert.equal(result.ok, true);
});

test("one-seat-per-user: re-confirming your own seat is not blocked by the rule", async () => {
  const seatIds = ["SEAT-A"];
  await handleScan(LIB, "SEAT-A", "checkIn", alice, Date.now(), seatIds);

  // stillHere doesn't go through the checkIn cross-seat check at all,
  // but this also exercises that checking into the SAME seat you
  // already hold isn't misidentified as "another" seat.
  const result = await handleScan(LIB, "SEAT-A", "checkIn", alice, Date.now(), seatIds);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "seat_not_available"); // already occupied by self, not the cross-seat rule
});

test("one-seat-per-user rule is scoped per library: holding a seat at one library doesn't block another", async () => {
  const seatIds = ["SEAT-A"];

  let result = await handleScan("engineering", "SEAT-A", "checkIn", alice, Date.now(), seatIds);
  assert.equal(result.ok, true);

  // Same identity, same seat ID, but a DIFFERENT library — should be
  // treated as a completely separate seat, not blocked.
  result = await handleScan("wartenweiler", "SEAT-A", "checkIn", alice, Date.now(), seatIds);
  assert.equal(result.ok, true);
});

test("two different students on two seats both score independently", async () => {
  await handleScan(LIB, "SEAT-A", "checkIn", alice);
  await handleScan(LIB, "SEAT-A", "stillHere", alice);

  await handleScan(LIB, "SEAT-B", "checkIn", bob);
  await handleScan(LIB, "SEAT-B", "stillHere", bob);

  const board = await getLeaderboard(LIB);
  assert.equal(board.length, 2);
  const names = board.map((e) => e.nickname).sort();
  assert.deepEqual(names, ["Alice", "Bob"]);
});

test("leaderboards are isolated per library", async () => {
  await handleScan("engineering", "SEAT-A", "checkIn", alice);
  await handleScan("engineering", "SEAT-A", "stillHere", alice);

  // Bob studies at a different library on a same-named seat ID.
  await handleScan("wartenweiler", "SEAT-A", "checkIn", bob);
  await handleScan("wartenweiler", "SEAT-A", "stillHere", bob);

  const engBoard = await getLeaderboard("engineering");
  const wartBoard = await getLeaderboard("wartenweiler");

  assert.equal(engBoard.length, 1);
  assert.equal(engBoard[0].nickname, "Alice");
  assert.equal(wartBoard.length, 1);
  assert.equal(wartBoard[0].nickname, "Bob");
});
test("history: leaving records the sitting's focus time, minus step-aways", async () => {
  const { getSittings } = require("../src/history");
  const t0 = Date.now() - 3 * 60 * 60 * 1000;
  const min = 60 * 1000;
  await handleScan(LIB, SEAT_ID, "checkIn", alice, t0);
  await handleScan(LIB, SEAT_ID, "stepAway", alice, t0 + 30 * min);
  await handleScan(LIB, SEAT_ID, "imBack", alice, t0 + 38 * min);
  await handleScan(LIB, SEAT_ID, "leaving", alice, t0 + 50 * min);

  const sittings = await getSittings(alice.token);
  assert.equal(sittings.length, 1);
  assert.equal(sittings[0].seat, SEAT_ID);
  assert.equal(sittings[0].ms, 42 * min);
  assert.deepEqual(await getSittings(bob.token), []);
});

test("history: a hold that runs out counts until it ran out; a mis-scan isn't counted", async () => {
  const { getSittings } = require("../src/history");
  const t0 = Date.now() - 3 * 60 * 60 * 1000;
  const { seat } = await handleScan(LIB, SEAT_ID, "checkIn", alice, t0);
  const hold = seat.checkInExpiry - t0; // shorter in peak hours
  await sweepExpiredSeats(LIB, [SEAT_ID], t0 + hold + 5 * 60 * 1000);
  let sittings = await getSittings(alice.token);
  assert.equal(sittings.length, 1);
  assert.equal(sittings[0].ms, hold);

  await handleScan(LIB, SEAT_ID, "checkIn", bob, t0);
  await handleScan(LIB, SEAT_ID, "leaving", bob, t0 + 20 * 1000);
  assert.deepEqual(await getSittings(bob.token), []);
});
