"use strict";

const crypto = require("crypto");
const QRCode = require("qrcode");
const { store } = require("./store");
const { getLibrary, isActiveLibrary } = require("./libraries");
const { getSeatIds, getLayout } = require("./seats");
const { getSeats, getSeat, saveSeat, resetToAvailable, SeatState, creditSessionDay } = require("./scan");
const { recordSitting } = require("./history");
const { listItems, staffThread, staffRemove } = require("./lostfound");
const { seatCode, seatCodesRequired } = require("./seatcode");
const { openStatus, closingGraceMinutes, closingSoon } = require("./hours");
const busy = require("./busy");
const usage = require("./usage");
const { limit } = require("./ratelimit");
const waitlist = require("./waitlist");
const { withLock, seatLock } = require("./lock");
const { closingNoticeKey } = require("./reminders");
const notices = require("./notices");
const push = require("./push");
const rooms = require("./rooms");

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
    if (i > -1 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; } // a mangled cookie is just "not signed in"
    }
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

/** "15:00" plus some minutes, as "15:05". */
function hhmmPlus(time, minutes) {
  const [h, m] = String(time).split(":").map(Number);
  const t = h * 60 + m + minutes;
  return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/** Sends a notification to everyone holding a seat now; body(seat) gives the text. Returns how many were sent. */
async function tellHolders(libId, body, { closingDate = null } = {}) {
  const seats = await getSeats(libId, getSeatIds(libId));
  let sent = 0;
  for (const seat of seats.filter((x) => x.state !== SeatState.AVAILABLE && x.holderToken)) {
    // Told about closing already: no second notice 10 minutes before (reminders.js).
    if (closingDate) {
      await withLock(seatLock(libId), async () => {
        const fresh = await getSeat(libId, seat.id);
        if (fresh.holderToken !== seat.holderToken) return;
        fresh.closingNoticeFor = closingNoticeKey(closingDate.date, closingDate.time, fresh.sessionStart);
        await saveSeat(fresh);
      });
    }
    const r = await push.sendPush(seat.holderToken, {
      title: getLibrary(libId).name,
      body: body(seat),
      url: `/seat.html?lib=${encodeURIComponent(libId)}&seat=${encodeURIComponent(seat.id)}`,
      tag: `notice-${libId}`,
    }, { ttlSeconds: 30 * 60 });
    if (r.sent) sent++;
  }
  return sent;
}

const escapeHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function mountStaff(app, { siteOrigin }) {
  mountPoster(app, { siteOrigin });
  app.post("/api/staff/login", limit("staffLogin"), (req, res) => {
    if (!password()) return res.status(503).json({ ok: false, reason: "staff_disabled" });
    const given = req.body && req.body.password;
    if (typeof given !== "string" || !sameText(given, password())) {
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
      hours: openStatus(notices.libraryHours(libId)),
      usualHours: openStatus((layout && layout.hours) || null),
      notices: notices.publicNotices(libId),
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

  // --- Announcements and closing early (notices.js) ------------------------
  // Body: { lib, text, days, tell } — days 0 is "until the end of today";
  // tell also sends it to everyone holding a seat right now.
  app.post("/api/staff/notice", requireStaff, async (req, res) => {
    const libId = libraryFrom(req);
    if (!libId) return res.status(404).json({ ok: false, reason: "unknown_library" });
    const { text, days, tell } = req.body || {};
    const r = await notices.setNotice(libId, { text, days });
    if (!r.ok) return res.status(400).json(r);
    const told = tell ? await tellHolders(libId, () => r.notice.text) : 0;
    res.json({ ...r, told });
  });

  app.post("/api/staff/notice/clear", requireStaff, async (req, res) => {
    const libId = libraryFrom(req);
    if (!libId) return res.status(404).json({ ok: false, reason: "unknown_library" });
    res.json(await notices.clearNotice(libId));
  });

  // Body: { lib, time: "15:00", reason, tell } — today only.
  app.post("/api/staff/earlyclose", requireStaff, async (req, res) => {
    const libId = libraryFrom(req);
    if (!libId) return res.status(404).json({ ok: false, reason: "unknown_library" });
    const { time, reason, tell } = req.body || {};
    const r = await notices.setEarlyClose(libId, { time, reason });
    if (!r.ok) return res.status(400).json(r);
    const e = r.earlyClose;
    const release = hhmmPlus(e.time, closingGraceMinutes());
    // Closing within 10 minutes (or "now"): the usual 10-minute notice may
    // already have been missed, so everyone holding a seat is told now
    // whatever the box says, and this counts as that notice.
    const soon = (closingSoon(notices.libraryHours(libId)) || {}).minutes <= 10;
    const told = tell || soon
      ? await tellHolders(libId, (seat) => `The library closes early today at ${e.time}${e.reason ? ` (${e.reason})` : ""}. Seat ${seat.id} is released at ${release}.`,
        { closingDate: soon ? { date: e.date, time: e.time } : null })
      : 0;
    res.json({ ...r, told });
  });

  app.post("/api/staff/earlyclose/clear", requireStaff, async (req, res) => {
    const libId = libraryFrom(req);
    if (!libId) return res.status(404).json({ ok: false, reason: "unknown_library" });
    res.json(await notices.clearEarlyClose(libId));
  });

  // A seat someone forgot to release (or left their things on).
  app.post("/api/staff/seat/:id/free", requireStaff, async (req, res) => {
    const libId = libraryFrom(req);
    if (!libId || !getSeatIds(libId).includes(req.params.id)) return res.status(404).json({ ok: false, reason: "unknown_seat" });
    const freed = await withLock(seatLock(libId), async () => {
      const seat = await getSeat(libId, req.params.id);
      if (seat.state === SeatState.AVAILABLE) return false;
      const now = Date.now();
      await recordSitting(libId, seat, now);
      // A real sitting still earns its day (15 minutes or more).
      if (seat.holderToken && seat.sessionStart && now - seat.sessionStart >= 15 * 60 * 1000) {
        await creditSessionDay(libId, seat.holderToken, seat.holderNickname, seat.id, seat.sessionStart);
      }
      resetToAvailable(seat);
      await saveSeat(seat);
      return true;
    });
    if (freed) waitlist.announceFreed(libId, [req.params.id]);
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

  // Discussion rooms: a day's bookings with who made them, and taking one off.
  app.get("/api/staff/rooms", requireStaff, async (req, res) => {
    const libId = libraryFrom(req);
    if (!libId) return res.status(404).json({ ok: false, reason: "unknown_library" });
    res.set("Cache-Control", "no-store").json(await rooms.staffDay(libId, String(req.query.date || "")));
  });

  app.post("/api/staff/rooms/cancel", requireStaff, async (req, res) => {
    const libId = libraryFrom(req);
    if (!libId) return res.status(404).json({ ok: false, reason: "unknown_library" });
    const r = await rooms.staffCancel(libId, String((req.body || {}).id || ""));
    res.status(r.ok ? 200 : 404).json(r);
  });

  // A sign for each discussion room's door, one per A4 page. Signed like the seat stickers.
  app.get("/staff/door-signs", async (req, res) => {
    if (!password() || !signedIn(req)) return res.redirect(302, "/staff.html");
    const libId = libraryFrom(req);
    if (!libId) return res.status(404).send("Unknown library");
    res.set("Cache-Control", "no-store").type("html").send(await doorSigns(siteOrigin(req), libId, getLibrary(libId)));
  });

  // Every seat's sticker on A4, ready to print (or save as a PDF). Made here
  // because the codes need SEAT_SIGNING_SECRET, which only the server knows.
  app.get("/staff/stickers", async (req, res) => {
    if (!password() || !signedIn(req)) return res.redirect(302, "/staff.html");
    const libId = libraryFrom(req);
    if (!libId) return res.status(404).send("Unknown library");
    const origin = siteOrigin(req);
    const lib = getLibrary(libId);
    if (req.query.size === "a4") return res.set("Cache-Control", "no-store").type("html").send(await seatSheets(origin, libId, lib));
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
  /* On a phone, one sticker per row to look at; print still lays out three to a page. */
  @media screen and (max-width: 560px) { .sheet { grid-template-columns: 1fr; padding: 0 16px 16px; } header { padding: 16px; } }
</style></head><body>
<header><h1>${escapeHtml(lib.name)}: ${stickers.length} seat stickers</h1>
<button onclick="print()">Print or save as PDF</button></header>${warning}
<main class="sheet">${stickers.join("")}</main></body></html>`);
  });
}

/**
 * One seat to an A4 page: a large signed QR code, the seat and its area,
 * for a desk sign or a frame. The same look as the launch poster.
 */
async function seatSheets(origin, libId, lib) {
  const zoneNames = (getLayout(libId) || {}).zoneNames || {};
  const seatIds = getSeatIds(libId);
  const pages = await Promise.all(seatIds.map(async (seatId) => sheetPage(lib, {
    link: seatLink(origin, libId, seatId),
    label: "Seat",
    name: seatId,
    area: zoneNames[waitlist.seatArea(seatId)],
    cta: "Scan to check in",
    steps: [
      ["Scan", "Open your camera, point it at the code, tap Check in."],
      ["Stay", "Tap Still here when asked. Step away for up to 1 h 15 min."],
      ["Leave", "Tap Check out, so the next person can sit down."],
    ],
    foot: ["No app, no sign-up", `Seat ${seatId}`],
  })));
  return a4Sheets(lib, { title: "Seat QR codes, A4", bar: `${seatIds.length} seats · one per A4 page`, pages });
}

/** The link on a discussion room's door: the rooms page, with the door's signed code. */
function roomDoorLink(origin, libraryId, roomId) {
  const q = new URLSearchParams();
  if (libraryId !== "engineering") q.set("lib", libraryId);
  q.set("room", roomId);
  const code = seatCode(libraryId, `room:${roomId}`);
  if (code) q.set("k", code);
  return `${origin}/rooms.html?${q}`;
}

/** One A4 sign per discussion room, for its door. */
async function doorSigns(origin, libId, lib) {
  const list = rooms.bookableRooms(libId);
  const pages = await Promise.all(list.map((r) => sheetPage(lib, {
    link: roomDoorLink(origin, libId, r.id),
    label: "Discussion room",
    name: r.label,
    cta: "Scan when you arrive",
    steps: [
      ["Book", "Up to two hours a day, a week ahead, on the Rooms page."],
      ["Scan", "From 10 minutes before to 15 after the start, or it's released."],
      ["Free now?", "Scan to take it on the spot. Leaving early? Tap Leave."],
    ],
    foot: ["No app, no sign-up", r.label],
    small: true,
  })));
  return a4Sheets(lib, { title: "Discussion room door signs", bar: `${list.length} rooms · one per A4 page`, pages });
}

/** One sign's page: the big name, its QR code, three steps. */
async function sheetPage(lib, { link, label, name, area, cta, steps, foot, small = false }) {
  const qr = await QRCode.toString(link, { type: "svg", margin: 0, errorCorrectionLevel: "Q", color: { dark: "#121614", light: "#0000" } });
  return `<article class="page">
  <div class="top"><span class="mark"><img src="/icons/favicon.svg" alt="">NaviSpace</span><span class="where">${escapeHtml(lib.name)}<br>Wits University</span></div>
  <div class="seat${small ? " long" : ""}"><span class="label">${escapeHtml(label)}</span><b>${escapeHtml(name)}</b>${area ? `<span class="area">${escapeHtml(area)}</span>` : ""}</div>
  <div class="qr">${qr}</div>
  <p class="cta">${escapeHtml(cta)}</p>
  <section class="steps">
${steps.map(([h, p], i) => `    <div class="step"><span class="n">0${i + 1}</span><h2>${escapeHtml(h)}</h2><p>${escapeHtml(p)}</p></div>`).join("\n")}
  </section>
  <div class="foot"><span>${escapeHtml(foot[0])}</span><span>${escapeHtml(foot[1])}</span></div>
</article>`;
}

/** A printable stack of A4 signs, with a print button on screen. */
function a4Sheets(lib, { title, bar, pages }) {
  const warning = seatCodesRequired() ? "" :
    `<p class="warn">SEAT_SIGNING_SECRET isn't set on the server, so these codes aren't signed. Set it first, then print.</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)} · ${escapeHtml(lib.name)}</title>
<style>
  @font-face { font-family: "Newsreader"; src: url("/fonts/newsreader.woff2") format("woff2"); font-weight: 200 800; }
  @font-face { font-family: "Public Sans"; src: url("/fonts/public-sans.woff2") format("woff2"); font-weight: 100 900; }
  @font-face { font-family: "Plex Mono"; src: url("/fonts/ibm-plex-mono-500.woff2") format("woff2"); font-weight: 500; }
  @page { size: A4; margin: 0; }
  :root { --ink: #121614; --muted: #5b625c; --brass: #a8843f; --line: #d9d3c3; --paper: #fbf8f1; }
  * { box-sizing: border-box; }
  html { background: #e9e5da; }
  body { margin: 0; color: var(--ink); font: 400 15px/1.5 "Public Sans", system-ui, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; max-width: 210mm; margin: 0 auto; padding: 16px 0; font: 500 12px "Plex Mono", ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
  .bar button { font: inherit; letter-spacing: inherit; text-transform: inherit; padding: 10px 16px; border: 1px solid var(--ink); background: var(--ink); color: var(--paper); cursor: pointer; }
  .warn { max-width: 210mm; margin: 0 auto 16px; padding: 10px; border: 1px solid #b00; color: #b00; }
  .page { width: 210mm; height: 297mm; margin: 0 auto 24px; background: var(--paper); position: relative; overflow: hidden; padding: 18mm 18mm 14mm; display: grid; grid-template-rows: auto auto 1fr auto auto auto; justify-items: center; box-shadow: 0 10px 40px rgba(0,0,0,.12); break-after: page; }
  .page::before { content: ""; position: absolute; inset: 0 0 auto 0; height: 7mm; background: var(--ink); }
  .page::after { content: ""; position: absolute; top: 7mm; left: 0; right: 0; height: 1.2mm; background: var(--brass); }
  .top { justify-self: stretch; display: flex; justify-content: space-between; align-items: center; margin-top: 4mm; }
  .mark { display: flex; align-items: center; gap: 3mm; font: 500 15px "Plex Mono", monospace; letter-spacing: .14em; text-transform: uppercase; }
  .mark img { width: 11mm; height: 11mm; }
  .where { font: 500 11px "Plex Mono", monospace; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); text-align: right; }
  .seat { display: grid; justify-items: center; margin-top: 8mm; }
  .seat .label, .seat .area { font: 500 12px "Plex Mono", monospace; letter-spacing: .2em; text-transform: uppercase; color: var(--brass); }
  .seat .area { color: var(--muted); letter-spacing: .14em; }
  .seat b { font: 400 34mm/1 "Newsreader", Georgia, serif; letter-spacing: -0.02em; margin: 1mm 0 2mm; }
  .seat.long b { font-size: 24mm; margin: 3mm 0 3mm; }
  .qr { align-self: center; width: 118mm; height: 118mm; padding: 6mm; border: 1.4mm solid var(--ink); background: #fff; }
  .qr svg { width: 100%; height: 100%; display: block; }
  .cta { margin: 0 0 8mm; font: 400 30px/1.1 "Newsreader", Georgia, serif; }
  .steps { justify-self: stretch; display: grid; grid-template-columns: repeat(3, 1fr); border-top: 0.4mm solid var(--ink); }
  .step { padding: 4mm 5mm 0 0; }
  .step + .step { padding-left: 5mm; border-left: 0.3mm solid var(--line); }
  .step .n { font: 500 12px "Plex Mono", monospace; letter-spacing: .14em; color: var(--brass); }
  .step h2 { margin: 1mm 0 1mm; font: 400 22px/1.1 "Newsreader", Georgia, serif; }
  .step p { margin: 0; font-size: 12.5px; line-height: 1.45; color: #3a403b; }
  .foot { justify-self: stretch; display: flex; justify-content: space-between; gap: 8mm; margin-top: 7mm; padding-top: 3mm; border-top: 0.3mm solid var(--line); font: 500 10.5px/1.5 "Plex Mono", monospace; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
  @media print { html { background: none; } .bar, .warn { display: none; } .page { margin: 0; box-shadow: none; } }
  @media screen and (max-width: 820px) { .page { transform: scale(var(--fit, 1)); transform-origin: top left; margin: 0 0 calc(297mm * var(--fit, 1) - 297mm); } .bar { padding: 12px 16px; } }
</style></head><body>
<script>
  function fit() {
    const page = 210 * 96 / 25.4;
    document.documentElement.style.setProperty("--fit", Math.min(1, document.documentElement.clientWidth / (page + 40)));
  }
  fit();
  addEventListener("resize", fit);
</script>
<div class="bar"><span>${escapeHtml(bar)} · ${escapeHtml(lib.name)}</span><button onclick="print()">Print or save as PDF</button></div>${warning}
${pages.join("\n")}
</body></html>`;
}

/** "Weekdays 08:00–20:00 · Fridays until 17:00", from a plan's hours. */
function hoursLine(hours) {
  const h = hours || {};
  const plural = { Mon: "Mondays", Tue: "Tuesdays", Wed: "Wednesdays", Thu: "Thursdays", Fri: "Fridays" };
  const extra = Object.entries(h.closesOn || {})
    .filter(([day]) => plural[day])
    .map(([day, t]) => `${plural[day]} until ${t}`);
  return [`Weekdays ${h.opens || "08:00"}–${h.closes || "20:00"}`, ...extra].join(" · ");
}

/** The launch poster: entrance and front desk, A4. A QR code to the home page and three steps. */
function mountPoster(app, { siteOrigin }) {
  app.get("/staff/poster", async (req, res) => {
    if (!password() || !signedIn(req)) return res.redirect(302, "/staff.html");
    const libId = libraryFrom(req);
    if (!libId) return res.status(404).send("Unknown library");
    const lib = getLibrary(libId);
    const link = `${siteOrigin(req)}/${libId === "engineering" ? "" : `?lib=${encodeURIComponent(libId)}`}`;
    const qr = await QRCode.toString(link, { type: "svg", margin: 0, errorCorrectionLevel: "Q", color: { dark: "#121614", light: "#0000" } });
    const shown = link.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const layout = getLayout(libId) || {};
    res.set("Cache-Control", "no-store").type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Launch poster · ${escapeHtml(lib.name)}</title>
<style>
  @font-face { font-family: "Newsreader"; src: url("/fonts/newsreader.woff2") format("woff2"); font-weight: 200 800; }
  @font-face { font-family: "Newsreader"; src: url("/fonts/newsreader-italic.woff2") format("woff2"); font-style: italic; font-weight: 200 800; }
  @font-face { font-family: "Public Sans"; src: url("/fonts/public-sans.woff2") format("woff2"); font-weight: 100 900; }
  @font-face { font-family: "Plex Mono"; src: url("/fonts/ibm-plex-mono-500.woff2") format("woff2"); font-weight: 500; }
  @page { size: A4; margin: 0; }
  :root { --ink: #121614; --muted: #5b625c; --brass: #a8843f; --free: #3f8a63; --line: #d9d3c3; --paper: #fbf8f1; }
  * { box-sizing: border-box; }
  html { background: #e9e5da; }
  body { margin: 0; color: var(--ink); font: 400 15px/1.5 "Public Sans", system-ui, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; max-width: 210mm; margin: 0 auto; padding: 16px 0; font: 500 12px "Plex Mono", ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
  .bar button { font: inherit; letter-spacing: inherit; text-transform: inherit; padding: 10px 16px; border: 1px solid var(--ink); background: var(--ink); color: var(--paper); cursor: pointer; }
  .page { width: 210mm; height: 297mm; margin: 0 auto 24px; background: var(--paper); position: relative; overflow: hidden; padding: 18mm 18mm 16mm; display: grid; grid-template-rows: auto auto 1fr auto auto; box-shadow: 0 10px 40px rgba(0,0,0,.12); }
  .page::before { content: ""; position: absolute; inset: 0 0 auto 0; height: 7mm; background: var(--ink); }
  .page::after { content: ""; position: absolute; top: 7mm; left: 0; right: 0; height: 1.2mm; background: var(--brass); }
  .top { display: flex; justify-content: space-between; align-items: center; margin-top: 4mm; }
  .mark { display: flex; align-items: center; gap: 3mm; font: 500 15px "Plex Mono", monospace; letter-spacing: .14em; text-transform: uppercase; }
  .mark img { width: 11mm; height: 11mm; }
  .where { font: 500 11px "Plex Mono", monospace; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); text-align: right; }
  h1 { margin: 14mm 0 0; font: 400 25mm/0.95 "Newsreader", Georgia, serif; letter-spacing: -0.02em; }
  h1 em { font-style: italic; color: var(--brass); }
  .lede { margin: 6mm 0 0; font: 400 19px/1.4 "Newsreader", Georgia, serif; max-width: 140mm; color: #2b302c; }
  .scan { align-self: center; display: grid; grid-template-columns: 78mm 1fr; gap: 10mm; align-items: center; margin: 8mm 0; }
  .qr { width: 78mm; height: 78mm; padding: 5mm; border: 1.2mm solid var(--ink); background: #fff; position: relative; }
  .qr svg { width: 100%; height: 100%; display: block; }
  .scan-copy b { display: block; font: 400 32px/1.1 "Newsreader", Georgia, serif; }
  .scan-copy p { margin: 3mm 0 0; color: var(--muted); font-size: 15px; }
  .scan-copy .url { margin-top: 5mm; font: 500 13px "Plex Mono", monospace; color: var(--ink); word-break: break-all; }
  .free { display: inline-flex; align-items: center; gap: 2mm; margin-top: 5mm; font: 500 11px "Plex Mono", monospace; letter-spacing: .12em; text-transform: uppercase; color: var(--free); }
  .free i { width: 3mm; height: 3mm; border-radius: 50%; background: var(--free); }
  .steps { display: grid; grid-template-columns: repeat(3, 1fr); border-top: 0.4mm solid var(--ink); }
  .step { padding: 5mm 5mm 0 0; }
  .step + .step { padding-left: 5mm; border-left: 0.3mm solid var(--line); }
  .step .n { font: 500 12px "Plex Mono", monospace; letter-spacing: .14em; color: var(--brass); }
  .step h2 { margin: 2mm 0 2mm; font: 400 25px/1.1 "Newsreader", Georgia, serif; }
  .step p { margin: 0; font-size: 13.5px; line-height: 1.45; color: #3a403b; }
  .foot { display: flex; justify-content: space-between; gap: 8mm; margin-top: 9mm; padding-top: 4mm; border-top: 0.3mm solid var(--line); font: 500 10.5px/1.5 "Plex Mono", monospace; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
  @media print { html { background: none; } .bar { display: none; } .page { margin: 0; box-shadow: none; } }
  /* Phones preview the A4 page scaled to fit. The scale comes from a line of
     script (--fit): dividing a width by a length isn't CSS Firefox understands. */
  @media screen and (max-width: 820px) { .page { transform: scale(var(--fit, 1)); transform-origin: top left; margin: 0 0 calc(297mm * var(--fit, 1) - 297mm); } .bar { padding: 12px 16px; } }
</style></head><body>
<script>
  function fit() {
    const page = 210 * 96 / 25.4; // A4 width in CSS pixels
    document.documentElement.style.setProperty("--fit", Math.min(1, document.documentElement.clientWidth / (page + 40)));
  }
  fit();
  addEventListener("resize", fit);
</script>
<div class="bar"><span>Launch poster · A4 · ${escapeHtml(lib.name)}</span><button onclick="print()">Print or save as PDF</button></div>
<article class="page">
  <div class="top">
    <span class="mark"><img src="/icons/favicon.svg" alt="">NaviSpace</span>
    <span class="where">${escapeHtml(lib.name)}<br>Wits University</span>
  </div>
  <div>
    <h1>Find a seat.<br><em>Keep it.</em></h1>
    <p class="lede">See which desks are free before you walk the floor, and hold yours while you work. No app to download, no sign-up.</p>
  </div>
  <section class="scan">
    <div class="qr">${qr}</div>
    <div class="scan-copy">
      <b>Scan to see the floor, live.</b>
      <p>Open your phone's camera and point it at the code.</p>
      <span class="free"><i></i>Free seats, right now</span>
      <p class="url">${escapeHtml(shown)}</p>
    </div>
  </section>
  <section class="steps">
    <div class="step"><span class="n">01</span><h2>Scan your desk</h2><p>Every desk has its own code. Scan it and tap Check in. The seat is yours.</p></div>
    <div class="step"><span class="n">02</span><h2>Keep your seat</h2><p>Tap Still here when asked. Stepping out? Hold it for up to 1 h 15 min.</p></div>
    <div class="step"><span class="n">03</span><h2>Check out</h2><p>Leaving? Tap Check out, so the next person can sit down.</p></div>
  </section>
  <div class="foot"><span>${escapeHtml(hoursLine(layout.hours))}</span><span>Full? Tap “Notify me” for the next free seat</span></div>
</article>
</body></html>`);
  });
}

module.exports = { mountStaff, mountPoster, seatLink, roomDoorLink, hoursLine };
