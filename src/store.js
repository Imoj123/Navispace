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

// Singleton store for the running process. Swap this line for a real
// KV client constructor when moving off the in-memory version.
const store = new MemoryStore();

module.exports = { store, MemoryStore };
