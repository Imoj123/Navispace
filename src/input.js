"use strict";

/**
 * Cleaning what students and staff send. Request bodies are JSON from the
 * open internet: a field can be a number, an array, an object or a 50,000
 * character string, whatever the page would normally send.
 */

/** A trimmed string of at most max characters (spaces collapsed), or "" if it isn't text. */
function text(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/** A nickname as shown on seats, the board and Lost & Found. */
function nickname(value) {
  return text(value, 24);
}

/** A device token: a short string (the pages use a UUID), or null. */
function token(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 100 ? value : null;
}

module.exports = { text, nickname, token };
