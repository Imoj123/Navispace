"use strict";

/**
 * Registry of libraries NaviSpace covers. Each library is either
 * "active" (has real seats, can be checked into) or "coming_soon"
 * (shown on the picker so people know it's planned, but has no seats
 * and can't be scanned into yet).
 *
 * Configurable without touching code via the LIBRARIES env var:
 *   LIBRARIES=engineering:Engineering Library:active,wartenweiler:Wartenweiler Library:coming_soon,commerce:Commerce Library:coming_soon
 * (id:Display Name:status, comma-separated between libraries)
 *
 * Falls back to the same three below if unset, so local dev and the
 * current single-library deployment keep working without a new env
 * var — add Wartenweiler/Commerce as "active" here (or override via
 * env) once they actually get seats.
 */

function parseLibraries(raw) {
    return raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
            const [id, name, status] = entry.split(":").map((s) => s.trim());
            if (!id || !name) return null;
            return {
                id,
                name,
                status: status === "active" ? "active" : "coming_soon",
            };
        })
        .filter(Boolean);
}

function resolveLibraries() {
    if (process.env.LIBRARIES) {
        const parsed = parseLibraries(process.env.LIBRARIES);
        if (parsed.length) return parsed;
    }

    return [
        { id: "engineering", name: "Engineering Library", status: "active" },
        { id: "wartenweiler", name: "Wartenweiler Library", status: "coming_soon" },
        { id: "commerce", name: "Commerce Library", status: "coming_soon" },
    ];
}

const LIBRARIES = resolveLibraries();

function getLibrary(id) {
    return LIBRARIES.find((lib) => lib.id === id) || null;
}

function isActiveLibrary(id) {
    const lib = getLibrary(id);
    return Boolean(lib && lib.status === "active");
}

module.exports = { LIBRARIES, getLibrary, isActiveLibrary, resolveLibraries };