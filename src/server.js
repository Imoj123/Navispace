"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const compression = require("compression");

const config = require("./config");
const { LIBRARIES, getLibrary, isActiveLibrary } = require("./libraries");
const { getSeatIds, getZoneOrder, getLayout } = require("./seats");
const { getSeat, getSeats, handleScan, findHeldSeat } = require("./scan");
const { sweepExpiredSeats, startSweepLoop } = require("./sweep");
const { getLeaderboard } = require("./leaderboard");
const { getSittings } = require("./history");
const { openStatus } = require("./hours");
const busy = require("./busy");
const { reportSeat } = require("./reports");
const { saveSubscription, removeSubscription, sendPush, vapidPublicKey } = require("./push");
const { startReminderLoop } = require("./reminders");
const { reportItem, listItems, claimItem, resolveItem, markAtDesk, getThread, sendMessage } = require("./lostfound");
const { seatCodeValid, seatCodesRequired } = require("./seatcode");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const BASE_MANIFEST = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, "manifest.json"), "utf8"));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A device token is a bearer credential: anyone who has it can step
 * away, release or keep someone else's seat. Public responses carry a
 * short SHA-256 of it instead, which a device can compare against its
 * own token's hash without the raw value ever leaving the server. */
function tokenHash(token) {
  if (!token) return null;
  return crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 16);
}

function publicSeat(seat) {
  if (!seat) return seat;
  const { holderToken, holderNickname, ...rest } = seat;
  return { ...rest, holderHash: tokenHash(holderToken) };
}

function publicItem(item) {
  if (!item) return item;
  const { reporterToken, ...rest } = item;
  const out = { ...rest, reporterHash: tokenHash(reporterToken) };
  if (item.claim) {
    // The claim note is proof of ownership: only the finder and the
    // claimant see it, in their private thread.
    const { claimantToken, note, ...claim } = item.claim;
    out.claim = { ...claim, claimantHash: tokenHash(claimantToken) };
  }
  return out;
}

/** Every active library's { libraryId, seatIds } — what the sweep and
 * reminder loops need to check every library in one pass. */
function activeLibrarySeatGroups() {
  return LIBRARIES.filter((lib) => lib.status === "active").map((lib) => ({
    libraryId: lib.id,
    seatIds: getSeatIds(lib.id),
    hours: libraryHours(lib.id),
  }));
}

/** A library's opening hours from its plan (defaults in hours.js). */
function libraryHours(libraryId) {
  const layout = getLayout(libraryId);
  return (layout && layout.hours) || null;
}

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** Minimal Cookie header parser — the one cookie we read doesn't justify a dependency. */
function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * The web app manifest, with the installing device's identity (and the
 * seat it's on) carried in start_url. iOS gives a Home Screen app its own
 * storage, separate from Safari, so without this the installed app gets a
 * fresh token — and its push subscription is filed under a token that
 * never holds a seat, so reminders never reach it.
 *
 * The identity arrives two ways, because Safari may read the manifest
 * either when the page loads or when "Add to Home Screen" is tapped:
 * the manifest link's own query (?handoff=&nick=&lib=&seat=, set by
 * client.js once the page has an identity), or the ns_handoff cookie
 * client.js sets with the same fields (sent because the link is
 * crossorigin="use-credentials"). The installed app adopts it on launch
 * (adoptHandoffIdentity in client.js).
 */
function buildManifest(req) {
  const manifest = { ...BASE_MANIFEST, id: "/" };
  let source = req.query;
  if (!UUID_RE.test(String(source.handoff || ""))) {
    source = Object.fromEntries(new URLSearchParams(readCookie(req, "ns_handoff") || ""));
  }
  const handoff = String(source.handoff || "");
  if (!UUID_RE.test(handoff)) return manifest;

  const params = new URLSearchParams({ handoff });
  const nick = String(source.nick || "").trim().slice(0, 24);
  if (nick) params.set("nick", nick);

  // Start on the seat the student was on, so the installed app opens
  // right where "Enable seat reminders" is.
  const lib = String(source.lib || "");
  const seat = String(source.seat || "");
  if (SAFE_ID_RE.test(lib) && SAFE_ID_RE.test(seat)) {
    params.set("lib", lib);
    params.set("seat", seat);
    manifest.start_url = `/seat.html?${params}`;
  } else {
    manifest.start_url = `/?${params}`;
  }
  return manifest;
}

