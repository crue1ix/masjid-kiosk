const admin = require('firebase-admin');
const path = require('path');
const config = require('./config');

// Lazy init so importing this module never fails just because
// serviceAccountKey.json doesn't exist yet (e.g. during `--list-groups`
// first run, before Firebase has been set up).
let db = null;
function getDb() {
  if (!db) {
    const serviceAccount = require(path.resolve(config.firebaseServiceAccountPath));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
  }
  return db;
}

// One doc per ISO date (programs/{isoDate}). Full overwrite by design: a
// corrected re-post of the same week should fully replace the prior parse
// for each day it mentions, not merge field-by-field with stale data.
// createdAt is preserved across overwrites (only set fresh on first write).
async function writeProgramDays(days, rawMessageId) {
  const firestore = getDb();
  for (const day of days) {
    const docRef = firestore.collection('programs').doc(day.isoDate);
    const existing = await docRef.get();
    const createdAt = (existing.exists && existing.data().createdAt)
      ? existing.data().createdAt
      : admin.firestore.FieldValue.serverTimestamp();

    await docRef.set({
      date: day.isoDate,
      hijriSubtitle: day.hijriSubtitle || null,
      specialOccasion: day.specialOccasion || null,
      items: day.items,
      source: 'whatsapp-auto',
      createdAt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      rawMessageId
    });
  }
}

async function writeAd({ url, type, title, duration, expiresAt, rawMessageId }) {
  const firestore = getDb();
  await firestore.collection('ads').add({
    url,
    type,
    title,
    duration,
    order: 999,
    active: true,
    expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
    source: 'whatsapp-auto',
    rawMessageId,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

module.exports = { writeProgramDays, writeAd, getDb, admin };
