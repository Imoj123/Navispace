"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { UpstashStore } = require("../src/store-upstash");
const { MemoryStore } = require("../src/store");

test("UpstashStore.getMany reads every key in one MGET request", async (t) => {
  const calls = [];
  t.mock.method(global, "fetch", async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      json: async () => ({ result: [JSON.stringify({ id: "W1" }), null, "not json"] }),
    };
  });
  const store = new UpstashStore("https://example.upstash.io/", "tok");
  const values = await store.getMany(["seat:a:W1", "seat:a:W2", "seat:a:W3"]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.upstash.io");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), ["MGET", "seat:a:W1", "seat:a:W2", "seat:a:W3"]);
  assert.deepEqual(values, [{ id: "W1" }, null, null]);
});

test("MemoryStore.getMany matches get for each key", async () => {
  const store = new MemoryStore();
  await store.put("a", { n: 1 });
  assert.deepEqual(await store.getMany(["a", "missing"]), [{ n: 1 }, null]);
});
