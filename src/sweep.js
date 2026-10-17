"use strict";

const { store } = require("./store");
const { SeatState, seatKey, resetToAvailable, saveSeat } = require("./scan");
const { recordSitting } = require("./history");
const { releaseDue, releasedAtToday } = require("./hours");
const { withLock, seatLock } = require("./lock");

/**
 * Reclaims seats whose expiry has passed without a confirming scan —
 * this is what actually guarantees correctness (the "forgot to check
 * out" / "forgot to return" cases), independent of whether the
 * client-side "still here" prompt ever fires.
 *
 * Scoped to one library per call (registered seat IDs are needed
 * since a plain Map has no native "scan all seat keys" — pass the
 * known seat ID list in). Returns the reclaimed seat IDs for that
 * library; startSweepLoop below calls this once per library.
 *
 * Options: hours (the library's opening hours: a few minutes after it
 * closes, every held seat is freed) and observe(libraryId, seats, now), handed every
 * seat after the sweep, which is how busy.js learns the busiest hours
 * without a second read.
 */
function sweepExpiredSeats(libraryId, seatIds, now = Date.now(), opts = {}) {
  // Takes its turn with check-ins and the rest (see lock.js), so a seat
  // confirmed a moment ago isn't freed from a stale read.
  return withLock(seatLock(libraryId), () => sweepNow(libraryId, seatIds, now, opts));
}

async function sweepNow(libraryId, seatIds, now, { hours, observe } = {}) {
  const reclaimed = [];
  // A few minutes after the library closes (see closingGraceMinutes), every
  // seat is freed: nobody holds a desk overnight or over a weekend. Their
  // sittings end when the seats were released.
  const closed = hours ? releaseDue(hours, now) : false;
  const closedAt = closed ? releasedAtToday(hours, now) : null;

  const stored = await store.getMany(seatIds.map((id) => seatKey(libraryId, id)));
  for (const [i, seatId] of seatIds.entries()) {
    const seat = stored[i];
    if (!seat) continue;

    const occupiedExpired =
      seat.state === SeatState.OCCUPIED &&
      seat.checkInExpiry &&
      now > seat.checkInExpiry;

    const stepAwayExpired =
      seat.state === SeatState.STEPPED_AWAY &&
      seat.stepAwayExpiry &&
      now > seat.stepAwayExpiry;

    const heldAtClose = closed && (seat.state === SeatState.OCCUPIED || seat.state === SeatState.STEPPED_AWAY);

    if (occupiedExpired || stepAwayExpired || heldAtClose) {
      // The sitting ended when its hold ran out (or the library closed),
      // not when the sweep noticed.
      const expiry = seat.state === SeatState.OCCUPIED ? seat.checkInExpiry : seat.stepAwayExpiry;
      await recordSitting(libraryId, seat, Math.min(expiry || now, closedAt || now, now));
      resetToAvailable(seat);
      await saveSeat(seat);
      reclaimed.push(seatId);
    }
  }

  if (observe) await observe(libraryId, stored, now);

  return reclaimed;
}

/**
 * Starts the recurring sweep across every active library. Returns a
 * stop function (clearInterval wrapper) so tests and graceful
 * shutdown can turn it off cleanly.
 *
 * getLibrarySeatGroups should resolve to an array of
 * { libraryId, seatIds } — one entry per library worth sweeping.
 *
 * Runs one sweep immediately on startup, in addition to the regular
 * interval — without this, a cold start (e.g. Render waking a
 * sleeping free-tier instance after it's been asleep for hours or
 * days) has a window of up to intervalMs where an already-expired
 * seat still reads as occupied to anyone checking right then, purely
 * because the recurring timer hasn't ticked yet. An immediate first
 * pass closes that gap so "wake up" and "reconcile stale seats"
 * happen together.
 */
function startSweepLoop(getLibrarySeatGroups, intervalMs, onSweep, observe) {
  const runSweep = async () => {
    // A failed pass (e.g. the store briefly unreachable) is logged and
    // retried next interval — it must never take the whole server down.
    try {
      const groups = await getLibrarySeatGroups();
      for (const { libraryId, seatIds, hours } of groups) {
        const reclaimed = await sweepExpiredSeats(libraryId, seatIds, Date.now(), { hours, observe });
        if (reclaimed.length && onSweep) onSweep(libraryId, reclaimed);
      }
    } catch (err) {
      console.error(`[sweep] pass failed, will retry: ${err.message}`);
    }
  };

  runSweep(); // immediate pass — closes the cold-start gap described above

  const handle = setInterval(runSweep, intervalMs);

  // Don't hold the process open just for the sweep timer in tests/CLI use.
  if (handle.unref) handle.unref();

  return () => clearInterval(handle);
}

module.exports = { sweepExpiredSeats, startSweepLoop };
