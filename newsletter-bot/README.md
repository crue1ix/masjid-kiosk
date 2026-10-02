# Newsletter bot

This bot puts newsletter content on the kiosk without anyone typing it in. A Google Apps Script runs inside a dedicated Gmail account that is subscribed to the masjid's email newsletter. Every 30 minutes it checks that inbox for new issues. It sends each issue's text and flyer images or PDFs to Gemini, then publishes what Gemini extracts to Firestore:

- **Program days** go to `programs/{YYYY-MM-DD}`, the same documents the "Import a schedule from text" tool in `admin.html` writes. Lines that only announce a routine salaat are skipped, just like the paste tool. Friday's Jumu'ah Salaat is the exception and is always kept.
  - If a day already exists, the new items are **merged** in; nothing is overwritten. Duplicate items (same time and label) are ignored, so manual edits in admin survive.
- **Announcements** are appended to `hub_content/announcements`.
  - Repeats are caught even when worded differently. Gemini is shown the announcements already on the kiosk and says which one each new announcement repeats. A repeat updates the bot's existing card with the newest wording instead of adding another. Cards you typed in by hand are never changed.
  - Announcements the bot added are removed automatically after 30 days. Ones you add by hand are never touched.
  - If you edit the text of one the bot added, it becomes yours (marked "Edited by you" in admin): the bot won't reword it or auto-remove it.

- **Saying of the Week** is copied word-for-word into `hub_content/saying` (`quote`, `attribution`, `reference`). Each newsletter's saying replaces the last one. The kiosk shows it as a built-in slide, which you turn on in admin under **Ad Reel → Built-in slides**. You can fix the text with its **Edit** button.
- **Posters** go into the ad reel (`ads`).
  - Gemini looks at every image in the email and picks out the posters: designed flyers for an event, program, class, fundraiser or occasion. It skips logos, header banners, photos, social icons, QR-only images and bank-detail graphics.
  - Each poster is uploaded to Cloudinary and goes live in the reel right away, tagged **📧 From newsletter** on admin's Ad Reel page.
  - Each poster is set to expire **7 days** after it's added (`POSTER_EXPIRY_DAYS` in `Code.gs`). To change one poster's expiry, click **Edit** on it in the Ad Reel page and pick a new "Remove automatically on" date, or clear the date to keep it indefinitely.
  - If a later newsletter carries the same flyer again (same file), the existing ad's expiry is pushed out to 7 days from then instead of adding a copy. The bot never shortens an expiry you set, and never adds one back to a poster you cleared.
  - Expired bot posters are deleted from `ads` on the next run. Manual uploads are never touched. The file stays in Cloudinary, because the unsigned preset can't delete it.

Everything goes live right away. If the AI gets something wrong, edit or delete it in `admin.html` as usual. The admin Home page shows the bot's health (green, amber or red), and Settings → Newsletter bot shows its last check, the last newsletter it published and its last error.

It costs nothing to run: Apps Script, Gmail and the Gemini free tier are all free, and there is no server to host.

---

## One-time setup (about 15 minutes)

### 1. Create the Gmail account
1. Create a new Gmail account for the bot, e.g. `alhayy.kiosk.bot@gmail.com`.
2. Subscribe it to the masjid newsletter the same way a community member would.
3. When the first issue arrives, note the exact **sender address**.
4. In Gmail, go to Settings → Filters. Create a filter for `from:<sender address>` with **Never send it to Spam** and **Categorize as: Primary** checked.

### 2. Create a Firebase service account key
The bot uses this key to write to Firestore. Because it is a service account, it bypasses the security rules, so you don't need to change any rules.

1. Open the Firebase Console → ⚙ Project settings → **Service accounts**.
2. Click **Generate new private key**. A JSON file downloads.
3. **Keep this file private.** Don't commit it and don't email it. Anyone who has it can write to the database.

### 3. Create the Apps Script project
Do this while **signed in as the bot Gmail account**.

