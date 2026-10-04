"use strict";

const { store } = require("./store");
const { SeatState, seatKey, resetToAvailable, saveSeat } = require("./scan");

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
 */
async function sweepExpiredSeats(libraryId, seatIds, now = Date.now()) {
  const reclaimed = [];

  for (const seatId of seatIds) {
    const seat = await store.get(seatKey(libraryId, seatId));
    if (!seat) continue;

    const occupiedExpired =
      seat.state === SeatState.OCCUPIED &&
      seat.checkInExpiry &&
      now > seat.checkInExpiry;

    const stepAwayExpired =
      seat.state === SeatState.STEPPED_AWAY &&
      seat.stepAwayExpiry &&
      now > seat.stepAwayExpiry;

    if (occupiedExpired || stepAwayExpired) {
      resetToAvailable(seat);
      await saveSeat(seat);
      reclaimed.push(seatId);
    }
  }

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
function startSweepLoop(getLibrarySeatGroups, intervalMs, onSweep) {
  const runSweep = async () => {
    const groups = await getLibrarySeatGroups();
    for (const { libraryId, seatIds } of groups) {
      const reclaimed = await sweepExpiredSeats(libraryId, seatIds);
      if (reclaimed.length && onSweep) onSweep(libraryId, reclaimed);
    }
  };

  runSweep(); // immediate pass — closes the cold-start gap described above

  const handle = setInterval(runSweep, intervalMs);

  // Don't hold the process open just for the sweep timer in tests/CLI use.
  if (handle.unref) handle.unref();

  return () => clearInterval(handle);
}

module.exports = { sweepExpiredSeats, startSweepLoop };
