# Newsletter bot

This bot puts newsletter content on the kiosk without anyone typing it in. A Google Apps Script runs inside a dedicated Gmail account that is subscribed to the masjid's email newsletter. Every 30 minutes it checks that inbox for new issues. It sends each issue's text and flyer images or PDFs to Gemini, then publishes what Gemini extracts to Firestore:

- **Program days** go to `programs/{YYYY-MM-DD}`, the same documents the "Parse with AI" tool in `admin.html` writes. Lines that only announce a routine salaat are skipped, just like the paste tool.
  - If a day already exists, the new items are **merged** in; nothing is overwritten. Duplicate items (same time and label) are ignored, so manual edits in admin survive.
- **Announcements** are appended to `hub_content/announcements`.
  - Duplicates (same text) are skipped.
  - Announcements the bot added are removed automatically after 30 days. Ones you add by hand are never touched.

Everything goes live right away. If the AI gets something wrong, edit or delete it in `admin.html` as usual. The Programs Calendar section of `admin.html` shows a status line with the bot's last check, the last newsletter it published and its last error.

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
- **A newsletter that changes an event's time** adds the new time next to the old one, because items are merged, not replaced. Delete the stale item in admin.

## Relationship to `whatsapp-bot/`
The WhatsApp bot does the same job from a WhatsApp group. It is no longer used, because it needs an always-on Node server and relies on an unofficial WhatsApp client. This bot replaces it.
