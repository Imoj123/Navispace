"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { UpstashStore } = require("../src/store-upstash");
const { MemoryStore } = require("../src/store");

const ok = (result) => ({ ok: true, json: async () => ({ result }) });

test("UpstashStore.getMany reads every key in one MGET request", async (t) => {
  const urls = [];
  t.mock.method(global, "fetch", async (url) => {
    urls.push(url);
    return ok([JSON.stringify({ id: "W1" }), null, "not json"]);
  });
  const store = new UpstashStore("https://example.upstash.io/", "tok");
  const values = await store.getMany(["seat:a:W1", "seat:a:W2", "seat:a:W3"]);

  assert.deepEqual(urls, ["https://example.upstash.io/MGET/seat%3Aa%3AW1/seat%3Aa%3AW2/seat%3Aa%3AW3"]);
  assert.deepEqual(values, [{ id: "W1" }, null, null]);
});

test("UpstashStore.getMany falls back to one GET per key if MGET fails", async (t) => {
  t.mock.method(global, "fetch", async (url) => {
    if (url.includes("/MGET/")) return { ok: false, status: 400, text: async () => "nope" };
    return ok(url.endsWith("W1") ? JSON.stringify({ id: "W1" }) : null);
  });
  t.mock.method(console, "warn", () => {});
  const store = new UpstashStore("https://example.upstash.io", "tok");
  assert.deepEqual(await store.getMany(["seat:a:W1", "seat:a:W2"]), [{ id: "W1" }, null]);
});

test("MemoryStore.getMany matches get for each key", async () => {
  const store = new MemoryStore();
  await store.put("a", { n: 1 });
  assert.deepEqual(await store.getMany(["a", "missing"]), [{ n: 1 }, null]);
});
