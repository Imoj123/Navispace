"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createApp } = require("../src/server");
const { store } = require("../src/store");

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
    const scan = await fetch(`${base}/api/library/engineering/scan/A1`, {
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
    assert.deepEqual(held, { ok: true, libraryId: "engineering", seatId: "A1", state: "OCCUPIED" });

    const none = await (await fetch(`${base}/api/held`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "someone-else" }),
    })).json();
    assert.equal(none.seatId, null);
  });
});
