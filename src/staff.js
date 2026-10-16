"use strict";

const crypto = require("crypto");
const QRCode = require("qrcode");
const { store } = require("./store");
const { getLibrary, isActiveLibrary } = require("./libraries");
const { getSeatIds, getLayout } = require("./seats");
const { getSeats, getSeat, saveSeat, resetToAvailable, SeatState } = require("./scan");
const { recordSitting } = require("./history");
const { listItems, staffThread, staffRemove } = require("./lostfound");
const { seatCode, seatCodesRequired } = require("./seatcode");
const { openStatus } = require("./hours");
const busy = require("./busy");
const usage = require("./usage");
const { limit } = require("./ratelimit");

/**
 * The staff page (/staff.html): one password, set as STAFF_PASSWORD on the
 * server, for the library's front desk and whoever runs NaviSpace.
 *
 * Signing in sets an httpOnly cookie holding an expiry and a signature made
 * from the password, so changing the password signs everyone out. Without
 * STAFF_PASSWORD the staff page is switched off.
 */
const SESSION_HOURS = 12;
const COOKIE = "ns_staff";

function password() {
  return (process.env.STAFF_PASSWORD || "").trim() || null;
}

function sign(exp) {
  return crypto.createHmac("sha256", `navispace-staff:${password()}`).update(String(exp)).digest("base64url");
}

