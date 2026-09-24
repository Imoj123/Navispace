"use strict";

const { store } = require("./store");
const config = require("./config");

/**
 * Reads the top N students by weeklySessionDays. Student records are
 * plain KV values (studentKey(token) -> record). Uses the store's
 * listKeys (a MemoryStore-only convenience — a real KV backend would
 * need a proper secondary index instead) — fine at single-library
 * scale, not meant to scale past one building.
 */
async function getLeaderboard(topN = 10, now = Date.now()) {
  const windowMs = config.LEADERBOARD_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const entries = [];

  const studentKeys = await store.listKeys("student:");
  for (const key of studentKeys) {
    const student = await store.get(key);
    if (!student) continue;

    const inWindow = now - student.windowStart <= windowMs;
    const sessionDays = inWindow ? student.weeklySessionDays : 0;
    if (sessionDays <= 0) continue;

    entries.push({ nickname: student.nickname, sessionDays });
  }

  entries.sort((a, b) => b.sessionDays - a.sessionDays);
  return entries.slice(0, topN);
}

module.exports = { getLeaderboard };
