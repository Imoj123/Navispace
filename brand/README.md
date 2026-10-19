# NaviSpace brand kit

Everything for LinkedIn, the pitch deck and the Evidence Pack. Regenerate the
PNGs from `public/icons/favicon.svg` if the logo ever changes.

## Files

| File | Use |
|---|---|
| `linkedin-profile-1080.png` | LinkedIn company logo / profile photo. Full-bleed square; the N sits inside LinkedIn's circle crop. |
| `linkedin-banner-1584x396.png` | LinkedIn cover (company page or personal profile). The left third is kept clear for the profile photo. |
| `linkedin-post-1200x627.png` | Image for a post or a shared link. |
| `logo-app-icon-1024.png` | The rounded-square icon, as on phones (Add to Home Screen). Slides, documents. |
| `logo-n-brass-transparent-1024.png` | The N alone, brass, transparent. On dark backgrounds. |
| `logo-n-dark-transparent-1024.png` | The N alone, dark, transparent. On white or light paper. |
| `logo.svg` | Vector master. Scales to any size. |
| `qr-navispace-home.png` | QR code to the home page (navispace-1.onrender.com). Slides, the Evidence Pack, the pitch table. |

## Seat QR codes, one per A4 page

Seat codes are signed with `SEAT_SIGNING_SECRET`, which only the live server
holds, so print them from the live site:

1. Open `https://navispace-1.onrender.com/staff.html` and sign in with the staff password.
2. Under **Seat stickers**, tap **One per A4 page**.
3. **Print or save as PDF**: paper A4, margins none, background graphics on.
   One page per seat (65 pages).

The small three-to-a-page stickers are still under **Open printable stickers**.
Reprint whenever the secret changes or seats are renamed.

## Colours

| Name | Hex | Use |
|---|---|---|
| Ground | `#121614` | Backgrounds, ink on paper |
| Brass | `#c4a35f` | Accent, rules, the N |
| Brass light | `#d6b878` | Highlights, italic accents |
| Free | `#8cc5a4` | Free seats only |
| Text | `#ece6d6` | Text on dark |
| Paper | `#fbf8f1` | Print background |

## Type

- **Newsreader**: headlines (serif; italic for the brass accent).
- **Public Sans**: body text.
- **IBM Plex Mono**: labels and small caps, letter-spaced, uppercase.

All three are free (Google Fonts) and already in `public/fonts/`.

## Words

- **Motto:** Find a seat. Keep it.
- **One line:** Live seat availability and QR check-in for university libraries. No app, no sign-up.
- **Steps:** Scan your desk · Keep your seat · Check out.
- Say "Add to Home Screen", never "install" or "download the app".
- Times in 24-hour format (20:00, not 8 pm).

## LinkedIn company page

- **Name:** NaviSpace
- **Tagline (120 max):** Find a seat. Keep it. Live seat availability and QR check-in for university libraries.
- **Industry:** Software Development
- **Company size:** 2–10 employees
- **Website:** https://navispace-1.onrender.com
- **About:**

  > NaviSpace shows students which library seats are free before they walk the
  > floor, and lets them hold a seat fairly while they study. Each desk has its
  > own QR code: scan it to check in, tap "Still here" to keep it, step away
  > for up to 1 h 15 min, and check out when you leave. Seats left empty are
  > released automatically, so the next student can sit down.
  >
  > It runs in the phone's browser, with no app to download and no sign-up, and
  > it is live in the Wits Engineering Library. Library staff get a front desk
  > view for announcements, early closing, Lost & Found and usage.
  >
  > NaviSpace is a student venture built for ELEN3018A Integrated Venture
  > Economics at the University of the Witwatersrand.
