"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.ALWAYS_OPEN = "1";
const { createApp } = require("../src/server");
const { store } = require("../src/store");
const { getSeatIds } = require("../src/seats");
const push = require("../src/push");
const waitlist = require("../src/waitlist");

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
const sub = { endpoint: "https://push.example/1", keys: { p256dh: "x", auth: "y" } };
const tick = () => new Promise((r) => setTimeout(r, 30));

test.beforeEach(() => { store.clear(); require("../src/ratelimit").reset(); });

test("joining needs notifications on, a known area, and no seat already", async () => {
  await withServer(async (base) => {
    const url = `${base}/api/library/engineering/waitlist`;
    assert.equal((await (await fetch(url, json({ token: "w1" }))).json()).reason, "notifications_off");
    await fetch(`${base}/api/push/subscribe`, json({ token: "w1", subscription: sub, quiet: true }));
    assert.equal((await (await fetch(url, json({ token: "w1", area: "Q" }))).json()).reason, "unknown_area");

    const joined = await (await fetch(url, json({ token: "w1", area: "S" }))).json();
    assert.equal(joined.waiting, true);
    assert.equal(joined.area, "S");
    const status = await (await fetch(`${url}/status`, json({ token: "w1" }))).json();
    assert.equal(status.waiting, true);

    // Someone with a seat has nothing to wait for.
    const [seat] = getSeatIds("engineering");
    await fetch(`${base}/api/push/subscribe`, json({ token: "w2", subscription: sub, quiet: true }));
    await fetch(`${base}/api/library/engineering/scan/${seat}`, json({ action: "checkIn", token: "w2", nickname: "Sipho" }));
    assert.equal((await (await fetch(url, json({ token: "w2" }))).json()).reason, "already_holding_seat");

    await fetch(`${url}/leave`, json({ token: "w1" }));
    assert.equal((await (await fetch(`${url}/status`, json({ token: "w1" }))).json()).waiting, false);
  });
});

test("a freed seat tells the people waiting for its area or any seat, oldest first, and they leave the list", async (t) => {
  const told = [];
  t.mock.method(push, "sendPush", async (token, payload) => { told.push([token, payload.body]); return { sent: true }; });
  const now = Date.now();
  await waitlist.joinWaitlist("engineering", "any-1", null, now - 5000);
  await waitlist.joinWaitlist("engineering", "east-1", "E", now - 4000);
  await waitlist.joinWaitlist("engineering", "window-1", "S", now - 3000);
  await waitlist.joinWaitlist("engineering", "window-2", "S", now - 2000);

  const n = await waitlist.seatsFreed("engineering", ["S4"], { libraryName: "Engineering Library", names: { S: "Window carrels" }, now });
  assert.equal(n, 3);
  // People waiting for the window carrels first, then anyone.
  assert.deepEqual(told.map(([tok]) => tok), ["window-1", "window-2", "any-1"]);
  assert.match(told[0][1], /^Window carrels, seat S4 in Engineering Library/);
  // Told once: they're off the list; the east-wall waiter is still on it.
  assert.equal((await waitlist.waitStatus("engineering", "window-1", now)).waiting, false);
  assert.equal((await waitlist.waitStatus("engineering", "east-1", now)).waiting, true);
});

test("waiting lapses after a few hours, and someone holding a seat isn't told", async (t) => {
  const told = [];
  t.mock.method(push, "sendPush", async (token) => { told.push(token); return { sent: true }; });
  const now = Date.now();
  await waitlist.joinWaitlist("engineering", "old", null, now - (waitlist.WAIT_HOURS * 3600 + 60) * 1000);
  await waitlist.joinWaitlist("engineering", "seated", null, now);
  await waitlist.joinWaitlist("engineering", "fresh", null, now);
  await waitlist.seatsFreed("engineering", ["C1"], { holders: new Set(["seated"]), now });
  assert.deepEqual(told, ["fresh"]);
});

test("checking out of a seat tells someone waiting, and checking in takes you off the list", async (t) => {
  const told = [];
  t.mock.method(push, "sendPush", async (token, payload) => { told.push([token, payload.url]); return { sent: true }; });
  await withServer(async (base) => {
    const [seat] = getSeatIds("engineering");
    await fetch(`${base}/api/library/engineering/scan/${seat}`, json({ action: "checkIn", token: "sitter", nickname: "Lerato" }));
    await fetch(`${base}/api/push/subscribe`, json({ token: "waiter", subscription: sub, quiet: true }));
    await fetch(`${base}/api/library/engineering/waitlist`, json({ token: "waiter" }));
    await fetch(`${base}/api/library/engineering/scan/${seat}`, json({ action: "leaving", token: "sitter", nickname: "Lerato" }));
    await tick();
    assert.deepEqual(told, [["waiter", `/library.html?lib=engineering&seat=${seat}`]]);

    await fetch(`${base}/api/library/engineering/waitlist`, json({ token: "waiter" }));
    await fetch(`${base}/api/library/engineering/scan/${seat}`, json({ action: "checkIn", token: "waiter", nickname: "Ayanda" }));
    await tick();
    assert.equal((await waitlist.waitStatus("engineering", "waiter")).waiting, false);
  });
});

test("after closing, nobody is told and the list is cleared", async (t) => {
  const told = [];
  t.mock.method(push, "sendPush", async (token) => { told.push(token); return { sent: true }; });
  await waitlist.joinWaitlist("engineering", "late", null);
  delete process.env.ALWAYS_OPEN;
  try {
    // Sunday 12:00 in Johannesburg: closed.
    const sunday = Date.parse("2026-10-18T10:00:00Z");
    assert.equal(await waitlist.announceFreed("engineering", ["C1"], sunday), 0);
  } finally {
    process.env.ALWAYS_OPEN = "1";
  }
  assert.deepEqual(told, []);
  assert.equal((await waitlist.waitStatus("engineering", "late")).waiting, false);
});

test("delete my data takes the device off the list", async () => {
  await waitlist.joinWaitlist("engineering", "gone", "W");
  await require("../src/forget").forgetDevice("gone");
  assert.equal((await waitlist.waitStatus("engineering", "gone")).waiting, false);
});
