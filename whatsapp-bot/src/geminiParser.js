const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const config = require('./config');

// Lazy client so importing this module never fails just because
// GEMINI_API_KEY isn't set yet (e.g. during `--list-groups` first run).
let model = null;
function getModel() {
  if (!model) {
    const genAI = new GoogleGenerativeAI(config.geminiApiKey);
    model = genAI.getGenerativeModel({
      model: config.geminiModel,
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA
      }
    });
  }
  return model;
}

const SYSTEM_PROMPT = `You are extracting structured data from WhatsApp messages posted by a mosque (Masjid Al Hayy) to its community announcements group.

The mosque's weekly programs announcement looks like this (real example):

Salaamun Alaykum,

Upcoming Programs at Masjid Al Hayy

Thursday, September 17th / 6th Night of Rabi al-Akhir
- 1:22 PM - Zohrain Salaat
- 7:42 PM - Maghribain Salaat
- 8:20 PM - Dua Kumayl - Dr. Syed Askari Hasan

Monday, September 21st / 10th Night of Rabi al-Akhir
Wiladat Imam Hassan Al Askari (as)
- 6:07 AM - Fajr Salaat (6:30 AM Jamaat)
- 8:10 PM - Hadith e Kisa - Ammar Ladak

Each day block starts with "<Weekday>, <Month> <Day><ordinal suffix> / <Nth> Night of <Hijri month>",
is sometimes followed by a line naming a special occasion (e.g. "Wiladat Imam Hassan Al Askari (as)"),
then a bulleted list of "<time> - <event label>" lines. A label may have a trailing "- Speaker Name"
(whoever is giving a lecture/dua) or a parenthetical note like "(6:30 AM Jamaat)".

Respond with isAnnouncement: false and an empty days array if the message is NOT this kind of programs
announcement (casual chat, a one-off notice, a reply, a flyer caption, anything else) — do not guess or
force-fit unrelated text into this schema.

For each day found:
- monthName: full month name (e.g. "September")
- dayNumber: the day of month as an integer (e.g. 17)
- hijriSubtitle: the "Nth Night of Hijri-month" text if present, else an empty string
- specialOccasion: the special occasion line if present, else an empty string
- items: each bulleted line, with:
  - time24: the time converted to 24-hour "HH:MM" (e.g. "1:22 PM" -> "13:22")
  - label: the event name, with any trailing "- Speaker Name" and any parenthetical removed
  - speaker: the trailing "- Name" if present, else an empty string
  - note: the parenthetical content if present (without the parentheses), else an empty string`;

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    isAnnouncement: {
      type: SchemaType.BOOLEAN,
      description: 'True only if this message is a program/schedule announcement in the known format.'
    },
    days: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          monthName: { type: SchemaType.STRING },
          dayNumber: { type: SchemaType.INTEGER },
          hijriSubtitle: { type: SchemaType.STRING },
          specialOccasion: { type: SchemaType.STRING },
          items: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                time24: { type: SchemaType.STRING },
                label: { type: SchemaType.STRING },
                speaker: { type: SchemaType.STRING },
                note: { type: SchemaType.STRING }
              },
              required: ['time24', 'label', 'speaker', 'note']
            }
          }
        },
        required: ['monthName', 'dayNumber', 'hijriSubtitle', 'specialOccasion', 'items']
      }
    }
  },
  required: ['isAnnouncement', 'days']
};

// Classifies AND extracts in one call: returns { isAnnouncement, days } on
// success, or null on a hard failure (network/API error — caller should
// treat that the same as "skip this message", not as isAnnouncement:false).
async function parseAnnouncement(text, postedAtIso) {
  try {
    const result = await getModel().generateContent(text);
    const parsed = JSON.parse(result.response.text());
    if (typeof parsed.isAnnouncement !== 'boolean' || !Array.isArray(parsed.days)) {
      console.warn('Gemini response did not match the expected shape; treating as non-announcement.');
      return { isAnnouncement: false, days: [] };
    }
    return parsed;
  } catch (err) {
    console.error('Gemini parsing failed:', err.message);
    return null;
  }
}

module.exports = { parseAnnouncement };
