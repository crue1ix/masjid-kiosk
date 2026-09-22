require('dotenv').config();

// Flat-object config, matching the convention already used by the main
// site's firebase-config.js. Values are read here but NOT validated —
// validation happens once in index.js's main(), because which values are
// actually required depends on the run mode (--list-groups needs none of
// the Gemini/Cloudinary/group-JID values yet).
const config = {
  firebaseServiceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json',
  whatsappGroupJid: process.env.WHATSAPP_GROUP_JID || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
  cloudinaryUploadPreset: process.env.CLOUDINARY_UPLOAD_PRESET || '',
  adExpiryDays: parseInt(process.env.AD_EXPIRY_DAYS, 10) || 7,
  defaultAdDurationSeconds: parseInt(process.env.DEFAULT_AD_DURATION_SECONDS, 10) || 8,
  cleanupIntervalMs: 60 * 60 * 1000 // hourly
};

module.exports = config;
