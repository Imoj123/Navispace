"use strict";

const { store } = require("./store");
const { LIBRARIES } = require("./libraries");
const { getSeatIds } = require("./seats");
const { findHeldSeat, saveSeat, resetToAvailable, studentKey } = require("./scan");
const { removeSubscription } = require("./push");
const { leaveWaitlist } = require("./waitlist");
const config = require("./config");
const { withLock, seatLock } = require("./lock");
const { forgetRooms } = require("./rooms");

/**
 * "Delete my data" (privacy page): removes everything NaviSpace keeps under
 * a device's token, in every library:
 *
 * - the seat it holds (freed now),
 * - its sittings ("Your week") and study-board record,
 * - its notification sign-up and any "tell me when a seat frees up",
 * - its discussion room bookings,
 * - Lost & Found items it posted (with their conversations), and its
 *   claims on other people's items (the item goes back to unclaimed and
 *   the conversation is deleted).
 *
 * Usage counts are already anonymous (a one-way hash, see usage.js) and the
 * busy-hours averages hold no one at all, so neither needs touching.
 */
async function forgetDevice(token) {
  const removed = { seats: 0, items: 0, claims: 0, bookings: 0 };
  await store.delete(`history:${token}`);
  await removeSubscription(token);

  for (const lib of LIBRARIES) {
    await store.delete(studentKey(lib.id, token));
    await leaveWaitlist(lib.id, token);
    removed.bookings += await forgetRooms(lib.id, token);
    for (const key of await store.listKeys(`credit:${lib.id}:${token}:`)) await store.delete(key);

    const seatIds = lib.status === "active" ? getSeatIds(lib.id) : [];
    if (seatIds.length) {
      await withLock(seatLock(lib.id), async () => {
        const held = await findHeldSeat(lib.id, token, seatIds);
        if (held) {
          resetToAvailable(held);
          await saveSeat(held);
          removed.seats++;
        }
      });
    }

    const keys = await store.listKeys(`lostfound:${lib.id}:`);
    const items = await store.getMany(keys);
    for (const [i, item] of items.entries()) {
      if (!item) continue;
      const threadKey = `lfthread:${lib.id}:${item.id}`;
      if (item.reporterToken === token) {
        await store.delete(keys[i]);
        await store.delete(threadKey);
        removed.items++;
      } else if (item.claim && item.claim.claimantToken === token) {
        item.claim = null;
        item.status = "unclaimed";
        item.messageCount = 0;
        item.lastMessageAt = null;
        delete item.reported;
        await store.put(keys[i], item, { expirationTtl: config.LOST_FOUND_TTL_DAYS * 24 * 60 * 60 });
        await store.delete(threadKey);
        removed.claims++;
      }
    }
  }
  return { ok: true, removed };
}

module.exports = { forgetDevice };
