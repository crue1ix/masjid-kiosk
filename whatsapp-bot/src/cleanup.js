const { getDb, admin } = require('./firestoreWriter');

// Deletes `ads` docs whose expiresAt has passed. Runs hourly (see index.js)
// plus once at startup. The kiosk's own client-side filter (index.html) is
// a defensive second layer in case this ever lags.
async function runCleanup() {
  const db = getDb();
  const now = admin.firestore.Timestamp.now();
  const snapshot = await db.collection('ads').where('expiresAt', '<=', now).get();

  if (snapshot.empty) {
    console.log('Cleanup: no expired ads.');
    return;
  }

  const batch = db.batch();
  snapshot.docs.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
  console.log(`Cleanup: deleted ${snapshot.size} expired ad(s).`);
}

module.exports = { runCleanup };
