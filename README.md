# Masjid Al-Hayy Kiosk

A touchscreen kiosk site: plays an ad reel when idle, and opens into a "hub"
(prayer times, map, announcements, events, donate, contact) when tapped.

You do **not** need to know how to code to run this day-to-day. Setup below
is a one-time process; after that, adding a new ad is just: open a webpage,
sign in, pick a file, click Upload.

---

## Part 1 — Set up Firebase (free) — this is where ads are stored

Firebase is what makes the "upload" step simple. It gives you a private
admin page instead of needing to touch GitHub every time you add an ad.

1. Go to **console.firebase.google.com** and sign in with a Google account
   (make one dedicated to the masjid if you don't already have one for this).
2. Click **Add project**, name it something like `masjid-alhayy-kiosk`,
   and finish the setup wizard (you can skip Google Analytics).
3. In the left sidebar, click **Build > Authentication** → **Get started**
   → enable the **Email/Password** sign-in method.
   - Go to the **Users** tab → **Add user** → enter your email and a
     password. This is what you'll use to log into the admin page.
4. In the left sidebar, click **Build > Firestore Database** → **Create
   database** → start in **production mode** → pick a location close to you.
5. Click the **Rules** tab in Firestore and replace the contents with:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /ads/{adId} {
         allow read: if true;
         allow write: if request.auth != null;
       }
       match /hub_content/{docId} {
         allow read: if true;
         allow write: if request.auth != null;
       }
     }
   }
   ```
   Click **Publish**. This means: anyone can *view* the ads and hub content
   (needed for the kiosk to work), but only someone signed in (you) can
   *change* anything.

6. **Skip Firebase Storage.** As of early 2026, Google requires linking a
   credit card (the "Blaze" plan) just to turn Storage on — even though
   actual usage would stay free. We're using a different, genuinely
   free-with-no-card service (Cloudinary) for the photo/video files
   instead, covered in Part 1b below. Firestore and Authentication above
   are unaffected and stay completely free.

7. Now get your config keys: click the **gear icon > Project settings**
   (top left), scroll to **Your apps**, click the **</>** (web) icon,
   give it any nickname, click **Register app**. Firebase shows you a code
   block with a `firebaseConfig` object — copy those values into
   `firebase-config.js` in this project (replace the `PASTE_YOUR_...`
   placeholders).

---

## Part 1b — Set up Cloudinary (free, no card) — this is where photos/videos live

1. Go to **cloudinary.com** and sign up for a free account. No credit
   card is required for the free plan.
2. Once you're in, your **Dashboard** shows a **Cloud name** near the
   top — copy it.
3. Click the gear icon (**Settings**) → **Upload** tab → scroll to
   **Upload presets** → **Add upload preset**.
4. Set **Signing Mode** to **Unsigned** (this lets the admin page upload
   directly from the browser without exposing any secret keys). You can
   leave everything else default. Save it, and copy its preset name.
5. Open `firebase-config.js` and paste your **cloud name** and **preset
   name** into the `CLOUDINARY_CONFIG` section near the top.

That's it — the admin page is already wired to use these once you fill
them in.

---

## Part 2 — Customize the kiosk

Open `firebase-config.js` and edit the `KIOSK_CONFIG` section:
- `masjidName` — shown at the top of the hub
- `latitude` / `longitude` — your masjid's coordinates (used to calculate
  accurate prayer times automatically, free, no extra setup)
- `defaultImageDuration` — how long a photo ad stays up if you don't set a
  custom duration
- `hubIdleTimeoutSeconds` — how long the hub waits with no touches before
  it goes back to showing ads

Optional: replace `assets/map.jpg` with an actual photo or graphic of your
masjid's floor plan / site map — that's what shows under the "Masjid Map"
tile. If you don't add one, that tile just shows a placeholder message
until you do.

---

## Part 3 — Put it on GitHub Pages

1. Create a new **public** repository on GitHub (e.g. `masjid-kiosk`).
2. Upload all the files in this folder to that repository (drag-and-drop
   works fine on github.com — you don't need git installed for this part).
3. Go to the repo's **Settings > Pages**. Under "Build and deployment",
   set Source to **Deploy from a branch**, branch `main`, folder `/ (root)`.
   Save.
4. After a minute, GitHub gives you a URL like:
   `https://yourusername.github.io/masjid-kiosk/`
   - The kiosk display uses: `.../masjid-kiosk/index.html`
   - You (for uploading ads) use: `.../masjid-kiosk/admin.html`

