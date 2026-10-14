"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");

const config = require("./config");
const { LIBRARIES, getLibrary, isActiveLibrary } = require("./libraries");
const { getSeatIds, getZoneOrder, getLayout } = require("./seats");
const { getSeat, getSeats, handleScan, findHeldSeat } = require("./scan");
const { sweepExpiredSeats, startSweepLoop } = require("./sweep");
const { getLeaderboard } = require("./leaderboard");
const { reportSeat } = require("./reports");
const { saveSubscription, removeSubscription, sendPush, vapidPublicKey } = require("./push");
const { startReminderLoop } = require("./reminders");
const { reportItem, listItems, claimItem, resolveItem } = require("./lostfound");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const BASE_MANIFEST = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, "manifest.json"), "utf8"));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every active library's { libraryId, seatIds } — what the sweep and
 * reminder loops need to check every library in one pass. */
function activeLibrarySeatGroups() {
  return LIBRARIES.filter((lib) => lib.status === "active").map((lib) => ({
    libraryId: lib.id,
    seatIds: getSeatIds(lib.id),
  }));
}

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** Minimal Cookie header parser — the one cookie we read doesn't justify a dependency. */
function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * The web app manifest, with the installing device's identity (and the
 * seat it's on) carried in start_url. iOS gives a Home Screen app its own
 * storage, separate from Safari, so without this the installed app gets a
 * fresh token — and its push subscription is filed under a token that
 * never holds a seat, so reminders never reach it.
 *
 * The identity arrives two ways, because Safari may read the manifest
 * either when the page loads or when "Add to Home Screen" is tapped:
 * the manifest link's own query (?handoff=&nick=&lib=&seat=, set by
 * client.js once the page has an identity), or the ns_handoff cookie
 * client.js sets with the same fields (sent because the link is
 * crossorigin="use-credentials"). The installed app adopts it on launch
 * (adoptHandoffIdentity in client.js).
 */
