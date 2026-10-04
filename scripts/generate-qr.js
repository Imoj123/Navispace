"use strict";

/**
 * Generates one QR code PNG per registered seat, per active library,
 * encoding the URL a student's phone camera opens directly to that
 * seat's landing page. Same URL also works fine written to an NFC tag
 * (extension #3) — no separate encoding needed for that.
 *
 * Usage:
 *   BASE_URL=https://navispace.example.com npm run qr
 *   (defaults to http://localhost:3000 for local testing)
 *
 * Writes into qr-codes/<libraryId>/seat-<seatId>.png. The Engineering
 * Library's codes omit the lib param (just ?seat=A1) to stay
 * byte-for-byte identical to codes already printed before
 * multi-library support existed — only libraries added later get an
 * explicit ?lib= in their URL.
 */

const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");
const { LIBRARIES } = require("../src/libraries");
const { getSeatIds } = require("../src/seats");

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const OUT_DIR = path.join(__dirname, "..", "qr-codes");

async function main() {
  let total = 0;

  for (const lib of LIBRARIES) {
    if (lib.status !== "active") {
      console.log(`- ${lib.name}: coming soon, skipping (no seats configured yet)`);
      continue;
    }

    const seatIds = getSeatIds(lib.id);
    if (!seatIds.length) {
      console.log(`- ${lib.name}: active but has no seats configured (SEAT_IDS_${lib.id.toUpperCase()}?) — skipping`);
      continue;
    }

    const libDir = path.join(OUT_DIR, lib.id);
    fs.mkdirSync(libDir, { recursive: true });

    for (const seatId of seatIds) {
      const query =
        lib.id === "engineering"
          ? `seat=${encodeURIComponent(seatId)}`
          : `lib=${encodeURIComponent(lib.id)}&seat=${encodeURIComponent(seatId)}`;
      const url = `${BASE_URL}/seat.html?${query}`;
      const outPath = path.join(libDir, `seat-${seatId}.png`);
      await QRCode.toFile(outPath, url, { width: 512, margin: 2 });
      console.log(`✓ ${lib.name} ${seatId} -> ${outPath}  (${url})`);
      total++;
    }
  }

  console.log(`\nDone. ${total} QR codes written under ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
