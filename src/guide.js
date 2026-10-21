"use strict";

const QRCode = require("qrcode");
const config = require("./config");
const { getLibrary } = require("./libraries");
const { getLayout } = require("./seats");
const { hoursLine } = require("./staff");
const rooms = require("./rooms");

/**
 * The student guide (/guide): everything NaviSpace does, in plain steps.
 * Four A4 pages when printed or saved as a PDF (the launch poster's look),
 * and one readable column on a phone, so it doubles as the app's help page.
 * Open to everyone; the QR code on the cover goes to the home page.
 */
const esc = (t) => String(t == null ? "" : t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const minutes = (ms) => Math.round(ms / 60000);
const span = (ms) => {
  const m = minutes(ms), h = Math.floor(m / 60), r = m % 60;
  if (!h) return `${m} min`;
  return r ? `${h} h ${r} min` : `${h} hour${h === 1 ? "" : "s"}`;
};

// A little floor of seats, as on the home page: free ones glow.
function seatsArt() {
  const free = new Set([5, 9, 12, 16, 22, 23, 27, 31, 34, 40]);
  let out = "";
  for (let i = 0; i < 42; i++) {
    const x = (i % 7) * 13, y = Math.floor(i / 7) * 13;
    out += `<rect x="${x}" y="${y}" width="9" height="9" rx="2" class="${free.has(i) ? "f" : "t"}"/>`;
  }
  return `<svg class="art" viewBox="-2 -2 93 80" aria-hidden="true">${out}</svg>`;
}

function mountGuide(app, { siteOrigin }) {
  app.get("/guide", async (req, res) => {
    const libId = getLibrary(String(req.query.lib || "")) ? String(req.query.lib) : "engineering";
    const lib = getLibrary(libId);
    const layout = getLayout(libId) || {};
    const home = `${siteOrigin(req)}/${libId === "engineering" ? "" : `?lib=${encodeURIComponent(libId)}`}`;
    const shown = home.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const qr = await QRCode.toString(home, { type: "svg", margin: 0, errorCorrectionLevel: "Q", color: { dark: "#121614", light: "#0000" } });
    const hold = span(config.CHECK_IN_DURATION_MS);
    const away = span(config.STEP_AWAY_DURATION_MS);
    const prompt = minutes(config.STILL_HERE_PROMPT_INTERVAL_MS);
    const roomList = rooms.bookableRooms(libId);
    const roomNames = roomList.map((r) => r.label).join(", ").replace(/, ([^,]*)$/, " and $1");
    const foot = (n) => `<div class="foot"><span>NaviSpace · ${esc(lib.name)}</span><span>${esc(shown)}</span><span>${n} / 4</span></div>`;

    res.set("Cache-Control", "no-cache").type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>How NaviSpace works · ${esc(lib.name)}</title>
<meta name="description" content="A short guide to NaviSpace: finding and keeping a seat, focus sessions, your week, the study board, discussion rooms and Lost &amp; Found.">
<link rel="icon" href="/icons/favicon.svg" type="image/svg+xml">
<meta property="og:image" content="${esc(siteOrigin(req))}/icons/icon-512.png">
<style>
  @font-face { font-family: "Newsreader"; src: url("/fonts/newsreader.woff2") format("woff2"); font-weight: 200 800; }
  @font-face { font-family: "Newsreader"; src: url("/fonts/newsreader-italic.woff2") format("woff2"); font-style: italic; font-weight: 200 800; }
  @font-face { font-family: "Public Sans"; src: url("/fonts/public-sans.woff2") format("woff2"); font-weight: 100 900; }
  @font-face { font-family: "Plex Mono"; src: url("/fonts/ibm-plex-mono-500.woff2") format("woff2"); font-weight: 500; }
  @page { size: A4; margin: 0; }
  :root { --ink: #121614; --muted: #5b625c; --brass: #a8843f; --free: #3f8a63; --taken: #c0583a; --away: #b9832a; --line: #d9d3c3; --paper: #fbf8f1; --tint: #f1ece0; }
  * { box-sizing: border-box; }
  html { background: #e9e5da; }
  body { margin: 0; color: var(--ink); font: 400 14px/1.5 "Public Sans", system-ui, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; max-width: 210mm; margin: 0 auto; padding: 16px 0; font: 500 12px "Plex Mono", ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
  .bar a { color: inherit; }
  .bar button { font: inherit; letter-spacing: inherit; text-transform: inherit; padding: 10px 16px; border: 1px solid var(--ink); background: var(--ink); color: var(--paper); cursor: pointer; }
  .page { width: 210mm; height: 297mm; margin: 0 auto 24px; background: var(--paper); position: relative; overflow: hidden; padding: 20mm 18mm 14mm; display: flex; flex-direction: column; box-shadow: 0 10px 40px rgba(0,0,0,.12); break-after: page; }
  .page::before { content: ""; position: absolute; inset: 0 0 auto 0; height: 7mm; background: var(--ink); }
  .page::after { content: ""; position: absolute; top: 7mm; left: 0; right: 0; height: 1.2mm; background: var(--brass); }
  .top { display: flex; justify-content: space-between; align-items: center; margin-top: 2mm; }
  .mark { display: flex; align-items: center; gap: 3mm; font: 500 14px "Plex Mono", monospace; letter-spacing: .14em; text-transform: uppercase; }
  .mark img { width: 10mm; height: 10mm; }
  .where { font: 500 10.5px "Plex Mono", monospace; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); text-align: right; }
  .kicker { font: 500 11px "Plex Mono", monospace; letter-spacing: .18em; text-transform: uppercase; color: var(--brass); margin: 8mm 0 0; }
  h1 { margin: 3mm 0 0; font: 400 18mm/0.95 "Newsreader", Georgia, serif; letter-spacing: -0.02em; }
  h1 em, h2 em { font-style: italic; color: var(--brass); }
  h2 { margin: 2mm 0 5mm; font: 400 12mm/1 "Newsreader", Georgia, serif; letter-spacing: -0.015em; }
  .lede { margin: 5mm 0 0; font: 400 17px/1.45 "Newsreader", Georgia, serif; max-width: 150mm; color: #2b302c; }
  .grow { flex: 1; }
  .foot { display: flex; justify-content: space-between; gap: 6mm; padding-top: 3mm; border-top: 0.3mm solid var(--line); font: 500 9.5px/1.5 "Plex Mono", monospace; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin-top: 6mm; }
  /* Cover */
  .cover-mid { display: grid; grid-template-columns: 1fr 58mm; gap: 10mm; align-items: center; margin: 7mm 0 0; }
  .qr { width: 58mm; padding: 4mm; border: 1.2mm solid var(--ink); background: #fff; }
  .qr svg { width: 100%; height: auto; display: block; }
  .qr-cap { margin-top: 3mm; text-align: center; font: 500 11px "Plex Mono", monospace; letter-spacing: .06em; }
  .art { width: 100%; max-width: 64mm; display: block; }
  .art .f { fill: var(--free); }
  .art .t { fill: #d8d2c3; }
  .contents { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0 8mm; margin-top: 8mm; border-top: 0.4mm solid var(--ink); }
  .contents div { padding: 3mm 0; border-bottom: 0.3mm solid var(--line); display: grid; grid-template-columns: 9mm 1fr; }
  .contents b { font: 500 11px/1.6 "Plex Mono", monospace; color: var(--brass); }
  .contents span { font: 400 16px/1.3 "Newsreader", Georgia, serif; }
  .contents small { display: block; font: 400 12px/1.4 "Public Sans", sans-serif; color: var(--muted); }
  .home-screen { margin-top: 6mm; padding: 5mm 6mm; background: var(--tint); display: grid; grid-template-columns: 1fr 1fr; gap: 4mm 8mm; }
  .home-screen h3 { grid-column: 1 / -1; margin: 0; font: 400 19px/1.2 "Newsreader", Georgia, serif; }
  .home-screen p { margin: 0; font-size: 12.5px; color: #3a403b; }
  .home-screen b { color: var(--ink); }
  /* Steps */
  .steps { display: grid; gap: 0; border-top: 0.4mm solid var(--ink); }
  .step { display: grid; grid-template-columns: 14mm 1fr; gap: 0 4mm; padding: 4mm 0; border-bottom: 0.3mm solid var(--line); }
  .step .n { font: 400 11mm/1 "Newsreader", Georgia, serif; color: var(--brass); }
  .step h3 { margin: 0 0 1mm; font: 400 19px/1.2 "Newsreader", Georgia, serif; }
  .step p { margin: 0; font-size: 13px; color: #3a403b; }
  .step p + p { margin-top: 1.5mm; }
  .tap { display: inline-block; padding: 0 2mm; border: 0.3mm solid var(--ink); font: 500 10.5px/1.7 "Plex Mono", monospace; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; }
  .chips { display: flex; flex-wrap: wrap; gap: 2mm 5mm; margin-top: 2mm; font: 500 10.5px "Plex Mono", monospace; letter-spacing: .08em; text-transform: uppercase; }
  .chips span { display: inline-flex; align-items: center; gap: 1.6mm; }
  .chips i { width: 3mm; height: 3mm; border-radius: 50%; }
  .tips { display: grid; grid-template-columns: 1fr 1fr; gap: 5mm; margin-top: 6mm; }
  .tip { padding: 4.5mm 5mm; background: var(--tint); }
  .tip h4 { margin: 0 0 1.5mm; font: 500 11px "Plex Mono", monospace; letter-spacing: .1em; text-transform: uppercase; color: var(--brass); }
  .tip p { margin: 0; font-size: 12.5px; color: #3a403b; }
  /* Features */
  .feature { display: grid; grid-template-columns: 34mm 1fr; gap: 6mm; padding: 5mm 0; border-bottom: 0.3mm solid var(--line); }
  .feature:first-of-type { border-top: 0.4mm solid var(--ink); }
  .feature .label { font: 500 10.5px/1.5 "Plex Mono", monospace; letter-spacing: .12em; text-transform: uppercase; color: var(--brass); }
  .feature .label b { display: block; font: 400 21px/1.15 "Newsreader", Georgia, serif; letter-spacing: 0; text-transform: none; color: var(--ink); margin-top: 1mm; }
  .feature p { margin: 0; font-size: 13px; color: #3a403b; }
  .feature p + p, .feature ul { margin-top: 2mm; }
  .feature ul { padding-left: 4.5mm; margin-bottom: 0; font-size: 13px; color: #3a403b; }
  .feature li + li { margin-top: 1mm; }
  .faq { display: grid; grid-template-columns: 1fr 1fr; gap: 4mm 8mm; margin-top: 6mm; }
  .faq h4 { margin: 0 0 1mm; font: 400 16px/1.25 "Newsreader", Georgia, serif; }
  .faq p { margin: 0; font-size: 12px; color: #3a403b; }
  @media print { html { background: none; } .bar { display: none; } .page { margin: 0; box-shadow: none; } }
  /* On a phone: one readable column instead of a shrunk sheet of paper. */
  @media screen and (max-width: 820px) {
    .bar { padding: 12px 16px; }
    .page { width: auto; height: auto; overflow: visible; margin: 0 0 12px; padding: 34px 20px 22px; box-shadow: none; }
    h1 { font-size: 54px; }
    h2 { font-size: 38px; }
    .cover-mid, .contents, .home-screen, .tips, .faq { grid-template-columns: 1fr; }
    .cover-mid { display: none; } /* you're already in NaviSpace: no code to scan */
    .feature { grid-template-columns: 1fr; gap: 2mm; }
    .foot span:nth-child(2) { display: none; }
  }
</style></head><body>
<script>try { localStorage.setItem("navispace_guide_seen", "1"); } catch { }</script>
<div class="bar"><a href="/">← NaviSpace</a><button onclick="print()">Print or save as PDF</button></div>

<article class="page">
  <div class="top"><span class="mark"><img src="/icons/favicon.svg" alt="">NaviSpace</span><span class="where">${esc(lib.name)}<br>Wits University</span></div>
  <p class="kicker">The student guide</p>
  <h1>Find a seat.<br><em>Keep it.</em></h1>
  <p class="lede">NaviSpace shows which desks in the library are free right now, holds yours while you study, and helps you get more out of every sitting. It runs in your phone's browser: no app to download, no sign-up.</p>
  <div class="cover-mid">
    <div>${seatsArt()}<div class="chips" style="margin-top:4mm"><span><i style="background:var(--free)"></i>Free</span><span><i style="background:#cfc8b8"></i>Taken</span></div></div>
    <div><div class="qr">${qr}</div><p class="qr-cap">Scan to open NaviSpace</p></div>
  </div>
  <div class="contents">
    <div><b>02</b><span>Get a seat<small>Find, check in, keep it, step away, check out</small></span></div>
    <div><b>03</b><span>Study better<small>Focus sessions, your week, the study board</small></span></div>
    <div><b>04</b><span>Rooms and more<small>Discussion rooms, Lost &amp; Found, notifications</small></span></div>
    <div><b>04</b><span>Quick answers<small>When something doesn't work</small></span></div>
  </div>
  <div class="home-screen">
    <h3>Keep it one tap away: add it to your Home Screen</h3>
    <p><b>iPhone (Safari):</b> open the link, tap <b>Share</b>, then <b>Add to Home Screen</b>. Open NaviSpace from the new icon; only that way can an iPhone get reminders.</p>
    <p><b>Android (Chrome):</b> open the link, tap <b>⋮</b>, then <b>Add to Home screen</b> (or accept the prompt).</p>
  </div>
  <div class="grow"></div>
  ${foot(1)}
</article>

<article class="page">
  <div class="top"><span class="mark"><img src="/icons/favicon.svg" alt="">NaviSpace</span><span class="where">Get a seat</span></div>
  <p class="kicker">Five steps</p>
  <h2>Get a seat, <em>keep it.</em></h2>
  <div class="steps">
    <div class="step"><span class="n">1</span><div><h3>Find a free seat</h3>
      <p>Open <span class="tap">Map</span> to see every desk, live. The home page tells you how many are free and when the library is busiest.</p>
      <div class="chips"><span><i style="background:var(--free)"></i>Free</span><span><i style="background:var(--taken)"></i>Taken</span><span><i style="background:var(--away)"></i>Stepped away, held for someone</span></div></div></div>
    <div class="step"><span class="n">2</span><div><h3>Scan the code on the desk</h3>
      <p>Every desk has its own QR code. Point your camera at it and tap <span class="tap">Check in</span>. The seat is yours for ${hold}. The first time, you'll pick a nickname (no email, no password).</p>
      <p>Only the code on the desk can check you in, so nobody can take a seat from across campus.</p></div></div>
    <div class="step"><span class="n">3</span><div><h3>Keep your seat</h3>
      <p>About every ${prompt} minutes the seat page asks <i>Still studying?</i> Tap <span class="tap">Keep going</span> and the hold starts again. With notifications on, you also get a nudge 10 and 5 minutes before it would end.</p></div></div>
    <div class="step"><span class="n">4</span><div><h3>Step away without losing it</h3>
      <p>Off to a lecture or for coffee? Tap <span class="tap">Step away</span>: the seat is held for you for ${away}. When you're back, tap <span class="tap">I'm back</span>.</p></div></div>
    <div class="step"><span class="n">5</span><div><h3>Check out when you leave</h3>
      <p>Tap <span class="tap">Check out</span> so the next person can sit down. Forgot? The hold simply runs out, and every seat is released a few minutes after closing.</p></div></div>
  </div>
  <div class="tips">
    <div class="tip"><h4>Library nearly full?</h4><p>When only a few seats are left, the map and home page offer <span class="tap">Notify me</span>, for any seat or your favourite area. When one frees up you're told: whoever scans it first gets it.</p></div>
    <div class="tip"><h4>Seat looks empty but says taken?</h4><p>Scan it and tap <i>This looks wrong — report it</i>. When ${config.REPORT_THRESHOLD} people report the same seat, it's freed for everyone.</p></div>
  </div>
  <div class="grow"></div>
  ${foot(2)}
</article>

<article class="page">
  <div class="top"><span class="mark"><img src="/icons/favicon.svg" alt="">NaviSpace</span><span class="where">Study better</span></div>
  <p class="kicker">Once you're sitting down</p>
  <h2>Study <em>better.</em></h2>
  <div class="feature"><div class="label">Focus session<b>A calm timer that keeps your seat</b></div><div>
    <p>After you check in, tap <span class="tap">Start focus session</span> on the seat page (or <i>Your focus session</i> on the home page). Your phone becomes a quiet clock over real footage while NaviSpace keeps your seat.</p>
    <ul>
      <li><b>Scenes:</b> rain, ocean, night sky, a koi pond, or <i>Study with me</i>. Add gentle sound if you like.</li>
      <li><b>Two ways to time it:</b> an open session that counts up, or Pomodoro: 25 minutes of focus, 5 of rest, with a soft chime between.</li>
      <li><b>Encouragement</b> by name as you pass 15, 30, 45 and 60 minutes, and your personal best.</li>
      <li><b>It keeps the screen on</b> and asks <i>Still studying?</i> for you. <span class="tap">Step away</span> pauses everything; <span class="tap">End session</span> when you're done.</li>
    </ul></div></div>
  <div class="feature"><div class="label">Your week<b>Your own study record</b></div><div>
    <p>On the home page: the days you studied this week, your streak of days in a row, your longest sitting and your favourite seat. It's kept only for this device and nobody else sees it.</p></div></div>
  <div class="feature"><div class="label">Study board<b>A friendly weekly ranking</b></div><div>
    <p>One point for each day you study at a seat (however many seats you use that day), shown with your nickname. The board starts fresh every Monday, so anyone can top it this week.</p></div></div>
  <div class="feature"><div class="label">Busiest hours<b>Plan when to come</b></div><div>
    <p>The home page shows when the library is usually fullest (learned from how full it really gets) and the opening hours: ${esc(hoursLine(layout.hours))}.</p></div></div>
  <div class="tips" style="grid-template-columns:1fr"><div class="tip"><h4>Make it a habit</h4><p>Check in every day you study, even for a short sitting: that's what builds your streak and earns your point on the board. Pair it with a Pomodoro focus session and the hours add up.</p></div></div>
  <div class="grow"></div>
  ${foot(3)}
</article>

<article class="page">
  <div class="top"><span class="mark"><img src="/icons/favicon.svg" alt="">NaviSpace</span><span class="where">Rooms and more</span></div>
  <p class="kicker">Everything else</p>
  <h2>Rooms, lost things <em>and more.</em></h2>
  ${roomList.length ? `<div class="feature"><div class="label">Discussion rooms<b>Book a room for your group</b></div><div>
    <p>Open <span class="tap">Rooms</span> to book ${esc(roomNames)} by the hour: today or up to a week ahead, up to two hours a day. Tap a time, then the next one for two hours, then <span class="tap">Book</span>.</p>
    <p>When you arrive, <b>scan the code on the door</b> between 10 minutes before and 15 minutes after your start, or the room goes to someone else. Room free right now? Scan its door to take it on the spot. Finished early? Tap <span class="tap">Leave</span>.</p></div></div>` : ""}
  <div class="feature"><div class="label">Lost &amp; Found<b>Lost something?</b></div><div>
    <p>Found something? Post a photo and where it was. Lost something? Spot it on the board and claim it: you and the finder chat privately to arrange handing it back, or the finder hands it in at the front desk for you to collect.</p></div></div>
  <div class="feature"><div class="label">Notifications<b>Reminders that matter</b></div><div>
    <p>Turn them on from the home page (<i>Notifications</i>) for: your seat about to run out, a free seat when you asked to be told, your room booking, and replies about a lost item. Each device is turned on separately. On iPhone, add NaviSpace to your Home Screen first.</p></div></div>
  <div class="feature"><div class="label">Your privacy<b>Only a nickname</b></div><div>
    <p>No account, no email. The Privacy page lists what's kept and for how long, and <span class="tap">Delete my data</span> removes everything NaviSpace keeps for your phone in one tap.</p></div></div>
  <h3 style="margin:7mm 0 0;font:400 22px/1.2 'Newsreader',Georgia,serif">Quick answers</h3>
  <div class="faq">
    <div><h4>“Check in” isn't there?</h4><p>Scan the code on the desk itself; a link someone sent you can show a seat but not claim it.</p></div>
    <div><h4>The page says the library is closed?</h4><p>Check-ins work during opening hours only. The page says when it opens next.</p></div>
    <div><h4>No reminders arriving?</h4><p>Turn notifications on from the home page and tap <i>Send a test</i>. On iPhone, open NaviSpace from the Home Screen icon.</p></div>
    <div><h4>Still stuck?</h4><p>Ask at the library's front desk: staff can see the floor and free a seat that was left behind.</p></div>
  </div>
  <div class="grow"></div>
  ${foot(4)}
</article>
</body></html>`);
  });
}

module.exports = { mountGuide };
