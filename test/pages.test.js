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

test("every page shows the NaviSpace picture when shared as a link", async () => {
  const { createApp } = require("../src/server");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith(".html")).map((f) => (f === "index.html" ? "/" : `/${f}`));
    for (const page of pages.concat("/no-such-page")) {
      const html = await (await fetch(base + page)).text();
      const image = /<meta property="og:image" content="([^"]+)"/.exec(html);
      assert.ok(image, `${page} has no preview picture`);
      assert.match(image[1], /^https?:\/\/[^/]+\/icons\/icon-512\.png$/, page);
      assert.match(html, /<meta property="og:title" content="[^"]+"/, page);
      assert.equal((html.match(/property="og:image"/g) || []).length, 1, `${page} has one preview picture`);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});
