/* ============================================================
   NEWSLETTER BOT — Google Apps Script, runs inside the dedicated
   Gmail account that's subscribed to the masjid's email newsletter.

   Every 30 minutes (see setup()) it looks for new newsletter emails,
   sends the text + any flyer images/PDFs to Gemini, and publishes the
   resulting program days and announcements straight to Firestore —
   the same documents admin.html's "Parse with AI" tool writes, so
   index.html shows them with no changes. Images Gemini identifies as
   posters are uploaded to Cloudinary and added to the ad reel.

   Setup lives in README.md next to this file. All secrets are in
   Script Properties (Project Settings -> Script Properties), never here:
     NEWSLETTER_FROM        sender address of the newsletter
     FIREBASE_PROJECT_ID    e.g. al-hayy-ad-screen
     SA_CLIENT_EMAIL        service account "client_email"
     SA_PRIVATE_KEY         service account "private_key" (the whole
                            -----BEGIN PRIVATE KEY----- ... block)
   The Gemini key is read from Firestore admin_config/gemini (apiKey),
   the same place admin.html reads it from.
   ============================================================ */

const GEMINI_MODEL = 'gemini-3.6-flash';
const GEMINI_MAX_ATTEMPTS = 4;

// Tried in order when the main model is overloaded (503) or out of
// free-tier quota (429, counted per model). Picked automatically from
// the models this API key can actually call (see pickFallbackModels_),
// so Google renaming or retiring models can't break the bot. Override
// with a GEMINI_FALLBACK_MODELS Script Property (comma-separated); run
// listGeminiModels() to see the names available.
const GEMINI_FALLBACK_COUNT = 3;
const GEMINI_FALLBACK_MAX_ATTEMPTS = 1;

// Apps Script kills a run at 6 minutes, and a single Gemini call has
// been seen to hang for over 5 before failing. No new call with images
// starts after the first budget, and no call at all after the second,
// so the text-only retry still gets a chance and the run ends cleanly
// (the email is retried next run) instead of being cut off.
const RUN_STARTED_AT = Date.now();
const GEMINI_IMAGE_BUDGET_MS = 2 * 60 * 1000;
const GEMINI_TIME_BUDGET_MS = 4 * 60 * 1000;

const SEARCH_WINDOW = 'newer_than:14d';
const MAX_FAILURES_PER_MESSAGE = 3;
const PROCESSED_ID_HISTORY = 300;

// Flyer handling — small images are logos, social icons and tracking
// pixels, not content. Gemini's inline request limit is ~20MB total.
// Big multimodal requests make Gemini's free tier answer "503 overloaded"
// on every model, so these are kept well under its ~20MB request limit.
const MIN_IMAGE_BYTES = 15 * 1024;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_IMAGES_PER_EMAIL = 6;
const MAX_INLINE_BYTES_TOTAL = 8 * 1024 * 1024;
const GEMINI_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];

// Newsletter-sourced announcements older than this are pruned on each
// write so the kiosk list doesn't grow forever. Manual ones are kept.
const ANNOUNCEMENT_MAX_AGE_DAYS = 30;

// Flyers Gemini picks out as posters are added to the ad reel. Same
// unsigned upload preset admin.html uses (public values, see
// firebase-config.js). Each poster starts with this expiry; admins can
// change it per item from the Media list's Edit form.
const CLOUDINARY_CLOUD_NAME = 'u5syafcz';
const CLOUDINARY_UPLOAD_PRESET = 'adzamszc';
const POSTER_EXPIRY_DAYS = 7;
const POSTER_DURATION_SECONDS = 8;

const LABEL_PROCESSED = 'kiosk-processed';
const LABEL_FAILED = 'kiosk-failed';

/* ============================================================
   ENTRY POINTS
   ============================================================ */

// Run once by hand: authorizes scopes, creates labels, installs the timer.
function setup() {
  getConfig_();
  GmailApp.getUserLabelByName(LABEL_PROCESSED) || GmailApp.createLabel(LABEL_PROCESSED);
  GmailApp.getUserLabelByName(LABEL_FAILED) || GmailApp.createLabel(LABEL_FAILED);

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'processNewsletters')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('processNewsletters').timeBased().everyMinutes(30).create();

  // Fails loudly now (rather than on the first timer run) if the service
  // account or Gemini key isn't set up right.
  getGeminiApiKey_(getFirestoreToken_());
  Logger.log('Setup complete — processNewsletters will run every 30 minutes.');
}

