"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { store } = require("../src/store");
const { getSeat, handleScan, currentCheckInDurationMs } = require("../src/scan");
const { sendExpiryReminders } = require("../src/reminders");
const push = require("../src/push");
const config = require("../src/config");

const SEAT_ID = "REM-1";
const alice = { token: "tok-alice-rem", nickname: "Alice" };

test.beforeEach(() => {
    store.clear();
});

test("sends exactly one reminder within the lead window, and only once", async (t) => {
    const sent = [];
    t.mock.method(push, "sendPush", async (token, payload) => {
        sent.push({ token, payload });
        return { sent: true };
    });

    const now = Date.now();
    await handleScan(SEAT_ID, "checkIn", alice, now);

    // Well before the reminder lead window — nothing should go out yet.
    let reminded = await sendExpiryReminders(
        [SEAT_ID],
        now + 1000
    );
    assert.deepEqual(reminded, []);
    assert.equal(sent.length, 0);

    // Inside the lead window (just before expiry). Uses
    // currentCheckInDurationMs rather than the flat CHECK_IN_DURATION_MS
    // constant since the actual duration used depends on whether "now"
    // falls in peak hours (see config.js / scan.js).
    const duration = currentCheckInDurationMs(now);
    const nearExpiry = now + duration - config.REMINDER_LEAD_MS + 1000;
    reminded = await sendExpiryReminders([SEAT_ID], nearExpiry);
    assert.deepEqual(reminded, [SEAT_ID]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].token, alice.token);
    assert.equal(sent[0].payload.seatId, SEAT_ID);

    // A second sweep in the same window must NOT send again.
    reminded = await sendExpiryReminders([SEAT_ID], nearExpiry + 1000);
    assert.deepEqual(reminded, []);
    assert.equal(sent.length, 1, "should not double-send within the same expiry window");

    const seat = await getSeat(SEAT_ID);
    assert.equal(seat.reminderSent, true);
});

test("re-confirming resets reminderSent so a new reminder can go out later", async (t) => {
    const sent = [];
    t.mock.method(push, "sendPush", async (token, payload) => {
        sent.push({ token, payload });
        return { sent: true };
    });

    const now = Date.now();
    await handleScan(SEAT_ID, "checkIn", alice, now);

    const duration = currentCheckInDurationMs(now);
    const nearExpiry = now + duration - config.REMINDER_LEAD_MS + 1000;
    await sendExpiryReminders([SEAT_ID], nearExpiry);
    assert.equal(sent.length, 1);

    // Confirming ("stillHere") pushes expiry out again and clears the flag.
    await handleScan(SEAT_ID, "stillHere", alice, nearExpiry);
    let seat = await getSeat(SEAT_ID);
    assert.equal(seat.reminderSent, false);

    const duration2 = currentCheckInDurationMs(nearExpiry);
    const nextNearExpiry = nearExpiry + duration2 - config.REMINDER_LEAD_MS + 1000;
    const reminded = await sendExpiryReminders([SEAT_ID], nextNearExpiry);
    assert.deepEqual(reminded, [SEAT_ID]);
    assert.equal(sent.length, 2, "a fresh confirmation should allow a fresh reminder");
});

test("never sends for an AVAILABLE (unheld) seat", async (t) => {
    const sent = [];
    t.mock.method(push, "sendPush", async (token, payload) => {
        sent.push({ token, payload });
        return { sent: true };
    });

    const reminded = await sendExpiryReminders([SEAT_ID], Date.now());
    assert.deepEqual(reminded, []);
    assert.equal(sent.length, 0);
});
