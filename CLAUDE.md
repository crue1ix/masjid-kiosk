# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Masjid Al-Hayy Kiosk — a touchscreen kiosk app for mosques. It shows an advertising reel when idle and switches to an interactive hub (prayer times, map, announcements, events, donations, contact) on tap.

**No build process.** Pure vanilla HTML/CSS/JS with Firebase and Cloudinary loaded from CDN. Open files directly in a browser or push to GitHub Pages.

## Running the App

- **Local testing:** Open `index.html` or `admin.html` directly in a browser (requires internet for Firebase/Aladhan API)
- **Production:** Push to `main` branch; GitHub Pages serves both HTML files
- **Physical kiosk:** Fully Kiosk Browser (Android) pointed at the GitHub Pages URL

## Architecture

### Two HTML pages

**`index.html` — Public kiosk display**

Two modes managed entirely in JavaScript with no routing:
- **Ad Reel (idle):** Cycles through Firestore `ads` collection. Images advance by `duration` field (default 8s); videos play to completion. Uses `onSnapshot()` for real-time updates.
- **Hub (active):** Tap triggers a star-wipe CSS transition. 6-tile grid (Prayer Times, Map, Announcements, Events, Donate, About). Auto-returns to ad reel after `hubIdleTimeoutSeconds` (default 30s) of inactivity.

**`admin.html` — Admin interface**

Firebase email/password auth gate. Admins upload media directly to Cloudinary (unsigned upload preset — no backend), which writes the resulting URL + metadata to Firestore.

### Configuration (`firebase-config.js`)

Single file containing all customizable settings:
- `firebaseConfig` — Firebase project credentials
- `CLOUDINARY_CONFIG` — cloud name and upload preset
- `KIOSK_CONFIG` — masjid name, lat/long for prayer times, idle timeout, default image duration

### Data model (Firestore)

```
/ads (collection)
  url, type ("image"|"video"), title, duration, order, active, createdAt

/hub_content (collection)
  /announcements  { items: [{date, text}] }
  /events         { items: [{date, text}] }
  /donate         { text }
  /about          { text }
```

Firestore rules: public reads; authenticated writes only.

### External services

| Service | Purpose |
|---|---|
| Firebase Firestore | Ad metadata + hub content |
| Firebase Auth | Admin login |
| Cloudinary | Media storage (images/videos) |
| Aladhan API | Prayer times (cached in localStorage daily) |
| Google Fonts CDN | Reem Kufi (headings), Inter (body) |

### CSS design tokens

Defined as CSS custom properties in `style.css`: `--bg-deep`, `--gold`, etc. Star-wipe and fade animations are keyframe-defined there.
