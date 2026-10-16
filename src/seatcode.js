"use strict";

/**
 * Signed seat stickers.
 *
 * Each seat's QR code carries a short code, k, made from the seat's id and a
 * secret only the server knows (SEAT_SIGNING_SECRET):
 *
 *   /seat.html?seat=C1&k=Xb3f9QaL2e
 *
 * Checking in needs the right k for that seat, so a seat link typed by hand,
 * guessed, or found online can show the seat but not claim it: the only
 * practical way to get k is to scan the sticker. Without the secret, C1's code
 * says nothing about C2's.
 *
 * Changing the secret retires every printed code at once (reprint with
 * npm run qr). With no secret set, codes aren't required and every seat link
 * works as before — so the switch is flipped by setting the secret on Render
 * at the same time the new stickers go up.
 */

const crypto = require("crypto");

function secret() {
  return (process.env.SEAT_SIGNING_SECRET || "").trim() || null;
}

function seatCodesRequired() {
  return Boolean(secret());
}

/** The code printed on a seat's sticker (10 URL-safe characters). */
function seatCode(libraryId, seatId, key = secret()) {
  if (!key) return null;
  return crypto
    .createHmac("sha256", key)
    .update(`${libraryId}:${seatId}`)
    .digest("base64url")
    .slice(0, 10);
}

/** True when check-in at this seat is allowed with this code. */
function seatCodeValid(libraryId, seatId, code) {
  if (!seatCodesRequired()) return true;
  if (typeof code !== "string") return false;
  const expected = Buffer.from(seatCode(libraryId, seatId));
  const given = Buffer.from(code);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

module.exports = { seatCode, seatCodeValid, seatCodesRequired };