// Timer entry point. Also safe to run by hand.
function processNewsletters() {
  const config = getConfig_();
  const props = PropertiesService.getScriptProperties();
  const processed = JSON.parse(props.getProperty('PROCESSED_IDS') || '[]');
  const failures = JSON.parse(props.getProperty('FAILURE_COUNTS') || '{}');

  const token = getFirestoreToken_();
  const messages = findNewNewsletterMessages_(config.newsletterFrom, processed, failures);
  const processedLabel = GmailApp.getUserLabelByName(LABEL_PROCESSED) || GmailApp.createLabel(LABEL_PROCESSED);
  const failedLabel = GmailApp.getUserLabelByName(LABEL_FAILED) || GmailApp.createLabel(LABEL_FAILED);

  let lastSubject = null;
  let lastError = null;
  let lastSummary = null;

  let apiKey = null;
  if (messages.length > 0) {
    try {
      apiKey = getGeminiApiKey_(token);
    } catch (err) {
      lastError = err.message;
    }
  }

  // Oldest first, so a newer issue's edits win if two overlap.
  (apiKey ? messages : []).forEach(message => {
    const id = message.getId();
    try {
      const parsed = parseNewsletterMessage_(message, apiKey, token);
      const summary = publishParsed_(parsed, message, token);
      processed.push(id);
      delete failures[id];
      message.getThread().addLabel(processedLabel);
      lastSubject = message.getSubject();
      lastSummary = summary;
      Logger.log(`Processed "${message.getSubject()}": ${summary}`);
      saveProgress_(props, processed, failures);
    } catch (err) {
      // Gemini being busy or out of quota says nothing about this email —
      // just try again next run, without counting it toward giving up.
      if (err.transient) {
        lastError = `"${message.getSubject()}": ${err.message}`;
        Logger.log(`Will retry next run: ${lastError}`);
        return;
      }
      failures[id] = (failures[id] || 0) + 1;
      lastError = `"${message.getSubject()}": ${err.message}`;
      Logger.log(`Failed (${failures[id]}/${MAX_FAILURES_PER_MESSAGE}) ${lastError}`);
      if (failures[id] >= MAX_FAILURES_PER_MESSAGE) {
        message.getThread().addLabel(failedLabel);
        processed.push(id);
        delete failures[id];
      }
    }
  });

  saveProgress_(props, processed, failures);

  try {
    deleteExpiredPosters_(token);
  } catch (err) {
    Logger.log(`Expired poster cleanup failed: ${err.message}`);
  }

  // Heartbeat for admin.html — written every run so a stalled bot is visible.
  const status = { lastRunAt: new Date(), lastError: lastError || '' };
  if (lastSubject) {
    status.lastProcessedSubject = lastSubject;
    status.lastProcessedAt = new Date();
    status.lastSummary = lastSummary;
  }
  patchDoc_(token, 'admin_config/newsletter_status', status, Object.keys(status));
}

// Saved after every published email too, so a run cut off by the
// 6-minute limit doesn't redo emails it already finished.
function saveProgress_(props, processed, failures) {
  props.setProperty('PROCESSED_IDS', JSON.stringify(processed.slice(-PROCESSED_ID_HISTORY)));
  props.setProperty('FAILURE_COUNTS', JSON.stringify(failures));
}

// Debug helper: parses the most recent newsletter (or a given Gmail
// message id) and logs what would be published, without writing anything.
function testParseOnly(messageId) {
  const config = getConfig_();
  let message;
  if (messageId) {
    message = GmailApp.getMessageById(messageId);
  } else {
    const threads = GmailApp.search(`from:${config.newsletterFrom}`, 0, 1);
    if (threads.length === 0) throw new Error(`No emails from ${config.newsletterFrom} found.`);
    const msgs = threads[0].getMessages();
    message = msgs[msgs.length - 1];
  }
  const token = getFirestoreToken_();
  const apiKey = getGeminiApiKey_(token);
  const parsed = parseNewsletterMessage_(message, apiKey, token);
  Logger.log(`Subject: ${message.getSubject()} (id ${message.getId()})`);
  Logger.log(JSON.stringify({ programDays: parsed.programDays, announcements: parsed.announcements, saying: parsed.saying }, null, 2));
  if (parsed.textOnly) Logger.log('Text-only parse — no posters picked.');
  Logger.log(`Posters (${parsed.posters.length}):`);
  parsed.posters.forEach(p => Logger.log(
    `  [Image ${p.imageIndex}] "${p.title}" — ${p.mimeType}, ${Math.round(p.bytes.length / 1024)} KB${p.sourceUrl ? ', ' + p.sourceUrl : ' (attachment)'}`
  ));
}

// Setup helper: shows what the script actually reads from Script
// Properties (private key masked), to spot copy/paste mistakes.
function checkConfig() {
  const config = getConfig_();
  const key = config.privateKey;
  Logger.log(`NEWSLETTER_FROM:     [${config.newsletterFrom}]`);
  Logger.log(`FIREBASE_PROJECT_ID: [${config.projectId}]`);
  Logger.log(`SA_CLIENT_EMAIL:     [${config.clientEmail}]`);
  Logger.log(`SA_PRIVATE_KEY:      starts "${key.slice(0, 31)}", ends "${key.trim().slice(-29)}", ${key.length} chars`);
}

// Lets a newsletter that was already processed (or gave up after
// failures) be picked up again on the next run.
function forgetProcessedMessages() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('PROCESSED_IDS');
  props.deleteProperty('FAILURE_COUNTS');
  Logger.log('Cleared processed/failed history.');
}

/* ============================================================
   CONFIG
   ============================================================ */

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const config = {
    newsletterFrom: props.getProperty('NEWSLETTER_FROM'),
    projectId: props.getProperty('FIREBASE_PROJECT_ID'),
    clientEmail: props.getProperty('SA_CLIENT_EMAIL'),
    privateKey: props.getProperty('SA_PRIVATE_KEY'),
  };
  // Copying values out of the JSON key file easily picks up stray quotes,
  // trailing commas or spaces.
  Object.keys(config).forEach(k => {
    if (config[k]) config[k] = config[k].trim().replace(/,$/, '').replace(/^"|"$/g, '').trim();
  });
  const missing = Object.keys(config).filter(k => !config[k]);
  if (missing.length) {
    throw new Error('Missing Script Properties: NEWSLETTER_FROM, FIREBASE_PROJECT_ID, SA_CLIENT_EMAIL and SA_PRIVATE_KEY are all required.');
  }
  // Pasting the JSON value often keeps literal "\n" sequences.
  config.privateKey = config.privateKey.replace(/\\n/g, '\n');
  return config;
}

/* ============================================================
   GMAIL
   ============================================================ */

// Tracked per message, not per thread: Gmail groups newsletters that
// share a subject line ("Weekly Programs") into one thread, so a
// thread-level "done" label would hide every later issue.
function findNewNewsletterMessages_(fromAddress, processedIds, failures) {
  const done = new Set(processedIds);
  const from = fromAddress.toLowerCase();
  const found = [];
  GmailApp.search(`from:${fromAddress} ${SEARCH_WINDOW}`, 0, 50).forEach(thread => {
    thread.getMessages().forEach(message => {
      if (done.has(message.getId())) return;
      if (message.getFrom().toLowerCase().indexOf(from) === -1) return;
      found.push(message);
    });
  });
  return found.sort((a, b) => a.getDate() - b.getDate());
}

