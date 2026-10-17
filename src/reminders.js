"use strict";

const { SeatState, getSeats, getSeat, saveSeat } = require("./scan");
const { withLock, seatLock } = require("./lock");
// Imported as a module object (not destructured) so tests can
// monkeypatch push.sendPush without a real VAPID/web-push round trip.
const push = require("./push");
const config = require("./config");
const { closingSoon } = require("./hours");

// Minutes before closing that everyone holding a seat gets a heads-up.
const CLOSING_NOTICE_MIN = 10;

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
async function sendExpiryReminders(libraryId, seatIds, now = Date.now(), hours = null) {
    const reminded = [];
    // Closing soon: everyone holding a seat hears once, ten minutes before.
    const closing = hours ? closingSoon(hours, now) : null;
    const closingNotice = closing && closing.minutes > 0 && closing.minutes <= CLOSING_NOTICE_MIN;

    const seats = await getSeats(libraryId, seatIds);
    for (const seat of seats) {
        const seatId = seat.id;
        if (!seat.holderToken) continue;

        if (closingNotice && seat.closingNoticeDate !== closing.date &&
            (seat.state === SeatState.OCCUPIED || seat.state === SeatState.STEPPED_AWAY)) {
            const result = await push.sendPush(seat.holderToken, {
                title: "NaviSpace",
                body: `The library closes at ${closing.closes}. Seat ${seat.id} is released at ${closing.releasedAt}.`,
                seatId: seat.id,
                libraryId,
            });
            // Once a day, sent or not.
            await updateSameSitting(seat, (fresh) => { fresh.closingNoticeDate = closing.date; });
            if (result.sent) reminded.push(seatId);
        }

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
            await updateSameSitting(seat, (fresh) => { fresh.remindersSent = due; });
            reminded.push(seatId);
        }
    }

    return reminded;
}

/**
 * Saves a reminder's bookkeeping on the seat, re-read under the seat lock
 * (lock.js): a push can take a while, and the student may have checked
 * out, confirmed or stepped away meanwhile. Saving the copy read before
 * the push would undo that, so only the same sitting, unchanged, is touched.
 */
async function updateSameSitting(seen, change) {
    await withLock(seatLock(seen.libraryId), async () => {
        const fresh = await getSeat(seen.libraryId, seen.id);
        if (fresh.holderToken !== seen.holderToken || fresh.sessionStart !== seen.sessionStart ||
            fresh.state !== seen.state || fresh.checkInExpiry !== seen.checkInExpiry ||
            fresh.stepAwayExpiry !== seen.stepAwayExpiry) return;
        change(fresh);
        await saveSeat(fresh);
    });
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
            for (const { libraryId, seatIds, hours } of groups) {
                const reminded = await sendExpiryReminders(libraryId, seatIds, Date.now(), hours);
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
