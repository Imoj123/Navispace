"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.ALWAYS_OPEN = "1";
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

const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test.beforeEach(() => { store.clear(); require("../src/ratelimit").reset(); });
test.afterEach(() => { delete process.env.STAFF_PASSWORD; delete process.env.SEAT_SIGNING_SECRET; });

test("the staff page is off until STAFF_PASSWORD is set, and needs it", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/staff/overview`)).status, 503);
    process.env.STAFF_PASSWORD = "desk-secret";
    assert.equal((await fetch(`${base}/api/staff/overview`)).status, 401);
    assert.equal((await fetch(`${base}/api/staff/login`, json({ password: "guess" }))).status, 401);
    const ok = await fetch(`${base}/api/staff/login`, json({ password: "desk-secret" }));
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get("set-cookie");
    assert.match(cookie, /^ns_staff=\d+\.[\w-]+; Path=\/; Max-Age=43200; HttpOnly; SameSite=Strict/);
    const me = await (await fetch(`${base}/api/staff/me`, { headers: { Cookie: cookie.split(";")[0] } })).json();
    assert.equal(me.signedIn, true);
    // Changing the password signs everyone out.
    process.env.STAFF_PASSWORD = "new-secret";
    assert.equal((await fetch(`${base}/api/staff/overview`, { headers: { Cookie: cookie.split(";")[0] } })).status, 401);
  });
});

test("staff see held seats, usage and every item, and can free a seat and remove an item", async () => {
  process.env.STAFF_PASSWORD = "desk-secret";
  await withServer(async (base) => {
    const login = await fetch(`${base}/api/staff/login`, json({ password: "desk-secret" }));
    const headers = { Cookie: login.headers.get("set-cookie").split(";")[0], "Content-Type": "application/json" };
    const [seat] = getSeatIds("engineering");
    await fetch(`${base}/api/library/engineering/scan/${seat}`, json({ action: "checkIn", token: "tok-s1", nickname: "Thandi" }));
    const { item } = await (await fetch(`${base}/api/library/engineering/lostfound`, json({ description: "Keys", photoDataUrl: "data:image/jpeg;base64,AAAA", token: "tok-f", nickname: "Finder" }))).json();
    await fetch(`${base}/api/library/engineering/lostfound/${item.id}/claim`, json({ token: "tok-o", nickname: "Owner", note: "Red keyring" }));
    assert.equal((await fetch(`${base}/api/library/engineering/lostfound/${item.id}/thread/report`, json({ token: "tok-x" }))).status, 403);
    assert.equal((await fetch(`${base}/api/library/engineering/lostfound/${item.id}/thread/report`, json({ token: "tok-o" }))).status, 200);

    const o = await (await fetch(`${base}/api/staff/overview?lib=engineering`, { headers })).json();
    assert.deepEqual(o.seats.map((s) => [s.id, s.nickname]), [[seat, "Thandi"]]);
    assert.equal(o.items[0].reported.by, "owner");
    assert.equal(o.items[0].claimedBy, "Owner");
    const today = o.usage.daily[o.usage.daily.length - 1];
    assert.equal(today.checkIns, 1);
    assert.equal(today.students, 1);
    assert.equal(today.posts, 1);
    assert.equal(JSON.stringify(o).includes("tok-"), false, "no device tokens");

    const thread = await (await fetch(`${base}/api/staff/lostfound/${item.id}/thread?lib=engineering`, { headers })).json();
    assert.equal(thread.messages[0].text, "Red keyring");

    await fetch(`${base}/api/staff/seat/${seat}/free`, { method: "POST", headers, body: JSON.stringify({ lib: "engineering" }) });
    await fetch(`${base}/api/staff/lostfound/${item.id}/remove`, { method: "POST", headers, body: JSON.stringify({ lib: "engineering" }) });
    const after = await (await fetch(`${base}/api/staff/overview?lib=engineering`, { headers })).json();
    assert.equal(after.seats.length, 0);
    assert.equal(after.items.length, 0);
    // The public board doesn't show who reported what.
    assert.equal((await (await fetch(`${base}/api/library/engineering/lostfound`)).json()).length, 0);
  });
});

test("stickers: signed links for every seat, only for signed-in staff", async () => {
  process.env.STAFF_PASSWORD = "desk-secret";
  process.env.SEAT_SIGNING_SECRET = "sticker-secret";
  await withServer(async (base) => {
    const out = await fetch(`${base}/staff/stickers?lib=engineering`, { redirect: "manual" });
    assert.equal(out.status, 302);
    const login = await fetch(`${base}/api/staff/login`, json({ password: "desk-secret" }));
    const res = await fetch(`${base}/staff/stickers?lib=engineering`, { headers: { Cookie: login.headers.get("set-cookie").split(";")[0] } });
    const html = await res.text();
    assert.equal(res.headers.get("x-robots-tag"), "noindex");
    assert.equal((html.match(/<figure class="sticker">/g) || []).length, getSeatIds("engineering").length);
    assert.equal(html.includes("isn't set on the server"), false);
    const { seatLink } = require("../src/staff");
    const { seatCode } = require("../src/seatcode");
    const [seat] = getSeatIds("engineering");
    assert.equal(seatLink("https://x", "engineering", seat), `https://x/seat.html?seat=${seat}&k=${seatCode("engineering", seat)}`);
  });
});
