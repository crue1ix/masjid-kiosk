// ============================================================
// FIREBASE CONFIGURATION
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyBmwaEQyFclFYD_zjhpJLWbJP7xeXb9quo",
  authDomain: "al-hayy-ad-screen.firebaseapp.com",
  projectId: "al-hayy-ad-screen",
  storageBucket: "al-hayy-ad-screen.firebasestorage.app",
  messagingSenderId: "94672953738",
  appId: "1:94672953738:web:6acb748dfd20f927b36873"
};

// ============================================================
// CLOUDINARY CONFIGURATION — this is where ad photos/videos are
// actually stored.
// ============================================================
const CLOUDINARY_CONFIG = {
  cloudName: "u5syafcz",
  uploadPreset: "adzamszc"
};

// ============================================================
// KIOSK SETTINGS — edit these freely, no Firebase knowledge needed
// ============================================================
const KIOSK_CONFIG = {
  masjidName: "Masjid Al-Hayy",

  // Update to your masjid's real coordinates (used for prayer times).
  // Easiest way: search your masjid on Google Maps, right-click the pin,
  // the lat/lng shown is what you copy here.
  latitude: 28.7744,
  longitude: -81.2856,

  // Prayer time calculation method for the Aladhan API.
  // 2 = Islamic Society of North America (ISNA) — common in the US/Canada.
  calculationMethod: 2,

  defaultImageDuration: 8,
  hubIdleTimeoutSeconds: 30
};
