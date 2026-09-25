"use strict";

/**
 * In-memory store for NaviSpace (Day 1 MVP).
 *
 * This is intentionally isolated behind a small async-looking API
 * (get/put/delete all return Promises) so it can be swapped for a
 * real key-value backend (e.g. Cloudflare KV, Redis) later without
 * touching any of the logic in scan.js or server.js — those only
 * ever call store.get/put/delete, never touch the Map directly.
 */

class MemoryStore {
  constructor() {
    this.data = new Map();
  }

  async get(key) {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.data.delete(key);
      return null;
    }
    return entry.value;
  }

  /**
   * @param {string} key
   * @param {*} value
   * @param {{ expirationTtl?: number }} [opts] TTL in seconds, matching
   *   the Cloudflare KV `put` option name so a future swap is a drop-in.
   */
  async put(key, value, opts = {}) {
    const expiresAt = opts.expirationTtl
      ? Date.now() + opts.expirationTtl * 1000
      : null;
    this.data.set(key, { value, expiresAt });
  }

  async delete(key) {
    this.data.delete(key);
  }

  /** Not part of the KV-compatible surface — test/debug convenience only. */
  async listKeys(prefix = "") {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }

  /** Test/debug convenience only — wipes everything. */
  clear() {
    this.data.clear();
  }
}

const { tryCreateUpstashStore } = require("./store-upstash");

// Singleton store for the running process. If UPSTASH_REDIS_REST_URL
// and UPSTASH_REDIS_REST_TOKEN are set (see store-upstash.js), use
// that for real persistence across restarts/sleeps; otherwise fall
// back to the in-memory store (fine for local dev, but data is lost
// on every restart — see the deployment notes).
const upstashStore = tryCreateUpstashStore();
const store = upstashStore || new MemoryStore();

if (upstashStore) {
  console.log("[store] Using Upstash Redis (persistent).");
} else {
  console.log(
    "[store] Using in-memory store (NOT persistent — data resets on every restart). " +
      "Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN for persistence."
  );
}

module.exports = { store, MemoryStore };
