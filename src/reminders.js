"use strict";

const { SeatState, getSeat, saveSeat } = require("./scan");
// Imported as a module object (not destructured) so tests can
// monkeypatch push.sendPush without a real VAPID/web-push round trip.
const push = require("./push");
const config = require("./config");

/**
 * Finds seats within REMINDER_LEAD_MS of their current expiry
 * (checkInExpiry for OCCUPIED, stepAwayExpiry for STEPPED_AWAY) and
 * pushes a heads-up to whoever's holding them — "confirm you're still
 * here or the seat frees up soon" — before the sweep actually
 * reclaims it. Exactly one reminder per expiry window: seat.reminderSent
 * is cleared by scan.js any time the expiry is recomputed (checkIn,
 * stillHere, stepAway, imBack), so a fresh confirmation always earns a
 * fresh reminder later, but this loop itself never repeats one.
 *
 * A holder with no push subscription, or no VAPID keys configured at
 * all, is a silent no-op via sendPush — this loop never throws on a
 * missing subscription. Scoped to one library per call, same shape as
 * sweep.js's sweepExpiredSeats.
 */
async function sendExpiryReminders(libraryId, seatIds, now = Date.now()) {
    const reminded = [];

    for (const seatId of seatIds) {
        const seat = await getSeat(libraryId, seatId);
        if (!seat.holderToken || seat.reminderSent) continue;

        const expiry =
            seat.state === SeatState.OCCUPIED
                ? seat.checkInExpiry
                : seat.state === SeatState.STEPPED_AWAY
                    ? seat.stepAwayExpiry
                    : null;
        if (!expiry) continue;

        const timeLeft = expiry - now;
        if (timeLeft <= 0 || timeLeft > config.REMINDER_LEAD_MS) continue;

        const body =
            seat.state === SeatState.OCCUPIED
                ? `Seat ${seat.id} will free up soon unless you confirm you're still there.`
                : `Seat ${seat.id} will free up soon unless you come back.`;

        const result = await push.sendPush(seat.holderToken, {
            title: "NaviSpace",
            body,
            seatId: seat.id,
            libraryId,
        });

        if (result.sent) {
            seat.reminderSent = true;
            await saveSeat(seat);
            reminded.push(seatId);
        }
    }

    return reminded;
}

/**
 * Starts the recurring reminder check across every active library.
 * Mirrors sweep.js's startSweepLoop shape (immediate first pass +
 * interval, unref'd so it never holds the process open on its own,
 * getLibrarySeatGroups resolving to [{ libraryId, seatIds }, ...]) so
 * the two background loops behave consistently.
 */
function startReminderLoop(getLibrarySeatGroups, intervalMs, onReminder) {
    const run = async () => {
        const groups = await getLibrarySeatGroups();
        for (const { libraryId, seatIds } of groups) {
            const reminded = await sendExpiryReminders(libraryId, seatIds);
            if (reminded.length && onReminder) onReminder(libraryId, reminded);
        }
    };

    run();

    const handle = setInterval(run, intervalMs);
    if (handle.unref) handle.unref();

    return () => clearInterval(handle);
}

module.exports = { sendExpiryReminders, startReminderLoop };