function getMessageText_(message) {
  const plain = (message.getPlainBody() || '').trim();
  if (plain.length > 200) return plain;
  return htmlToText_(message.getBody() || '');
}

function htmlToText_(html) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

// Collects flyer images (attached, inline, and hosted via <img src> —
// Mailchimp-style newsletters host every image on a CDN) and PDFs as
// Gemini inline_data parts. Each image is preceded by an "[Image N]"
// label so Gemini can say which ones are posters; images[N] keeps the
// bytes to upload them.
function getMediaParts_(message) {
  const parts = [];
  const images = [];
  let totalBytes = 0;
  let imageCount = 0;

  const seenDigests = new Set();

  const addBlob = (bytes, mimeType, sourceUrl) => {
    mimeType = (mimeType || '').split(';')[0].trim().toLowerCase();
    if (mimeType === 'image/jpg') mimeType = 'image/jpeg';
    const isPdf = mimeType === 'application/pdf';
    const isImage = GEMINI_IMAGE_TYPES.indexOf(mimeType) !== -1;
    if (!isPdf && !isImage) return;
    if (isImage && (bytes.length < MIN_IMAGE_BYTES || bytes.length > MAX_IMAGE_BYTES || imageCount >= MAX_IMAGES_PER_EMAIL)) return;
    if (totalBytes + bytes.length > MAX_INLINE_BYTES_TOTAL) return;
    // Newsletters often carry the same flyer twice (attached + hosted).
    const digest = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes));
    if (seenDigests.has(digest)) return;
    seenDigests.add(digest);
    totalBytes += bytes.length;
    if (isImage) {
      parts.push({ text: `[Image ${images.length}]` });
      images.push({ bytes, mimeType, digest, sourceUrl: sourceUrl || '' });
      imageCount++;
    }
    parts.push({ inline_data: { mime_type: mimeType, data: Utilities.base64Encode(bytes) } });
  };

  message.getAttachments({ includeInlineImages: true, includeAttachments: true }).forEach(att => {
    addBlob(att.getBytes(), att.getContentType(), '');
  });

  const html = message.getBody() || '';
  const scheduleEnd = findScheduleEnd_(html);
  const seen = new Set();
  const imgRe = /<img[^>]+src=["']([^"']+)["']/gi;
  let match;
  let skippedAboveSchedule = 0;
  while ((match = imgRe.exec(html)) && imageCount < MAX_IMAGES_PER_EMAIL) {
    if (match.index < scheduleEnd) {
      skippedAboveSchedule++;
      continue;
    }
    const url = match[1].replace(/&amp;/g, '&');
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    try {
      const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
      if (res.getResponseCode() !== 200) continue;
      const blob = res.getBlob();
      addBlob(blob.getBytes(), blob.getContentType() || res.getHeaders()['Content-Type'], url);
    } catch (err) {
      // An unreachable image shouldn't sink the whole newsletter.
    }
  }
  if (skippedAboveSchedule) Logger.log(`Skipped ${skippedAboveSchedule} image(s) above the end of the schedule.`);
  return { parts, images };
}

// The newsletter always puts its posters after the weekly schedule, so
// images above it (masthead, banners, "Saying of the Week") are skipped
// and don't use up MAX_IMAGES_PER_EMAIL. Returns the HTML offset of the
// last day header ("Wednesday, September 16th / 5th Night of ..."), or
// 0 to keep every image when there is no schedule in that format.
// Tags are blanked out (not removed) so offsets still line up with html.
function findScheduleEnd_(html) {
  const text = html.replace(/<[^>]*>/g, tag => ' '.repeat(tag.length));
  const sp = '(?:\\s|&nbsp;|&#160;)+';
  const dayHeader = new RegExp(
    `\\b(?:mon|tues|wednes|thurs|fri|satur|sun)day,?${sp}(?:${MONTH_NAMES.join('|')})${sp}\\d{1,2}` +
    `[\\s\\S]{0,120}?Night${sp}of\\b`, 'gi');
  let last = 0;
  let match;
  while ((match = dayHeader.exec(text))) last = match.index;
  return last;
}

/* ============================================================
   GEMINI
   ============================================================ */

