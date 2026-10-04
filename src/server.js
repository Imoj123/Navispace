"use strict";

const path = require("path");
const express = require("express");

const config = require("./config");
const { LIBRARIES, getLibrary, isActiveLibrary } = require("./libraries");
const { getSeatIds, getZoneOrder } = require("./seats");
const { getSeat, handleScan } = require("./scan");
const { sweepExpiredSeats, startSweepLoop } = require("./sweep");
const { getLeaderboard } = require("./leaderboard");
const { reportSeat } = require("./reports");
const { saveSubscription, removeSubscription } = require("./push");
const { startReminderLoop } = require("./reminders");
const { reportItem, listItems, claimItem, resolveItem } = require("./lostfound");

const PORT = process.env.PORT || 3000;

/** Every active library's { libraryId, seatIds } — what the sweep and
 * reminder loops need to check every library in one pass. */
function activeLibrarySeatGroups() {
  return LIBRARIES.filter((lib) => lib.status === "active").map((lib) => ({
    libraryId: lib.id,
    seatIds: getSeatIds(lib.id),
  }));
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: "3mb" })); // lost & found photos ride in the JSON body
  app.use(express.static(path.join(__dirname, "..", "public")));

  // --- Libraries ---------------------------------------------------------

  app.get("/api/libraries", (_req, res) => {
    res.json(
      LIBRARIES.map((lib) => ({
        id: lib.id,
        name: lib.name,
        status: lib.status,
        seatCount: lib.status === "active" ? getSeatIds(lib.id).length : 0,
        zoneOrder: lib.status === "active" ? getZoneOrder(lib.id) : null,
      }))
    );
  });

  // --- Seat state ----------------------------------------------------------

  app.get("/api/library/:libId/seat/:id", async (req, res) => {
    const { libId } = req.params;
    if (!getLibrary(libId)) {
      return res.status(404).json({ ok: false, reason: "unknown_library" });
    }
    const seat = await getSeat(libId, req.params.id);
    res.json(seat);
  });

  app.get("/api/library/:libId/seats", async (req, res) => {
    const { libId } = req.params;
    if (!getLibrary(libId)) {
      return res.status(404).json({ ok: false, reason: "unknown_library" });
    }
    const seatIds = getSeatIds(libId);
    const seats = await Promise.all(seatIds.map((id) => getSeat(libId, id)));
    res.json(seats);
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
    res.json({ ok: true });
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
      VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || null,
    });
  });

  return app;
}

function start() {
  const app = createApp();

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