function buildManifest(req) {
  const manifest = { ...BASE_MANIFEST, id: "/" };
  let source = req.query;
  if (!UUID_RE.test(String(source.handoff || ""))) {
    source = Object.fromEntries(new URLSearchParams(readCookie(req, "ns_handoff") || ""));
  }
  const handoff = String(source.handoff || "");
  if (!UUID_RE.test(handoff)) return manifest;

  const params = new URLSearchParams({ handoff });
  const nick = String(source.nick || "").trim().slice(0, 24);
  if (nick) params.set("nick", nick);

  // Start on the seat the student was on, so the installed app opens
  // right where "Enable seat reminders" is.
  const lib = String(source.lib || "");
  const seat = String(source.seat || "");
  if (SAFE_ID_RE.test(lib) && SAFE_ID_RE.test(seat)) {
    params.set("lib", lib);
    params.set("seat", seat);
    manifest.start_url = `/seat.html?${params}`;
  } else {
    manifest.start_url = `/?${params}`;
  }
  return manifest;
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: "3mb" })); // lost & found photos ride in the JSON body

  // Uptime pings (cron-job.org / UptimeRobot) hit this to keep the
  // instance awake: cheap, touches no store, never cached.
  app.get("/healthz", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ ok: true, uptime: Math.round(process.uptime()) });
  });

  // The web app manifest, with the installing device's identity carried
  // in start_url. iOS gives a Home Screen app its own storage, separate
  // from Safari, so without this the installed app gets a fresh token —
  // and its push subscription is filed under a token that never holds a
  // seat, so reminders never reach it. client.js points the manifest
  // link here with ?handoff=<token>&nick=<nickname>; the installed app
  // adopts them on launch (see adoptHandoffIdentity in client.js).
  app.get("/manifest.json", (req, res) => {
    res.set("Cache-Control", "no-store")
      .type("application/manifest+json")
      .send(JSON.stringify(buildManifest(req)));
  });

  app.use(express.static(PUBLIC_DIR));

  // --- Libraries ---------------------------------------------------------

  app.get("/api/libraries", (_req, res) => {
    res.json(
      LIBRARIES.map((lib) => ({
        id: lib.id,
        name: lib.name,
        status: lib.status,
        seatCount: lib.status === "active" ? getSeatIds(lib.id).length : 0,
        zoneOrder: lib.status === "active" ? getZoneOrder(lib.id) : null,
        hasLayout: Boolean(getLayout(lib.id)),
      }))
    );
  });

  // --- Floor plan -----------------------------------------------------------

  app.get("/api/library/:libId/layout", (req, res) => {
    const layout = getLayout(req.params.libId);
    if (!layout) return res.status(404).json({ ok: false, reason: "no_layout" });
    res.json(layout);
  });

  // --- Seat state ----------------------------------------------------------

  app.get("/api/library/:libId/seat/:id", async (req, res) => {
    const { libId } = req.params;
    if (!getLibrary(libId)) {
      return res.status(404).json({ ok: false, reason: "unknown_library" });
    }
    // An id that isn't one of this library's seats (an old QR code, a
    // typo) is reported as such, rather than as a free seat.
    if (!getSeatIds(libId).includes(req.params.id)) {
      return res.status(404).json({ ok: false, reason: "unknown_seat" });
    }
    const seat = await getSeat(libId, req.params.id);
    res.json(seat);
  });

  app.get("/api/library/:libId/seats", async (req, res) => {
    const { libId } = req.params;
    if (!getLibrary(libId)) {
      return res.status(404).json({ ok: false, reason: "unknown_library" });
    }
    res.json(await getSeats(libId, getSeatIds(libId)));
  });

  // --- Scan actions ----------------------------------------------------------
  // Body: { action, token, nickname }

  app.post("/api/library/:libId/scan/:id", async (req, res) => {
    const { libId } = req.params;
    const { action, token, nickname } = req.body || {};

    if (!isActiveLibrary(libId)) {
      return res.status(404).json({ ok: false, reason: "library_not_active" });
    }
    const seatIds = getSeatIds(libId);
    if (!seatIds.includes(req.params.id)) {
      return res.status(404).json({ ok: false, reason: "unknown_seat" });
    }
    if (!token || !nickname) {
      return res.status(400).json({ ok: false, reason: "missing_identity" });
    }

    const result = await handleScan(
      libId,
      req.params.id,
      action,
      { token, nickname },
      Date.now(),
      seatIds
    );

    res.status(result.ok ? 200 : 409).json(result);
  });

  // --- Crowdsourced correction -----------------------------------------------
  // Body: { token } — same device identity used for scans.

  app.post("/api/library/:libId/report/:id", async (req, res) => {
    const { libId } = req.params;
    const { token } = req.body || {};

    if (!isActiveLibrary(libId) || !getSeatIds(libId).includes(req.params.id)) {
      return res.status(404).json({ ok: false, reason: "unknown_seat" });
    }
    if (!token) {
      return res.status(400).json({ ok: false, reason: "missing_identity" });
    }

    const result = await reportSeat(libId, req.params.id, token);
    res.json({ ok: true, ...result });
  });

  // --- Leaderboard -------------------------------------------------------

  app.get("/api/library/:libId/leaderboard", async (req, res) => {
    const { libId } = req.params;
    if (!getLibrary(libId)) {
      return res.status(404).json({ ok: false, reason: "unknown_library" });
    }
    const entries = await getLeaderboard(libId, 10);
    res.json(entries);
  });

  // --- Manual sweep trigger (handy for testing without waiting) -------------

  app.post("/api/library/:libId/sweep", async (req, res) => {
    const { libId } = req.params;
    const reclaimed = await sweepExpiredSeats(libId, getSeatIds(libId));
    res.json({ reclaimed });
  });

  // --- Lost & Found --------------------------------------------------------
  // Body (report): { description, location, photoDataUrl, token, nickname }

  app.get("/api/library/:libId/lostfound", async (req, res) => {
    const { libId } = req.params;
    if (!getLibrary(libId)) {
      return res.status(404).json({ ok: false, reason: "unknown_library" });
    }
    const items = await listItems(libId);
    res.json(items);
  });

  app.post("/api/library/:libId/lostfound", async (req, res) => {
    const { libId } = req.params;
    if (!isActiveLibrary(libId)) {
      return res.status(404).json({ ok: false, reason: "library_not_active" });
    }
    const { description, location, photoDataUrl, token, nickname } = req.body || {};
    const result = await reportItem(libId, {
      description,
      location,
      photoDataUrl,
      reporterToken: token,
      reporterNickname: nickname,
    });
    res.status(result.ok ? 200 : 400).json(result);
  });

  // Body: { token, nickname, note }
  app.post("/api/library/:libId/lostfound/:itemId/claim", async (req, res) => {
    const { libId, itemId } = req.params;
    const { token, nickname, note } = req.body || {};
    if (!token) {
      return res.status(400).json({ ok: false, reason: "missing_identity" });
    }
    const result = await claimItem(libId, itemId, {
      claimantToken: token,
      claimantNickname: nickname,
      note,
    });
    res.status(result.ok ? 200 : 409).json(result);
  });

  // Body: { token } — must be the original reporter's device.
  app.post("/api/library/:libId/lostfound/:itemId/resolve", async (req, res) => {
    const { libId, itemId } = req.params;
    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ ok: false, reason: "missing_identity" });
    }
    const result = await resolveItem(libId, itemId, token);
    res.status(result.ok ? 200 : 403).json(result);
  });

  // --- Web Push subscriptions ------------------------------------------------
  // Body: { token, subscription } — subscription is the PushSubscription
  // object the browser's PushManager.subscribe() returns.

  app.post("/api/push/subscribe", async (req, res) => {
    const { token, subscription } = req.body || {};
    if (!token || !subscription) {
      return res.status(400).json({ ok: false, reason: "missing_fields" });
    }
    await saveSubscription(token, subscription);
    // Send one right away so the student sees reminders work end to end
    // (and a broken VAPID/push setup shows up now, not 55 minutes later).
    const test = await sendPush(token, {
      title: "NaviSpace",
      body: "Reminders are on. We'll ping you before your seat frees up.",
    });
    res.json({ ok: true, testSent: test.sent, testReason: test.reason || null });
  });

  // Body: { token } — which seat (if any) this device holds, across all
  // active libraries. Lets the home page (and the installed app, which
  // isn't opened by a QR scan) take a student straight back to it.
  app.post("/api/held", async (req, res) => {
    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ ok: false, reason: "missing_token" });
    }
    for (const { libraryId, seatIds } of activeLibrarySeatGroups()) {
      const seat = await findHeldSeat(libraryId, token, seatIds);
      if (seat) return res.json({ ok: true, libraryId, seatId: seat.id, state: seat.state });
    }
    res.json({ ok: true, libraryId: null, seatId: null });
  });

  app.post("/api/push/unsubscribe", async (req, res) => {
    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ ok: false, reason: "missing_token" });
    }
    await removeSubscription(token);
    res.json({ ok: true });
  });

  // --- Client-facing config (kept in sync with config.js so the UI ----
  // --- never hardcodes a second copy of these numbers) -----------------

  app.get("/api/config", (_req, res) => {
    res.json({
      STALENESS_HIGH_MAX: config.STALENESS_HIGH_MAX,
      STALENESS_MEDIUM_MAX: config.STALENESS_MEDIUM_MAX,
      REPORT_THRESHOLD: config.REPORT_THRESHOLD,
      CHECK_IN_DURATION_MS: config.CHECK_IN_DURATION_MS,
      PEAK_CHECK_IN_DURATION_MS: config.PEAK_CHECK_IN_DURATION_MS,
      PEAK_HOURS_START: config.PEAK_HOURS_START,
      PEAK_HOURS_END: config.PEAK_HOURS_END,
      VAPID_PUBLIC_KEY: vapidPublicKey(),
    });
  });

  return app;
}

