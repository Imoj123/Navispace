"use strict";

const { store } = require("./store");
const { seatKey, getSeat, saveSeat, resetToAvailable } = require("./scan");
const config = require("./config");

function reportKey(seatId) {
    return `reports:${seatId}`;
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
async function reportSeat(seatId, reporterToken, now = Date.now()) {
    const key = reportKey(seatId);
    const existing = (await store.get(key)) || [];

    // Drop expired reports and any earlier report from this same
    // device, then add the new one — one active report per device.
    const active = existing
        .filter((r) => now - r.time < config.REPORT_WINDOW_MS)
        .filter((r) => r.token !== reporterToken);
    active.push({ token: reporterToken, time: now });

    const threshold = config.REPORT_THRESHOLD;
    let corrected = false;

    if (active.length >= threshold) {
        const seat = await getSeat(seatId);
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
