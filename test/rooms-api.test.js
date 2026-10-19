"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.ALWAYS_OPEN = "1";
process.env.SEAT_SIGNING_SECRET = "room-secret";
const { createApp } = require("../src/server");
const { store } = require("../src/store");
const { seatCode } = require("../src/seatcode");

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, (p, body) => fetch(`${base}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test.beforeEach(() => { store.clear(); require("../src/ratelimit").reset(); });

const R = "/api/library/engineering/rooms";

test("rooms: book tomorrow, see it as mine, others see only 'booked', cancel it", async () => {
  await withServer(async (base, post) => {
    const view = await (await post(`${R}/view`, {})).json();
    assert.deepEqual(view.rooms.map((r) => r.label), ["Room 1", "Room 2", "Room 3"]);
    const tomorrow = view.days[1].date;
    const res = await post(`${R}/book`, { token: "tok-a", nickname: "Ann", room: "R2", date: tomorrow, start: 600, end: 720 });
    assert.equal(res.status, 200);
    const { booking } = await res.json();
    assert.equal((await post(`${R}/book`, { token: "tok-b", nickname: "Ben", room: "R2", date: tomorrow, start: 660, end: 720 })).status, 409);

    const theirs = await (await post(`${R}/view`, { token: "tok-b", date: tomorrow })).json();
    assert.deepEqual(theirs.rooms[1].bookings.map((b) => [b.start, b.end, b.mine]), [[600, 720, false]]);
    assert.equal(JSON.stringify(theirs).includes("Ann"), false);
    const mine = await (await post(`${R}/mine`, { token: "tok-a" })).json();
    assert.deepEqual(mine.bookings.map((b) => [b.id, b.label]), [[booking.id, "Room 2"]]);

    assert.equal((await post(`${R}/cancel`, { token: "tok-b", id: booking.id })).status, 409);
    assert.equal((await post(`${R}/cancel`, { token: "tok-a", id: booking.id })).status, 200);
    assert.equal((await post(`${R}/cancel`, { token: "tok-a", id: booking.id })).status, 404);
  });
});

test("rooms: the door needs its own code; a free room can be taken there", async () => {
  await withServer(async (base, post) => {
    const k = seatCode("engineering", "room:R3");
    assert.equal((await post(`${R}/door`, { token: "tok-a", room: "R3" })).status, 403);
    assert.equal((await post(`${R}/door`, { token: "tok-a", room: "R3", k: seatCode("engineering", "room:R1") })).status, 403);
    const door = await (await post(`${R}/door`, { token: "tok-a", room: "R3", k })).json();
    assert.equal(door.reason, "no_booking");
    assert.ok(door.walkIn.length >= 1);
    assert.equal((await post(`${R}/walkin`, { token: "tok-a", nickname: "Ann", room: "R3", end: door.walkIn[0] })).status, 403);
    const walk = await post(`${R}/walkin`, { token: "tok-a", nickname: "Ann", room: "R3", end: door.walkIn[0], k });
    assert.equal(walk.status, 200);
    assert.equal((await walk.json()).booking.claimed, true);
    const again = await (await post(`${R}/door`, { token: "tok-a", room: "R3", k })).json();
    assert.equal(again.ok, true);
  });
});

test("rooms: bad input is turned away, and a library without rooms has none", async () => {
  await withServer(async (base, post) => {
    assert.equal((await post(`${R}/book`, { token: "tok-a", room: "R1", date: "x", start: 600, end: 660 })).status, 400);
    assert.equal((await post(`${R}/book`, { token: "tok-a", nickname: "A", room: "R1", date: "x", start: "600", end: 660 })).status, 409);
    assert.equal((await post(`${R}/door`, { token: "tok-a", room: "R9", k: "x" })).status, 404);
    assert.equal((await post(`${R}/cancel`, { token: "tok-a", id: "nonsense" })).status, 404);
    assert.equal((await post("/api/library/nope/rooms/view", {})).status, 404);
  });
});