function start() {
  // Last line of defence: a stray rejected promise is logged, not fatal.
  // (Node exits on an unhandled rejection by default — on Render that
  // reads as "Service Unavailable" until the next restart.)
  process.on("unhandledRejection", (err) => {
    console.error("[server] unhandled rejection:", err && err.message ? err.message : err);
  });

  const app = createApp();
  // Surfaces a missing or malformed VAPID setup in the logs at boot,
  // rather than at the first reminder.
  require("./push").ensureConfigured();

  const stopSweep = startSweepLoop(
    () => Promise.resolve(activeLibrarySeatGroups()),
    config.SWEEP_INTERVAL_MS,
    (libraryId, reclaimed) => {
      console.log(`[sweep] ${libraryId} reclaimed: ${reclaimed.join(", ")}`);
    }
  );

  const stopReminders = startReminderLoop(
    () => Promise.resolve(activeLibrarySeatGroups()),
    config.REMINDER_CHECK_INTERVAL_MS,
    (libraryId, reminded) => {
      console.log(`[reminders] ${libraryId} sent: ${reminded.join(", ")}`);
    }
  );

  const server = app.listen(PORT, () => {
    console.log(`NaviSpace listening on http://localhost:${PORT}`);
  });

  const shutdown = () => {
    stopSweep();
    stopReminders();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}

module.exports = { createApp, start };

if (require.main === module) {
  start();
}
