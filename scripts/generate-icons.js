"use strict";

/**
 * Draws NaviSpace's app icons (the wordmark tile: a paper square with a
 * green dot, on the ink ground) as PNGs with no image dependencies —
 * a tiny PNG encoder over zlib, 4x supersampled for smooth edges.
 *
 *   npm run icons
 *
 * icon-192/512: full-bleed ink, mark inside the maskable safe zone.
 * badge-96: the mark alone in white on transparent — Android tints the
 * status-bar badge from its alpha channel only.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const INK = [0x10, 0x18, 0x2b];
const PAPER = [0xf4, 0xf3, 0xef];
const GREEN = [0x35, 0xa7, 0x76];
const WHITE = [255, 255, 255];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Inside a rounded square of half-side h, corner radius r, centred at c. */
function inRoundedSquare(x, y, c, h, r) {
  const dx = Math.max(Math.abs(x - c) - (h - r), 0);
  const dy = Math.max(Math.abs(y - c) - (h - r), 0);
  return Math.abs(x - c) <= h && Math.abs(y - c) <= h && dx * dx + dy * dy <= r * r;
}

function draw(size, { background, tile, dot, tileScale }) {
  const SS = 4;
  const out = Buffer.alloc(size * size * 4);
  const c = size / 2;
  // Mirrors .wordmark-mark: a 20px tile, 6px corners, 8px dot.
  const h = (size * tileScale) / 2;
  const r = h * (6 / 10);
  const dotR = h * (4 / 10);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          let col = background, a = background ? 1 : 0;
          if (inRoundedSquare(px, py, c, h, r)) { col = tile; a = 1; }
          if ((px - c) ** 2 + (py - c) ** 2 <= dotR * dotR) {
            if (dot) { col = dot; a = 1; } else { a = 0; }
          }
          if (a) { acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2]; acc[3] += 1; }
        }
      }
      const i = (y * size + x) * 4;
      const n = SS * SS;
      out[i] = acc[3] ? Math.round(acc[0] / acc[3]) : 0;
      out[i + 1] = acc[3] ? Math.round(acc[1] / acc[3]) : 0;
      out[i + 2] = acc[3] ? Math.round(acc[2] / acc[3]) : 0;
      out[i + 3] = Math.round((acc[3] / n) * 255);
    }
  }
  return encodePng(size, out);
}

const dir = path.join(__dirname, "..", "public", "icons");
fs.mkdirSync(dir, { recursive: true });
for (const size of [192, 512]) {
  fs.writeFileSync(
    path.join(dir, `icon-${size}.png`),
    draw(size, { background: INK, tile: PAPER, dot: GREEN, tileScale: 0.5 })
  );
}
fs.writeFileSync(path.join(dir, "apple-touch-icon.png"), draw(180, { background: INK, tile: PAPER, dot: GREEN, tileScale: 0.5 }));
// Badge: white tile with the dot cut out, transparent elsewhere.
fs.writeFileSync(path.join(dir, "badge-96.png"), draw(96, { background: null, tile: WHITE, dot: null, tileScale: 0.8 }));
console.log("Wrote icons to public/icons/");
