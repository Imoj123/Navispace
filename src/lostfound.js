"use strict";

const crypto = require("crypto");
const { store } = require("./store");
const config = require("./config");

function itemKey(libraryId, itemId) {
    return `lostfound:${libraryId}:${itemId}`;
}

function threadKey(libraryId, itemId) {
    return `lfthread:${libraryId}:${itemId}`;
}

function listPrefix(libraryId) {
    return `lostfound:${libraryId}:`;
}

const TTL_SECONDS = config.LOST_FOUND_TTL_DAYS * 24 * 60 * 60;
// The same post again this soon (a double tap, a phone re-sending a slow
// upload) returns the first item instead of making a second one.
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_MESSAGE_CHARS = 300;
const MAX_MESSAGES = 60;
// Text only: a link in a lost-and-found chat is almost always a scam.
const LINK_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|co|ly|me|app|link|xyz)\b)/i;

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

    const twin = (await listItems(libraryId)).find((i) =>
        i.reporterToken === reporterToken &&
        i.description === String(description).slice(0, 200) &&
        i.photoDataUrl === photoDataUrl &&
        now - i.createdAt < DUPLICATE_WINDOW_MS);
    if (twin) return { ok: true, item: twin, duplicate: true };

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
    // One read for all of them (see store.getMany), not one per item.
    const items = (await store.getMany(keys)).filter(Boolean);

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
    // The claim note opens the private thread between the two of them.
    const opening = item.claim.note ? [{ from: "owner", text: item.claim.note, at: now }] : [];
    item.messageCount = opening.length;
    item.lastMessageAt = opening.length ? now : null;

    await store.put(key, item, { expirationTtl: TTL_SECONDS });
    await store.put(threadKey(libraryId, itemId), opening, { expirationTtl: TTL_SECONDS });
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
    // Once it's back with its owner, their conversation goes too.
    await store.delete(threadKey(libraryId, itemId));
    return { ok: true };
}

/**
 * The finder handed the item to the library's front desk: anyone can now
 * collect it there, without arranging to meet. Finder only.
 */
async function markAtDesk(libraryId, itemId, requesterToken, now = Date.now()) {
    const key = itemKey(libraryId, itemId);
    const item = await store.get(key);
    if (!item) return { ok: false, reason: "not_found" };
    if (item.reporterToken !== requesterToken) return { ok: false, reason: "not_reporter" };
    item.atDesk = true;
    item.atDeskAt = now;
    await store.put(key, item, { expirationTtl: TTL_SECONDS });
    return { ok: true, item };
}

/** Which side of a claim this device is on: "finder", "owner" or null. */
function roleOf(item, token) {
    if (!token) return null;
    if (item.reporterToken === token) return "finder";
    if (item.claim && item.claim.claimantToken === token) return "owner";
    return null;
}

/**
 * The private thread for a claimed item. Only the finder and the person
 * who claimed it can read it; everyone else gets not_allowed.
 */
async function getThread(libraryId, itemId, token) {
    const item = await store.get(itemKey(libraryId, itemId));
    if (!item || !item.claim) return { ok: false, reason: "not_found" };
    const role = roleOf(item, token);
    if (!role) return { ok: false, reason: "not_allowed" };
    const messages = (await store.get(threadKey(libraryId, itemId))) || [];
    return {
        ok: true,
        role,
        finder: item.reporterNickname,
        owner: item.claim.claimantNickname,
        atDesk: Boolean(item.atDesk),
        messages,
    };
}

/**
 * Adds a message to a claim's thread. Text only (no links), short, and a
 * thread holds at most MAX_MESSAGES. Returns the recipient's token so the
 * caller can notify them.
 */
async function sendMessage(libraryId, itemId, token, text, now = Date.now()) {
    const key = itemKey(libraryId, itemId);
    const item = await store.get(key);
    if (!item || !item.claim) return { ok: false, reason: "not_found" };
    const role = roleOf(item, token);
    if (!role) return { ok: false, reason: "not_allowed" };
    const clean = String(text || "").replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_CHARS);
    if (!clean) return { ok: false, reason: "empty" };
    if (LINK_RE.test(clean)) return { ok: false, reason: "no_links" };

    const tKey = threadKey(libraryId, itemId);
    const messages = (await store.get(tKey)) || [];
    if (messages.length >= MAX_MESSAGES) return { ok: false, reason: "thread_full" };
    const message = { from: role, text: clean, at: now };
    messages.push(message);
    await store.put(tKey, messages, { expirationTtl: TTL_SECONDS });

    item.messageCount = messages.length;
    item.lastMessageAt = now;
    await store.put(key, item, { expirationTtl: TTL_SECONDS });

    return {
        ok: true,
        message,
        recipientToken: role === "finder" ? item.claim.claimantToken : item.reporterToken,
        senderNickname: role === "finder" ? item.reporterNickname : item.claim.claimantNickname,
        item,
    };
}

/**
 * One of the two people in a thread reports it (harassment, a scam): the
 * item is flagged for library staff, who can read the thread and remove it
 * from the staff page. Participants only.
 */
async function reportThread(libraryId, itemId, token, now = Date.now()) {
    const key = itemKey(libraryId, itemId);
    const item = await store.get(key);
    if (!item || !item.claim) return { ok: false, reason: "not_found" };
    const role = roleOf(item, token);
    if (!role) return { ok: false, reason: "not_allowed" };
    item.reported = { at: now, by: role };
    await store.put(key, item, { expirationTtl: TTL_SECONDS });
    return { ok: true };
}

/** Staff: the thread of any item, without the participant check. */
async function staffThread(libraryId, itemId) {
    const item = await store.get(itemKey(libraryId, itemId));
    if (!item) return { ok: false, reason: "not_found" };
    return { ok: true, messages: (await store.get(threadKey(libraryId, itemId))) || [] };
}

/** Staff: remove an item (collected from the desk, or abusive) and its thread. */
async function staffRemove(libraryId, itemId) {
    await store.delete(itemKey(libraryId, itemId));
    await store.delete(threadKey(libraryId, itemId));
    return { ok: true };
}

module.exports = {
    reportItem, listItems, claimItem, resolveItem, markAtDesk, getThread, sendMessage, reportThread,
    staffThread, staffRemove, MAX_MESSAGE_CHARS,
};
