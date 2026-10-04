"use strict";

/**
 * NaviSpace service worker: makes the app installable and handles Web
 * Push reminders. Kept deliberately simple:
 *
 * - App-shell caching is cache-first for static files, network-first
 *   for API calls (/api/...) — seat/leaderboard state must never be
 *   served stale from cache, that would defeat the whole point of a
 *   live status display.
 * - Push events show a notification; clicking it focuses an existing
 *   NaviSpace tab if one's open, otherwise opens the relevant seat
 *   page (or the map if no seat was included).
 */

// Bump this whenever the cached shell files change meaningfully (new
// design, new pages) — activate() deletes any cache under the old
// name, so this is what actually forces previously-installed devices
// to pick up the new version instead of serving stale cached HTML
// forever under a cache-first strategy.
const CACHE_NAME = "navispace-shell-v3";
const SHELL_FILES = [
    "/",
    "/index.html",
    "/library.html",
    "/seat.html",
    "/leaderboard.html",
    "/lost-found.html",
    "/client.js",
    "/styles.css",
    "/manifest.json",
    "/icons/icon-192.png",
    "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
    );
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((names) =>
                Promise.all(
                    names
                        .filter((name) => name !== CACHE_NAME)
                        .map((name) => caches.delete(name))
                )
            )
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    // Never cache API calls — seat/leaderboard state must always be live.
    if (url.pathname.startsWith("/api/")) {
        event.respondWith(fetch(event.request).catch(() => new Response(
            JSON.stringify({ ok: false, reason: "offline" }),
            { status: 503, headers: { "Content-Type": "application/json" } }
        )));
        return;
    }

    // Cache-first for the static app shell, falling back to network
    // (and caching what we fetch) for anything else same-origin.
    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) return cached;
            return fetch(event.request).then((res) => {
                if (res.ok && url.origin === self.location.origin) {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
                }
                return res;
            });
        })
    );
});

self.addEventListener("push", (event) => {
    let payload = { title: "NaviSpace", body: "Your seat needs attention." };
    if (event.data) {
        try {
            payload = { ...payload, ...event.data.json() };
        } catch {
            payload.body = event.data.text();
        }
    }

    event.waitUntil(
        self.registration.showNotification(payload.title, {
            body: payload.body,
            icon: "/icons/icon-192.png",
            badge: "/icons/icon-192.png",
            data: { seatId: payload.seatId || null, libraryId: payload.libraryId || null },
            tag: payload.seatId ? `navispace-${payload.libraryId}-${payload.seatId}` : "navispace",
        })
    );
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const { seatId, libraryId } = event.notification.data || {};
    const targetUrl = seatId
        ? `/seat.html?lib=${encodeURIComponent(libraryId || "engineering")}&seat=${encodeURIComponent(seatId)}`
        : "/";

    event.waitUntil(
        self.clients
            .matchAll({ type: "window", includeUncontrolled: true })
            .then((clientsArr) => {
                for (const client of clientsArr) {
                    if (client.url.includes(targetUrl) && "focus" in client) {
                        return client.focus();
                    }
                }
                if (self.clients.openWindow) {
                    return self.clients.openWindow(targetUrl);
                }
            })
    );
});
