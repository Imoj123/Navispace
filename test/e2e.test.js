"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { store } = require("../src/store");
const { SeatState, getSeat, handleScan } = require("../src/scan");
const { sweepExpiredSeats } = require("../src/sweep");
const { getLeaderboard } = require("../src/leaderboard");
const config = require("../src/config");

const SEAT_ID = "TEST-1";
const alice = { token: "tok-alice", nickname: "Alice" };
const bob = { token: "tok-bob", nickname: "Bob" };

test.beforeEach(() => {
  store.clear();
});

test("full lifecycle: check in -> confirm -> step away -> return -> check out", async () => {
  let seat = await getSeat(SEAT_ID);
  assert.equal(seat.state, SeatState.AVAILABLE);

  // Check in
  let result = await handleScan(SEAT_ID, "checkIn", alice);
  assert.equal(result.ok, true);
  assert.equal(result.seat.state, SeatState.OCCUPIED);
  assert.equal(result.seat.holderToken, alice.token);

  // Confirm ("still here") — should credit a session-day
  result = await handleScan(SEAT_ID, "stillHere", alice);
  assert.equal(result.ok, true);
  assert.equal(result.seat.confirmStreak, 1);

  let board = await getLeaderboard();
  assert.equal(board.length, 1);
  assert.equal(board[0].nickname, "Alice");
  assert.equal(board[0].sessionDays, 1);

  // A second "stillHere" the same day must NOT double-credit
  await handleScan(SEAT_ID, "stillHere", alice);
  board = await getLeaderboard();
  assert.equal(board[0].sessionDays, 1, "same-day confirmations should not double-credit");

  // Step away
  result = await handleScan(SEAT_ID, "stepAway", alice);
  assert.equal(result.ok, true);
  assert.equal(result.seat.state, SeatState.STEPPED_AWAY);

  // Someone else can't claim the seat mid-step-away
  const stolen = await handleScan(SEAT_ID, "imBack", bob);
  assert.equal(stolen.ok, false);
  assert.equal(stolen.reason, "not_holder");

  // Return
  result = await handleScan(SEAT_ID, "imBack", alice);
  assert.equal(result.ok, true);
  assert.equal(result.seat.state, SeatState.OCCUPIED);

  // Check out
  result = await handleScan(SEAT_ID, "leaving", alice);
  assert.equal(result.ok, true);
  assert.equal(result.seat.state, SeatState.AVAILABLE);
  assert.equal(result.seat.holderToken, null);

  seat = await getSeat(SEAT_ID);
  assert.equal(seat.state, SeatState.AVAILABLE);
});

test("invalid transitions are rejected, not thrown", async () => {
  // Can't step away before checking in
  let result = await handleScan(SEAT_ID, "stepAway", alice);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_occupied");

  // Can't check in twice
  await handleScan(SEAT_ID, "checkIn", alice);
  result = await handleScan(SEAT_ID, "checkIn", bob);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "seat_not_available");

  // Unknown action
  result = await handleScan(SEAT_ID, "doTheThing", alice);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unknown_action");
});

test("expiry sweep reclaims a stale OCCUPIED seat", async () => {
  const now = Date.now();
  await handleScan(SEAT_ID, "checkIn", alice, now);

  // Simulate time passing well beyond the check-in expiry without
  // any confirming scan.
  const later = now + config.CHECK_IN_DURATION_MS + 1000;
  const reclaimed = await sweepExpiredSeats([SEAT_ID], later);

  assert.deepEqual(reclaimed, [SEAT_ID]);
  const seat = await getSeat(SEAT_ID);
  assert.equal(seat.state, SeatState.AVAILABLE);
});

test("expiry sweep reclaims a stale STEPPED_AWAY seat", async () => {
  const now = Date.now();
  await handleScan(SEAT_ID, "checkIn", alice, now);
  await handleScan(SEAT_ID, "stepAway", alice, now);

  const later = now + config.STEP_AWAY_DURATION_MS + 1000;
  const reclaimed = await sweepExpiredSeats([SEAT_ID], later);

  assert.deepEqual(reclaimed, [SEAT_ID]);
  const seat = await getSeat(SEAT_ID);
  assert.equal(seat.state, SeatState.AVAILABLE);
});

test("sweep leaves a live seat alone", async () => {
  const now = Date.now();
  await handleScan(SEAT_ID, "checkIn", alice, now);

  const soon = now + 1000; // well before expiry
  const reclaimed = await sweepExpiredSeats([SEAT_ID], soon);

  assert.deepEqual(reclaimed, []);
  const seat = await getSeat(SEAT_ID);
  assert.equal(seat.state, SeatState.OCCUPIED);
});

test("leaving mid-session still credits today's session-day", async () => {
  await handleScan(SEAT_ID, "checkIn", alice);
  await handleScan(SEAT_ID, "leaving", alice);

  const board = await getLeaderboard();
  assert.equal(board.length, 1);
  assert.equal(board[0].sessionDays, 1);
});

test("two different students on two seats both score independently", async () => {
  await handleScan("SEAT-A", "checkIn", alice);
  await handleScan("SEAT-A", "stillHere", alice);

  await handleScan("SEAT-B", "checkIn", bob);
  await handleScan("SEAT-B", "stillHere", bob);

  const board = await getLeaderboard();
  assert.equal(board.length, 2);
  const names = board.map((e) => e.nickname).sort();
  assert.deepEqual(names, ["Alice", "Bob"]);
});
