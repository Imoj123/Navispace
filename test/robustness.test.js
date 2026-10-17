"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.ALWAYS_OPEN = "1";
const { createApp } = require("../src/server");
const { store } = require("../src/store");
const { getSeatIds } = require("../src/seats");
const { getLeaderboard } = require("../src/leaderboard");
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

let ip = 1;
const post = (base, path, body, headers = {}) => fetch(base + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.77.0.${ip++ % 250}`, ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

/** Makes the in-memory store as slow as a network one (Upstash), so races show. */
function slowStore(t) {
  for (const fn of ["get", "put", "delete", "getMany", "listKeys"]) {
    const original = store[fn].bind(store);
    t.mock.method(store, fn, async (...args) => {
      await new Promise((r) => setTimeout(r, 3 + Math.random() * 12));
      return original(...args);
    });
  }
}

test.beforeEach(() => { store.clear(); require("../src/ratelimit").reset(); });

test("two people checking into one seat at the same moment: only one gets it", async (t) => {
  slowStore(t);
  await withServer(async (base) => {
    for (const seat of getSeatIds("engineering").slice(0, 5)) {
      const results = await Promise.all(["a", "b"].map((who) =>
        post(base, `/api/library/engineering/scan/${seat}`, { action: "checkIn", token: `${who}-${seat}`, nickname: who }).then((r) => r.status)));
      assert.deepEqual(results.sort(), [200, 409], seat);
    }
  });
});

test("one device checking into three seats at once still gets one", async (t) => {
  slowStore(t);
  await withServer(async (base) => {
    const seats = getSeatIds("engineering").slice(10, 13);
    const results = await Promise.all(seats.map((seat) =>
      post(base, `/api/library/engineering/scan/${seat}`, { action: "checkIn", token: "greedy", nickname: "G" }).then((r) => r.status)));
    assert.equal(results.filter((s) => s === 200).length, 1);
  });
});

test("everyone joining the wait list at once is kept", async (t) => {
  slowStore(t);
  await Promise.all(Array.from({ length: 10 }, (_, i) => waitlist.joinWaitlist("engineering", `w${i}`, null)));
  for (let i = 0; i < 10; i++) assert.equal((await waitlist.waitStatus("engineering", `w${i}`)).waiting, true, `w${i}`);
});

test("reports arriving together all count, and reports from before a sitting don't", async (t) => {
  slowStore(t);
  await withServer(async (base) => {
    const [seat, other] = getSeatIds("engineering");
    // Two reports while the seat was empty: they mean nothing for the next person.
    await post(base, `/api/library/engineering/report/${seat}`, { token: "r1" });
    await post(base, `/api/library/engineering/report/${seat}`, { token: "r2" });
    await post(base, `/api/library/engineering/scan/${seat}`, { action: "checkIn", token: "sitter", nickname: "S" });
    const one = await (await post(base, `/api/library/engineering/report/${seat}`, { token: "r3" })).json();
    assert.equal(one.corrected, false);
    // Three reports at once on a held seat: all three count, and it's freed.
    await post(base, `/api/library/engineering/scan/${other}`, { action: "checkIn", token: "sitter2", nickname: "S" });
    const many = await Promise.all(["x1", "x2", "x3"].map((tok) => post(base, `/api/library/engineering/report/${other}`, { token: tok }).then((r) => r.json())));
    assert.equal(many.filter((r) => r.corrected).length, 1);
  });
});

test("checking in and out of several seats in a day still earns one point", async () => {
  await withServer(async (base) => {
    for (const seat of getSeatIds("engineering").slice(20, 26)) {
      await post(base, `/api/library/engineering/scan/${seat}`, { action: "checkIn", token: "hopper", nickname: "Hopper" });
      await post(base, `/api/library/engineering/scan/${seat}`, { action: "leaving", token: "hopper", nickname: "Hopper" });
    }
    const board = await getLeaderboard("engineering", 10);
    assert.equal(board.find((e) => e.nickname === "Hopper").sessionDays, 1);
  });
});

test("odd request bodies get a short answer, never a hang, a crash or a stack trace", async () => {
  await withServer(async (base) => {
    const L = "/api/library/engineering/lostfound";
    for (const [i, photo] of [123, ["a"], { a: 1 }, true, "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,<script>"].entries()) {
      const r = await post(base, L, { description: "pen", photoDataUrl: photo, token: `t-photo-${i}`, nickname: "N" });
      assert.equal(r.status, 400, JSON.stringify(photo));
    }
    for (const body of ["{bad json", "null", "123", '"str"']) {
      const r = await post(base, "/api/held", body);
      assert.equal(r.status, 400, body);
      assert.deepEqual(await r.json(), { ok: false, reason: "bad_json" });
    }
    for (const token of [123, ["a"], { a: 1 }, "x".repeat(500)]) {
      assert.equal((await post(base, "/api/held", { token })).status, 400, JSON.stringify(token));
    }
    const huge = await post(base, "/api/held", JSON.stringify({ token: "t", pad: "x".repeat(4 * 1024 * 1024) }));
    assert.equal(huge.status, 413);
  });
});

test("nicknames are short text, whatever is sent", async () => {
  await withServer(async (base) => {
    const [seat] = getSeatIds("engineering");
    const r = await post(base, `/api/library/engineering/scan/${seat}`, { action: "checkIn", token: "long-name", nickname: "N".repeat(5000) });
    assert.equal(r.status, 200);
    await post(base, `/api/library/engineering/scan/${seat}`, { action: "stillHere", token: "long-name", nickname: "N".repeat(5000) });
    const objectName = await post(base, `/api/library/engineering/scan/${seat}`, { action: "stillHere", token: "long-name", nickname: { evil: 1 } });
    assert.equal(objectName.status, 400); // not text: no nickname
    const board = await getLeaderboard("engineering", 10);
    assert.equal(board[0].nickname, "N".repeat(24));
  });
});

test("a claim note with a link is refused, like chat messages", async () => {
  await withServer(async (base) => {
    const { item } = await (await post(base, "/api/library/engineering/lostfound", { description: "Keys", photoDataUrl: "data:image/jpeg;base64,AAAA", token: "finder", nickname: "F" })).json();
    const r = await post(base, `/api/library/engineering/lostfound/${item.id}/claim`, { token: "owner", nickname: "O", note: "pay me at https://evil.example" });
    assert.deepEqual(await r.json(), { ok: false, reason: "no_links" });
  });
});

test("a mangled staff cookie is just 'not signed in'", async () => {
  process.env.STAFF_PASSWORD = "desk-secret";
  try {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/staff/overview`, { headers: { Cookie: "ns_staff=%E0%A4%A" } });
      assert.equal(r.status, 401);
      const page = await fetch(`${base}/staff/stickers`, { headers: { Cookie: "ns_staff=%E0%A4%A" }, redirect: "manual" });
      assert.equal(page.status, 302);
      assert.equal((await post(base, "/api/staff/login", { password: ["desk-secret"] })).status, 401);
    });
  } finally {
    delete process.env.STAFF_PASSWORD;
  }
});
