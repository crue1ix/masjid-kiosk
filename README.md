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

You confirmed the display runs Android — here's how to lock it to this
site and have it survive reboots/power cycles unattended:

1. On the Android device, install **Fully Kiosk Browser** from the
   Google Play Store (free; the Plus/Pro license removes a small
   watermark and unlocks scheduling, but isn't required).
2. Open it, and when prompted, set the **Start URL** to your kiosk address:
   `https://yourusername.github.io/masjid-kiosk/index.html`
3. In Fully Kiosk's settings, turn on:
   - **Kiosk Mode** (blocks the Android home/back buttons and status bar)
   - **Keep screen on**
   - **Start on boot** (so it comes back automatically after a power cut)
   - **Auto reload on error / on connection loss** (recovers from wifi drops)
   - Turn **off** Fully's own screensaver/motion-detection features — the
     kiosk page already handles its own idle-to-ad-reel behavior, so you
     don't want two systems fighting each other.
4. Do a real test: unplug the screen, plug it back in, and confirm it
   boots straight into the ad reel without you touching anything.

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
