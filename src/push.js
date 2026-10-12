"use strict";

const webpush = require("web-push");
const { store } = require("./store");

/**
 * Web Push subscriptions, keyed by the same device-local identity
 * token used everywhere else (localStorage token — not verified
 * login, see design notes in client.js). One subscription per token;
 * subscribing again (e.g. a new device, or the browser rotating the
 * subscription) just overwrites the old one.
 */
function pushKey(token) {
    return `push:${token}`;
}

function vapidConfigured() {
    return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

let configured = false;
function ensureConfigured() {
    if (configured || !vapidConfigured()) return;
    // Apple's push service rejects VAPID JWTs whose subject isn't a
    // real contact (403 BadJwtToken), so a placeholder here silently
    // breaks every iPhone. Set VAPID_SUBJECT=mailto:you@yourdomain.
    if (!process.env.VAPID_SUBJECT) {
        console.warn("[push] VAPID_SUBJECT is not set — iOS devices will reject pushes. Set it to mailto:<your email>.");
    }
    webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || "mailto:admin@example.com",
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
    configured = true;
}

async function saveSubscription(token, subscription) {
    await store.put(pushKey(token), subscription);
}

async function removeSubscription(token) {
    await store.delete(pushKey(token));
}

/**
 * Sends one push notification to whatever device is subscribed under
 * this identity token. Silently no-ops if there's no subscription, no
 * VAPID keys configured yet, or the push fails for a reason that
 * means the subscription is dead (410 Gone / 404) — in that last
 * case it also cleans up the stale subscription so future sends don't
 * keep hitting the same dead endpoint.
 *
 * Never throws — a failed reminder should never break the caller
 * (the reminder sweep, or a scan request).
 */
async function sendPush(token, payload) {
    if (!vapidConfigured()) return { sent: false, reason: "no_vapid_key" };
    ensureConfigured();

    const subscription = await store.get(pushKey(token));
    if (!subscription) return { sent: false, reason: "not_subscribed" };

    try {
        // TTL: a "your seat frees up soon" reminder is worthless after
        // a few minutes, so don't let the push service deliver it late.
        // urgency high: lets it through Android's battery saver/doze.
        await webpush.sendNotification(subscription, JSON.stringify(payload), {
            TTL: 5 * 60,
            urgency: "high",
        });
        return { sent: true };
    } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
            await removeSubscription(token);
        }
        // Logged so a failing push service shows up in the host's logs
        // instead of vanishing — this is where "notifications don't
        // work" gets diagnosed.
        console.warn(`[push] send failed (${err.statusCode || "no status"}): ${err.body || err.message}`);
        return { sent: false, reason: err.message || "send_failed" };
    }
}

module.exports = {
    vapidConfigured,
    saveSubscription,
    removeSubscription,
    sendPush,
};
