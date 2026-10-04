"use strict";

const crypto = require("crypto");
const { store } = require("./store");
const config = require("./config");

function itemKey(libraryId, itemId) {
    return `lostfound:${libraryId}:${itemId}`;
}

function listPrefix(libraryId) {
    return `lostfound:${libraryId}:`;
}

const TTL_SECONDS = config.LOST_FOUND_TTL_DAYS * 24 * 60 * 60;

/**
 * Reports a found item: a photo plus a short description, optionally
 * where in the library it turned up. reporterToken is the same
 * device-local identity used for seats — not verified login, but
 * enough to let only the original poster later mark it returned (see
 * resolveItem), mirroring the holderToken pattern scan.js already
 * uses for seats.
 *
 * The photo is expected to already be a reasonably small base64 data
 * URL — the client downscales/compresses before upload (see
 * client.js's downscaleImageFile). This is just the backstop: a
 * payload over LOST_FOUND_MAX_PHOTO_CHARS is rejected outright rather
 * than risking a store write that's too large for the backend (a
 * free-tier Redis has per-value size limits).
 */
async function reportItem(libraryId, { description, location, photoDataUrl, reporterToken, reporterNickname }, now = Date.now()) {
    if (!description || !photoDataUrl || !reporterToken) {
        return { ok: false, reason: "missing_fields" };
    }
    if (!photoDataUrl.startsWith("data:image/")) {
        return { ok: false, reason: "invalid_photo" };
    }
    if (photoDataUrl.length > config.LOST_FOUND_MAX_PHOTO_CHARS) {
        return { ok: false, reason: "photo_too_large" };
    }

    const item = {
        id: crypto.randomUUID(),
        libraryId,
        description: String(description).slice(0, 200),
        location: location ? String(location).slice(0, 120) : "",
        photoDataUrl,
        reporterToken,
        reporterNickname: reporterNickname || "Anonymous",
        status: "unclaimed",
        claim: null,
        createdAt: now,
    };

    await store.put(itemKey(libraryId, item.id), item, { expirationTtl: TTL_SECONDS });
    return { ok: true, item };
}

/**
 * Lists a library's board, newest first, unclaimed items ahead of
 * claimed ones (claimed items are "awaiting pickup," not gone yet —
 * they stay visible so the claimant and finder can coordinate — but
 * shouldn't crowd out the still-unclaimed items at the top).
 */
async function listItems(libraryId) {
    const keys = await store.listKeys(listPrefix(libraryId));
    const items = [];
    for (const key of keys) {
        const item = await store.get(key);
        if (item) items.push(item);
    }

    items.sort((a, b) => {
        if (a.status !== b.status) return a.status === "unclaimed" ? -1 : 1;
        return b.createdAt - a.createdAt;
    });

    return items;
}

/**
 * "I think this is mine" — records a claimant's contact nickname and
 * a short note (e.g. proof of ownership: "it's got a blue sticker on
 * the back") against the item, so the original finder can reach out
 * and arrange a handoff. This does NOT transfer custody through the
 * app — there's no way for NaviSpace to verify ownership, so the item
 * physically stays with whoever found it until they choose to mark it
 * returned (see resolveItem). First claim wins; a second claimant
 * sees the existing claim rather than overwriting it.
 */
async function claimItem(libraryId, itemId, { claimantToken, claimantNickname, note }, now = Date.now()) {
    const key = itemKey(libraryId, itemId);
    const item = await store.get(key);
    if (!item) return { ok: false, reason: "not_found" };
    if (item.status === "claimed") return { ok: false, reason: "already_claimed", item };

    item.status = "claimed";
    item.claim = {
        claimantToken,
        claimantNickname: claimantNickname || "Anonymous",
        note: note ? String(note).slice(0, 200) : "",
        claimedAt: now,
    };

    await store.put(key, item, { expirationTtl: TTL_SECONDS });
    return { ok: true, item };
}

/**
 * Marks an item returned/handled and removes it from the board.
 * Restricted to the original reporter's device token — only the
 * person who actually holds the item can know it's been handed over,
 * the same reasoning as a seat's holderToken checks.
 */
async function resolveItem(libraryId, itemId, requesterToken) {
    const key = itemKey(libraryId, itemId);
    const item = await store.get(key);
    if (!item) return { ok: false, reason: "not_found" };
    if (item.reporterToken !== requesterToken) {
        return { ok: false, reason: "not_reporter" };
    }
    await store.delete(key);
    return { ok: true };
}

module.exports = { reportItem, listItems, claimItem, resolveItem };
