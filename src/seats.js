"use strict";

/**
 * Registry of known seat IDs for this deployment. Configurable
 * without touching code, in two ways (checked in this order):
 *
 * 1. SEAT_IDS env var — explicit comma-separated list, e.g.
 *      SEAT_IDS=A1,A2,A3,B1,B2,B3,C1,C2
 *    Use this for irregular layouts or exact naming.
 *
 * 2. SEAT_ZONES + SEATS_PER_ZONE env vars — auto-generates a
 *    numbered range per zone, e.g.
 *      SEAT_ZONES=A,B,C
 *      SEATS_PER_ZONE=10
 *    produces A1..A10, B1..B10, C1..C10 (30 seats total).
 *
 * If neither is set, falls back to the small placeholder list below
 * so local dev / testing still works out of the box.
 *
 * On Render, set these under your service's "Environment" tab and
 * redeploy (or just restart) — no code change or git push needed to
 * add more seats.
 */

function parseExplicitList(raw) {
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

function generateFromZones(zonesRaw, perZoneRaw) {
    const zones = parseExplicitList(zonesRaw);
    const perZone = parseInt(perZoneRaw, 10);

    if (!zones.length || !Number.isInteger(perZone) || perZone <= 0) {
        return null; // malformed config — caller falls back to default
    }

    const ids = [];
    for (const zone of zones) {
        for (let n = 1; n <= perZone; n++) {
            ids.push(`${zone}${n}`);
        }
    }
    return ids;
}

function resolveSeatIds() {
    if (process.env.SEAT_IDS) {
        const ids = parseExplicitList(process.env.SEAT_IDS);
        if (ids.length) return ids;
    }

    if (process.env.SEAT_ZONES && process.env.SEATS_PER_ZONE) {
        const generated = generateFromZones(
            process.env.SEAT_ZONES,
            process.env.SEATS_PER_ZONE
        );
        if (generated) return generated;
    }

    // Placeholder fallback for local dev — replace via env vars above
    // for any real deployment.
    return ["A1", "A2", "A3", "B1", "B2", "B3"];
}

const SEAT_IDS = resolveSeatIds();

module.exports = { SEAT_IDS, resolveSeatIds };
