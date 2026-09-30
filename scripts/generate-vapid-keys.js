"use strict";

/**
 * One-time setup helper: prints a fresh VAPID key pair for Web Push.
 * Run once (npm run vapid-keys), then copy the two values into your
 * environment as VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (Render:
 * service Environment tab, same place as SEAT_IDS / UPSTASH_* / etc).
 * Keep the private key secret — treat it like any other credential.
 */

const webpush = require("web-push");

const keys = webpush.generateVAPIDKeys();

console.log("VAPID keys generated. Add these to your environment:\n");
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log(`VAPID_SUBJECT=mailto:you@example.com  (any contact address works)`);
console.log(
"\nRestart the server after setting these — reminders silently stay off until both are present."
);