// Adapted from PROGRAM_PARSE_SYSTEM_PROMPT in admin.html. A newsletter
// can carry a schedule AND several announcements at once, so instead of
// classifying the whole message into one type it extracts both lists.
const NEWSLETTER_PARSE_PROMPT = `You are extracting data from an email newsletter sent by a mosque (Masjid Al Hayy) to its community. The newsletter's content may be in the email text, inside attached/embedded flyer images, inside an attached PDF, or a mix. Read ALL of it (including every image) and extract two things: the programs schedule and community announcements. A single newsletter may contain both, only one, or neither.

Ignore newsletter boilerplate: unsubscribe links, "view in browser", mailing address footers, social media links, donation bank details, and generic greetings.

=== PART 1: Programs schedule -> programDays ===
Scheduled, dated, timed events at the masjid. Often looks like this (real example from the masjid):

Upcoming Programs at Masjid Al Hayy

Thursday, September 17th / 6th Night of Rabi al-Akhir
- 1:22 PM - Zohrain Salaat
- 7:42 PM - Maghribain Salaat
- 8:20 PM - Dua Kumayl - Dr. Syed Askari Hasan

Monday, September 21st / 10th Night of Rabi al-Akhir
Wiladat Imam Hassan Al Askari (as)
- 6:07 AM - Fajr Salaat (6:30 AM Jamaat)
- 8:10 PM - Hadith e Kisa - Ammar Ladak

Each day block usually starts with "<Weekday>, <Month> <Day><ordinal suffix> / <Nth> Night of <Hijri month>", is sometimes followed by a line naming a special occasion, then a list of "<time> - <event label>" lines. A flyer for a single event (e.g. "Majlis on Friday October 3rd at 8 PM with Maulana X") is also a program day with one item.

IMPORTANT — skip routine prayer lines: the kiosk this feeds already has a separate, always-on Prayer Times display, so do NOT include a line that is only a routine obligatory prayer announcement (Fajr Salaat, Zohrain Salaat, Asr Salaat, Maghribain Salaat, Isha Salaat), even if it has a jamaat-time note in parentheses like "(6:30 AM Jamaat)". EXCEPTION: always KEEP the Friday Jumu'ah Salaat line (any spelling, e.g. Jummah, Juma, Jumu'ah) — it is a weekly congregational event the masjid wants on the calendar. Apart from Jumu'ah, only include lines that name something beyond the routine prayer itself — a lecture, dua, recitation, ziyarat, class, breakfast, majlis, or other named activity. If a routine prayer is bundled with something extra on the same line (e.g. "Fajr Salaat, Dua Sabah, Breakfast"), keep the line since it contains real content beyond the prayer. If, after excluding pure routine-prayer lines, a day has no items left AND no special occasion, omit that day entirely. But if the day still has a named special occasion (e.g. "Wiladat Imam Hassan Al Askari (as)"), keep that day even with an empty items list.

For each day:
- monthName: full month name (e.g. "September")
- dayNumber: the day of month as an integer (e.g. 17)
- hijriSubtitle: the "Nth Night of Hijri-month" text if present, else an empty string
- specialOccasion: the special occasion line if present, else an empty string
- items: each qualifying event line, with:
  - time24: the time converted to 24-hour "HH:MM" (e.g. "1:22 PM" -> "13:22")
  - label: the event name, with any trailing "- Speaker Name" and any parenthetical removed
  - speaker: the speaker/host name if given, else an empty string
  - note: any parenthetical or short extra detail (e.g. "Dinner to follow"), else an empty string

If the same date appears more than once (e.g. in the text and again on a flyer), merge it into a single day without duplicating items.

=== PART 2: Community announcements -> announcements ===
Prose notices worth showing on a kiosk: moon-sighting declarations, upcoming special occasions, registration drives, classes starting, fundraisers, condolences, community news, etc. Do NOT turn individual scheduled program items from Part 1 into announcements too — only notices that aren't simply a timed item on the schedule.

For each announcement:
- monthName / dayNumber: the single most important date the announcement is centered on. If none is central, monthName is an empty string and dayNumber is 0.
- text: a clear, concise 1-3 sentence summary for a kiosk display — capture the key fact and any critical date; it does not need to be verbatim.
- existingIndex: the newsletter repeats notices week after week, and the kiosk may already show this one. After the newsletter you are given a numbered list "ANNOUNCEMENTS ALREADY ON THE KIOSK". If this announcement is about the same thing as one of those (same event, drive, or notice — even if worded differently or with a detail added or changed), set existingIndex to that number. Otherwise set it to -1.

List each distinct notice only once, even if the newsletter mentions it in several places.

=== PART 3: Posters -> posters ===
Each image is preceded by a label like "[Image 0]". Some images are posters that will be shown full-screen on the masjid's digital display; most others are not. A poster is a self-contained, designed graphic promoting an event, program, class, majlis, fundraiser, occasion or campaign, with readable text, that makes sense on its own (a program schedule flyer counts).
NOT posters: photos of people, places or past events; logos; newsletter header/footer banners or mastheads; email signatures; social media icons; decorative dividers; images that are only a QR code; and donation bank-detail graphics.

For each poster:
- imageIndex: the N from its "[Image N]" label
- title: a short title for it (e.g. "Majlis - Friday Oct 3"), under 60 characters

Only include an image if you are confident it is a poster; when in doubt, leave it out.

=== PART 4: Saying of the Week -> sayingOfTheWeek ===
The newsletter text usually contains a short quote under the heading "Saying of the Week", often placed in the middle of the schedule. It looks like this:

Saying of the Week
"Physical beauty is the outer beauty, and the beauty of the intellect is inner beauty."
~ Imam Hassan Al Askari (as)
Misan Ul Hikmah

Extract it exactly as written (do not paraphrase or summarize):
- quote: the saying itself, without the surrounding quotation marks
- attribution: who said it, without the leading "~" or dash (e.g. "Imam Hassan Al Askari (as)")
- reference: the book or source line after the attribution if present (e.g. "Misan Ul Hikmah"), else an empty string
If there is no Saying of the Week, return empty strings for all three. It is never a program day item or an announcement.

Return empty arrays for anything not present. Do not guess or invent content that isn't in the newsletter.`;

const NEWSLETTER_PARSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    programDays: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          monthName: { type: 'STRING' },
          dayNumber: { type: 'INTEGER' },
          hijriSubtitle: { type: 'STRING' },
          specialOccasion: { type: 'STRING' },
          items: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                time24: { type: 'STRING' },
                label: { type: 'STRING' },
                speaker: { type: 'STRING' },
                note: { type: 'STRING' }
              },
              required: ['time24', 'label', 'speaker', 'note']
            }
          }
        },
        required: ['monthName', 'dayNumber', 'hijriSubtitle', 'specialOccasion', 'items']
      }
    },
    announcements: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          monthName: { type: 'STRING' },
          dayNumber: { type: 'INTEGER' },
          text: { type: 'STRING' },
          existingIndex: { type: 'INTEGER' }
        },
        required: ['monthName', 'dayNumber', 'text', 'existingIndex']
      }
    },
    posters: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          imageIndex: { type: 'INTEGER' },
          title: { type: 'STRING' }
        },
        required: ['imageIndex', 'title']
      }
    },
    sayingOfTheWeek: {
      type: 'OBJECT',
      properties: {
        quote: { type: 'STRING' },
        attribution: { type: 'STRING' },
        reference: { type: 'STRING' }
      },
      required: ['quote', 'attribution', 'reference']
    }
  },
  required: ['programDays', 'announcements', 'posters', 'sayingOfTheWeek']
};