---

## Part 4 — Add your first ad

1. Open the `admin.html` URL from a phone, tablet, or computer.
2. Sign in with the email/password you created in Firebase.
3. Choose an image or video file, give it a title (just for your own
   reference), set how long it should show (images only), and click
   **Upload**.
4. It shows up on the kiosk automatically — no refresh needed.
5. You can toggle any ad on/off, or delete it, from the same page.

**A note on video files:** Cloudinary's free plan gives you roughly
25 GB/month shared across storage and bandwidth, and each loop of the ad
reel on the kiosk re-requests the file, so keep videos reasonably
compressed. Most phone-shot videos are already fine — if a business
sends you a huge raw file, a free tool like HandBrake can shrink it
first. If you ever outgrow the free tier, Cloudinary will tell you
clearly rather than silently charging a card, since none is on file.

---

## Part 5 — Set up the Android screen as a kiosk

This locks the tablet so it only shows the kiosk site — no one can back
out to the home screen, settings, or other apps — and makes sure it
comes back on its own after a power cut.

We use an app called **FreeKiosk** to do the locking. It's free, does
everything you need, and has no watermark or subscription (Fully Kiosk
Browser, the more well-known option, charges to remove its watermark —
FreeKiosk gives you the same result for free).

**Setup steps:**

1. On the tablet, install **FreeKiosk** from the Google Play Store.
   (If it's not available for your device, you can download the app
   file directly from
   [github.com/RushB-fr/freekiosk/releases](https://github.com/RushB-fr/freekiosk/releases).)
2. Open FreeKiosk and enter your kiosk's web address as the **Start URL**:
   `https://crue1ix.github.io/masjid-kiosk/index.html`
3. In FreeKiosk's settings, turn **ON**:
   - **Kiosk Mode** — hides the home/back buttons and top status bar
   - **Keep screen on**
   - **Launch on boot** — so it turns back on by itself after a power cut
   - **Auto-reload on error/connection loss** — recovers from wifi drops
   - Turn screensaver/motion-detection features **OFF** (the site already
     handles switching between ads and the hub on its own)
4. Test it for real: unplug the tablet, plug it back in, and make sure it
   comes back up on its own showing the ad reel.

**Optional — for a device sitting somewhere fully public with no one
watching it:** FreeKiosk can also be set as the tablet's "Device Owner,"
which is a stronger lock that even blocks a factory reset attempt. This
needs a one-time command run from a computer — see the
[FreeKiosk docs](https://github.com/RushB-fr/freekiosk) if you want this
extra step. For most masjid setups, regular Kiosk Mode above is enough.

**No-app alternative:** Android also has a built-in **Screen Pinning**
feature (Settings → Security → Advanced → Screen pinning) that locks the
screen to one app without installing anything. It's quick to set up, but
someone can still get out of it by holding the Back button, so it's more
of a stopgap than a real replacement for FreeKiosk.

On top of all this, the kiosk site itself also has some built-in
protection: it automatically goes fullscreen when tapped, keeps the
screen from dimming/sleeping, and blocks things like right-click menus,
dragging, and pinch-zooming. Think of this as a backup layer — FreeKiosk
handles the main lock, and the site closes a few extra gaps on top of it.

---

## How it behaves, in short

- **No one at the screen:** cycles through active ads (images and videos)
  in the order you set, looping forever.
- **Someone taps the screen:** a short star-shaped transition plays, then
  the hub opens (prayer times, map, announcements, events, donate, about).
- **No touches on the hub for `hubIdleTimeoutSeconds`:** it automatically
  returns to the ad reel — or someone can tap "Back to ads" manually.

## Managing announcements / events / donate / about text

These currently pull from Firestore documents so you can update them
without touching code. In the Firebase console, go to Firestore, create a
collection called `hub_content`, and add documents with these exact IDs:

- `announcements` — field `items`: an array of objects like
  `{ "date": "Aug 29", "text": "Jumu'ah starts at 1:30pm this week." }`
- `events` — same shape as announcements
- `donate` — field `text`: a plain string (donation instructions, Zelle
  info, etc.)
- `about` — field `text`: address, phone number, social links, etc.

If you'd rather not deal with Firestore's document editor for these, say
the word and I'll build a small "Edit hub content" section into the admin
page too — same pattern as the ad uploader.
