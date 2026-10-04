"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { store } = require("../src/store");
const { reportItem, listItems, claimItem, resolveItem } = require("../src/lostfound");

const LIB = "test-lib";
const finder = { token: "tok-finder", nickname: "Finder" };
const claimant = { token: "tok-claimant", nickname: "Claimant" };

// A tiny valid-looking data URL — content doesn't matter for these
// tests, only that it starts with "data:image/" and has a length, so
// we don't need a real image fixture on disk.
const PHOTO = "data:image/png;base64," + "A".repeat(100);

test.beforeEach(() => {
    store.clear();
});

test("reports an item and it shows up unclaimed", async () => {
    const result = await reportItem(LIB, {
        description: "Blue water bottle",
        location: "Desk near B2",
        photoDataUrl: PHOTO,
        reporterToken: finder.token,
        reporterNickname: finder.nickname,
    });
    assert.equal(result.ok, true);
    assert.equal(result.item.status, "unclaimed");

    const items = await listItems(LIB);
    assert.equal(items.length, 1);
    assert.equal(items[0].description, "Blue water bottle");
});

test("rejects a report missing required fields or a bad/oversized photo", async () => {
    let result = await reportItem(LIB, {
        description: "",
        photoDataUrl: PHOTO,
        reporterToken: finder.token,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing_fields");

    result = await reportItem(LIB, {
        description: "Keys",
        photoDataUrl: "not-a-data-url",
        reporterToken: finder.token,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid_photo");

    const hugePhoto = "data:image/png;base64," + "A".repeat(2_000_000);
    result = await reportItem(LIB, {
        description: "Keys",
        photoDataUrl: hugePhoto,
        reporterToken: finder.token,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "photo_too_large");
});

test("claim flow: first claim wins, item stays visible but marked claimed", async () => {
    const { item } = await reportItem(LIB, {
        description: "Calculator",
        photoDataUrl: PHOTO,
        reporterToken: finder.token,
        reporterNickname: finder.nickname,
    });

    const claimed = await claimItem(LIB, item.id, {
        claimantToken: claimant.token,
        claimantNickname: claimant.nickname,
        note: "Has my name engraved on the back",
    });
    assert.equal(claimed.ok, true);
    assert.equal(claimed.item.status, "claimed");
    assert.equal(claimed.item.claim.claimantNickname, "Claimant");

    // A second claimant is turned away — first claim wins.
    const secondClaim = await claimItem(LIB, item.id, {
        claimantToken: "tok-someone-else",
        claimantNickname: "Someone Else",
    });
    assert.equal(secondClaim.ok, false);
    assert.equal(secondClaim.reason, "already_claimed");

    // Still listed (awaiting pickup), not deleted.
    const items = await listItems(LIB);
    assert.equal(items.length, 1);
    assert.equal(items[0].status, "claimed");
});

test("only the original reporter can resolve (mark returned) an item", async () => {
    const { item } = await reportItem(LIB, {
        description: "Umbrella",
        photoDataUrl: PHOTO,
        reporterToken: finder.token,
        reporterNickname: finder.nickname,
    });

    const deniedResolve = await resolveItem(LIB, item.id, claimant.token);
    assert.equal(deniedResolve.ok, false);
    assert.equal(deniedResolve.reason, "not_reporter");

    const items = await listItems(LIB);
    assert.equal(items.length, 1, "wrongly-denied resolve must not remove the item");

    const okResolve = await resolveItem(LIB, item.id, finder.token);
    assert.equal(okResolve.ok, true);

    const itemsAfter = await listItems(LIB);
    assert.equal(itemsAfter.length, 0);
});

test("boards are isolated per library", async () => {
    await reportItem(LIB, {
        description: "Engineering library item",
        photoDataUrl: PHOTO,
        reporterToken: finder.token,
        reporterNickname: finder.nickname,
    });
    await reportItem("other-lib", {
        description: "Other library item",
        photoDataUrl: PHOTO,
        reporterToken: finder.token,
        reporterNickname: finder.nickname,
    });

    const items = await listItems(LIB);
    assert.equal(items.length, 1);
    assert.equal(items[0].description, "Engineering library item");
});

test("unclaimed items sort ahead of claimed ones, newest first within each group", async () => {
    const now = Date.now();
    const { item: older } = await reportItem(
        LIB,
        { description: "Older item", photoDataUrl: PHOTO, reporterToken: finder.token, reporterNickname: "Finder" },
        now - 1000
    );
    const { item: newer } = await reportItem(
        LIB,
        { description: "Newer item", photoDataUrl: PHOTO, reporterToken: finder.token, reporterNickname: "Finder" },
        now
    );

    await claimItem(LIB, newer.id, { claimantToken: claimant.token, claimantNickname: "Claimant" });

    const items = await listItems(LIB);
    assert.equal(items.length, 2);
    // The unclaimed one (older) should come first despite being older,
    // since unclaimed items are more actionable than claimed ones.
    assert.equal(items[0].id, older.id);
    assert.equal(items[0].status, "unclaimed");
    assert.equal(items[1].id, newer.id);
    assert.equal(items[1].status, "claimed");
});
