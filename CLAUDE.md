# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Masjid Al-Hayy Kiosk — a touchscreen kiosk app for mosques. It shows an advertising reel when idle and switches to an interactive hub (prayer times, map, announcements, events, donations, contact) on tap.

**No build process.** Pure vanilla HTML/CSS/JS with Firebase and Cloudinary loaded from CDN. Open files directly in a browser or push to GitHub Pages.

## Running the App

- **Local testing:** Open `index.html` or `admin.html` directly in a browser (requires internet for Firebase/Aladhan API)
- **Production:** Push to `main` branch; GitHub Pages serves all the HTML files (`index.html`, `admin.html`, `portal.html`)
- **Physical kiosk:** [FreeKiosk](https://github.com/RushB-fr/freekiosk) (Android, free/open-source, no watermark or subscription) pointed at the GitHub Pages URL, in Kiosk/Lock Task Mode. Fully Kiosk Browser also works but its watermark-removal tier is a paid add-on. See README Part 5.

## Architecture

### Three HTML pages

**`index.html` — Public kiosk display**

Two modes managed entirely in JavaScript with no routing:
- **Ad Reel (idle):** Cycles through Firestore `ads` collection. Images advance by `duration` field (default 8s); videos play to completion. Uses `onSnapshot()` for real-time updates.
- **Hub (active):** Tap triggers a star-wipe CSS transition. 6-tile grid (Prayer Times, Map, Announcements, Events, Donate, About). Auto-returns to ad reel after `hubIdleTimeoutSeconds` (default 30s) of inactivity.

**`admin.html` — Admin interface** (markup) + **`admin.js`** (logic) + **`admin.css`** (styles, light theme; independent of `style.css`)

Firebase email/password auth gate. Admins upload media directly to Cloudinary (unsigned upload preset — no backend), which writes the resulting URL + metadata to Firestore.

Hash-routed pages, all kept in the DOM so unsaved edits survive switching: `#home` (live overview + kiosk preview), `#reel` (three tabs: **Slides** = built-in slides + uploaded/newsletter slides; **Client submissions** = review queue, Approve writes an `ads` doc with `source: "client"`; **Client accounts** = approve/decline/suspend portal sign-ups; a red badge on the nav shows pending count), `#announcements`, `#programs` (day list + day editor + AI import from pasted text), `#settings` (lock, idle timeout, bot/AI-key status, danger zone). Sidebar on wide screens, bottom bar under 900px. Unsaved edits (announcements, a program day) show a sticky Save/Discard bar.

**`portal.html`** (+ `portal.js`, `portal.css`, which builds on `admin.css`) — Client portal

Clients sign up with email/password (`clients/{uid}` starts `pending`), wait for admin approval, then upload an image/video (Cloudinary, same unsigned preset) as a `submissions` doc and watch its status (Under review / Approved / Not approved / Withdrawn). They can withdraw a pending submission or send a fixed version after a rejection. Admins and clients share Firebase Auth, so admin.js only lets in users that have an `admins/{uid}` doc.

### Configuration (`firebase-config.js`)

Single file containing all customizable settings:
- `firebaseConfig` — Firebase project credentials
- `CLOUDINARY_CONFIG` — cloud name and upload preset
- `KIOSK_CONFIG` — masjid name, lat/long for prayer times, idle timeout, default image duration

### Data model (Firestore)

```
/ads (collection)
  url, type ("image"|"video"), title, duration, order, active, createdAt
  expiresAt (optional), source ("newsletter-auto" for bot posters), imageHash, rawMessageId

/settings/kiosk
  locked, hubIdleTimeoutSeconds,
  specialReels { prayerTimes, prayerTimesDurationSeconds, saying, sayingDurationSeconds }

/hub_content (collection)
  /announcements  { items: [{date, text}] }
  /events         { items: [{date, text}] }
  /donate         { text }
  /about          { text }
  /saying         { quote, attribution, reference, updatedBy, updatedAt }  (Saying of the Week reel)

/admins/{uid}          (created by hand in the Firebase console — marks an admin)

/clients/{uid}
  name, organization, email, phone?, status ("pending"|"approved"|"rejected"|"suspended"),
  rejectReason?, createdAt, reviewedAt

/submissions/{id}
  clientUid, clientName, organization, title, notes, url, type, bytes,
  requestedStart?, requestedEnd? (YYYY-MM-DD), replacesId?,
  status ("pending"|"approved"|"rejected"|"withdrawn"), rejectReason?,
  adId?, duration?, expiresAt?, liveFrom?, createdAt, reviewedAt, withdrawnAt
  (ads created from one also carry source:"client", submissionId, clientUid)

/hub_taps/{YYYY-MM-DD} (collection)
  count   — hub opens from the ad reel that day (kiosk's local date; locked taps not counted)
```

Firestore rules live in `firestore.rules` (paste into the Firebase console): public reads on kiosk content; writes are admin-only (`isAdmin()` = has an `admins/{uid}` doc); clients may only create their own pending `clients` doc and, once approved, create/withdraw their own `submissions`. Service-account bots bypass the rules.

### External services

| Service | Purpose |
|---|---|
| Firebase Firestore | Ad metadata + hub content |
| Firebase Auth | Admin login |
| Cloudinary | Media storage (images/videos) |
| Aladhan API | Prayer times (cached in localStorage daily) |
| Google Fonts CDN | Reem Kufi (headings), Inter (body) |

### CSS design tokens

Defined as CSS custom properties in `style.css` (kiosk only): `--bg-deep`, `--gold`, etc. Star-wipe and fade animations are keyframe-defined there. The admin page has its own tokens in `admin.css` (`--bg`, `--surface`, `--gold`, …).

### Interface of the Kiosk

the kiosk is 3840 x 2160 --  side x top


### 

## Versioning

When committing, always choose the version number yourself (look at the latest commit's `V<x.y.z>` and go up from it) — don't ask the user. Commit message format: `V<x.y.z> Kiosk - <summary>`.
- Small fixes/tweaks: bump the last number (4.1.1 → 4.1.2).
- New features: bump the middle number (4.1 → 4.2).
- Major updates/redesigns: bump the first number (4.x → 5.0).
- cp means to commit and push to github
