"use strict";

const path = require("path");
const express = require("express");

const config = require("./config");
const { SEAT_IDS } = require("./seats");
const { getSeat, handleScan } = require("./scan");
const { sweepExpiredSeats, startSweepLoop } = require("./sweep");
const { getLeaderboard } = require("./leaderboard");
const { reportSeat } = require("./reports");

const PORT = process.env.PORT || 3000;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "..", "public")));

  // --- Seat state -----------------------------------------------------

  app.get("/api/seat/:id", async (req, res) => {
    const seat = await getSeat(req.params.id);
    res.json(seat);
  });

  app.get("/api/seats", async (_req, res) => {
    const seats = await Promise.all(SEAT_IDS.map((id) => getSeat(id)));
    res.json(seats);
  });

  // --- Scan actions -----------------------------------------------------
  // Body: { action, token, nickname }

  app.post("/api/scan/:id", async (req, res) => {
    const { action, token, nickname } = req.body || {};

    if (!SEAT_IDS.includes(req.params.id)) {
      return res.status(404).json({ ok: false, reason: "unknown_seat" });
    }
    if (!token || !nickname) {
      return res.status(400).json({ ok: false, reason: "missing_identity" });
    }

    const result = await handleScan(
      req.params.id,
      action,
      { token, nickname },
      Date.now(),
      SEAT_IDS
    );

    res.status(result.ok ? 200 : 409).json(result);
  });

  // --- Crowdsourced correction ------------------------------------------
  // Body: { token } — same device identity used for scans.

  app.post("/api/report/:id", async (req, res) => {
    const { token } = req.body || {};

    if (!SEAT_IDS.includes(req.params.id)) {
      return res.status(404).json({ ok: false, reason: "unknown_seat" });
    }
    if (!token) {
      return res.status(400).json({ ok: false, reason: "missing_identity" });
    }

    const result = await reportSeat(req.params.id, token);
    res.json({ ok: true, ...result });
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
    });
  });

  // --- Leaderboard -----------------------------------------------------

  app.get("/api/leaderboard", async (_req, res) => {
    const entries = await getLeaderboard(10);
    res.json(entries);
  });

  // --- Manual sweep trigger (handy for testing without waiting) -------

  app.post("/api/sweep", async (_req, res) => {
    const reclaimed = await sweepExpiredSeats(SEAT_IDS);
    res.json({ reclaimed });
  });

  return app;
}

function start() {
  const app = createApp();

  const stopSweep = startSweepLoop(
    () => Promise.resolve(SEAT_IDS),
    config.SWEEP_INTERVAL_MS,
    (reclaimed) => {
      console.log(`[sweep] reclaimed: ${reclaimed.join(", ")}`);
    }
  );

  const server = app.listen(PORT, () => {
    console.log(`NaviSpace listening on http://localhost:${PORT}`);
  });

  const shutdown = () => {
    stopSweep();
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