1. Go to <https://script.google.com> → **New project**, and name it "Kiosk Newsletter Bot".
2. Replace the contents of `Code.gs` with this folder's `Code.gs`.
3. Show the manifest: ⚙ Project Settings → tick **Show "appsscript.json" manifest file in editor**. Replace its contents with this folder's `appsscript.json`.
4. In ⚙ Project Settings → **Script Properties**, add:

   | Property | Value |
   |---|---|
   | `NEWSLETTER_FROM` | the newsletter's sender address |
   | `FIREBASE_PROJECT_ID` | `project_id` from the JSON key (`al-hayy-ad-screen`) |
   | `SA_CLIENT_EMAIL` | `client_email` from the JSON key |
   | `SA_PRIVATE_KEY` | `private_key` from the JSON key: the whole `-----BEGIN PRIVATE KEY-----…-----END PRIVATE KEY-----\n` string. Pasting it with literal `\n` sequences is fine. |

5. Delete the downloaded JSON key file from your computer. The values now live only in Script Properties.

The bot uses the same Gemini key the admin page does: `admin_config/gemini` → `apiKey` in Firestore. To rotate the key, change it there.

### 4. Test it, then turn it on
1. In the editor, pick **`testParseOnly`** from the function dropdown and click **Run**.
   - Approve the permissions prompt. Google warns that the app is unverified; click Advanced → Go to project. This is expected for your own scripts.
   - The function parses the most recent newsletter and **only logs** the result; it writes nothing.
   - Check the execution log. Program days and times should be right, routine salaat lines should be gone, and the announcements should make sense.
2. Pick **`setup`** and click **Run**. This creates the Gmail labels and installs the 30-minute timer.
3. Optionally, pick **`processNewsletters`** and click **Run** to publish the recent newsletter now, instead of waiting for the timer. Then check the kiosk.

---

## Day-to-day

- **The bot looks at emails from the last 14 days.** It tracks each email by ID, so every email is processed once. It also adds a `kiosk-processed` label in Gmail so you can see what it handled.
- **Failures:**
  - A failed email is retried on the next run.
  - After 3 failures the email gets the `kiosk-failed` label and is skipped.
  - Gemini being overloaded (503) or out of quota (429) does **not** count as a failure. The email is simply retried on the next run.
  - To reprocess everything, run `forgetProcessedMessages`, then `processNewsletters`.
- **Gemini fallback models:**
  - If the main model (`gemini-3.6-flash`) is overloaded or out of quota, the bot switches to lighter "flash" models.
  - It picks them automatically from the models your API key can actually use: newest first, full before lite, up to 3.
  - Run `listGeminiModels` to see every available model and which ones it would pick.
  - To choose them yourself instead, add a Script Property `GEMINI_FALLBACK_MODELS` with a comma-separated list of names from that output.
- **Logs:** open the Apps Script editor → **Executions** to see each run and its output.
- **Changing the extraction:** the prompt is `NEWSLETTER_PARSE_PROMPT` in `Code.gs`. After editing it in the repo, paste the updated file into the Apps Script editor; it does not sync automatically.
- **Poster limits:**
  - The newsletter puts its posters after the weekly schedule, so images above the last day header (`<Weekday>, <Month> <Day> / <Nth> Night of …`) are skipped. If no day header in that format is found, every image is considered.
  - Only the first 6 images (after the schedule) per email are looked at, and only ones between 15 KB and 3 MB (`MAX_IMAGES_PER_EMAIL`, `MAX_IMAGE_BYTES` in `Code.gs`). A poster over 3 MB, or one that comes after 6 other images, is missed.
  - If Gemini is too busy and the bot falls back to text only, that email's posters are skipped.
  - If the newsletter re-encodes the same flyer, it can appear twice. Delete the extra one in admin.
  - `testParseOnly` logs which images it would add as posters, without uploading anything.
- **A newsletter that changes an event's time** adds the new time next to the old one, because items are merged, not replaced. Delete the stale item in admin.

## Relationship to `whatsapp-bot/`
The WhatsApp bot does the same job from a WhatsApp group. It is no longer used, because it needs an always-on Node server and relies on an unofficial WhatsApp client. This bot replaces it.