function sameText(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function signedIn(req) {
  if (!password()) return false;
  const [exp, sig] = String(readCookie(req, COOKIE) || "").split(".");
  return Number(exp) > Date.now() && Boolean(sig) && sameText(sig, sign(exp));
}

function requireStaff(req, res, next) {
  if (!password()) return res.status(503).json({ ok: false, reason: "staff_disabled" });
  if (!signedIn(req)) return res.status(401).json({ ok: false, reason: "not_signed_in" });
  res.set("Cache-Control", "no-store");
  next();
}

function libraryFrom(req) {
  const id = String((req.query.lib || (req.body && req.body.lib) || "engineering"));
  return getLibrary(id) ? id : null;
}

/** The sticker link for a seat: the same URLs `npm run qr` prints. */
function seatLink(origin, libraryId, seatId) {
  const query = libraryId === "engineering"
    ? `seat=${encodeURIComponent(seatId)}`
    : `lib=${encodeURIComponent(libraryId)}&seat=${encodeURIComponent(seatId)}`;
  const code = seatCode(libraryId, seatId);
  return `${origin}/seat.html?${query}${code ? `&k=${code}` : ""}`;
}

const escapeHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function mountStaff(app, { siteOrigin }) {
  app.post("/api/staff/login", limit("staffLogin"), (req, res) => {
    if (!password()) return res.status(503).json({ ok: false, reason: "staff_disabled" });
    if (!sameText((req.body && req.body.password) || "", password())) {
      return res.status(401).json({ ok: false, reason: "wrong_password" });
    }
    const exp = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
    const secure = req.secure ? "; Secure" : "";
    res.set("Set-Cookie", `${COOKIE}=${exp}.${sign(exp)}; Path=/; Max-Age=${SESSION_HOURS * 3600}; HttpOnly; SameSite=Strict${secure}`);
    res.json({ ok: true });
  });

  app.post("/api/staff/logout", (_req, res) => {
    res.set("Set-Cookie", `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`).json({ ok: true });
  });

  app.get("/api/staff/me", (req, res) => {
    res.set("Cache-Control", "no-store").json({ ok: true, enabled: Boolean(password()), signedIn: signedIn(req) });
  });

  // Everything on the staff page in one call.
  app.get("/api/staff/overview", requireStaff, async (req, res) => {
    const libId = libraryFrom(req);
    if (!libId) return res.status(404).json({ ok: false, reason: "unknown_library" });
    const seatIds = getSeatIds(libId);
    const [seats, items, use, hourly] = await Promise.all([
      getSeats(libId, seatIds), listItems(libId), usage.getUsage(libId, 14), busy.hourlyAverages(libId),
    ]);
    const layout = getLayout(libId);
    res.json({
      ok: true,
      library: { id: libId, name: getLibrary(libId).name, active: isActiveLibrary(libId) },
      hours: openStatus(layout && layout.hours),
      stickers: { signed: seatCodesRequired(), count: seatIds.length },
      seats: seats
        .filter((s) => s.state !== SeatState.AVAILABLE)
        .map((s) => ({
          id: s.id, state: s.state, nickname: s.holderNickname || "", since: s.sessionStart,
          until: s.state === SeatState.OCCUPIED ? s.checkInExpiry : s.stepAwayExpiry,
        })),
      seatCount: seatIds.length,
      items: items.map((i) => ({
        id: i.id, description: i.description, location: i.location, photo: i.photoDataUrl,
        createdAt: i.createdAt, finder: i.reporterNickname, atDesk: Boolean(i.atDesk),
        claimedBy: i.claim ? i.claim.claimantNickname : null, messages: i.messageCount || 0,
        reported: i.reported || null,
      })),
      usage: use,
      hourly,
    });
  });

  // A seat someone forgot to release (or left their things on).
  app.post("/api/staff/seat/:id/free", requireStaff, async (req, res) => {
    const libId = libraryFrom(req);
    if (!libId || !getSeatIds(libId).includes(req.params.id)) return res.status(404).json({ ok: false, reason: "unknown_seat" });
    const seat = await getSeat(libId, req.params.id);
    if (seat.state !== SeatState.AVAILABLE) {
      await recordSitting(libId, seat, Date.now());
      resetToAvailable(seat);
      await saveSeat(seat);
    }
    res.json({ ok: true });
  });

  app.get("/api/staff/lostfound/:itemId/thread", requireStaff, async (req, res) => {
    const libId = libraryFrom(req);
    if (!libId) return res.status(404).json({ ok: false, reason: "unknown_library" });
    const r = await staffThread(libId, req.params.itemId);
    res.status(r.ok ? 200 : 404).json(r);
  });

  // Collected from the desk, or taken down after a report.
  app.post("/api/staff/lostfound/:itemId/remove", requireStaff, async (req, res) => {
    const libId = libraryFrom(req);
    if (!libId) return res.status(404).json({ ok: false, reason: "unknown_library" });
    res.json(await staffRemove(libId, req.params.itemId));
  });

  // Every seat's sticker on A4, ready to print (or save as a PDF). Made here
  // because the codes need SEAT_SIGNING_SECRET, which only the server knows.
  app.get("/staff/stickers", async (req, res) => {
    if (!password() || !signedIn(req)) return res.redirect(302, "/staff.html");
    const libId = libraryFrom(req);
    if (!libId) return res.status(404).send("Unknown library");
    const origin = siteOrigin(req);
    const lib = getLibrary(libId);
    const stickers = await Promise.all(getSeatIds(libId).map(async (seatId) => {
      const svg = await QRCode.toString(seatLink(origin, libId, seatId), { type: "svg", margin: 1, errorCorrectionLevel: "M" });
      return `<figure class="sticker"><div class="qr">${svg}</div><figcaption><b>${escapeHtml(seatId)}</b><span>Scan to check in</span><small>${escapeHtml(lib.name)} · NaviSpace</small></figcaption></figure>`;
    }));
    const warning = seatCodesRequired() ? "" :
      `<p class="warn">SEAT_SIGNING_SECRET isn't set on the server, so these stickers carry no seat code. Set it first, then print.</p>`;
    res.set("Cache-Control", "no-store").type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Seat stickers · ${escapeHtml(lib.name)}</title>
<style>
  @page { size: A4; margin: 10mm; }
  body { margin: 0; font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace; color: #111; background: #fff; }
  header { padding: 16px 10mm; display: flex; justify-content: space-between; align-items: baseline; gap: 16px; flex-wrap: wrap; }
  header h1 { font: 400 20px Georgia, serif; margin: 0; }
  header button { font: inherit; padding: 8px 14px; border: 1px solid #111; background: #fff; cursor: pointer; }
  .warn { margin: 0 10mm 12px; padding: 10px; border: 1px solid #b00; color: #b00; }
  .sheet { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6mm; padding: 0 10mm 10mm; }
  .sticker { margin: 0; border: 1px dashed #999; padding: 5mm; display: grid; justify-items: center; gap: 3mm; break-inside: avoid; }
  .qr svg { width: 42mm; height: 42mm; display: block; }
  figcaption { display: grid; justify-items: center; gap: 1mm; text-align: center; }
  figcaption b { font: 400 30px Georgia, serif; }
  figcaption span { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; }
  figcaption small { font-size: 9px; color: #555; }
  @media print { header, .warn { display: none; } .sticker { border-color: #ccc; } }
</style></head><body>
<header><h1>${escapeHtml(lib.name)}: ${stickers.length} seat stickers</h1>
<button onclick="print()">Print or save as PDF</button></header>${warning}
<main class="sheet">${stickers.join("")}</main></body></html>`);
  });
}

module.exports = { mountStaff, seatLink };
