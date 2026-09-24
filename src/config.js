"use strict";

/**
 * All tunable constants in one place. These are the numbers we
 * reasoned through in design — durations are deliberately short
 * defaults suited to local testing; real deployment values are
 * noted alongside each one.
 */

module.exports = {
  // How long a checked-in seat stays OCCUPIED without a "still here"
  // confirmation before the sweep reclaims it.
  // Real deployment: several hours (a full study session).
  CHECK_IN_DURATION_MS: 60 * 60 * 1000, // 1 hour

  // Shorter check-in window during peak hours (extension #5),
  // applied on top of CHECK_IN_DURATION_MS.
  PEAK_CHECK_IN_DURATION_MS: 20 * 60 * 1000, // 20 min
  PEAK_HOURS_START: 10, // 10am local
  PEAK_HOURS_END: 18, // 6pm local

  // How long a seat stays STEPPED_AWAY (belongings-style hold, minus
  // the desk sensor — here it's purely a scanned "I'm stepping away")
  // before the sweep frees it.
  // Real deployment: 20-30 min.
  STEP_AWAY_DURATION_MS: 10 * 60 * 1000, // 10 min

  // How often the client prompts "still studying?" while checked in.
  // Real deployment: ~45 min.
  STILL_HERE_PROMPT_INTERVAL_MS: 15 * 60 * 1000, // 15 min

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
};