function parseNewsletterMessage_(message, apiKey, token) {
  // Gemini rewords each announcement every time it reads one, so repeats
  // across weekly issues can't be caught by comparing text. Instead it's
  // shown what's already on the kiosk and says which notice each one is.
  const existingDoc = getDoc_(token, 'hub_content/announcements');
  const existingAnnouncements = ((existingDoc && existingDoc.items) || []).filter(item => item.text);
  const existingList = existingAnnouncements.length
    ? existingAnnouncements.map((item, i) => `[${i}] ${item.date ? '(' + item.date + ') ' : ''}${item.text}`).join('\n')
    : '(none)';
  const text = `Subject: ${message.getSubject()}\nSent: ${message.getDate().toDateString()}\n\n${getMessageText_(message)}` +
    `\n\n=== ANNOUNCEMENTS ALREADY ON THE KIOSK ===\n${existingList}`;
  Logger.log(`Reading "${message.getSubject()}" — collecting text and images…`);
  const media = getMediaParts_(message);
  const mediaParts = media.parts;
  const fileParts = mediaParts.filter(p => p.inline_data);
  const mediaBytes = fileParts.reduce((sum, p) => sum + p.inline_data.data.length * 3 / 4, 0);
  Logger.log(`Sending to Gemini: ${text.length} chars of text + ${fileParts.length} image/PDF file(s), ${(mediaBytes / 1048576).toFixed(1)} MB…`);

  let raw;
  try {
    raw = mediaParts.length
      ? callGemini_(apiKey, [{ text }].concat(mediaParts), 3, GEMINI_IMAGE_BUDGET_MS)
      : callGemini_(apiKey, [{ text }], GEMINI_MAX_ATTEMPTS, GEMINI_TIME_BUDGET_MS);
  } catch (err) {
    // Every model rejecting a request with images at once usually means
    // the request is too heavy, not that Gemini is down — the text alone
    // still carries most newsletters' schedule.
    if (!err.transient || mediaParts.length === 0) throw err;
    Logger.log('Retrying with the email text only (no images)…');
    raw = callGemini_(apiKey, [{ text }], 2, GEMINI_TIME_BUDGET_MS);
    raw.textOnly = true;
  }
  const parsed = normalizeParsed_(raw, message.getDate());
  // Indices are resolved to text now: the list is re-read when publishing.
  parsed.announcements.forEach(a => {
    const match = existingAnnouncements[a.existingIndex];
    a.matchesText = match ? match.text : null;
  });
  parsed.textOnly = !!raw.textOnly;
  parsed.posters = parsed.textOnly ? [] : matchPosters_(raw.posters, media.images);
  return parsed;
}

// Maps Gemini's poster picks back to the image bytes that were sent.
function matchPosters_(rawPosters, images) {
  const used = new Set();
  const posters = [];
  (rawPosters || []).forEach(p => {
    const idx = p.imageIndex;
    if (!Number.isInteger(idx) || idx < 0 || idx >= images.length || used.has(idx)) return;
    used.add(idx);
    posters.push(Object.assign({ imageIndex: idx, title: (p.title || '').trim() || 'Newsletter poster' }, images[idx]));
  });
  return posters;
}

// Main model first, with the same 503 backoff as callGeminiParse() in
// admin.html, then each lighter fallback model with fewer retries (to
// stay inside Apps Script's 6-minute limit). If every model is busy or
// out of quota the error is marked transient: the next run retries it.
function callGemini_(apiKey, parts, mainAttempts, budgetMs) {
  const payload = JSON.stringify({
    system_instruction: { parts: [{ text: NEWSLETTER_PARSE_PROMPT }] },
    contents: [{ parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: NEWSLETTER_PARSE_SCHEMA
    }
  });

  const models = [GEMINI_MODEL].concat(getFallbackModels_(apiKey));
  let lastProblem = '';
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const maxAttempts = i === 0 ? (mainAttempts || GEMINI_MAX_ATTEMPTS) : GEMINI_FALLBACK_MAX_ATTEMPTS;
    if (i > 0) Logger.log(`Falling back to ${model}…`);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (Date.now() - RUN_STARTED_AT > (budgetMs || GEMINI_TIME_BUDGET_MS)) {
        const err = new Error('Ran out of time waiting on Gemini — will retry on a later run.');
        err.transient = true;
        err.outOfTime = true;
        throw err;
      }
      const res = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload,
        muteHttpExceptions: true
      });
      const code = res.getResponseCode();
      if (code === 200) {
        const data = JSON.parse(res.getContentText());
        const outText = data.candidates && data.candidates[0] && data.candidates[0].content &&
          data.candidates[0].content.parts && data.candidates[0].content.parts[0].text;
        if (!outText) throw new Error(`No response from Gemini (${model}).`);
        if (i > 0) Logger.log(`Parsed with fallback model ${model}.`);
        return JSON.parse(outText);
      }
      if (code === 503) {
        if (!lastProblem) Logger.log(`Gemini says: ${extractGeminiError_(res.getContentText())}`);
        lastProblem = 'overloaded';
        if (attempt < maxAttempts) {
          Logger.log(`${model} busy (503) — retrying (${attempt}/${maxAttempts - 1})…`);
          Utilities.sleep(Math.min(attempt * 2000, 10000));
          continue;
        }
        Logger.log(`${model} still busy.`);
        break;
      }
      if (code === 429) {
        lastProblem = 'out of quota';
        Logger.log(`${model} is out of free-tier quota.`);
        break;
      }
      if (code === 404) {
        Logger.log(`${model} isn't available to this API key — skipping it.`);
        break;
      }
      throw new Error(`Gemini API error (${model}, ${code}): ${res.getContentText().slice(0, 200)}`);
    }
  }

  const err = new Error(`Every Gemini model is ${lastProblem || 'unavailable'} right now — will retry on a later run.`);
  err.transient = true;
  throw err;
}