/* --- Fast pages --------------------------------------------------------------
 * Every page links /styles.css and /client.js. Pages are served with each of
 * those stamped ?v=<hash of its contents>, so a phone can keep the files for a
 * year and still fetch fresh ones the moment a deploy changes them. Pages
 * themselves are always revalidated, so a deploy shows up on the next load. */
const VERSIONED_ASSETS = ["/styles.css", "/client.js"];
const fileCache = new Map(); // path -> { mtimeMs, value }

function cachedByMtime(file, build) {
  const { mtimeMs } = fs.statSync(file);
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.value;
  const value = build(fs.readFileSync(file));
  fileCache.set(file, { mtimeMs, value });
  return value;
}

function assetVersion(urlPath) {
  return cachedByMtime(path.join(PUBLIC_DIR, urlPath), (buf) =>
    crypto.createHash("sha256").update(buf).digest("hex").slice(0, 10));
}

function pageWithVersions(file) {
  let html = cachedByMtime(file, (buf) => buf.toString("utf8"));
  for (const asset of VERSIONED_ASSETS) {
    html = html.split(`"${asset}"`).join(`"${asset}?v=${assetVersion(asset)}"`);
  }
  return html;
}

/** Focus-mode scenes whose clip is deployed (public/media/<key>.mp4). */
function availableScenes() {
  try {
    return fs.readdirSync(path.join(PUBLIC_DIR, "media"))
      .filter((f) => f.endsWith(".mp4"))
      .map((f) => f.slice(0, -4));
  } catch {
    return [];
  }
}

