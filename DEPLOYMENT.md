# Running NaviSpace on Render

NaviSpace runs as one Render web service (`npm start`) at
`https://navispace-1.onrender.com`, with its data in an Upstash Redis
database. Every merge to `main` redeploys it automatically.

## Checklist

| | What | Why |
| --- | --- | --- |
| ✅ | Upstash variables set | Check-ins, Lost & Found, conversations and "Your week" survive restarts |
| ✅ | VAPID keys set | Seat reminders and Lost & Found notifications |
| ✅ | `SEAT_SIGNING_SECRET` set | Only a scanned sticker can claim a seat |
| ✅ | Keep-awake ping every 10 minutes | Reminders, seat releases and closing time keep running |
| ☐ | `STAFF_PASSWORD` set | Turns on the staff page (front desk, usage, stickers) |
| ☐ | Seat stickers printed from the staff page | Old stickers stop working once the secret is set |
| ☐ | Opening hours and closed days confirmed | Check-ins are refused outside them |

## Environment variables

Set these on the Render service: **Dashboard → your service → Environment**.
Saving them redeploys the service.

### Required

| Variable | Value |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | From a free Upstash Redis database. Without them, every restart or sleep **erases** all data. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | From `npm run vapid-keys`. Generate once and keep: changing them cancels every notification sign-up. |
| `VAPID_SUBJECT` | `mailto:` plus a real address you own, e.g. `mailto:you@yourdomain`. Apple rejects a placeholder. |
| `SEAT_SIGNING_SECRET` | A long random string. Seats can then only be claimed with the code printed on their sticker. Changing it retires every printed sticker. |
| `STAFF_PASSWORD` | The password for `/staff.html`. Give it to the front desk. Changing it signs everyone out. Without it the staff page is off. |

### Optional

| Variable | Value |
| --- | --- |
| `PRIVACY_CONTACT` | An email address (or a sentence) shown on the privacy page for questions and requests. Without it, the page says to ask at the front desk. |
| `CLOSED_DAYS` | Extra closed dates, comma-separated: `2026-12-21,2026-12-22` for a recess, an election day or a closure. |
| `CLOSING_GRACE_MINUTES` | How long after closing held seats are released. Default `5`, for evenings the library closes a little late. |
| `TIME_ZONE` | Default `Africa/Johannesburg`. |
| `ALWAYS_OPEN` | `1` ignores opening hours, for testing at night or on a weekend. **Remove it afterwards.** |

## Keeping it awake

Render's free plan sleeps after 15 minutes without visitors. While it sleeps,
**nothing runs**: no reminders, no seats freed when their hold runs out, no
release at closing time, and no learning of the busiest hours. The first
visitor afterwards waits 30–60 seconds.

The keep-awake ping is set up: a cron-job.org job requests

```
https://navispace-1.onrender.com/healthz
```

every 10 minutes. `/healthz` is cheap and never cached. One always-on service
uses about 730 of the free plan's 750 hours a month, so don't keep a second
free service awake on the same account. Render's Starter plan removes the need
for the ping altogether.

**If something stops working at night or after a quiet spell,** check the job's
history on cron-job.org first: failed pings mean the server was asleep.

## How a day runs

- **Opening hours:** weekdays from 08:00, Johannesburg time. Closes at 20:00, and
  17:00 on Fridays. Closed on weekends and South African public holidays
  (including Good Friday, Family Day and Sunday holidays moved to the Monday),
  plus any `CLOSED_DAYS`. Set in `hours` in `src/layouts/engineering.json`
  (`opens`, `closes`, and `closesOn` such as `{"Fri": "17:00"}`).
- **Check-ins** are refused outside opening hours. While closed, a seat page
  says "Library closed" and when check-ins reopen, and the home page says when
  the library opens.
- **A check-in holds the seat for 2 hours.** "Still here" on the seat page
  (asked 50 minutes after the last confirmation, also after a reload or from
  the Home Screen app) starts the 2 hours again.
- **Reminders** go out 10 and 5 minutes before a hold ends. Ignore them and the
  seat frees itself when the hold ends (the server checks every minute; a seat
  whose hold has just ended can be taken straight away).
- **Stepping away** holds the seat for 1 hour 15 minutes.
- **Closing early:** staff can close early for one day from the staff page
  (see below); everything here then follows the earlier time.
- **Closing:** 10 minutes before closing, everyone holding a seat gets one
  notification (and no other reminders after it). Check-ins, Still here and
  I'm back stop at closing time, and every held seat is released 5 minutes
  later (`CLOSING_GRACE_MINUTES`). If the server was asleep through closing,
  sittings still end at that release time.
- **Full floor:** when 3 seats or fewer are left, the home page and the map
  offer **Notify me**: any seat, or a favourite area. When a seat frees up
  (checked out, hold ran out, freed by staff or by reports), up to 3 people
  waiting for it get a notification, oldest first; whoever scans first gets it.
  The notification opens the map with that seat pointed out. Waiting lapses
  after 3 hours and is cleared at closing; nobody is sent to a seat in the last
  10 minutes before closing. Needs notifications on.
- **Study board:** one point for each day a student studies (Still here, Check
  out, or a sitting of 15 minutes or more that ends on its own), however many
  seats they use that day. The board is a calendar week, Monday to Sunday, and
  starts fresh every Monday.
- **Busiest hours** on the home page are learned from how full the library is.
  Until each open hour has about three days of data, the plan's estimate
  (`hours.busiest`) shows.

