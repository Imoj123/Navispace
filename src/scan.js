"use strict";

const { store } = require("./store");
const config = require("./config");

/**
 * Seat states, mirroring the AVAILABLE / OCCUPIED / STEPPED_AWAY
 * three-state machine from the original sensor design — driven by
 * scans instead of sensor thresholds.
 */
const SeatState = Object.freeze({
  AVAILABLE: "AVAILABLE",
  OCCUPIED: "OCCUPIED",
  STEPPED_AWAY: "STEPPED_AWAY",
});

function seatKey(seatId) {
  return `seat:${seatId}`;
}

function studentKey(token) {
  return `student:${token}`;
}

function creditKey(token, seatId, dayKey) {
  return `credit:${token}:${seatId}:${dayKey}`;
}

/** Local YYYY-MM-DD, used as the leaderboard's one-credit-per-day unit. */
function dayKeyFor(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

/** Extension #5: shorter check-in window during configured peak hours. */
function currentCheckInDurationMs(now = Date.now()) {
  const hour = new Date(now).getHours();
  const isPeak =
    hour >= config.PEAK_HOURS_START && hour < config.PEAK_HOURS_END;
  return isPeak
    ? config.PEAK_CHECK_IN_DURATION_MS
    : config.CHECK_IN_DURATION_MS;
}

async function getSeat(seatId) {
  const seat = await store.get(seatKey(seatId));
  return (
    seat ?? {
      id: seatId,
      state: SeatState.AVAILABLE,
      checkInExpiry: null,
      stepAwayExpiry: null,
      lastConfirmTime: null,
      confirmStreak: 0,
      holderToken: null,
      holderNickname: null,
    }
  );
}

async function saveSeat(seat) {
  await store.put(seatKey(seat.id), seat);
}

/**
 * Credits one leaderboard "session day" for this student+seat, capped
 * at one per seat per day (extension against the unbounded-duration
 * gaming vector — see design notes). No-ops silently if already
 * credited today.
 */
async function creditSessionDay(token, nickname, seatId, now = Date.now()) {
  const dKey = dayKeyFor(now);
  const cKey = creditKey(token, seatId, dKey);

  const alreadyCredited = await store.get(cKey);
  if (alreadyCredited) return false;

  // Auto-expire the credit marker after 2 days — it only needs to
  // survive long enough to prevent same-day double-crediting.
  await store.put(cKey, true, { expirationTtl: 60 * 60 * 24 * 2 });

  const sKey = studentKey(token);
  const student = (await store.get(sKey)) ?? {
    token,
    nickname,
    weeklySessionDays: 0,
    windowStart: now,
  };

  const windowMs = config.LEADERBOARD_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  if (now - student.windowStart > windowMs) {
    student.weeklySessionDays = 0;
    student.windowStart = now;
  }

  student.weeklySessionDays += 1;
  student.nickname = nickname; // keep nickname fresh in case it changed
  await store.put(sKey, student);
  return true;
}

/**
 * Central scan handler. action is one of:
 *   "checkIn" | "stillHere" | "stepAway" | "imBack" | "leaving"
 *
 * identity: { token, nickname } — device-local, unverified (see design notes).
 *
 * Returns { ok: boolean, seat, reason? }. Invalid transitions are
 * no-ops that report ok:false with a reason, rather than throwing —
 * a stale client (e.g. two tabs) shouldn't crash the request.
 */
async function handleScan(seatId, action, identity, now = Date.now()) {
  const seat = await getSeat(seatId);

  switch (action) {
    case "checkIn": {
      if (seat.state !== SeatState.AVAILABLE) {
        return { ok: false, seat, reason: "seat_not_available" };
      }
      seat.state = SeatState.OCCUPIED;
      seat.checkInExpiry = now + currentCheckInDurationMs(now);
      seat.stepAwayExpiry = null;
      seat.lastConfirmTime = now;
      seat.confirmStreak = 0;
      seat.holderToken = identity.token;
      seat.holderNickname = identity.nickname;
      await saveSeat(seat);
      return { ok: true, seat };
    }

    case "stillHere": {
      if (seat.state !== SeatState.OCCUPIED) {
        return { ok: false, seat, reason: "not_occupied" };
      }
      if (seat.holderToken !== identity.token) {
        return { ok: false, seat, reason: "not_holder" };
      }
      await creditSessionDay(identity.token, identity.nickname, seatId, now);
      seat.checkInExpiry = now + currentCheckInDurationMs(now);
      seat.lastConfirmTime = now;
      seat.confirmStreak = (seat.confirmStreak ?? 0) + 1;
      await saveSeat(seat);
      return { ok: true, seat };
    }

    case "stepAway": {
      if (seat.state !== SeatState.OCCUPIED) {
        return { ok: false, seat, reason: "not_occupied" };
      }
      if (seat.holderToken !== identity.token) {
        return { ok: false, seat, reason: "not_holder" };
      }
      seat.state = SeatState.STEPPED_AWAY;
      seat.stepAwayExpiry = now + config.STEP_AWAY_DURATION_MS;
      await saveSeat(seat);
      return { ok: true, seat };
    }

    case "imBack": {
      if (seat.state !== SeatState.STEPPED_AWAY) {
        return { ok: false, seat, reason: "not_stepped_away" };
      }
      if (seat.holderToken !== identity.token) {
        return { ok: false, seat, reason: "not_holder" };
      }
      seat.state = SeatState.OCCUPIED;
      seat.checkInExpiry = now + currentCheckInDurationMs(now);
      seat.stepAwayExpiry = null;
      seat.lastConfirmTime = now;
      await saveSeat(seat);
      return { ok: true, seat };
    }

    case "leaving": {
      if (seat.state === SeatState.AVAILABLE) {
        return { ok: false, seat, reason: "already_available" };
      }
      if (seat.holderToken !== identity.token) {
        return { ok: false, seat, reason: "not_holder" };
      }
      // Final credit for today before releasing, same as a "stillHere"
      // would have, so leaving mid-session isn't worse than confirming.
      await creditSessionDay(identity.token, identity.nickname, seatId, now);
      resetToAvailable(seat);
      await saveSeat(seat);
      return { ok: true, seat };
    }

    default:
      return { ok: false, seat, reason: "unknown_action" };
  }
}

function resetToAvailable(seat) {
  seat.state = SeatState.AVAILABLE;
  seat.checkInExpiry = null;
  seat.stepAwayExpiry = null;
  seat.lastConfirmTime = null;
  seat.confirmStreak = 0;
  seat.holderToken = null;
  seat.holderNickname = null;
}

module.exports = {
  SeatState,
  seatKey,
  studentKey,
  dayKeyFor,
  currentCheckInDurationMs,
  getSeat,
  saveSeat,
  creditSessionDay,
  handleScan,
  resetToAvailable,
};
