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

/**
 * Every seat-related key is namespaced by libraryId — NaviSpace now
 * covers multiple libraries (Engineering, Wartenweiler, Commerce, ...)
 * and seat IDs like "A1" are only unique *within* one library, so
 * without this a check-in at Engineering A1 and Wartenweiler A1 would
 * collide in the store.
 */
function seatKey(libraryId, seatId) {
  return `seat:${libraryId}:${seatId}`;
}

function studentKey(libraryId, token) {
  return `student:${libraryId}:${token}`;
}

function creditKey(libraryId, token, seatId, dayKey) {
  return `credit:${libraryId}:${token}:${seatId}:${dayKey}`;
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

async function getSeat(libraryId, seatId) {
  const seat = await store.get(seatKey(libraryId, seatId));
  return (
    seat ?? {
      id: seatId,
      libraryId,
      state: SeatState.AVAILABLE,
      checkInExpiry: null,
      stepAwayExpiry: null,
      lastConfirmTime: null,
      confirmStreak: 0,
      holderToken: null,
      holderNickname: null,
      reminderSent: false,
    }
  );
}

async function saveSeat(seat) {
  await store.put(seatKey(seat.libraryId, seat.id), seat);
}

/**
 * Credits one leaderboard "session day" for this student+seat, capped
 * at one per seat per day (extension against the unbounded-duration
 * gaming vector — see design notes). No-ops silently if already
 * credited today. Leaderboards are per-library — a library's board is
 * its own community, and it keeps the credit key naturally scoped
 * alongside everything else.
 */
async function creditSessionDay(libraryId, token, nickname, seatId, now = Date.now()) {
  const dKey = dayKeyFor(now);
  const cKey = creditKey(libraryId, token, seatId, dKey);

  const alreadyCredited = await store.get(cKey);
  if (alreadyCredited) return false;

  // Auto-expire the credit marker after 2 days — it only needs to
  // survive long enough to prevent same-day double-crediting.
  await store.put(cKey, true, { expirationTtl: 60 * 60 * 24 * 2 });

  const sKey = studentKey(libraryId, token);
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
 * Looks across every other seat in the SAME library for one already
 * held (OCCUPIED or STEPPED_AWAY) by this identity token — the
 * one-seat-per-user rule, scoped per library (holding a seat at
 * Engineering doesn't block checking in at Wartenweiler once that's
 * live — they're different physical rooms). excludeSeatId is the seat
 * being checked into, so a holder re-confirming/re-entering their own
 * seat is never mistaken for holding "another" seat.
 */
async function findHeldSeat(libraryId, token, seatIds, excludeSeatId = null) {
  for (const id of seatIds) {
    if (id === excludeSeatId) continue;
    const seat = await getSeat(libraryId, id);
    if (
      seat.holderToken === token &&
      (seat.state === SeatState.OCCUPIED || seat.state === SeatState.STEPPED_AWAY)
    ) {
      return seat;
    }
  }
  return null;
}

/**
 * Central scan handler. action is one of:
 *   "checkIn" | "stillHere" | "stepAway" | "imBack" | "leaving"
 *
 * identity: { token, nickname } — device-local, unverified (see design notes).
 *
 * allSeatIds (optional): every configured seat ID *in this library*,
 * used only by the "checkIn" case to enforce one-seat-per-user — pass
 * it in from the caller (server.js) so this module doesn't need to
 * know how seat IDs are resolved. Omitting it (e.g. in older tests)
 * simply skips that cross-seat check.
 *
 * Returns { ok: boolean, seat, reason? }. Invalid transitions are
 * no-ops that report ok:false with a reason, rather than throwing —
 * a stale client (e.g. two tabs) shouldn't crash the request.
 */
async function handleScan(libraryId, seatId, action, identity, now = Date.now(), allSeatIds = null) {
  const seat = await getSeat(libraryId, seatId);

  switch (action) {
    case "checkIn": {
      if (seat.state !== SeatState.AVAILABLE) {
        return { ok: false, seat, reason: "seat_not_available" };
      }
      if (allSeatIds) {
        const heldSeat = await findHeldSeat(libraryId, identity.token, allSeatIds, seatId);
        if (heldSeat) {
          return {
            ok: false,
            seat,
            reason: "already_holding_seat",
            heldSeatId: heldSeat.id,
          };
        }
      }
      seat.state = SeatState.OCCUPIED;
      seat.checkInExpiry = now + currentCheckInDurationMs(now);
      seat.stepAwayExpiry = null;
      seat.lastConfirmTime = now;
      seat.confirmStreak = 0;
      seat.holderToken = identity.token;
      seat.holderNickname = identity.nickname;
      seat.reminderSent = false;
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
      await creditSessionDay(libraryId, identity.token, identity.nickname, seatId, now);
      seat.checkInExpiry = now + currentCheckInDurationMs(now);
      seat.lastConfirmTime = now;
      seat.confirmStreak = (seat.confirmStreak ?? 0) + 1;
      seat.reminderSent = false;
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
      seat.reminderSent = false;
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
      seat.reminderSent = false;
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
      await creditSessionDay(libraryId, identity.token, identity.nickname, seatId, now);
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
  seat.reminderSent = false;
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
  findHeldSeat,
  resetToAvailable,
};
