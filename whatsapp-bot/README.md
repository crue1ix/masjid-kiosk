# Masjid Al-Hayy WhatsApp Bot

Watches the mosque's WhatsApp announcements group and automatically publishes:
- Weekly **programs schedule** text messages → parsed by Gemini (free tier) into the kiosk's `programs` Firestore collection (feeds the Events tile calendar in `index.html`).
- **Flyer photos/videos** posted to the group → uploaded to Cloudinary and added to the kiosk's ad reel (`ads` collection), auto-expiring after a set number of days.

This is a separate, always-on Node.js service — it is **not** part of the static kiosk site and needs its own host.

## ⚠️ Read this before setting it up

This bot connects to WhatsApp using **Baileys**, an unofficial library that implements the WhatsApp Web protocol. It is **not an official WhatsApp/Meta API**. That means:

- **It violates WhatsApp's Terms of Service.** The linked phone number carries a real risk of being banned or rate-limited.
- **Use a secondary/dedicated WhatsApp number for this**, not the mosque's main line, so a ban (if it happens) doesn't disrupt anyone's actual WhatsApp.
- **This needs an always-on host.** A small VPS (~$5-6/mo from any standard provider) is the simplest reliable option. A spare Raspberry Pi at the mosque works too, as a free alternative, but depends on the mosque's power/internet staying up.
- **There is no human review step.** Everything this bot writes is tagged `source: "whatsapp-auto"` in Firestore so it can be spotted and corrected afterward in `admin.html`'s "Programs Calendar" section — but nothing blocks it from publishing automatically, by design.
- **Occasional re-linking is normal**, not a bug. WhatsApp sessions can get logged out server-side; when that happens you'll need to delete `data/baileys_auth` and scan a new QR code.

## One-time setup

### 1. Firebase service account

Firebase Console → your project → **Project Settings → Service Accounts → Generate new private key**. Save the downloaded file as `serviceAccountKey.json` in this directory (`whatsapp-bot/serviceAccountKey.json`). **Never commit this file** — it's already gitignored.

### 2. Install dependencies

Requires **Node.js 18 or newer** (uses global `fetch`/`FormData`/`Blob`).

```
cd whatsapp-bot
npm install
```

### 3. Configure environment

```
cp .env.example .env
```

Fill in:
- `GEMINI_API_KEY` — free, from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (sign in with any Google account, click "Create API key")
- `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_UPLOAD_PRESET` — same values as `CLOUDINARY_CONFIG` in the main site's `firebase-config.js`
- Leave `WHATSAPP_GROUP_JID` blank for now (next step finds it)

### 4. Link WhatsApp and find the group ID

```
npm run list-groups
```

Scan the printed QR code with the WhatsApp account you're dedicating to this bot (**Settings → Linked Devices → Link a Device**). Once connected, it prints every group that account is a member of, e.g.:

```
120363012345678901@g.us  —  Masjid Al Hayy Announcements
```

Copy the correct group's id into `.env` as `WHATSAPP_GROUP_JID`.

### 5. Update Firestore security rules

The kiosk's Firestore rules are managed in the Firebase Console (not in this repo) and only cover collections that existed when they were written. Make sure a `programs` block exists alongside `ads`/`hub_content`/`settings`:

```
match /programs/{date} {
  allow read: if true;
  allow write: if request.auth != null;
}
```

(The bot writes via the Firebase Admin SDK, which bypasses these rules entirely — this step is really for the kiosk's own public reads and `admin.html`'s manual editor.)

### 6. Run it

```
npm start
```

On success you'll see `WhatsApp connected.` and the bot will start watching the configured group in real time.

## Running it long-term

Use a process manager so it survives reboots and restarts automatically on crashes.

**pm2:**
```
npm install -g pm2
pm2 start src/index.js --name whatsapp-bot
pm2 save
pm2 startup
```

**systemd** (example unit file, adjust paths/user):
```ini
[Unit]
Description=Masjid Al-Hayy WhatsApp bot
After=network.target

[Service]
WorkingDirectory=/path/to/masjid-kiosk/whatsapp-bot
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
User=youruser

[Install]
WantedBy=multi-user.target
```

## How it decides what to publish

- **Every text message** from the configured group is sent to Gemini with the exact expected announcement format. Gemini both classifies ("is this actually a programs announcement?") and extracts structured data in one call — casual chat, replies, and one-off notices are ignored, not force-fit into the schema.
- **Every image/video** posted to the group is uploaded and added to the ad reel with an expiry date — no filtering, since only admins are expected to post there.
- A corrected re-post of the same week's announcement **fully overwrites** each day it mentions (not a merge), so re-sending a fixed announcement cleanly replaces the earlier parse.

## Troubleshooting

- **"WhatsApp session logged out"** — delete `data/baileys_auth/` and run `npm start` again to re-link with a fresh QR code.
- **Nothing gets published** — check the console output; every ignored message logs why (not from the configured group, or Gemini classified it as not an announcement).
- **"Missing required .env values"** on startup — fill in whatever it lists; `--list-groups` mode doesn't need these, but normal `npm start` does.
