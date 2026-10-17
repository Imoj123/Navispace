"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Every page's own JavaScript must at least parse: one stray bracket in an
// inline <script> stops the whole page from working, and no other test
// loads the pages in a browser.
const PUBLIC = path.join(__dirname, "..", "public");

test("every page's scripts, client.js and sw.js parse", () => {
  const broken = [];
  for (const file of fs.readdirSync(PUBLIC).filter((f) => f.endsWith(".html") || f === "client.js" || f === "sw.js")) {
    const source = fs.readFileSync(path.join(PUBLIC, file), "utf8");
    // Inline scripts only, and only JavaScript ones (not JSON blocks such as speculation rules).
    const scripts = file.endsWith(".js") ? [source]
      : [...source.matchAll(/<script(?![^>]*\b(?:src=|type="(?!text\/javascript|module)[^"]*"))[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    scripts.forEach((code, i) => {
      try {
        new vm.Script(code, { filename: `${file} script ${i + 1}` });
      } catch (err) {
        broken.push(`${file} script ${i + 1}: ${err.message}`);
      }
    });
  }
  assert.deepEqual(broken, []);
});
