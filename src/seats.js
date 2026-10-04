"use strict";

const { LIBRARIES } = require("./libraries");

/**
 * Registry of known seat IDs, resolved separately per library.
 * Configurable without touching code, in two ways per library
 * (checked in this order), using the library's id uppercased as the
 * env var suffix:
 *
 * 1. SEAT_IDS_<LIBID> — explicit comma-separated list, e.g.
 *      SEAT_IDS_ENGINEERING=A1,A2,A3,B1,B2,B3,C1,C2
 *    Use this for irregular layouts or exact naming.
 *
 * 2. SEAT_ZONES_<LIBID> + SEATS_PER_ZONE_<LIBID> — auto-generates a
 *    numbered range per zone, e.g.
 *      SEAT_ZONES_ENGINEERING=A,B,C
 *      SEATS_PER_ZONE_ENGINEERING=10
 *    produces A1..A10, B1..B10, C1..C10 (30 seats total).
 *
 * A library with no seat config at all (including every "coming
 * soon" library, by design) resolves to an empty seat list — there's
 * nothing to check into yet, and the picker/map UI shows that plainly
 * rather than falling back to placeholder seats that don't exist in
 * that building.
 *
 * The one exception is "engineering" with nothing configured, which
 * falls back to a small placeholder list — this is the library that
 * existed before multi-library support, so local dev / a fresh
 * deployment keeps working out of the box exactly as before.
 *
 * On Render, set these under your service's "Environment" tab and
 * redeploy (or just restart) — no code change or git push needed to
 * add more seats or bring a new library online (just also flip its
 * status to "active" in LIBRARIES).
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

function envSuffix(libraryId) {
    return libraryId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function resolveSeatIds(libraryId) {
    const suffix = envSuffix(libraryId);

    const explicit = process.env[`SEAT_IDS_${suffix}`];
    if (explicit) {
        const ids = parseExplicitList(explicit);
        if (ids.length) return ids;
    }

    const zones = process.env[`SEAT_ZONES_${suffix}`];
    const perZone = process.env[`SEATS_PER_ZONE_${suffix}`];
    if (zones && perZone) {
        const generated = generateFromZones(zones, perZone);
        if (generated) return generated;
    }

    if (libraryId === "engineering") {
        // Placeholder fallback for local dev / pre-existing deployments —
        // replace via env vars above for any real deployment.
        return ["A1", "A2", "A3", "B1", "B2", "B3"];
    }

    return [];
}

/**
 * Optional left-to-right column order for a library's bird's-eye map,
 * e.g. SEAT_ZONE_ORDER_ENGINEERING=C,A,B. Any zone actually present in
 * that library's seats but left out of this list is appended
 * afterward (alphabetically), so a new zone added later never
 * silently disappears from the map just because this var wasn't
 * updated.
 */
function resolveZoneOrder(libraryId) {
    const suffix = envSuffix(libraryId);
    const raw = process.env[`SEAT_ZONE_ORDER_${suffix}`];
    if (!raw) return null;
    const zones = parseExplicitList(raw).map((z) => z.toUpperCase());
    return zones.length ? zones : null;
}

// Resolved once at startup for every known library (including
// coming-soon ones, which simply resolve to []).
const SEATS_BY_LIBRARY = {};
const ZONE_ORDER_BY_LIBRARY = {};
for (const lib of LIBRARIES) {
    SEATS_BY_LIBRARY[lib.id] = resolveSeatIds(lib.id);
    ZONE_ORDER_BY_LIBRARY[lib.id] = resolveZoneOrder(lib.id);
}

function getSeatIds(libraryId) {
    return SEATS_BY_LIBRARY[libraryId] || [];
}

function getZoneOrder(libraryId) {
    return ZONE_ORDER_BY_LIBRARY[libraryId] || null;
}

module.exports = {
    resolveSeatIds,
    resolveZoneOrder,
    getSeatIds,
    getZoneOrder,
    SEATS_BY_LIBRARY,
    ZONE_ORDER_BY_LIBRARY,
};