Timings live in `src/config.js`.

## The staff page

`https://navispace-1.onrender.com/staff.html`, behind `STAFF_PASSWORD`
(sign-in lasts 12 hours, 10 wrong guesses lock it for 15 minutes):

- **Tell everyone:**
  - **Announcement:** one line (up to 200 characters) shown at the top of
    every library page, until the end of today, for 3 days or for a week.
    Tick the box to also send it as a notification to everyone holding a seat.
    **Take it down** removes it at once.
  - **Close early today:** pick a time ("Now", or every 15 minutes until the
    usual close) and an optional reason. Check-ins stop then, everyone with a
    seat is told (now, if ticked, and 10 minutes before), held seats are
    released 5 minutes after, and the pages and home screen show the new time.
    **Undo** goes back to the usual time. It's for today only: tomorrow is
    normal. For a whole closed day, use `CLOSED_DAYS` instead.
- **Seats in use:** who holds which seat and until when, with **Free this seat**
  for someone who left without checking out.
- **Lost & found:** every item, reported conversations first, then items at the
  desk. Read a conversation, mark an item **Collected: remove**, or take it down.
- **Usage, last 14 days:** check-ins, different students, a weekday on average,
  Lost & Found posts, the most-used seats, and how full the library is by hour.
  Students are counted by scrambled codes only.
- **Seat stickers:** every seat's sticker on A4, signed with the server's
  `SEAT_SIGNING_SECRET`. Print, or save as a PDF.
- **Launch poster:** an A4 poster for the entrance and the front desk: a QR code
  to the home page, the three steps (scan your desk, keep your seat, check out)
  and the opening hours. Print in colour if you can.

## Robustness

- Changes to a library's seats, its wait list and each Lost & Found item take
  turns inside the server (`src/lock.js`), so two people can't both get one
  seat. This assumes **one** server instance, which is how Render's plan runs
  it. Running several instances would need a lock in Upstash instead.
- Anything a request sends is checked for type and length (`src/input.js`);
  bad requests get a short JSON answer, never a crash or a stack trace.
- Notification sign-ups are only accepted for the browsers' own push services
  (Google, Mozilla, Apple, Microsoft).
- The public Lost & Found board shows the newest 120 items; staff see all.

## Speed limits

To stop one person flooding the floor or the board, each device and each
network is limited (per minute or hour): seat actions, seat reports, Lost &
Found posts, claims, messages and reports, notification sign-ups, "Notify me",
data deletion, and staff sign-in attempts. Over a limit, the page says to wait a
moment. The numbers are in `src/ratelimit.js`.

## Privacy

`/privacy.html` says, in plain language, what's kept, why and for how long
(POPIA), and has **Delete my data**: it frees the device's seat and deletes its
sittings, study board record, notification sign-up, any wait for a seat, Lost &
Found posts and claims (with their conversations). It's linked from the home page footer, the
nickname card and the Lost & Found form. **Keep it true:** if what NaviSpace
stores changes, update the page.

## Notifications

Each phone and computer is set up on its own, from the **Notifications**
section of the home page. It shows the device's status, turns notifications on,
sends a test, and lists the steps for that exact device and browser.

The test follows the notification all the way and says where it stopped:

| The test says | Where the problem is |
| --- | --- |
| "Sent and received… the device is hiding it" | The device's own settings. Follow the steps the section shows. |
| "The system refused to show it" | The browser's permission for the site. |
| "The browser never received it" | The connection to the push service (a VPN or firewall). |
| "The server couldn't send it (…)" | The VAPID variables. Check Render → Logs for a `[push]` line. |

What fixed real devices:

- **iPhone / iPad:** notifications only work from the Home Screen copy
  (Share → Add to Home Screen, iOS 16.4 or newer), turned on from inside it.
- **Mac, Chrome:** System Settings → Notifications → **Google Chrome**. It can
  be listed twice: set **both** to Allow, Alert Style **Persistent**. Turn off
  Do Not Disturb (Control Centre → Focus), which Apple shares across devices.
- **Mac, Safari:** Safari → Settings → Websites → Notifications → set
  `navispace-1.onrender.com` to Allow, then System Settings → Notifications →
  Safari → Persistent.

## Seat stickers

Each sticker's QR code opens its seat with a signed code (`&k=…`) made from
`SEAT_SIGNING_SECRET`. The stickers must be made with the **same secret as the
server**, so either print them from the staff page, or run locally with the
same value:

```
BASE_URL=https://navispace-1.onrender.com SEAT_SIGNING_SECRET=... npm run qr
```

which writes one PNG per seat to `qr-codes/`. Changing the secret retires every
printed sticker at once. Regenerate stickers whenever seats are added, removed
or renamed in the floor plan (`scripts/build-engineering-plan.py`).

## Logs worth knowing

In Render → Logs:

- `[store] Using in-memory store`: the Upstash variables are missing.
- `[push] send failed (…)`: a notification was rejected, with the push service's reason.
- `[push] VAPID_SUBJECT … malformed`: fix `VAPID_SUBJECT` (exactly `mailto:you@domain`).
- `[sweep] engineering reclaimed: …`: seats freed (hold ran out, or closing time).
- `[reminders] engineering sent: …`: reminders and closing notices that went out.
- `[waitlist] engineering told N waiting`: people told a seat freed up.
- `[notices] load failed`: the announcement and early close couldn't be read
  from Upstash at start-up (they reload every 5 minutes).
