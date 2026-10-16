"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createApp } = require("../src/server");
const { store } = require("../src/store");
const { getSeatIds } = require("../src/seats");

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test.beforeEach(() => store.clear());

test("/healthz answers without touching the store", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal((await res.json()).ok, true);
  });
});

test("manifest carries a valid handoff token into start_url, and only a valid one", async () => {
  await withServer(async (base) => {
    const token = "123e4567-e89b-12d3-a456-426614174000";
    const good = await (await fetch(`${base}/manifest.json?handoff=${token}&nick=Thandi`)).json();
    assert.equal(good.start_url, `/?handoff=${token}&nick=Thandi`);
    assert.equal(good.id, "/");

    const bad = await (await fetch(`${base}/manifest.json?handoff=not-a-token`)).json();
    assert.equal(bad.start_url, "/");
  });
});

test("manifest starts on the seat when given one, and falls back to the handoff cookie", async () => {
  await withServer(async (base) => {
    const token = "123e4567-e89b-12d3-a456-426614174000";
    const viaQuery = await (await fetch(`${base}/manifest.json?handoff=${token}&lib=engineering&seat=A2`)).json();
    assert.equal(viaQuery.start_url, `/seat.html?handoff=${token}&lib=engineering&seat=A2`);

    const cookie = encodeURIComponent(`handoff=${token}&nick=Goat&lib=engineering&seat=A2`);
    const viaCookie = await (await fetch(`${base}/manifest.json`, { headers: { Cookie: `ns_handoff=${cookie}` } })).json();
    assert.equal(viaCookie.start_url, `/seat.html?handoff=${token}&nick=Goat&lib=engineering&seat=A2`);

    const unsafeSeat = await (await fetch(`${base}/manifest.json?handoff=${token}&lib=engineering&seat=${encodeURIComponent("<x>")}`)).json();
    assert.equal(unsafeSeat.start_url, `/?handoff=${token}`);
  });
});

test("/api/held finds the seat this token holds", async () => {
  await withServer(async (base) => {
    const token = "tok-held-1";
    const seatId = getSeatIds("engineering")[0];
    const scan = await fetch(`${base}/api/library/engineering/scan/${seatId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "checkIn", token, nickname: "Ayo" }),
    });
    assert.equal(scan.status, 200);

    const held = await (await fetch(`${base}/api/held`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })).json();
    assert.equal(typeof held.sessionStart, "number");
    delete held.sessionStart;
    assert.deepEqual(held, { ok: true, libraryId: "engineering", seatId, state: "OCCUPIED", awayMs: 0, awayStart: null });

    const none = await (await fetch(`${base}/api/held`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "someone-else" }),
    })).json();
    assert.equal(none.seatId, null);
  });
});

test("engineering seats come from its floor plan, which the API serves", async () => {
  const ids = getSeatIds("engineering");
  assert.ok(ids.length >= 30, `expected the floor plan's seats, got ${ids.length}`);
  assert.equal(new Set(ids).size, ids.length, "seat ids must be unique");
  await withServer(async (base) => {
    const layout = await (await fetch(`${base}/api/library/engineering/layout`)).json();
    assert.deepEqual(layout.seats.map((s) => s.id), ids);
    assert.equal((await fetch(`${base}/api/library/commerce/layout`)).status, 404);
  });
});

test("a seat id that isn't in the library is reported, not shown as free", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/library/engineering/seat/NOT-A-SEAT`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).reason, "unknown_seat");
    const ok = await fetch(`${base}/api/library/engineering/seat/${getSeatIds("engineering")[0]}`);
    assert.equal(ok.status, 200);
  });
});

test("seat and lost & found APIs never return raw device tokens", async () => {
  await withServer(async (base) => {
    const crypto = require("crypto");
    const token = "123e4567-e89b-12d3-a456-426614174000";
    const other = "223e4567-e89b-12d3-a456-426614174000";
    const hash = (t) => crypto.createHash("sha256").update(t).digest("hex").slice(0, 16);
    const seatId = getSeatIds("engineering")[0];
    const post = (url, body) =>
      fetch(`${base}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

    const scan = await (await post(`/api/library/engineering/scan/${seatId}`, { action: "checkIn", token, nickname: "Thandi" })).json();
    assert.equal(scan.ok, true);
    assert.equal(scan.seat.holderHash, hash(token));

    const one = await (await fetch(`${base}/api/library/engineering/seat/${seatId}`)).json();
    const all = await (await fetch(`${base}/api/library/engineering/seats`)).json();
    assert.equal(one.holderHash, hash(token));
    assert.equal(all.find((s) => s.id === seatId).holderHash, hash(token));
    assert.equal(all.find((s) => s.id !== seatId).holderHash, null);

    const tiny = "data:image/jpeg;base64," + Buffer.from("x").toString("base64");
    const report = await (await post(`/api/library/engineering/lostfound`, { description: "Blue flask", photoDataUrl: tiny, token, nickname: "Thandi" })).json();
    assert.equal(report.ok, true);
    assert.equal(report.item.reporterHash, hash(token));
    const claim = await (await post(`/api/library/engineering/lostfound/${report.item.id}/claim`, { token: other, nickname: "Sipho" })).json();
    assert.equal(claim.item.claim.claimantHash, hash(other));
    const items = await (await fetch(`${base}/api/library/engineering/lostfound`)).json();

    const everything = JSON.stringify([scan, one, all, report, claim, items]);
    assert.ok(!everything.includes(token), "holder token leaked");
    assert.ok(!everything.includes(other), "claimant token leaked");
    assert.ok(!/holderToken|reporterToken|claimantToken|holderNickname/.test(everything));
  });
});