function createApp() {
  const app = express();
  app.use(compression());
  app.use(express.json({ limit: "3mb" })); // lost & found photos ride in the JSON body

  // Uptime pings (cron-job.org / UptimeRobot) hit this to keep the
  // instance awake: cheap, touches no store, never cached.
  app.get("/healthz", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ ok: true, uptime: Math.round(process.uptime()) });
  });

  // The web app manifest, with the installing device's identity carried
  // in start_url. iOS gives a Home Screen app its own storage, separate
  // from Safari, so without this the installed app gets a fresh token —
  // and its push subscription is filed under a token that never holds a
  // seat, so reminders never reach it. client.js points the manifest
  // link here with ?handoff=<token>&nick=<nickname>; the installed app
  // adopts them on launch (see adoptHandoffIdentity in client.js).
  app.get("/manifest.json", (req, res) => {
    res.set("Cache-Control", "no-store")
      .type("application/manifest+json")
      .send(JSON.stringify(buildManifest(req)));
  });

  // --- Search engines ---------------------------------------------------------
  // Only the home page and the map are meant to appear in search results; the
  // other pages carry <meta name="robots" content="noindex">, and data and
  // media say the same in a header. Crawlers may still fetch everything, so
  // the indexed pages render fully and the noindex tags are seen.
  const siteOrigin = (req) => `${req.get("x-forwarded-proto") || req.protocol}://${req.get("host")}`;
  const INDEXED_PAGES = ["/", "/library.html"];

  app.get("/robots.txt", (req, res) => {
    res.type("text/plain").send(`User-agent: *\nAllow: /\n\nSitemap: ${siteOrigin(req)}/sitemap.xml\n`);
  });

  app.get("/sitemap.xml", (req, res) => {
    const urls = INDEXED_PAGES.map((p) => `  <url><loc>${siteOrigin(req)}${p}</loc></url>`).join("\n");
    res.type("application/xml").send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  });

  app.use(["/api", "/media"], (_req, res, next) => {
    res.set("X-Robots-Tag", "noindex");
    next();
  });

  // Pages, with their stylesheet and script stamped by version.
  app.get(/^\/(?:[\w-]+\.html)?$/, (req, res, next) => {
    const name = req.path === "/" ? "index.html" : req.path.slice(1);
    const file = path.join(PUBLIC_DIR, name);
    if (!fs.existsSync(file)) return next();
    // Canonical links must be absolute; the pages say where, the server says which host.
    const html = pageWithVersions(file).replace('<link rel="canonical" href="/', `<link rel="canonical" href="${siteOrigin(req)}/`);
    res.set("Cache-Control", "no-cache").type("html").send(html);
  });

  // How long a phone may keep each kind of file without asking again.
  app.use((req, res, next) => {
    if (req.query.v || req.path.startsWith("/fonts/")) {
      res.set("Cache-Control", "public, max-age=31536000, immutable");
    } else if (req.path.startsWith("/icons/") || req.path.startsWith("/media/")) {
      res.set("Cache-Control", "public, max-age=86400");
    }
    next();
  });

  app.use(express.static(PUBLIC_DIR));

  app.get("/api/scenes", (_req, res) => {
    res.set("Cache-Control", "no-cache").json(availableScenes());
  });

  // --- Libraries ---------------------------------------------------------

  app.get("/api/libraries", (_req, res) => {
    res.json(
      LIBRARIES.map((lib) => ({
        id: lib.id,
        name: lib.name,
        status: lib.status,
        seatCount: lib.status === "active" ? getSeatIds(lib.id).length : 0,
        zoneOrder: lib.status === "active" ? getZoneOrder(lib.id) : null,
        hasLayout: Boolean(getLayout(lib.id)),
      }))
    );
  });

  // --- Floor plan -----------------------------------------------------------

  app.get("/api/library/:libId/layout", (req, res) => {
    const layout = getLayout(req.params.libId);
    if (!layout) return res.status(404).json({ ok: false, reason: "no_layout" });
    res.json(layout);
  });

  // Opening hours right now, and the busiest stretch of the day: learned
  // from how full the library really is once there's enough data, the
  // plan's own estimate until then.
  app.get("/api/library/:libId/hours", async (req, res) => {
    const { libId } = req.params;
    if (!getLibrary(libId)) {
      return res.status(404).json({ ok: false, reason: "unknown_library" });
    }
    const hours = libraryHours(libId);
    const learned = await busy.busiestWindow(libId, hours);
    res.set("Cache-Control", "no-cache").json({
      ...openStatus(hours),
      busiest: learned || (hours && hours.busiest) || null,
      busiestLearned: Boolean(learned),
    });
  });

  // --- Seat state ----------------------------------------------------------

  app.get("/api/library/:libId/seat/:id", async (req, res) => {
    const { libId } = req.params;
    if (!getLibrary(libId)) {
      return res.status(404).json({ ok: false, reason: "unknown_library" });
    }
    // An id that isn't one of this library's seats (an old QR code, a
    // typo) is reported as such, rather than as a free seat.
    if (!getSeatIds(libId).includes(req.params.id)) {
      return res.status(404).json({ ok: false, reason: "unknown_seat" });
    }
    const seat = await getSeat(libId, req.params.id);
    res.json(publicSeat(seat));
  });

  app.get("/api/library/:libId/seats", async (req, res) => {
    const { libId } = req.params;
    if (!getLibrary(libId)) {
      return res.status(404).json({ ok: false, reason: "unknown_library" });
    }
    res.json((await getSeats(libId, getSeatIds(libId))).map(publicSeat));
  });

  // --- Scan actions ----------------------------------------------------------
  // Body: { action, token, nickname }

  app.post("/api/library/:libId/scan/:id", async (req, res) => {
    const { libId } = req.params;
    const { action, token, nickname, k } = req.body || {};

    if (!isActiveLibrary(libId)) {
      return res.status(404).json({ ok: false, reason: "library_not_active" });
    }
    const seatIds = getSeatIds(libId);
    if (!seatIds.includes(req.params.id)) {
      return res.status(404).json({ ok: false, reason: "unknown_seat" });
    }
    if (!token || !nickname) {
      return res.status(400).json({ ok: false, reason: "missing_identity" });
    }
    // Claiming a seat needs the code from its sticker (see seatcode.js).
    // Everything after that is limited to the device holding the seat.
    // Outside opening hours nobody can take a seat (and the sweep frees
    // every seat at closing time).
    if (action === "checkIn") {
      const hours = openStatus(libraryHours(libId));
      if (!hours.open) {
        const seat = await getSeat(libId, req.params.id);
        return res.status(403).json({ ok: false, reason: "library_closed", hours, seat: publicSeat(seat) });
      }
    }
    if (action === "checkIn" && !seatCodeValid(libId, req.params.id, k)) {
      const seat = await getSeat(libId, req.params.id);
      return res.status(403).json({ ok: false, reason: "scan_required", seat: publicSeat(seat) });
    }

    const result = await handleScan(
      libId,
      req.params.id,
      action,
      { token, nickname },
      Date.now(),
      seatIds
    );

    if (result.seat) result.seat = publicSeat(result.seat);
    res.status(result.ok ? 200 : 409).json(result);
  });

  // --- Crowdsourced correction -----------------------------------------------
  // Body: { token } — same device identity used for scans.

  app.post("/api/library/:libId/report/:id", async (req, res) => {
    const { libId } = req.params;
    const { token } = req.body || {};

    if (!isActiveLibrary(libId) || !getSeatIds(libId).includes(req.params.id)) {
      return res.status(404).json({ ok: false, reason: "unknown_seat" });
    }
    if (!token) {
      return res.status(400).json({ ok: false, reason: "missing_identity" });
    }

    const result = await reportSeat(libId, req.params.id, token);
    res.json({ ok: true, ...result });
  });

  // --- Leaderboard -------------------------------------------------------

  app.get("/api/library/:libId/leaderboard", async (req, res) => {
    const { libId } = req.params;
    if (!getLibrary(libId)) {
      return res.status(404).json({ ok: false, reason: "unknown_library" });
    }
    const entries = await getLeaderboard(libId, 10);
    res.json(entries);
  });

  // --- Manual sweep trigger (handy for testing without waiting) -------------

  app.post("/api/library/:libId/sweep", async (req, res) => {
    const { libId } = req.params;
    const reclaimed = await sweepExpiredSeats(libId, getSeatIds(libId), Date.now(), { hours: libraryHours(libId) });
    res.json({ reclaimed });
  });

  // --- Lost & Found --------------------------------------------------------
  // Body (report): { description, location, photoDataUrl, token, nickname }

  app.get("/api/library/:libId/lostfound", async (req, res) => {
    const { libId } = req.params;
    if (!getLibrary(libId)) {
      return res.status(404).json({ ok: false, reason: "unknown_library" });
    }
    const items = await listItems(libId);
    res.json(items.map(publicItem));
  });

  app.post("/api/library/:libId/lostfound", async (req, res) => {
    const { libId } = req.params;
    if (!isActiveLibrary(libId)) {
      return res.status(404).json({ ok: false, reason: "library_not_active" });
    }
    const { description, location, photoDataUrl, token, nickname } = req.body || {};
    const result = await reportItem(libId, {
      description,
      location,
      photoDataUrl,
      reporterToken: token,
      reporterNickname: nickname,
    });
    if (result.item) result.item = publicItem(result.item);
    res.status(result.ok ? 200 : 400).json(result);
  });

  // Body: { token, nickname, note }
  app.post("/api/library/:libId/lostfound/:itemId/claim", async (req, res) => {
    const { libId, itemId } = req.params;
    const { token, nickname, note } = req.body || {};
    if (!token) {
      return res.status(400).json({ ok: false, reason: "missing_identity" });
    }
    const result = await claimItem(libId, itemId, {
      claimantToken: token,
      claimantNickname: nickname,
      note,
    });
    if (result.item) result.item = publicItem(result.item);
    res.status(result.ok ? 200 : 409).json(result);
  });

  // Body: { token } — must be the original reporter's device.
  app.post("/api/library/:libId/lostfound/:itemId/resolve", async (req, res) => {
    const { libId, itemId } = req.params;
    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ ok: false, reason: "missing_identity" });
    }
    const result = await resolveItem(libId, itemId, token);
    res.status(result.ok ? 200 : 403).json(result);
  });

  // Body: { token } — the finder handed the item to the front desk.
  app.post("/api/library/:libId/lostfound/:itemId/desk", async (req, res) => {
    const { libId, itemId } = req.params;
    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ ok: false, reason: "missing_identity" });
    }
    const result = await markAtDesk(libId, itemId, token);
    if (result.item) result.item = publicItem(result.item);
    res.status(result.ok ? 200 : result.reason === "not_found" ? 404 : 403).json(result);
  });

  // Body: { token } — the private thread between finder and claimant.
  // POST so the token never sits in a URL or a log.
  app.post("/api/library/:libId/lostfound/:itemId/thread", async (req, res) => {
    const { libId, itemId } = req.params;
    const result = await getThread(libId, itemId, (req.body || {}).token);
    res.set("Cache-Control", "no-store").status(result.ok ? 200 : result.reason === "not_found" ? 404 : 403).json(result);
  });

  // Body: { token, text } — adds a message and notifies the other person.
  app.post("/api/library/:libId/lostfound/:itemId/thread/send", async (req, res) => {
    const { libId, itemId } = req.params;
    const { token, text } = req.body || {};
    const result = await sendMessage(libId, itemId, token, text);
    if (!result.ok) {
      const status = { not_found: 404, not_allowed: 403 }[result.reason] || 400;
      return res.status(status).json(result);
    }
    // A notification for the other person, if they've turned them on.
    sendPush(result.recipientToken, {
      title: `${result.senderNickname} · ${result.item.description}`.slice(0, 80),
      body: result.message.text,
      url: `/lost-found.html?lib=${encodeURIComponent(libId)}&thread=${encodeURIComponent(itemId)}`,
      tag: `navispace-lf-${itemId}`,
    }, { ttlSeconds: 12 * 60 * 60 }).catch(() => { }); // still worth seeing hours later
    res.json({ ok: true, message: result.message });
  });

  // --- Web Push subscriptions ------------------------------------------------
  // Body: { token, subscription } — subscription is the PushSubscription
  // object the browser's PushManager.subscribe() returns.

  app.post("/api/push/subscribe", async (req, res) => {
    const { token, subscription, quiet } = req.body || {};
    if (!token || !subscription) {
      return res.status(400).json({ ok: false, reason: "missing_fields" });
    }
    await saveSubscription(token, subscription);
    // A quiet re-sync (the page refreshing an existing permission) skips the test.
    if (quiet) return res.json({ ok: true, testSent: false, testReason: "quiet" });
    // Send one right away so the student sees reminders work end to end
    // (and a broken VAPID/push setup shows up now, not 55 minutes later).
    const test = await sendPush(token, {
      title: "NaviSpace",
      body: "Reminders are on. We'll ping you before your seat frees up.",
    });
    res.json({ ok: true, testSent: test.sent, testReason: test.reason || null });
  });

  // Body: { token } — which seat (if any) this device holds, across all
  // active libraries. Lets the home page (and the installed app, which
  // isn't opened by a QR scan) take a student straight back to it.
  app.post("/api/held", async (req, res) => {
    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ ok: false, reason: "missing_token" });
    }
    for (const { libraryId, seatIds } of activeLibrarySeatGroups()) {
      const seat = await findHeldSeat(libraryId, token, seatIds);
      if (seat) {
        return res.json({ ok: true, libraryId, seatId: seat.id, state: seat.state, sessionStart: seat.sessionStart || null, awayMs: seat.awayMs || 0, awayStart: seat.awayStart || null });
      }
    }
    res.json({ ok: true, libraryId: null, seatId: null });
  });

  // Body: { token } — this device's sittings over the last few weeks, for
  // "Your week" on the home page. The page buckets them into its own local
  // days, so the server needs no idea of the student's time zone.
  app.post("/api/me/sittings", async (req, res) => {
    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ ok: false, reason: "missing_token" });
    }
    const sittings = await getSittings(token);
    res.json({ ok: true, now: Date.now(), sittings: sittings.map(({ seat, start, end, ms }) => ({ seat, start, end, ms })) });
  });

  app.post("/api/push/unsubscribe", async (req, res) => {
    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ ok: false, reason: "missing_token" });
    }
    await removeSubscription(token);
    res.json({ ok: true });
  });

  // --- Client-facing config (kept in sync with config.js so the UI ----
  // --- never hardcodes a second copy of these numbers) -----------------

  app.get("/api/config", (_req, res) => {
    res.json({
      STALENESS_HIGH_MAX: config.STALENESS_HIGH_MAX,
      STALENESS_MEDIUM_MAX: config.STALENESS_MEDIUM_MAX,
      REPORT_THRESHOLD: config.REPORT_THRESHOLD,
      CHECK_IN_DURATION_MS: config.CHECK_IN_DURATION_MS,
      VAPID_PUBLIC_KEY: vapidPublicKey(),
      SEAT_CODE_REQUIRED: seatCodesRequired(),
    });
  });

  // Anything else: data requests get JSON, people get the not-found page.
  app.use((req, res) => {
    if (req.path.startsWith("/api/")) return res.status(404).json({ ok: false, reason: "not_found" });
    res.status(404).set("Cache-Control", "no-cache").type("html")
      .send(pageWithVersions(path.join(PUBLIC_DIR, "404.html")));
  });

  return app;
}