function extractGeminiError_(body) {
  try {
    return JSON.parse(body).error.message;
  } catch (err) {
    return body.slice(0, 200);
  }
}

function getFallbackModels_(apiKey) {
  const override = PropertiesService.getScriptProperties().getProperty('GEMINI_FALLBACK_MODELS');
  if (override) return override.split(',').map(m => m.trim()).filter(Boolean);

  const cache = CacheService.getScriptCache();
  const cached = cache.get('gemini_fallback_models');
  if (cached) return JSON.parse(cached);
  let models = [];
  try {
    models = pickFallbackModels_(fetchGeminiModelNames_(apiKey));
  } catch (err) {
    Logger.log(`Couldn't list Gemini models: ${err.message}`);
  }
  cache.put('gemini_fallback_models', JSON.stringify(models), 6 * 60 * 60);
  return models;
}

function fetchGeminiModelNames_(apiKey) {
  const res = UrlFetchApp.fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(apiKey)}`,
    { muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) throw new Error(`ListModels failed (${res.getResponseCode()}): ${res.getContentText().slice(0, 200)}`);
  return (JSON.parse(res.getContentText()).models || [])
    .filter(m => (m.supportedGenerationMethods || []).indexOf('generateContent') !== -1)
    .map(m => m.name.replace('models/', ''));
}

// Text-capable "flash" models other than the main one: versions up to
// the main one's first (newer ones tend to be the most in demand and
// the first to report busy), newest first, full before lite. Skips specialty variants (image generation,
// speech, live audio) that can't return the JSON this needs.
function pickFallbackModels_(names) {
  const version = n => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0');
  const isLite = n => /lite/.test(n) ? 1 : 0;
  const isPreview = n => /preview|exp/.test(n) ? 1 : 0;
  const mainVersion = version(GEMINI_MODEL);
  const isNewer = n => version(n) > mainVersion ? 1 : 0;
  return names
    .filter(n => n !== GEMINI_MODEL && /^gemini-.*flash/.test(n) && !/image|tts|audio|live|embed|thinking/.test(n))
    .sort((a, b) => isNewer(a) - isNewer(b) || version(b) - version(a) || isPreview(a) - isPreview(b) || isLite(a) - isLite(b) || a.localeCompare(b))
    .slice(0, GEMINI_FALLBACK_COUNT);
}

// Setup helper: logs the Gemini models this API key can call, and which
// ones the bot would pick as fallbacks.
function listGeminiModels() {
  const apiKey = getGeminiApiKey_(getFirestoreToken_());
  const names = fetchGeminiModelNames_(apiKey);
  names.forEach(n => Logger.log(n));
  Logger.log(`Automatic fallbacks: ${pickFallbackModels_(names).join(', ') || '(none found)'}`);
  CacheService.getScriptCache().remove('gemini_fallback_models');
}

/* ============================================================
   NORMALIZE — same safety nets as renderParsePreview() in admin.html
   ============================================================ */

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

// Same Dec -> Jan rollover logic as resolveProgramYear() in admin.html,
// with the email's sent date as the reference.
function resolveYear_(monthName, dayNumber, referenceDate) {
  const refYear = referenceDate.getFullYear();
  const refMonthIdx = referenceDate.getMonth();
  const eventMonthIdx = MONTH_NAMES.indexOf(String(monthName || '').toLowerCase());
  let year = refYear;
  if (eventMonthIdx !== -1 && eventMonthIdx < refMonthIdx - 1) year = refYear + 1;
  const mm = String((eventMonthIdx === -1 ? refMonthIdx : eventMonthIdx) + 1).padStart(2, '0');
  const dd = String(dayNumber).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

// Matches formatDateForDisplay() in admin.html ("September 22, 2026").
function formatDateForDisplay_(isoStr) {
  const [y, m, d] = isoStr.split('-').map(Number);
  const name = MONTH_NAMES[m - 1];
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${d}, ${y}`;
}