test("time stepped away is recorded so focus timers can leave it out", async () => {
  const { handleScan } = require("../src/scan");
  const id = { token: "123e4567-e89b-12d3-a456-426614174000", nickname: "Thandi" };
  const seatId = getSeatIds("engineering")[0];
  const t0 = Date.UTC(2026, 9, 15, 8, 0, 0);
  const min = 60 * 1000;

  let r = await handleScan("engineering", seatId, "checkIn", id, t0);
  assert.equal(r.seat.awayMs, 0);
  r = await handleScan("engineering", seatId, "stepAway", id, t0 + 30 * min);
  assert.equal(r.seat.awayStart, t0 + 30 * min);
  r = await handleScan("engineering", seatId, "imBack", id, t0 + 40 * min);
  assert.equal(r.seat.awayStart, null);
  assert.equal(r.seat.awayMs, 10 * min);
  r = await handleScan("engineering", seatId, "stepAway", id, t0 + 50 * min);
  r = await handleScan("engineering", seatId, "imBack", id, t0 + 55 * min);
  assert.equal(r.seat.awayMs, 15 * min);

  await withServer(async (base) => {
    const held = await (await fetch(`${base}/api/held`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: id.token }),
    })).json();
    assert.equal(held.awayMs, 15 * min);
    assert.equal(held.awayStart, null);
  });

  r = await handleScan("engineering", seatId, "leaving", id, t0 + 60 * min);
  assert.equal(r.seat.awayMs, 0);
});

test("pages stamp their stylesheet and script by version, and those can be kept for a year", async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.headers.get("cache-control"), "no-cache");
    const html = await page.text();
    const css = html.match(/\/styles\.css\?v=([a-f0-9]{10})/);
    const js = html.match(/\/client\.js\?v=([a-f0-9]{10})/);
    assert.ok(css && js, "stylesheet and script are versioned");
    const asset = await fetch(`${base}${css[0]}`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("cache-control"), /max-age=31536000, immutable/);
    assert.ok(!html.includes("fonts.googleapis.com"), "fonts are served by NaviSpace itself");


    const scenes = await (await fetch(`${base}/api/scenes`)).json();
    assert.ok(Array.isArray(scenes) && scenes.includes("koi"));
  });
});

test("with a signing secret, checking in needs the code from the seat's sticker", async () => {
  const { seatCode } = require("../src/seatcode");
  const before = process.env.SEAT_SIGNING_SECRET;
  process.env.SEAT_SIGNING_SECRET = "test-secret";
  try {
    await withServer(async (base) => {
      const [seatId, otherId] = getSeatIds("engineering");
      const token = "123e4567-e89b-12d3-a456-426614174000";
      const scan = (id, body) => fetch(`${base}/api/library/engineering/scan/${id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, nickname: "Thandi", ...body }),
      });

      const config = await (await fetch(`${base}/api/config`)).json();
      assert.equal(config.SEAT_CODE_REQUIRED, true);

      const noCode = await scan(seatId, { action: "checkIn" });
      assert.equal(noCode.status, 403);
      assert.equal((await noCode.json()).reason, "scan_required");

      const otherSeatsCode = await scan(seatId, { action: "checkIn", k: seatCode("engineering", otherId) });
      assert.equal(otherSeatsCode.status, 403, "one seat's code doesn't open another");

      const guessed = await scan(seatId, { action: "checkIn", k: "aaaaaaaaaa" });
      assert.equal(guessed.status, 403);

      const right = await scan(seatId, { action: "checkIn", k: seatCode("engineering", seatId) });
      assert.equal(right.status, 200);

      // Once seated, the holder's own actions don't need the code.
      assert.equal((await scan(seatId, { action: "stepAway" })).status, 200);
      assert.equal((await scan(seatId, { action: "imBack" })).status, 200);
      assert.equal((await scan(seatId, { action: "leaving" })).status, 200);
    });
  } finally {
    if (before === undefined) delete process.env.SEAT_SIGNING_SECRET;
    else process.env.SEAT_SIGNING_SECRET = before;
  }
});

test("without a signing secret, seat links check in as before", async () => {
  delete process.env.SEAT_SIGNING_SECRET;
  await withServer(async (base) => {
    const seatId = getSeatIds("engineering")[0];
    const res = await fetch(`${base}/api/library/engineering/scan/${seatId}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "checkIn", token: "tok-plain", nickname: "Ayo" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await (await fetch(`${base}/api/config`)).json()).SEAT_CODE_REQUIRED, false);
  });
});
