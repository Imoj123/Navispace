"use strict";

const { SeatState, getSeats, saveSeat } = require("./scan");
// Imported as a module object (not destructured) so tests can
// monkeypatch push.sendPush without a real VAPID/web-push round trip.
const push = require("./push");
const config = require("./config");

/**
 * Finds seats within a REMINDER_LEADS_MS lead time of their current expiry
 * (checkInExpiry for OCCUPIED, stepAwayExpiry for STEPPED_AWAY) and
 * pushes a heads-up to whoever's holding them — "confirm you're still
 * here or the seat frees up soon" — before the sweep actually
 * reclaims it. One reminder per lead time (10 min, then 5 min) per
 * expiry window: seat.remindersSent counts them, and scan.js resets it
 * any time the expiry is recomputed (checkIn,
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

    const seats = await getSeats(libraryId, seatIds);
    for (const seat of seats) {
        const seatId = seat.id;
        if (!seat.holderToken) continue;

        const expiry =
            seat.state === SeatState.OCCUPIED
                ? seat.checkInExpiry
                : seat.state === SeatState.STEPPED_AWAY
                    ? seat.stepAwayExpiry
                    : null;
        if (!expiry) continue;

        const timeLeft = expiry - now;
        if (timeLeft <= 0) continue;
        // How many lead times have passed; one reminder covers any that
        // were missed (e.g. the server was asleep at the 10-minute mark).
        const due = config.REMINDER_LEADS_MS.filter((lead) => timeLeft <= lead).length;
        if (due <= (seat.remindersSent || 0)) continue;
        const mins = Math.max(1, Math.round(timeLeft / 60000));

        const body =
            seat.state === SeatState.OCCUPIED
                ? `Seat ${seat.id} frees up in ${mins} min unless you confirm you're still there.`
                : `Seat ${seat.id} frees up in ${mins} min unless you come back.`;

        const result = await push.sendPush(seat.holderToken, {
            title: "NaviSpace",
            body,
            seatId: seat.id,
            libraryId,
        });

        if (result.sent) {
            seat.remindersSent = due;
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
        // Same as the sweep: a failed pass is logged and retried, never fatal.
        try {
            const groups = await getLibrarySeatGroups();
            for (const { libraryId, seatIds } of groups) {
                const reminded = await sendExpiryReminders(libraryId, seatIds);
                if (reminded.length && onReminder) onReminder(libraryId, reminded);
            }
        } catch (err) {
            console.error(`[reminders] pass failed, will retry: ${err.message}`);
        }
    };

    run();

    const handle = setInterval(run, intervalMs);
    if (handle.unref) handle.unref();

    return () => clearInterval(handle);
}

module.exports = { sendExpiryReminders, startReminderLoop };
