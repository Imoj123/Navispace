"use strict";

/**
 * Makes changes to the same thing take turns. Every change to a library's
 * seats reads them, decides, then writes; with a network store (Upstash)
 * two requests a few milliseconds apart would both read the old state and
 * both "win" (two people on one seat, one person on three, a reminder
 * putting back a seat its holder just left). Running them one after the
 * other, per key, closes that.
 *
 * In memory, so it holds for one server process, which is how NaviSpace
 * runs (one Render instance). Running several instances would need a lock
 * in the store instead.
 */
const tails = new Map(); // key -> promise of the last queued task

function withLock(key, fn) {
  const prev = tails.get(key) || Promise.resolve();
  const run = prev.then(() => fn());
  // The queue continues whether this task succeeded or not.
  const tail = run.catch(() => { });
  tails.set(key, tail);
  tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return run;
}

/** The lock for everything that changes a library's seats. */
const seatLock = (libraryId) => `seats:${libraryId}`;

module.exports = { withLock, seatLock };
