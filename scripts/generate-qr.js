"use strict";

/**
 * Generates one QR code PNG per registered seat, encoding the URL a
 * student's phone camera opens directly to that seat's landing page.
 * Same URL also works fine written to an NFC tag (extension #3) —
 * no separate encoding needed for that.
 *
 * Usage:
 *   BASE_URL=https://navispace.example.com npm run qr
 *   (defaults to http://localhost:3000 for local testing)
 */

const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");
const { SEAT_IDS } = require("../src/seats");

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const OUT_DIR = path.join(__dirname, "..", "qr-codes");

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const seatId of SEAT_IDS) {
    const url = `${BASE_URL}/seat.html?seat=${encodeURIComponent(seatId)}`;
    const outPath = path.join(OUT_DIR, `seat-${seatId}.png`);
    await QRCode.toFile(outPath, url, { width: 512, margin: 2 });
    console.log(`✓ ${seatId} -> ${outPath}  (${url})`);
  }

  console.log(`\nDone. ${SEAT_IDS.length} QR codes written to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