function normalizeParsed_(raw, referenceDate) {
  const byDate = {};
  (raw.programDays || []).forEach(day => {
    if (!day.monthName || !day.dayNumber) return;
    const isoDate = resolveYear_(day.monthName, day.dayNumber, referenceDate);
    const items = (day.items || [])
      .map(item => ({
        time: item.time24 || '',
        label: item.label || '',
        speaker: item.speaker || '',
        note: item.note || ''
      }))
      .filter(item => item.time && item.label);
    const existing = byDate[isoDate];
    if (existing) {
      existing.items = mergeItems_(existing.items, items);
      existing.hijriSubtitle = existing.hijriSubtitle || day.hijriSubtitle || null;
      existing.specialOccasion = existing.specialOccasion || day.specialOccasion || null;
    } else {
      byDate[isoDate] = {
        isoDate,
        hijriSubtitle: day.hijriSubtitle || null,
        specialOccasion: day.specialOccasion || null,
        items: mergeItems_([], items)
      };
    }
  });
  const programDays = Object.keys(byDate).sort()
    .map(k => byDate[k])
    .filter(day => day.items.length > 0 || day.specialOccasion);

  const announcements = (raw.announcements || [])
    .filter(a => a.text && a.text.trim())
    .map(a => ({
      date: (a.monthName && a.dayNumber)
        ? formatDateForDisplay_(resolveYear_(a.monthName, a.dayNumber, referenceDate))
        : '',
      text: a.text.trim(),
      existingIndex: Number.isInteger(a.existingIndex) ? a.existingIndex : -1
    }));

  const s = raw.sayingOfTheWeek || {};
  const quote = String(s.quote || '').trim().replace(/^["“”']+|["“”']+$/g, '').trim();
  const saying = quote ? {
    quote,
    attribution: String(s.attribution || '').trim().replace(/^[~\-–—\s]+/, ''),
    reference: String(s.reference || '').trim()
  } : null;

  return { programDays, announcements, saying };
}

function itemKey_(item) {
  return `${item.time}|${String(item.label).toLowerCase().replace(/\s+/g, ' ').trim()}`;
}

// Existing items win on conflict, so a manual edit in admin.html isn't
// overwritten by a later newsletter repeating the same event.
function mergeItems_(existingItems, newItems) {
  const seen = new Set();
  const merged = [];
  existingItems.concat(newItems).forEach(item => {
    const key = itemKey_(item);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  });
  return merged.sort((a, b) => a.time.localeCompare(b.time));
}

/* ============================================================
   PUBLISH
   ============================================================ */

function publishParsed_(parsed, message, token) {
  const now = new Date();
  const messageId = message.getId();

  parsed.programDays.forEach(day => {
    const path = `programs/${day.isoDate}`;
    const existing = getDoc_(token, path);
    const doc = {
      date: day.isoDate,
      hijriSubtitle: (existing && existing.hijriSubtitle) || day.hijriSubtitle,
      specialOccasion: (existing && existing.specialOccasion) || day.specialOccasion,
      items: mergeItems_((existing && existing.items) || [], day.items),
      source: existing && existing.source === 'manual' ? 'manual' : 'newsletter-auto',
      createdAt: (existing && existing.createdAt) || now,
      updatedAt: now,
      rawMessageId: messageId
    };
    patchDoc_(token, path, doc);
  });

  let added = 0;
  let updated = 0;
  if (parsed.announcements.length > 0) {
    const path = 'hub_content/announcements';
    const existing = getDoc_(token, path);
    const cutoff = now.getTime() - ANNOUNCEMENT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const items = ((existing && existing.items) || []).filter(item =>
      item.source !== 'newsletter-auto' || !item.addedAt || new Date(item.addedAt).getTime() >= cutoff
    );
    const normalize = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const seenText = new Set(items.map(item => normalize(item.text)));
    const touched = new Set();
    // Looked up by the text Gemini was shown, which an earlier repeat in
    // this same email may already have replaced.
    const byOriginalText = new Map(items.map(item => [item.text, item]));
    parsed.announcements.forEach(a => {
      // A repeat of a notice already on the kiosk: the bot's own copy takes
      // the newest wording (it may add or change a detail) and its 30-day
      // clock restarts; one typed in by hand in admin is left alone.
      const match = a.matchesText ? byOriginalText.get(a.matchesText) : null;
      if (match) {
        if (touched.has(match)) return;
        touched.add(match);
        if (match.source === 'newsletter-auto') {
          match.text = a.text;
          match.date = a.date || match.date;
          match.addedAt = now.toISOString();
          seenText.add(normalize(a.text));
          updated++;
        }
        return;
      }
      if (seenText.has(normalize(a.text))) return;
      seenText.add(normalize(a.text));
      items.push({ date: a.date, text: a.text, source: 'newsletter-auto', addedAt: now.toISOString() });
      added++;
    });
    // Always written, so the age-based prune applies even when nothing new was added.
    patchDoc_(token, path, { items }, ['items']);
  }

  // Each newsletter's saying replaces the last one (emails run oldest
  // first, so the newest wins), including one typed in by hand in admin.
  if (parsed.saying) {
    patchDoc_(token, 'hub_content/saying', Object.assign({}, parsed.saying, {
      updatedBy: 'newsletter-auto',
      updatedAt: now,
      rawMessageId: messageId
    }));
  }

  const posterResult = publishPosters_(parsed.posters, message, token);

  return `${parsed.programDays.length} program day(s), ${added} new announcement(s), ` +
    (updated ? `${updated} repeated announcement(s) updated, ` : '') +
    `${posterResult.added} new poster(s)` +
    (parsed.saying ? ', saying of the week updated' : '') +
    (posterResult.renewed ? `, ${posterResult.renewed} renewed` : '') +
    (posterResult.failed ? `, ${posterResult.failed} poster upload(s) failed` : '') +
    (parsed.textOnly ? ' — text only, flyer images were skipped' : '');
}

// Adds each poster to the ad reel, expiring after POSTER_EXPIRY_DAYS.
// Weekly newsletters often repeat a flyer, so one already added by the
// bot just gets its expiry pushed out instead of a second copy — never
// pulled in, and never added back if an admin cleared it in the Edit form.
function publishPosters_(posters, message, token) {
  const result = { added: 0, renewed: 0, failed: 0 };
  if (!posters.length) return result;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + POSTER_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  const existingByHash = {};
  listCollection_(token, 'ads').forEach(ad => {
    if (ad.source === 'newsletter-auto' && ad.imageHash) existingByHash[ad.imageHash] = ad;
  });

  posters.forEach(poster => {
    try {
      const existing = existingByHash[poster.digest];
      if (existing) {
        if (existing.expiresAt instanceof Date && existing.expiresAt < expiresAt) {
          patchDoc_(token, `ads/${existing.id}`, { expiresAt }, ['expiresAt']);
          existing.expiresAt = expiresAt;
          result.renewed++;
        }
        return;
      }
      const url = uploadToCloudinary_(poster.bytes, poster.mimeType);
      const doc = {
        url,
        type: 'image',
        title: poster.title,
        duration: POSTER_DURATION_SECONDS,
        order: 999,
        active: true,
        expiresAt,
        source: 'newsletter-auto',
        imageHash: poster.digest,
        rawMessageId: message.getId(),
        createdAt: now
      };
      doc.id = createDoc_(token, 'ads', doc);
      existingByHash[poster.digest] = doc;
      result.added++;
    } catch (err) {
      result.failed++;
      Logger.log(`Poster "${poster.title}" failed: ${err.message}`);
    }
  });
  return result;
}


// The kiosk already hides expired ads; this removes the bot's own expired
// posters so the admin Media list doesn't fill up. Manual uploads are left
// alone. (The Cloudinary file stays — an unsigned preset can't delete.)
function deleteExpiredPosters_(token) {
  const now = Date.now();
  let deleted = 0;
  listCollection_(token, 'ads').forEach(ad => {
    if (ad.source !== 'newsletter-auto' || !(ad.expiresAt instanceof Date)) return;
    if (ad.expiresAt.getTime() > now) return;
    deleteDoc_(token, `ads/${ad.id}`);
    deleted++;
  });
  if (deleted) Logger.log(`Removed ${deleted} expired newsletter poster(s).`);
}

function uploadToCloudinary_(bytes, mimeType) {
  const res = UrlFetchApp.fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
    method: 'post',
    payload: {
      file: `data:${mimeType};base64,${Utilities.base64Encode(bytes)}`,
      upload_preset: CLOUDINARY_UPLOAD_PRESET
    },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(`Cloudinary upload failed (${res.getResponseCode()}): ${res.getContentText().slice(0, 200)}`);
  }
  return JSON.parse(res.getContentText()).secure_url;
}

/* ============================================================
   FIRESTORE REST (service account auth)
   ============================================================ */

function getFirestoreToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('firestore_token');
  if (cached) return cached;

  const config = getConfig_();
  const nowSec = Math.floor(Date.now() / 1000);
  const b64 = obj => Utilities.base64EncodeWebSafe(JSON.stringify(obj)).replace(/=+$/, '');
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
    iss: config.clientEmail,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSec,
    exp: nowSec + 3600
  });
  const signature = Utilities.base64EncodeWebSafe(
    Utilities.computeRsaSha256Signature(unsigned, config.privateKey)
  ).replace(/=+$/, '');

  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`
    },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(`Service account auth failed (${res.getResponseCode()}): ${res.getContentText().slice(0, 200)}`);
  }
  const token = JSON.parse(res.getContentText()).access_token;
  cache.put('firestore_token', token, 3000);
  return token;
}

function getGeminiApiKey_(token) {
  const doc = getDoc_(token, 'admin_config/gemini');
  if (!doc || !doc.apiKey) throw new Error('No Gemini API key found in Firestore admin_config/gemini (field apiKey).');
  return doc.apiKey;
}

function firestoreUrl_(path) {
  const projectId = PropertiesService.getScriptProperties().getProperty('FIREBASE_PROJECT_ID');
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`;
}

