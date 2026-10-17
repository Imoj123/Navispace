"use strict";

const { store } = require("./store");
const { weekStart } = require("./hours");
const { studentWeek } = require("./scan");

/**
 * Reads the top N students by weeklySessionDays, for one library.
 * Leaderboards are per-library — each library is its own study
 * community, and this falls naturally out of studentKey already being
 * namespaced by libraryId in scan.js. Student records are plain KV
 * values (studentKey(libraryId, token) -> record). Uses the store's
 * listKeys (a MemoryStore-only convenience — a real KV backend would
 * need a proper secondary index instead) — fine at single-building
 * scale, not meant to scale past that.
 */
async function getLeaderboard(libraryId, topN = 10, now = Date.now()) {
  // This calendar week only (Monday to Sunday, library time).
  const week = weekStart(now);
  const entries = [];

  const studentKeys = await store.listKeys(`student:${libraryId}:`);
  const students = await store.getMany(studentKeys);
  for (const student of students) {
    if (!student) continue;

    const sessionDays = studentWeek(student) === week ? student.weeklySessionDays : 0;
    if (sessionDays <= 0) continue;

    entries.push({ nickname: student.nickname, sessionDays });
  }

  entries.sort((a, b) => b.sessionDays - a.sessionDays);
  return entries.slice(0, topN);
}

module.exports = { getLeaderboard };

