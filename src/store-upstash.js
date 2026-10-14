"use strict";

/**
 * Upstash Redis-backed store — same get/put/delete/listKeys interface
 * as MemoryStore (store.js), so swapping this in requires no changes
 * anywhere else in the codebase (scan.js, sweep.js, leaderboard.js
 * all only ever call store.get/put/delete/listKeys).
 *
 * Uses Upstash's REST API (plain HTTPS, no Redis client library or
 * persistent socket needed) — a good fit for a small server on a
 * free tier. Requires two env vars, both provided on your Upstash
 * database's dashboard:
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *
 * Values are JSON-serialized so any JS value (objects, arrays,
 * booleans) round-trips the same way MemoryStore stores them.
 */

class UpstashStore {
    constructor(url, token) {
        if (!url || !token) {
            throw new Error(
                "UpstashStore requires both a REST URL and token (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)"
            );
        }
        this.baseUrl = url.replace(/\/+$/, "");
        this.token = token;
    }

    /**
     * Runs a single Redis command via Upstash's REST API, sent as a JSON
     * array in a POST body (no URL-length limit, so a many-key MGET fits).
     */
    async command(...args) {
        const res = await fetch(this.baseUrl, {
            method: "POST",
            headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
            body: JSON.stringify(args.map(String)),
        });

        if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(
                `Upstash command failed (${res.status}): ${args[0]} — ${body}`
            );
        }

        const json = await res.json();
        return json.result;
    }

    async get(key) {
        const raw = await this.command("GET", key);
        if (raw == null) return null;
        try {
            return JSON.parse(raw);
        } catch {
            return null; // corrupted/foreign value — treat as absent rather than throw
        }
    }

    /**
     * Reads many keys in ONE round trip (MGET). Each Upstash call is an
     * HTTPS request, so reading a library's seats one by one cost a
     * request per seat — seconds per check-in once there are dozens.
     * Returns values in key order, null where absent.
     */
    async getMany(keys) {
        if (!keys.length) return [];
        const raws = await this.command("MGET", ...keys);
        return (Array.isArray(raws) ? raws : []).map((raw) => {
            if (raw == null) return null;
            try {
                return JSON.parse(raw);
            } catch {
                return null;
            }
        });
    }

    async put(key, value, opts = {}) {
        const serialized = JSON.stringify(value);
        if (opts.expirationTtl) {
            await this.command("SET", key, serialized, "EX", opts.expirationTtl);
        } else {
            await this.command("SET", key, serialized);
        }
    }

    async delete(key) {
        await this.command("DEL", key);
    }

    /**
     * Lists keys matching a prefix. Uses KEYS, which is fine at the
     * small scale this project runs at (a single library's seats and
     * students) — Upstash itself advises against KEYS at large scale,
     * but there's no secondary index here to reach for instead. If
     * this ever needs to scale past one building, replace with SCAN
     * or a maintained index set.
     */
    async listKeys(prefix = "") {
        const result = await this.command("KEYS", `${prefix}*`);
        return Array.isArray(result) ? result : [];
    }
}

/**
 * Returns an UpstashStore if both env vars are present, otherwise
 * null — callers fall back to MemoryStore in that case.
 */
function tryCreateUpstashStore() {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return null;
    return new UpstashStore(url, token);
}

module.exports = { UpstashStore, tryCreateUpstashStore };