// Returns the document as a plain object, or null if it doesn't exist.
function getDoc_(token, path) {
  const res = UrlFetchApp.fetch(firestoreUrl_(path), {
    headers: { Authorization: `Bearer ${token}` },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() === 404) return null;
  if (res.getResponseCode() !== 200) {
    throw new Error(`Firestore read ${path} failed (${res.getResponseCode()}): ${res.getContentText().slice(0, 200)}`);
  }
  return fromFirestoreFields_(JSON.parse(res.getContentText()).fields || {});
}

// Without updateMask this replaces the whole document (like set());
// with one, only those fields are touched (like set(..., {merge:true})).
function patchDoc_(token, path, data, updateMask) {
  let url = firestoreUrl_(path);
  if (updateMask) {
    url += '?' + updateMask.map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');
  }
  const res = UrlFetchApp.fetch(url, {
    method: 'patch',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${token}` },
    payload: JSON.stringify({ fields: toFirestoreFields_(data) }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(`Firestore write ${path} failed (${res.getResponseCode()}): ${res.getContentText().slice(0, 200)}`);
  }
}

// Creates a document with an auto-generated ID and returns that ID.
function createDoc_(token, collectionPath, data) {
  const res = UrlFetchApp.fetch(firestoreUrl_(collectionPath), {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${token}` },
    payload: JSON.stringify({ fields: toFirestoreFields_(data) }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(`Firestore create in ${collectionPath} failed (${res.getResponseCode()}): ${res.getContentText().slice(0, 200)}`);
  }
  return JSON.parse(res.getContentText()).name.split('/').pop();
}

function deleteDoc_(token, path) {
  const res = UrlFetchApp.fetch(firestoreUrl_(path), {
    method: 'delete',
    headers: { Authorization: `Bearer ${token}` },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200 && res.getResponseCode() !== 404) {
    throw new Error(`Firestore delete ${path} failed (${res.getResponseCode()}): ${res.getContentText().slice(0, 200)}`);
  }
}

// Every document in a collection as plain objects, each with its `id`.
function listCollection_(token, collectionPath) {
  const docs = [];
  let pageToken = '';
  do {
    let url = `${firestoreUrl_(collectionPath)}?pageSize=300`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
    const res = UrlFetchApp.fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      throw new Error(`Firestore list ${collectionPath} failed (${res.getResponseCode()}): ${res.getContentText().slice(0, 200)}`);
    }
    const data = JSON.parse(res.getContentText());
    (data.documents || []).forEach(d => {
      const obj = fromFirestoreFields_(d.fields || {});
      obj.id = d.name.split('/').pop();
      docs.push(obj);
    });
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return docs;
}

function toFirestoreValue_(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreValue_) } };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === 'object') return { mapValue: { fields: toFirestoreFields_(value) } };
  return { stringValue: String(value) };
}

function toFirestoreFields_(obj) {
  const fields = {};
  Object.keys(obj).forEach(k => { fields[k] = toFirestoreValue_(obj[k]); });
  return fields;
}

function fromFirestoreValue_(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFirestoreValue_);
  if ('mapValue' in v) return fromFirestoreFields_(v.mapValue.fields || {});
  return null;
}

function fromFirestoreFields_(fields) {
  const obj = {};
  Object.keys(fields).forEach(k => { obj[k] = fromFirestoreValue_(fields[k]); });
  return obj;
}
