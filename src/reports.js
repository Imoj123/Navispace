"use strict";

const { store } = require("./store");
const { getSeat, saveSeat, resetToAvailable } = require("./scan");
const { recordSitting } = require("./history");
const config = require("./config");
const { withLock, seatLock } = require("./lock");

function reportKey(libraryId, seatId) {
    return `reports:${libraryId}:${seatId}`;
}

/**
 * Records one "this seat's status looks wrong" report from a device
 * (identified by its localStorage token, same identity used
 * elsewhere — not verified login, just enough to stop one person
 * refreshing the page to fake multiple reports).
 *
 * Requires REPORT_THRESHOLD distinct reporters within REPORT_WINDOW_MS
 * before it corrects anything — a single report never flips a seat on
 * its own, so one bad-faith tap can't grief it.
 *
 * Returns { corrected, reportCount, threshold } so the client can show
 * "2 of 3 reports needed" type feedback.
 */
function reportSeat(libraryId, seatId, reporterToken, now = Date.now()) {
    // Same turn-taking as check-ins (lock.js): reports arriving together
    // all count, and a correction can't cross a check-in.
    return withLock(seatLock(libraryId), () => applyReport(libraryId, seatId, reporterToken, now));
}

async function applyReport(libraryId, seatId, reporterToken, now) {
    const key = reportKey(libraryId, seatId);
    const existing = (await store.get(key)) || [];
    const seat = await getSeat(libraryId, seatId);
    // Reports are about whoever holds the seat now: ones made before this
    // sitting began (e.g. while it was empty) don't count against it.
    const since = seat.sessionStart || 0;

    // Drop expired reports, ones from before this sitting and any earlier
    // report from this same device, then add the new one.
    const active = existing
        .filter((r) => now - r.time < config.REPORT_WINDOW_MS && r.time >= since)
        .filter((r) => r.token !== reporterToken);
    active.push({ token: reporterToken, time: now });

    const threshold = config.REPORT_THRESHOLD;
    let corrected = false;

    if (seat.state === "AVAILABLE") {
        // Already free: nothing to correct, and nothing to save up.
        await store.delete(key);
        return { corrected: false, reportCount: 0, threshold };
    }

    if (active.length >= threshold) {
        // Reported empty: count the sitting up to its last confirmed moment.
        await recordSitting(libraryId, seat, seat.lastConfirmTime || now);
        resetToAvailable(seat);
        await saveSeat(seat);
        await store.delete(key);
        corrected = true;
    } else {
        // Reports expire on their own via TTL, matching REPORT_WINDOW_MS,
        // so a stalled vote count doesn't linger forever in storage.
        await store.put(key, active, {
            expirationTtl: Math.ceil(config.REPORT_WINDOW_MS / 1000),
        });
    }

    return { corrected, reportCount: corrected ? 0 : active.length, threshold };
}

module.exports = { reportSeat };