function start() {
  // Last line of defence: a stray rejected promise is logged, not fatal.
  // (Node exits on an unhandled rejection by default — on Render that
  // reads as "Service Unavailable" until the next restart.)
  process.on("unhandledRejection", (err) => {
    console.error("[server] unhandled rejection:", err && err.message ? err.message : err);
  });

  const app = createApp();
  // Surfaces a missing or malformed VAPID setup in the logs at boot,
  // rather than at the first reminder.
  require("./push").ensureConfigured();

  const stopSweep = startSweepLoop(
    () => Promise.resolve(activeLibrarySeatGroups()),
    config.SWEEP_INTERVAL_MS,
    (libraryId, reclaimed) => {
      console.log(`[sweep] ${libraryId} reclaimed: ${reclaimed.join(", ")}`);
    },
    (libraryId, seats, now) => busy.observe(libraryId, seats, now, libraryHours(libraryId))
  );

  const stopReminders = startReminderLoop(
    () => Promise.resolve(activeLibrarySeatGroups()),
    config.REMINDER_CHECK_INTERVAL_MS,
    (libraryId, reminded) => {
      console.log(`[reminders] ${libraryId} sent: ${reminded.join(", ")}`);
    }
  );

  const server = app.listen(PORT, () => {
    console.log(`NaviSpace listening on http://localhost:${PORT}`);
  });

  const shutdown = () => {
    stopSweep();
    stopReminders();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}

module.exports = { createApp, start };

if (require.main === module) {
  start();
}
