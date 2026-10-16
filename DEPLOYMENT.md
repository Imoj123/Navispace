# Deploying NaviSpace on Render

## Stop the free tier from sleeping

Render's free web services sleep after 15 minutes without traffic. The next visitor waits 30–60 seconds while it boots. Worse, while it sleeps **the reminder and expiry loops don't run**, so no seat reminders are sent and expired seats aren't freed.

Pick one:

1. **Upgrade the service to Render's Starter plan.** This is the real fix: it never sleeps, and nothing else needs maintaining.
2. **Free: ping it every 10 minutes.** Create a free monitor at [cron-job.org](https://cron-job.org) or [UptimeRobot](https://uptimerobot.com) that requests:

   ```
   https://navispace-1.onrender.com/healthz
   ```

   every 10 minutes. `/healthz` is cheap and never cached. One service running 24/7 uses about 730 of the free tier's 750 instance-hours a month, so a single always-on service fits. Don't run a second free service on the same account this way, because together they would go over.

Installed copies of the app open instantly either way: the service worker now serves the cached pages first and refreshes them in the background.

## Environment variables for notifications

All four need to be set on the Render service (Dashboard → your service → Environment):

| Variable | Value |
| --- | --- |
| `VAPID_PUBLIC_KEY` | from `npm run vapid-keys` |
| `VAPID_PRIVATE_KEY` | from `npm run vapid-keys` |
| `VAPID_SUBJECT` | `mailto:` + a real email address you own, e.g. `mailto:you@yourdomain` (Apple rejects pushes signed with a placeholder) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | from a free Upstash Redis database. Without these, every restart or sleep **erases** check-ins and notification sign-ups. |

Generate the VAPID keys once and keep them. Changing them invalidates every existing subscription.

## Checking notifications work

1. Check in to a seat and tap **Enable seat reminders**. A test notification should arrive within a few seconds.
   - If the page says the test didn't go through, open Render → Logs and look for a `[push] send failed (...)` line, which gives the push service's reason.
2. **iPhone:** iOS only allows web notifications for an app added to the Home Screen, on iOS 16.4 or newer.
   - Check in from Safari, then **Share → Add to Home Screen**, then open NaviSpace from the new icon.
   - The installed app takes over your Safari identity and opens on your seat. Tap **Enable seat reminders** there.
   - If the app shows the seat as just "Occupied" instead of "You're checked in", the identity didn't carry over. Delete the icon, reload the seat page in Safari, and add it again.
   - If the test notification doesn't arrive, check Render → Logs for a `[push] VAPID_SUBJECT ... malformed` warning. It must be exactly `mailto:you@domain`, with no spaces.
3. Reminders arrive 10 minutes and again 5 minutes before a seat would free up (`REMINDER_LEADS_MS` in `src/config.js`). A check-in holds the seat for 2 hours, and stepping away holds it for 1 hour 15 minutes.

## Opening hours

The library is open on weekdays from 08:00, Johannesburg time. It closes at 20:00, and at 17:00 on Fridays. It's closed on weekends and South African public holidays, including Good Friday, Family Day, and Sunday holidays moved to the Monday. Outside those hours, check-ins are refused and every held seat is freed at closing time.

- **Times:** `hours.opens`, `hours.closes` and `hours.closesOn` (e.g. `{"Fri": "17:00"}`) in `src/layouts/engineering.json`.
- **Busiest hours:** learned from how full the library really is. The plan's `hours.busiest` is shown until every open hour has about three days of data.
- **Optional environment variables:**

| Variable | Value |
| --- | --- |
| `CLOSED_DAYS` | Extra closed dates, comma-separated, e.g. `2026-12-21,2026-12-22` for a recess or an election day |
| `TIME_ZONE` | Defaults to `Africa/Johannesburg` |
| `ALWAYS_OPEN` | `1` ignores opening hours, for testing at night or on a weekend. Remove it afterwards. |
