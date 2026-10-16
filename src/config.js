"use strict";

/**
 * All tunable constants in one place. These are the numbers we
 * reasoned through in design — durations are deliberately short
 * defaults suited to local testing; real deployment values are
 * noted alongside each one.
 */

module.exports = {
  // How long a checked-in seat stays OCCUPIED without a "still here"
  // confirmation before the sweep reclaims it. The same all day: there's
  // no shorter hold at busy times.
  CHECK_IN_DURATION_MS: 2 * 60 * 60 * 1000, // 2 hours

  // How long a seat stays STEPPED_AWAY (a scanned "I'm stepping away",
  // long enough for a lecture or lunch) before the sweep frees it.
  STEP_AWAY_DURATION_MS: 75 * 60 * 1000, // 1 h 15 min

  // How often the seat page asks "still studying?" while checked in.
  // Answering confirms the seat, so the 2-hour hold starts again.
  STILL_HERE_PROMPT_INTERVAL_MS: 50 * 60 * 1000, // 50 min

  // How long a "still here" prompt stays actionable client-side
  // before it's just dismissed (backend sweep is the real safety net).
  STILL_HERE_GRACE_MS: 5 * 60 * 1000, // 5 min

  // How often the server-side expiry sweep runs.
  SWEEP_INTERVAL_MS: 60 * 1000, // 1 min

  // Crowdsourced correction (extension #2): reports required within
  // the window before a seat auto-corrects to AVAILABLE.
  REPORT_THRESHOLD: 3,
  REPORT_WINDOW_MS: 10 * 60 * 1000, // 10 min

  // Leaderboard: one credit per seat per day, this many days retained
  // for the rolling weekly total.
  LEADERBOARD_WINDOW_DAYS: 7,

  // Staleness bands for the confidence display (extension #1), as a
  // fraction of the time until a seat's current expiry.
  STALENESS_HIGH_MAX: 0.5,
  STALENESS_MEDIUM_MAX: 1.0,

  // Web Push reminders (extension #5): send a "your seat is about to
  // free up" push this long before checkInExpiry/stepAwayExpiry hits,
  // and check for seats needing one this often. One reminder at each
  // lead time per expiry window (see seat.remindersSent in scan.js), so
  // nobody gets spammed while sitting there.
  REMINDER_LEADS_MS: [10 * 60 * 1000, 5 * 60 * 1000], // 10 min, then 5 min
  REMINDER_CHECK_INTERVAL_MS: 60 * 1000, // 1 min

  // Lost & Found: items auto-expire after this long so a forgotten
  // board doesn't grow unbounded on a free-tier store (items carry a
  // photo, which is the heaviest thing NaviSpace stores). Photos are
  // capped in base64-character length — client-side downscaling
  // should comfortably stay well under this; the server check is the
  // backstop against a browser that can't downscale.
  LOST_FOUND_TTL_DAYS: 30,
  LOST_FOUND_MAX_PHOTO_CHARS: 1_500_000, // ~1.1MB binary
};