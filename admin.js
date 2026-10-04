/* ============================================================
   KIOSK ADMIN — script for admin.html (plain browser JS, no build).
   Pages are hash-routed (#home, #reel, #announcements, #programs,
   #settings). Every page stays in the DOM, so unsaved edits on one
   page survive switching to another.
   ============================================================ */
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// The Gemini API key is never stored in this file or anywhere in git — it's
// read after login from Firestore admin_config/gemini (see loadGeminiApiKey()).
// The newsletter bot (newsletter-bot/) reads the same document.
const GEMINI_MODEL = 'gemini-3.6-flash';

const DAY_MS = 24 * 60 * 60 * 1000;
const $ = id => document.getElementById(id);

/* ============================================================
   ICONS — <i data-icon="name"> placeholders become inline SVG
   ============================================================ */
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
  reel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m10 9 5 3-5 3z"/>',
  megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h3l7 4V6L7 10H4a1 1 0 0 0-1 1z"/><path d="M17.5 9a4 4 0 0 1 0 6"/><path d="M7 14v4a2 2 0 0 0 2 2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  upload: '<path d="M12 16V4"/><path d="m6 10 6-6 6 6"/><path d="M4 20h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sparkle: '<path d="M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2 2.2.8-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m14 6 4 4"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  download: '<path d="M12 4v12"/><path d="m6 10 6 6 6-6"/><path d="M4 20h16"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v6H4V6h6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  logout: '<path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h10"/>'
};

function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

function hydrateIcons(root = document) {
  root.querySelectorAll('i[data-icon]').forEach(el => { el.outerHTML = icon(el.dataset.icon); });
}

hydrateIcons();
document.querySelectorAll('.js-masjid-name').forEach(el => { el.textContent = KIOSK_CONFIG.masjidName; });

/* ============================================================
   SMALL HELPERS
   ============================================================ */
function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Local YYYY-MM-DD (also the value format of <input type="date">).
function toIsoDateLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseIsoDateLocal(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function tryParseDateToISO(str) {
  if (!str) return null;
  const d = new Date(str);
  if (isNaN(d.getTime())) return null;
  return toIsoDateLocal(d);
}

// "September 22, 2026" — the format the kiosk, the bot and this page share.
function formatDateForDisplay(isoStr) {
  return parseIsoDateLocal(isoStr).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function formatProgramDateLabel(iso) {
  return parseIsoDateLocal(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function to12Hour(time24) {
  if (!time24) return '';
  const [h, m] = time24.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

// Whole calendar days from today (0 = today, negative = past).
function daysFromToday(date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return Math.round((d - today) / DAY_MS);
}

function timeAgo(date) {
  if (!date) return 'never';
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function setChecked(id, value) {
  const el = $(id);
  el.checked = value;
  syncSwitch(el);
}

// Don't overwrite a number the admin is in the middle of typing.
function setValueIfIdle(id, value) {
  const el = $(id);
  if (document.activeElement !== el) el.value = value;
}

// Switch captions ("Showing" / "Off") follow the checkbox.
function syncSwitch(input) {
  const label = input.closest('.switch') && input.closest('.switch').querySelector('.js-switch-text');
  if (label) label.textContent = input.checked ? label.dataset.on : label.dataset.off;
}

document.addEventListener('change', e => {
  if (e.target.matches('.switch input')) syncSwitch(e.target);
});

/* ============================================================
   AUTH
   ============================================================ */
$('login-form').addEventListener('submit', e => {
  e.preventDefault();
  const username = $('login-username').value.trim().toLowerCase();
  const password = $('login-password').value;
  const errorBox = $('login-error');
  errorBox.textContent = '';

  if (!username) {
    errorBox.textContent = 'Enter a username.';
    return;
  }

  const email = `${username}@${AUTH_CONFIG.usernameDomain}`;
  auth.signInWithEmailAndPassword(email, password).catch(err => {
    errorBox.textContent = err.code === 'auth/invalid-credential' || err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password'
      ? 'Incorrect username or password.'
      : err.message;
  });
});

document.querySelectorAll('.js-logout').forEach(btn => btn.addEventListener('click', () => auth.signOut()));

let appStarted = false;

auth.onAuthStateChanged(user => {
  if (user) {
    $('login-screen').classList.add('hidden');
    $('app').classList.remove('hidden');
    document.querySelectorAll('.js-username').forEach(el => { el.textContent = (user.email || '').split('@')[0]; });
    if (!appStarted) {
      appStarted = true;
      startApp();
    }
    // Shown only now that #app is visible, so the preview measures a real width.
    showPage(currentPageFromHash());
  } else {
    $('login-screen').classList.remove('hidden');
    $('app').classList.add('hidden');
  }
});

function startApp() {
  renderHomeDate();
  loadAdList();
  loadSaying();
  loadAnnouncements();
  loadProgramsAdmin();
  loadGeminiApiKey();
  loadNewsletterBotStatus();
  loadKioskSettings();
  loadHubTaps();
  // Keeps "checked 5 min ago" and expiry counts honest on a page left open.
  setInterval(() => {
    renderHomeDate();
    renderBotStatus();
    renderHomeReel();
    renderHubTaps();
  }, 60 * 1000);
}

/* ============================================================
   HUB OPENS — index.html adds 1 to hub_taps/{YYYY-MM-DD} each time
   a visitor taps the ad reel to open the hub (not while locked)
   ============================================================ */
let hubTapsByDay = null; // null = loading, 'unreadable' = rules block it

function loadHubTaps() {
  db.collection('hub_taps').onSnapshot(snapshot => {
    hubTapsByDay = {};
    snapshot.docs.forEach(doc => { hubTapsByDay[doc.id] = doc.data().count || 0; });
    renderHubTaps();
  }, () => {
    hubTapsByDay = 'unreadable';
    renderHubTaps();
  });
}

function renderHubTaps() {
  if (hubTapsByDay === null) return;
  if (hubTapsByDay === 'unreadable') {
    ['home-taps-today', 'home-taps-week', 'home-taps-total'].forEach(id => { $(id).textContent = '—'; });
    return;
  }
  const dayKey = offset => { const d = new Date(); d.setDate(d.getDate() - offset); return d.toLocaleDateString('en-CA'); };
  let week = 0;
  for (let i = 0; i < 7; i++) week += hubTapsByDay[dayKey(i)] || 0;
  const total = Object.values(hubTapsByDay).reduce((sum, n) => sum + n, 0);
  $('home-taps-today').textContent = (hubTapsByDay[dayKey(0)] || 0).toLocaleString();
  $('home-taps-week').textContent = week.toLocaleString();
  $('home-taps-total').textContent = total.toLocaleString();
}

$('btn-reset-hub-taps').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Reset the hub counter?',
    message: 'Today, Last 7 days and All time will all go back to 0. This can’t be undone.',
    confirmLabel: 'Reset counter'
  });
  if (!ok) return;
  const btn = $('btn-reset-hub-taps');
  btn.disabled = true;
  try {
    const snapshot = await db.collection('hub_taps').get();
    // Batches max out at 500 writes; one doc per day so this is rarely more than one.
    for (let i = 0; i < snapshot.docs.length; i += 500) {
      const batch = db.batch();
      snapshot.docs.slice(i, i + 500).forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    }
    showToast('Hub counter reset.', 'success');
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

/* ============================================================
   ROUTER
   ============================================================ */
const PAGES = ['home', 'reel', 'announcements', 'programs', 'settings'];
const PAGE_TITLES = { home: 'Home', reel: 'Ad Reel', announcements: 'Announcements', programs: 'Programs', settings: 'Settings' };
let currentPage = null;

function currentPageFromHash() {
  const name = location.hash.slice(1);
  return PAGES.includes(name) ? name : 'home';
}

function showPage(name) {
  const changed = currentPage !== name;
  currentPage = name;
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('hidden', p.dataset.page !== name));
  document.querySelectorAll('.nav-link').forEach(a => a.classList.toggle('active', a.dataset.page === name));
  document.title = `${PAGE_TITLES[name]} · Kiosk Admin`;
  if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
  if (changed) window.scrollTo(0, 0);
  if (name === 'home' && window.matchMedia('(min-width: 901px)').matches) mountPreview();
  // Textareas can only measure their content once their page is visible.
  if (name === 'announcements') document.querySelectorAll('.hub-item-text').forEach(autosize);
  updateDirtyBar();
}

function goTo(name) {
  if (location.hash.slice(1) === name) showPage(name);
  else location.hash = name;
}

window.addEventListener('hashchange', () => {
  if (auth.currentUser) showPage(currentPageFromHash());
});

/* ============================================================
   DIALOGS
   ============================================================ */
function openDialog(id) {
  const dialog = $(id);
  if (!dialog.open) dialog.showModal();
}

function closeDialog(id) {
  const dialog = $(id);
  if (dialog.open) dialog.close();
}

document.querySelectorAll('dialog.modal').forEach(dialog => {
  dialog.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => dialog.close()));
  // A click on the dimmed backdrop lands on the <dialog> itself.
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
});

// Promise-based replacement for confirm(), styled like the rest of the page.
function confirmDialog({ title, message, confirmLabel }) {
  const dialog = $('dlg-confirm');
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  $('confirm-ok').textContent = confirmLabel;
  return new Promise(resolve => {
    let confirmed = false;
    $('confirm-ok').onclick = () => { confirmed = true; dialog.close(); };
    $('confirm-cancel').onclick = () => dialog.close();
    dialog.addEventListener('close', () => resolve(confirmed), { once: true });
    dialog.showModal();
  });
}

/* ============================================================
   TOASTS
   ============================================================ */
function showToast(msg, type = 'success', action = null) {
  const container = $('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;

  const text = document.createElement('span');
  text.textContent = msg;
  toast.appendChild(text);

  const duration = action ? 5000 : 3000;
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    toast.classList.remove('show');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  };

  if (action) {
    const actionBtn = document.createElement('button');
    actionBtn.className = 'toast-action';
    actionBtn.type = 'button';
    actionBtn.textContent = action.label;
    actionBtn.addEventListener('click', () => {
      action.onClick();
      dismiss();
    });
    toast.appendChild(actionBtn);
  }

  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(dismiss, duration);
}

/* ============================================================
   UNSAVED CHANGES — sticky bar + nav dots + leave-page guard
   ============================================================ */
const dirtySections = new Set();

const DIRTY_SECTIONS = {
  announcements: {
    page: 'announcements',
    label: () => 'Unsaved changes to Announcements',
    save: () => saveAnnouncements(),
    discard: () => discardAnnouncements()
  },
  'program-day': {
    page: 'programs',
    label: () => `Unsaved changes to ${currentProgramDate ? formatProgramDateLabel(currentProgramDate) : 'a program day'}`,
    save: () => saveProgramDay(),
    discard: () => discardProgramDay()
  }
};

let dirtyBarSection = null;

function markSectionDirty(section) {
  dirtySections.add(section);
  updateDirtyBar();
}

function clearSectionDirty(section) {
  dirtySections.delete(section);
  updateDirtyBar();
}

function updateDirtyBar() {
  const dirtyPages = new Set([...dirtySections].map(s => DIRTY_SECTIONS[s].page));
  document.querySelectorAll('.nav-link').forEach(a => a.classList.toggle('has-unsaved', dirtyPages.has(a.dataset.page)));

  const sections = [...dirtySections];
  dirtyBarSection = sections.find(s => DIRTY_SECTIONS[s].page === currentPage) || sections[0] || null;
  const bar = $('dirty-bar');
  bar.classList.toggle('hidden', !dirtyBarSection);
  document.body.classList.toggle('has-dirty-bar', !!dirtyBarSection);
  if (!dirtyBarSection) return;

  const info = DIRTY_SECTIONS[dirtyBarSection];
  $('dirty-bar-text').textContent = info.label() + (sections.length > 1 ? ' (and 1 more)' : '');
  $('dirty-goto').classList.toggle('hidden', info.page === currentPage);
}

$('dirty-goto').addEventListener('click', () => dirtyBarSection && goTo(DIRTY_SECTIONS[dirtyBarSection].page));
$('dirty-save').addEventListener('click', () => dirtyBarSection && DIRTY_SECTIONS[dirtyBarSection].save());
$('dirty-discard').addEventListener('click', () => dirtyBarSection && DIRTY_SECTIONS[dirtyBarSection].discard());

window.addEventListener('beforeunload', e => {
  if (dirtySections.size > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/* ============================================================
   DRAG REORDER — generic; `onDrop(srcId, targetId)` decides what
   the new order means. Rows only become draggable while their ⠿
   handle is held, so text inside them can still be selected.
   ============================================================ */
let dragSrcId = null;

function makeRowDraggable(item, listEl, onDrop) {
  const handle = item.querySelector('.drag-handle');
  item.draggable = false;
  if (handle) {
    handle.addEventListener('mousedown', () => { item.draggable = true; });
    handle.addEventListener('mouseup', () => { item.draggable = false; });
  }
  item.addEventListener('dragstart', e => {
    dragSrcId = item.dataset.id;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragSrcId);
  });
  item.addEventListener('dragend', () => {
    item.draggable = false;
    item.classList.remove('dragging');
    listEl.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  });
  item.addEventListener('dragover', e => {
    e.preventDefault();
    if (item.dataset.id !== dragSrcId) item.classList.add('drag-over');
  });
  item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
  item.addEventListener('drop', e => {
    e.preventDefault();
    item.classList.remove('drag-over');
    const targetId = item.dataset.id;
    if (targetId !== dragSrcId) onDrop(dragSrcId, targetId);
  });
}

/* ============================================================
   LIVE KIOSK PREVIEW — index.html at kiosk resolution, scaled
   ============================================================ */
const KIOSK_PREVIEW_WIDTH = 2160;
const KIOSK_PREVIEW_HEIGHT = 3840;
let previewMounted = false;

function fitPreview(stage, frame) {
  if (!stage.clientWidth) return; // hidden — nothing to measure yet
  frame.style.width = KIOSK_PREVIEW_WIDTH + 'px';
  frame.style.height = KIOSK_PREVIEW_HEIGHT + 'px';
  frame.style.transform = `scale(${stage.clientWidth / KIOSK_PREVIEW_WIDTH})`;
}

[['preview-stage', 'preview-frame'], ['preview-stage-large', 'preview-frame-large']].forEach(([stageId, frameId]) => {
  new ResizeObserver(() => fitPreview($(stageId), $(frameId))).observe($(stageId));
});

// On phones the preview only loads when asked — it's a whole second kiosk.
function mountPreview() {
  if (previewMounted) return;
  previewMounted = true;
  $('preview-frame').src = 'index.html';
  $('btn-preview-load').classList.add('hidden');
  fitPreview($('preview-stage'), $('preview-frame'));
}

$('btn-preview-load').addEventListener('click', mountPreview);

$('btn-preview-refresh').addEventListener('click', () => {
  if (!previewMounted) return mountPreview();
  $('preview-frame').src = 'index.html';
});

$('btn-preview-enlarge').addEventListener('click', () => {
  $('preview-frame-large').src = 'index.html';
  openDialog('dlg-preview');
  fitPreview($('preview-stage-large'), $('preview-frame-large'));
});

$('dlg-preview').addEventListener('close', () => { $('preview-frame-large').src = 'about:blank'; });

$('btn-preview-open').addEventListener('click', () => window.open('index.html', '_blank'));

/* ============================================================
   HOME — overview of what's live on the kiosk
   ============================================================ */
function renderHomeDate() {
  const today = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  $('home-date').textContent = `${today} · Here's what's on the kiosk right now.`;
}

document.querySelectorAll('.quick-action').forEach(btn => btn.addEventListener('click', () => {
  if (btn.dataset.action === 'upload') openUploadDialog();
  else if (btn.dataset.action === 'announcement') addNewAnnouncement();
  else if (btn.dataset.action === 'import') openImportCard();
}));

function renderHomeLock() {
  const locked = !!kioskSettings.locked;
  $('home-lock-value').textContent = locked ? 'Locked' : 'Unlocked';
  $('home-lock-desc').textContent = locked
    ? 'Visitors can only watch the slides. The touch menu is turned off.'
    : 'Visitors can tap the screen to open the menu.';
}

function renderHomeReel() {
  if (!adsLoaded) return;
  const live = currentAdDocs.filter(item => !pendingDeleteIds.has(item.id));
  const showing = live.filter(item => adStatus(item.data).showing);
  const hidden = live.length - showing.length;
  const expiringThisWeek = showing.filter(item => {
    const ad = item.data;
    return ad.expiresAt && ad.expiresAt.toMillis() - Date.now() <= 7 * DAY_MS;
  }).length;
  const specials = [];
  if (kioskSettings.specialReels && kioskSettings.specialReels.prayerTimes) specials.push('Prayer Times');
  if (kioskSettings.specialReels && kioskSettings.specialReels.saying && currentSaying.quote) specials.push('Saying');

  $('home-reel-value').textContent = `${plural(showing.length, 'slide')} showing`;
  const parts = [];
  if (hidden) parts.push(`${hidden} hidden`);
  if (expiringThisWeek) parts.push(`<strong>${expiringThisWeek} leave${expiringThisWeek === 1 ? 's' : ''} this week</strong>`);
  parts.push(specials.length ? `plus ${specials.join(' and ')} slide${specials.length === 1 ? '' : 's'}` : 'no built-in slides on');
  $('home-reel-desc').innerHTML = parts.join(' · ');
}

function renderHomeSaying() {
  const on = !!(kioskSettings.specialReels && kioskSettings.specialReels.saying);
  $('home-saying-quote').textContent = currentSaying.quote
    ? `“${currentSaying.quote}”`
    : 'No saying yet.';
  $('home-saying-desc').textContent = !currentSaying.quote
    ? 'The newsletter bot fills this in each week.'
    : on
      ? `${currentSaying.attribution ? currentSaying.attribution + ' · ' : ''}Showing on the kiosk`
      : 'Turned off. Switch it on in Ad Reel.';
}

function renderHomePrograms() {
  const box = $('home-programs');
  const todayIso = toIsoDateLocal(new Date());
  const today = upcomingProgramDocs.find(d => d.id === todayIso);
  const day = today || upcomingProgramDocs[0];

  $('home-programs-title').textContent = today ? "Today's programs" : 'Next programs';
  if (!day) {
    $('home-programs-sub').textContent = 'Nothing on the calendar yet';
    box.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📅</div><p>No upcoming programs. They appear when the next newsletter arrives.</p></div>';
    return;
  }

  const data = day.data;
  $('home-programs-sub').textContent = today
    ? parseIsoDateLocal(day.id).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
    : `Nothing scheduled today · next is ${parseIsoDateLocal(day.id).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}`;
  const items = data.items || [];
  box.innerHTML = `
    ${data.specialOccasion ? `<div class="agenda-occasion">${escapeHtml(data.specialOccasion)}</div>` : ''}
    <div class="agenda">
      ${items.length ? items.map(item => `
        <div class="agenda-row">
          <div class="agenda-time">${to12Hour(item.time)}</div>
          <div>
            <div>${escapeHtml(item.label)}</div>
            ${item.speaker ? `<div class="agenda-speaker">${escapeHtml(item.speaker)}</div>` : ''}
          </div>
        </div>`).join('') : '<p class="muted" style="margin:0">No programs listed for this day.</p>'}
    </div>
    <button type="button" class="btn btn-ghost btn-sm" id="btn-home-edit-day" style="margin-top:0.6rem">${icon('pencil')}Edit this day</button>
  `;
  $('btn-home-edit-day').addEventListener('click', () => {
    goTo('programs');
    openProgramDay(day.id);
  });
}

// Same order the kiosk uses: upcoming soonest first, then undated.
function renderHomeAnnouncements() {
  const box = $('home-announcements');
  const entries = savedAnnouncements
    .filter(item => item.text)
    .map((item, order) => {
      const iso = tryParseDateToISO(item.date);
      const days = iso ? daysFromToday(parseIsoDateLocal(iso)) : null;
      return { item, order, iso, days };
    })
    .filter(e => e.days === null || e.days >= 0)
    .sort((a, b) => (a.days === null) - (b.days === null) || (a.days || 0) - (b.days || 0) || a.order - b.order)
    .slice(0, 3);

  if (!entries.length) {
    box.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📣</div><p>No current announcements.</p></div>';
    return;
  }
  box.innerHTML = entries.map(({ item, iso }) => {
    const d = iso ? parseIsoDateLocal(iso) : null;
    const badge = d
      ? `<div class="mini-date"><div class="mini-date-month">${d.toLocaleDateString('en-US', { month: 'short' })}</div><div class="mini-date-day">${d.getDate()}</div></div>`
      : `<div class="mini-date no-date">${icon('megaphone')}</div>`;
    return `<div class="mini-ann">${badge}<div class="mini-ann-text">${escapeHtml(item.text)}</div></div>`;
  }).join('');
}

/* ============================================================
   KIOSK SETTINGS (settings/kiosk) — lock, idle timeout, and the
   built-in slides' on/off + duration
   ============================================================ */
let kioskSettings = {};

function loadKioskSettings() {
  db.collection('settings').doc('kiosk').onSnapshot(doc => {
    kioskSettings = doc.exists ? doc.data() : {};
    const reels = kioskSettings.specialReels || {};
    setChecked('setting-locked', !!kioskSettings.locked);
    setChecked('home-lock-toggle', !!kioskSettings.locked);
    setChecked('setting-prayer-reel', !!reels.prayerTimes);
    setValueIfIdle('setting-prayer-reel-duration', reels.prayerTimesDurationSeconds || 15);
    setChecked('setting-saying-reel', !!reels.saying);
    setValueIfIdle('setting-saying-reel-duration', reels.sayingDurationSeconds || 15);
    setValueIfIdle('setting-idle-timeout', kioskSettings.hubIdleTimeoutSeconds || 30);
    renderHomeLock();
    renderHomeReel();
    renderHomeSaying();
  });
}

function setLocked(locked) {
  db.collection('settings').doc('kiosk').set({ locked }, { merge: true })
    .then(() => showToast(locked ? 'Screen locked. Visitors can only watch the slides.' : 'Screen unlocked.', 'success'))
    .catch(err => showToast('Error: ' + err.message, 'error'));
}

$('setting-locked').addEventListener('change', e => setLocked(e.target.checked));
$('home-lock-toggle').addEventListener('change', e => setLocked(e.target.checked));

$('setting-prayer-reel').addEventListener('change', () => {
  const enabled = $('setting-prayer-reel').checked;
  db.collection('settings').doc('kiosk').set({ specialReels: { prayerTimes: enabled } }, { merge: true })
    .then(() => showToast(enabled ? 'Prayer Times slide is on.' : 'Prayer Times slide is off.', 'success'));
});

$('setting-prayer-reel-duration').addEventListener('change', () => {
  const seconds = parseInt($('setting-prayer-reel-duration').value, 10) || 15;
  db.collection('settings').doc('kiosk').set({ specialReels: { prayerTimesDurationSeconds: seconds } }, { merge: true })
    .then(() => showToast('Saved.', 'success'));
});

$('setting-saying-reel').addEventListener('change', () => {
  const enabled = $('setting-saying-reel').checked;
  db.collection('settings').doc('kiosk').set({ specialReels: { saying: enabled } }, { merge: true })
    .then(() => showToast(enabled ? 'Saying slide is on.' : 'Saying slide is off.', 'success'));
});

$('setting-saying-reel-duration').addEventListener('change', () => {
  const seconds = parseInt($('setting-saying-reel-duration').value, 10) || 15;
  db.collection('settings').doc('kiosk').set({ specialReels: { sayingDurationSeconds: seconds } }, { merge: true })
    .then(() => showToast('Saved.', 'success'));
});

$('setting-idle-timeout').addEventListener('change', () => {
  const timeout = parseInt($('setting-idle-timeout').value, 10) || 30;
  db.collection('settings').doc('kiosk').set({ hubIdleTimeoutSeconds: timeout }, { merge: true })
    .then(() => showToast('Saved.', 'success'))
    .catch(err => showToast('Error: ' + err.message, 'error'));
});

/* ============================================================
   SAYING OF THE WEEK — hub_content/saying, written weekly by the
   newsletter bot; editable here (a later newsletter replaces it).
   ============================================================ */
let currentSaying = {};

function loadSaying() {
  db.collection('hub_content').doc('saying').onSnapshot(doc => {
    currentSaying = doc.exists ? doc.data() : {};
    $('saying-reel-meta').textContent = currentSaying.quote
      ? `“${currentSaying.quote.length > 90 ? currentSaying.quote.slice(0, 90) + '…' : currentSaying.quote}”${currentSaying.attribution ? ' · ' + currentSaying.attribution : ''}`
      : 'No saying yet. The newsletter bot fills this in weekly, or click Edit.';
    renderHomeSaying();
    renderHomeReel();
  });
}

$('btn-edit-saying').addEventListener('click', () => {
  $('saying-quote').value = currentSaying.quote || '';
  $('saying-attribution').value = currentSaying.attribution || '';
  $('saying-reference').value = currentSaying.reference || '';
  openDialog('dlg-saying');
});

$('btn-save-saying').addEventListener('click', () => {
  const quote = $('saying-quote').value.trim();
  if (!quote) {
    showToast('Enter the saying first.', 'error');
    return;
  }
  db.collection('hub_content').doc('saying').set({
    quote,
    attribution: $('saying-attribution').value.trim(),
    reference: $('saying-reference').value.trim(),
    updatedBy: 'manual',
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  })
    .then(() => {
      closeDialog('dlg-saying');
      showToast('Saying saved.', 'success');
    })
    .catch(err => showToast('Error: ' + err.message, 'error'));
});

/* ============================================================
   MEDIA PREVIEW (full-size slide)
   ============================================================ */
function toDownloadUrl(url) {
  return url.replace('/upload/', '/upload/fl_attachment/');
}

function openPreview(ad) {
  $('modal-media').innerHTML = ad.type === 'video'
    ? `<video src="${escapeHtml(ad.url)}" controls autoplay></video>`
    : `<img src="${escapeHtml(ad.url)}" alt="">`;
  $('modal-title').textContent = ad.title || 'Untitled slide';
  $('modal-download').href = toDownloadUrl(ad.url);
  openDialog('dlg-media');
}

$('dlg-media').addEventListener('close', () => { $('modal-media').innerHTML = ''; });

/* ============================================================
   UPLOAD
   ============================================================ */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200MB

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function validateUploadFile(file) {
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
    return 'Only image or video files are supported.';
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `File is too large (${formatBytes(file.size)}). Max size is ${formatBytes(MAX_UPLOAD_BYTES)}.`;
  }
  return null;
}

function showUploadError(msg) {
  const errorBox = $('upload-error');
  errorBox.textContent = msg || '';
  errorBox.classList.toggle('hidden', !msg);
}

function updateUploadPreview(file) {
  const hint = $('upload-dropzone-hint');
  const preview = $('upload-preview');
  const thumb = $('upload-preview-thumb');

  if (!file) {
    hint.classList.remove('hidden');
    preview.classList.add('hidden');
    thumb.innerHTML = '';
    showUploadError(null);
    $('duration-field').classList.remove('hidden');
    return;
  }

  showUploadError(validateUploadFile(file));

  const objectUrl = URL.createObjectURL(file);
  thumb.innerHTML = file.type.startsWith('video')
    ? `<video src="${objectUrl}" muted></video>`
    : `<img src="${objectUrl}" alt="">`;
  $('upload-preview-name').textContent = file.name;
  $('upload-preview-meta').textContent = `${file.type.startsWith('video') ? 'Video' : 'Image'} · ${formatBytes(file.size)} · click to change`;
  hint.classList.add('hidden');
  preview.classList.remove('hidden');
  $('duration-field').classList.toggle('hidden', file.type.startsWith('video'));
}

function resetUploadForm() {
  $('upload-file').value = '';
  $('upload-title').value = '';
  $('upload-expiry-days').value = '';
  updateUploadPreview(null);
  $('progress-wrap').classList.add('hidden');
  $('progress-fill').style.width = '0%';
  $('btn-upload').disabled = false;
}

function openUploadDialog() {
  if (!$('btn-upload').disabled) resetUploadForm(); // keep an upload in progress visible
  openDialog('dlg-upload');
}

$('btn-open-upload').addEventListener('click', openUploadDialog);

const dropzone = $('upload-dropzone');
const fileInput = $('upload-file');

fileInput.addEventListener('change', () => updateUploadPreview(fileInput.files[0]));

['dragenter', 'dragover'].forEach(evt => {
  dropzone.addEventListener(evt, e => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });
});
['dragleave', 'dragend'].forEach(evt => {
  dropzone.addEventListener(evt, () => dropzone.classList.remove('drag-over'));
});
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  fileInput.files = e.dataTransfer.files;
  updateUploadPreview(file);
});

$('btn-upload').addEventListener('click', () => {
  const file = fileInput.files[0];

  if (!file) {
    showToast('Choose a file first.', 'error');
    return;
  }

  const validationError = validateUploadFile(file);
  if (validationError) {
    showUploadError(validationError);
    showToast(validationError, 'error');
    return;
  }

  const type = file.type.startsWith('video') ? 'video' : 'image';
  const title = $('upload-title').value.trim();
  const duration = parseInt($('upload-duration').value, 10) || 8;
  const order = parseInt($('upload-order').value, 10) || 1;
  const expiryDaysRaw = $('upload-expiry-days').value;
  const expiryDays = expiryDaysRaw ? parseInt(expiryDaysRaw, 10) : null;

  if (CLOUDINARY_CONFIG.cloudName.startsWith('PASTE_')) {
    showToast('Cloudinary isn\'t set up yet — check firebase-config.js.', 'error');
    return;
  }

  const progressFill = $('progress-fill');
  $('progress-wrap').classList.remove('hidden');
  $('btn-upload').disabled = true;

  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', CLOUDINARY_CONFIG.uploadPreset);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', `https://api.cloudinary.com/v1_1/${CLOUDINARY_CONFIG.cloudName}/auto/upload`);

  xhr.upload.addEventListener('progress', e => {
    if (e.lengthComputable) progressFill.style.width = ((e.loaded / e.total) * 100) + '%';
  });

  xhr.onload = () => {
    if (xhr.status < 200 || xhr.status >= 300) {
      showToast('Upload failed: ' + xhr.responseText, 'error');
      $('btn-upload').disabled = false;
      return;
    }
    const result = JSON.parse(xhr.responseText);
    const adDoc = {
      url: result.secure_url,
      type, title, duration, order,
      active: true,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (expiryDays) {
      adDoc.expiresAt = firebase.firestore.Timestamp.fromDate(
        new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000)
      );
    }
    db.collection('ads').add(adDoc).then(() => {
      showToast('Uploaded! It will show on the kiosk automatically.', 'success');
      resetUploadForm();
      closeDialog('dlg-upload');
    });
  };

  xhr.onerror = () => {
    showToast('Upload failed — check your internet connection.', 'error');
    $('btn-upload').disabled = false;
  };

  xhr.send(formData);
});

/* ============================================================
   YOUR SLIDES — search, filter, drag-reorder, edit, show/hide, delete
   ============================================================ */
let currentAdDocs = [];
let adsLoaded = false;
let pendingDeleteIds = new Set();
let mediaSearchQuery = '';
let reelFilter = 'all';

const REEL_FILTER_LABELS = {
  all: 'All',
  showing: 'Showing',
  hidden: 'Hidden',
  newsletter: 'From newsletter',
  expiring: 'Expiring soon'
};

function loadAdList() {
  db.collection('ads').orderBy('order').onSnapshot(snapshot => {
    currentAdDocs = [];
    snapshot.forEach(doc => currentAdDocs.push({ id: doc.id, data: doc.data() }));
    adsLoaded = true;
    renderAdList();
    renderHomeReel();
  });
}

// "Showing" means the kiosk is actually playing it: switched on and not past
// its expiry (the kiosk skips expired slides even while they're switched on).
function adStatus(ad) {
  const now = Date.now();
  const msLeft = ad.expiresAt ? ad.expiresAt.toMillis() - now : null;
  const expired = msLeft !== null && msLeft <= 0;
  return {
    expired,
    showing: !!ad.active && !expired,
    expiringSoon: !expired && msLeft !== null && msLeft <= 3 * DAY_MS
  };
}

function matchesReelFilter(ad, filter) {
  const s = adStatus(ad);
  if (filter === 'showing') return s.showing;
  if (filter === 'hidden') return !s.showing;
  if (filter === 'newsletter') return ad.source === 'newsletter-auto';
  if (filter === 'expiring') return s.expiringSoon;
  return true;
}

function isReelFiltered() {
  return mediaSearchQuery.trim() !== '' || reelFilter !== 'all';
}

function getFilteredAdDocs() {
  const q = mediaSearchQuery.trim().toLowerCase();
  return currentAdDocs.filter(item =>
    !pendingDeleteIds.has(item.id) &&
    matchesReelFilter(item.data, reelFilter) &&
    (!q || (item.data.title || '').toLowerCase().includes(q) || (item.data.type || '').toLowerCase().includes(q))
  );
}

$('media-search').addEventListener('input', e => {
  mediaSearchQuery = e.target.value;
  renderAdList();
});

$('reel-filters').addEventListener('click', e => {
  const chip = e.target.closest('.filter-chip');
  if (!chip) return;
  reelFilter = chip.dataset.filter;
  renderAdList();
});

function clearReelFilters() {
  mediaSearchQuery = '';
  $('media-search').value = '';
  reelFilter = 'all';
  renderAdList();
}

function renderAdList() {
  const listEl = $('ad-list');
  const live = currentAdDocs.filter(item => !pendingDeleteIds.has(item.id));
  const docs = getFilteredAdDocs();
  const isFiltered = isReelFiltered();

  document.querySelectorAll('#reel-filters .filter-chip').forEach(chip => {
    const f = chip.dataset.filter;
    chip.classList.toggle('active', f === reelFilter);
    chip.innerHTML = `${REEL_FILTER_LABELS[f]}<span class="count">${live.filter(item => matchesReelFilter(item.data, f)).length}</span>`;
  });
  const showingCount = live.filter(item => adStatus(item.data).showing).length;
  $('reel-count').textContent = live.length ? `${showingCount} of ${live.length} showing` : '';
  $('reel-hint').textContent = isFiltered
    ? 'Clear the search and filters to drag slides into a new order.'
    : 'Drag ⠿ to change the play order. Click a picture to see it full size.';
  listEl.classList.toggle('is-filtered', isFiltered);

  if (docs.length === 0) {
    listEl.innerHTML = isFiltered
      ? `<div class="empty-state"><div class="empty-state-icon">🔍</div><p>No slides match.</p>
           <button type="button" class="btn btn-secondary btn-sm" style="margin-top:0.8rem" id="btn-clear-filters">Clear filters</button></div>`
      : `<div class="empty-state"><div class="empty-state-icon">🖼️</div><p>No slides yet. Upload your first one.</p>
           <button type="button" class="btn btn-primary btn-sm" style="margin-top:0.8rem" id="btn-empty-upload">Upload slide</button></div>`;
    const clear = $('btn-clear-filters');
    if (clear) clear.addEventListener('click', clearReelFilters);
    const upload = $('btn-empty-upload');
    if (upload) upload.addEventListener('click', openUploadDialog);
    return;
  }
  listEl.innerHTML = '';

  docs.forEach(item => {
    const { id, data: ad } = item;
    const status = adStatus(ad);
    const row = document.createElement('div');
    row.className = 'slide-row' + (status.showing ? '' : ' is-off');
    row.dataset.id = id;

    const chips = [ad.type === 'video'
      ? '<span class="chip">Video</span>'
      : `<span class="chip">Image · ${ad.duration || 8}s</span>`];
    chips.push(`<span class="chip">Position ${ad.order}</span>`);
    if (ad.source === 'newsletter-auto') chips.push('<span class="chip chip-blue">📧 From newsletter</span>');
    if (ad.expiresAt) {
      const label = ad.expiresAt.toDate().toLocaleDateString([], { month: 'short', day: 'numeric' });
      chips.push(status.expired
        ? `<span class="chip chip-red">Expired ${label}</span>`
        : `<span class="chip ${status.expiringSoon ? 'chip-amber' : ''}">Until ${label}</span>`);
    }

    row.innerHTML = `
      <div class="drag-handle" title="Drag to reorder" aria-hidden="true">⠿</div>
      <button type="button" class="slide-thumb" title="View full size" aria-label="View full size">
        ${ad.type === 'video'
          ? `<video src="${escapeHtml(ad.url)}" muted preload="metadata"></video><span class="thumb-badge">▶</span>`
          : `<img src="${escapeHtml(ad.url)}" alt="" loading="lazy">`}
      </button>
      <div class="slide-info">
        <div class="slide-title">${ad.title ? escapeHtml(ad.title) : '<span class="muted">Untitled</span>'}</div>
        <div class="chips">${chips.join('')}</div>
      </div>
      <label class="switch${status.expired ? ' is-expired' : ''}" title="Show this slide on the kiosk">
        <input type="checkbox" class="toggle-active" ${ad.active ? 'checked' : ''}>
        <span class="switch-track"></span>
        <span class="switch-label js-switch-text" data-on="${status.expired ? 'Expired' : 'Showing'}" data-off="Hidden">${ad.active ? (status.expired ? 'Expired' : 'Showing') : 'Hidden'}</span>
      </label>
      <div class="row-actions">
        <button type="button" class="icon-btn btn-edit" title="Edit" aria-label="Edit">${icon('pencil')}</button>
        <a class="icon-btn" href="${escapeHtml(toDownloadUrl(ad.url))}" download title="Download" aria-label="Download">${icon('download')}</a>
        <button type="button" class="icon-btn danger delete-ad" title="Delete" aria-label="Delete">${icon('trash')}</button>
      </div>
    `;

    row.querySelector('.slide-thumb').addEventListener('click', () => openPreview(ad));
    row.querySelector('.btn-edit').addEventListener('click', () => openEditSlide(id));
    row.querySelector('.toggle-active').addEventListener('change', e => {
      db.collection('ads').doc(id).update({ active: e.target.checked })
        .then(() => showToast(e.target.checked ? 'Slide is showing on the kiosk.' : 'Slide hidden from the kiosk.', 'success'));
    });
    row.querySelector('.delete-ad').addEventListener('click', () => {
      confirmDialog({
        title: 'Delete this slide?',
        message: `"${ad.title || 'Untitled'}" will be removed from the kiosk. You can undo for a few seconds afterwards.`,
        confirmLabel: 'Delete slide'
      }).then(ok => { if (ok) scheduleAdDelete(id); });
    });

    listEl.appendChild(row);
    if (!isFiltered) makeRowDraggable(row, listEl, reorderAds);
  });
}

function scheduleAdDelete(id) {
  pendingDeleteIds.add(id);
  renderAdList();
  renderHomeReel();
  const timeoutId = setTimeout(() => {
    pendingDeleteIds.delete(id);
    db.collection('ads').doc(id).delete();
  }, 5000);
  showToast('Slide deleted.', 'success', {
    label: 'Undo',
    onClick: () => {
      clearTimeout(timeoutId);
      pendingDeleteIds.delete(id);
      renderAdList();
      renderHomeReel();
    }
  });
}

function reorderAds(srcId, targetId) {
  const srcIdx = currentAdDocs.findIndex(d => d.id === srcId);
  const targetIdx = currentAdDocs.findIndex(d => d.id === targetId);
  if (srcIdx === -1 || targetIdx === -1) return;

  const reordered = currentAdDocs.slice();
  const [moved] = reordered.splice(srcIdx, 1);
  reordered.splice(targetIdx, 0, moved);

  const batch = db.batch();
  reordered.forEach((item, i) => {
    const newOrder = i + 1;
    if (item.data.order !== newOrder) {
      batch.update(db.collection('ads').doc(item.id), { order: newOrder });
    }
  });
  batch.commit().then(() => showToast('New order saved.', 'success'));
}

let editingAdId = null;

function openEditSlide(id) {
  const item = currentAdDocs.find(d => d.id === id);
  if (!item) return;
  const ad = item.data;
  editingAdId = id;
  $('edit-title').value = ad.title || '';
  $('edit-duration').value = ad.duration || 8;
  $('edit-duration-field').classList.toggle('hidden', ad.type !== 'image');
  $('edit-order').value = ad.order || 1;
  $('edit-expiry').value = ad.expiresAt ? toIsoDateLocal(ad.expiresAt.toDate()) : '';
  openDialog('dlg-edit-slide');
}

$('btn-save-slide').addEventListener('click', () => {
  const item = currentAdDocs.find(d => d.id === editingAdId);
  if (!item) return;
  const ad = item.data;
  const updates = {
    title: $('edit-title').value.trim(),
    order: parseInt($('edit-order').value, 10) || 1,
  };
  if (ad.type === 'image') updates.duration = parseInt($('edit-duration').value, 10) || 8;
  // Only written when changed, so saving a title edit keeps the exact
  // expiry time the newsletter bot set.
  const expiryValue = $('edit-expiry').value;
  const oldExpiryValue = ad.expiresAt ? toIsoDateLocal(ad.expiresAt.toDate()) : '';
  if (expiryValue !== oldExpiryValue) {
    const [y, m, d] = expiryValue.split('-').map(Number);
    updates.expiresAt = expiryValue
      ? firebase.firestore.Timestamp.fromDate(new Date(y, m - 1, d, 23, 59, 59))
      : firebase.firestore.FieldValue.delete();
  }
  db.collection('ads').doc(editingAdId).update(updates)
    .then(() => {
      closeDialog('dlg-edit-slide');
      showToast('Slide saved.', 'success');
    })
    .catch(err => showToast('Error: ' + err.message, 'error'));
});

/* ============================================================
   ANNOUNCEMENTS — hub_content/announcements { items: [{date, text}] }
   Live-updates from Firestore (e.g. when the bot adds one) unless the
   admin has unsaved edits. Each card keeps the bot's source/addedAt
   so its 30-day auto-prune still recognizes items it added.
   ============================================================ */
let savedAnnouncements = [];
let annCardCounter = 0;

function loadAnnouncements() {
  db.collection('hub_content').doc('announcements').onSnapshot(doc => {
    savedAnnouncements = doc.exists ? (doc.data().items || []) : [];
    renderHomeAnnouncements();
    if (!dirtySections.has('announcements')) renderAnnouncementsEditor(savedAnnouncements);
  }, () => {
    $('announcements-list').innerHTML = '<p class="field-hint">Could not load announcements.</p>';
  });
}

function announcementsEmptyState() {
  return `<div class="empty-state" id="announcements-empty"><div class="empty-state-icon">📣</div>
    <p>No announcements yet. Click <strong>New announcement</strong> to add one.</p></div>`;
}

function renderAnnouncementsEditor(items) {
  const container = $('announcements-list');
  container.innerHTML = '';
  if (items.length === 0) {
    container.innerHTML = announcementsEmptyState();
    return;
  }
  items.forEach(item => addAnnouncementCard(item));
}

function autosize(textarea) {
  textarea.style.height = 'auto';
  if (textarea.scrollHeight) textarea.style.height = textarea.scrollHeight + 'px';
}

function updateAnnouncementChips(card) {
  const dateValue = card.querySelector('.hub-item-date').value;
  let sourceChip = '<span class="chip">Added by you</span>';
  if (card.dataset.edited) sourceChip = '<span class="chip chip-gold">Edited by you</span>';
  else if (card.dataset.source === 'newsletter-auto') sourceChip = '<span class="chip chip-blue">📧 From newsletter</span>';

  let whenChip;
  let isPast = false;
  if (dateValue) {
    const days = daysFromToday(parseIsoDateLocal(dateValue));
    isPast = days < 0;
    if (days === 0) whenChip = '<span class="chip chip-gold">Today</span>';
    else if (days === 1) whenChip = '<span class="chip chip-gold">Tomorrow</span>';
    else if (days > 1) whenChip = `<span class="chip chip-green">In ${days} days</span>`;
    else whenChip = '<span class="chip">Past, shown faded</span>';
  } else {
    whenChip = card.dataset.original
      ? `<span class="chip">Shown as "${escapeHtml(card.dataset.original)}"</span>`
      : '<span class="chip">No date</span>';
  }
  card.classList.toggle('is-past', isPast);
  card.querySelector('.chips').innerHTML = sourceChip + whenChip;
}

function addAnnouncementCard(item = {}, { prepend = false } = {}) {
  const container = $('announcements-list');
  const empty = $('announcements-empty');
  if (empty) empty.remove();

  const date = item.date || '';
  const card = document.createElement('div');
  card.className = 'ann-card';
  card.dataset.id = 'ann-' + (++annCardCounter);
  if (item.source) card.dataset.source = item.source;
  if (item.addedAt) card.dataset.addedAt = item.addedAt;
  // A free-form date ("Every Friday") can't go in a date input; it's kept
  // as-is unless the admin picks a real date.
  if (date && !tryParseDateToISO(date)) card.dataset.original = date;

  card.innerHTML = `
    <div class="drag-handle" title="Drag to reorder" aria-hidden="true">⠿</div>
    <div class="ann-body">
      <div class="ann-top">
        <input type="date" class="hub-item-date" aria-label="Date">
        <div class="chips"></div>
        <button type="button" class="icon-btn danger remove-hub-item" title="Delete" aria-label="Delete announcement">${icon('trash')}</button>
      </div>
      <textarea class="hub-item-text" rows="2" placeholder="What should visitors know? Keep it to a sentence or two."></textarea>
    </div>
  `;
  card.querySelector('.hub-item-date').value = tryParseDateToISO(date) || '';
  const textarea = card.querySelector('.hub-item-text');
  textarea.value = item.text || '';

  card.querySelector('.hub-item-date').addEventListener('input', () => {
    updateAnnouncementChips(card);
    markSectionDirty('announcements');
  });
  textarea.addEventListener('input', () => {
    autosize(textarea);
    // Once edited here it's the admin's announcement: the bot won't reword
    // it and its 30-day auto-prune won't delete it.
    if (card.dataset.source === 'newsletter-auto') {
      card.dataset.source = 'manual';
      card.dataset.edited = '1';
      updateAnnouncementChips(card);
    }
    markSectionDirty('announcements');
  });
  card.querySelector('.remove-hub-item').addEventListener('click', () => {
    card.remove();
    markSectionDirty('announcements');
    if (!container.querySelector('.ann-card')) container.innerHTML = announcementsEmptyState();
  });

  updateAnnouncementChips(card);
  if (prepend) container.prepend(card);
  else container.appendChild(card);
  makeRowDraggable(card, container, announcementReorder);
  autosize(textarea);
  return card;
}

function announcementReorder(srcId, targetId) {
  const container = $('announcements-list');
  const srcRow = container.querySelector(`.ann-card[data-id="${srcId}"]`);
  const targetRow = container.querySelector(`.ann-card[data-id="${targetId}"]`);
  if (!srcRow || !targetRow) return;
  container.insertBefore(srcRow, targetRow);
  markSectionDirty('announcements');
}

function getAnnouncementItems() {
  return Array.from(document.querySelectorAll('#announcements-list .ann-card'))
    .map(card => {
      const dateValue = card.querySelector('.hub-item-date').value;
      const item = {
        date: dateValue ? formatDateForDisplay(dateValue) : (card.dataset.original || ''),
        text: card.querySelector('.hub-item-text').value.trim(),
      };
      if (card.dataset.source) item.source = card.dataset.source;
      if (card.dataset.addedAt) item.addedAt = card.dataset.addedAt;
      return item;
    })
    .filter(item => item.text);
}

function saveAnnouncements() {
  const items = getAnnouncementItems();
  const saveBtn = $('dirty-save');
  saveBtn.disabled = true;
  db.collection('hub_content').doc('announcements').set({ items })
    .then(() => {
      showToast('Announcements saved. The kiosk updates right away.', 'success');
      clearSectionDirty('announcements');
      renderAnnouncementsEditor(items);
      if (currentPage === 'announcements') document.querySelectorAll('.hub-item-text').forEach(autosize);
    })
    .catch(() => showToast('Error saving.', 'error'))
    .finally(() => { saveBtn.disabled = false; });
}

function discardAnnouncements() {
  clearSectionDirty('announcements');
  renderAnnouncementsEditor(savedAnnouncements);
  if (currentPage === 'announcements') document.querySelectorAll('.hub-item-text').forEach(autosize);
}

function addNewAnnouncement(item = {}) {
  goTo('announcements');
  const card = addAnnouncementCard(item, { prepend: true });
  markSectionDirty('announcements');
  card.classList.add('highlight-new');
  const textarea = card.querySelector('.hub-item-text');
  requestAnimationFrame(() => {
    autosize(textarea);
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    textarea.focus();
  });
  return card;
}

$('btn-add-announcement').addEventListener('click', () => addNewAnnouncement());

/* ============================================================
   PROGRAMS CALENDAR EDITOR
   Manual add/correct UI for the `programs` collection (one doc
   per ISO date) that also backs the kiosk's Events calendar.
   Bot-written days are tagged source:"newsletter-auto" (or the old
   "whatsapp-auto"); saving here always stamps source:"manual" and
   fully overwrites that day.
   ============================================================ */
let currentProgramDate = null;
let programItemCounter = 0;
let upcomingProgramDocs = [];
let programsUpcomingUnsub = null;

function isAutoProgramSource(source) {
  return source === 'newsletter-auto' || source === 'whatsapp-auto';
}

function programSourceChip(source) {
  if (source === 'newsletter-auto') return '<span class="chip chip-blue">📧 From newsletter</span>';
  if (source === 'whatsapp-auto') return '<span class="chip chip-blue">From WhatsApp bot</span>';
  return '<span class="chip">Saved by you</span>';
}

function loadProgramsAdmin() {
  const todayIso = toIsoDateLocal(new Date());
  if (programsUpcomingUnsub) programsUpcomingUnsub();
  programsUpcomingUnsub = db.collection('programs')
    .where('date', '>=', todayIso)
    .orderBy('date')
    .limit(30)
    .onSnapshot(snapshot => {
      upcomingProgramDocs = snapshot.docs.map(doc => ({ id: doc.id, data: doc.data() }));
      renderUpcomingProgramsList();
      renderHomePrograms();
    }, () => {
      $('programs-upcoming-list').innerHTML = '<p class="field-hint">Could not load programs.</p>';
    });
}

function renderUpcomingProgramsList() {
  const container = $('programs-upcoming-list');
  if (upcomingProgramDocs.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📅</div>
        <p>No upcoming days yet. They appear when the next newsletter arrives, or pick a date above to add one.</p>
      </div>`;
    return;
  }
  const todayIso = toIsoDateLocal(new Date());
  container.innerHTML = upcomingProgramDocs.map(({ id, data }) => {
    const d = parseIsoDateLocal(id);
    const items = data.items || [];
    const summary = data.specialOccasion ||
      (items.length ? `${plural(items.length, 'program')}: ${items.slice(0, 2).map(i => i.label).join(', ')}${items.length > 2 ? '…' : ''}` : 'No programs listed');
    return `
      <button type="button" class="day-row${id === currentProgramDate ? ' selected' : ''}${id === todayIso ? ' is-today' : ''}" data-date="${id}">
        <div class="day-badge">
          <div class="day-badge-wd">${id === todayIso ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'short' })}</div>
          <div class="day-badge-num">${d.getDate()}</div>
        </div>
        <div class="day-info">
          <div class="day-title">${d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div>
          <div class="day-summary">${escapeHtml(summary)}</div>
        </div>
        ${isAutoProgramSource(data.source) ? '<span class="chip chip-blue">Auto</span>' : ''}
      </button>
    `;
  }).join('');
  container.querySelectorAll('.day-row').forEach(btn => {
    btn.addEventListener('click', () => openProgramDay(btn.dataset.date));
  });
}

function markSelectedDay() {
  document.querySelectorAll('#programs-upcoming-list .day-row').forEach(row => {
    row.classList.toggle('selected', row.dataset.date === currentProgramDate);
  });
}

// Asks before throwing away unsaved edits to a different day.
async function openProgramDay(dateISO) {
  if (!dateISO) { showToast('Pick a date first.', 'error'); return; }
  if (dirtySections.has('program-day') && dateISO !== currentProgramDate) {
    const ok = await confirmDialog({
      title: 'Discard unsaved changes?',
      message: `Your changes to ${formatProgramDateLabel(currentProgramDate)} haven't been saved.`,
      confirmLabel: 'Discard changes'
    });
    if (!ok) return;
  }
  loadProgramDayIntoEditor(dateISO);
}

function showProgramEditor(dateISO, sourceChipHtml) {
  currentProgramDate = dateISO;
  $('program-editor-empty').classList.add('hidden');
  $('program-day-editor').classList.remove('hidden');
  $('programs-layout').classList.add('editing');
  $('program-editor-title').textContent = formatProgramDateLabel(dateISO);
  $('program-editor-source').innerHTML = sourceChipHtml;
  $('program-day-picker').value = dateISO;
  markSelectedDay();
  if (window.matchMedia('(max-width: 900px)').matches) {
    $('programs-layout').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function hideProgramEditor() {
  currentProgramDate = null;
  $('program-day-editor').classList.add('hidden');
  $('program-editor-empty').classList.remove('hidden');
  $('programs-layout').classList.remove('editing');
  $('program-day-picker').value = '';
  markSelectedDay();
}

function loadProgramDayIntoEditor(dateISO) {
  if (!dateISO) { showToast('Pick a date first.', 'error'); return; }
  showProgramEditor(dateISO, '');
  $('program-items-list').innerHTML = '<div class="loading-state"><div class="spinner"></div>Loading…</div>';

  db.collection('programs').doc(dateISO).get().then(doc => {
    if (currentProgramDate !== dateISO) return; // another day was opened meanwhile
    const data = doc.exists ? doc.data() : {};
    $('program-editor-source').innerHTML = doc.exists
      ? programSourceChip(data.source)
      : '<span class="chip chip-amber">New day, not saved yet</span>';
    $('program-occasion').value = data.specialOccasion || '';
    $('program-hijri').value = data.hijriSubtitle || '';

    const list = $('program-items-list');
    list.innerHTML = '';
    const items = data.items || [];
    if (items.length === 0) {
      addProgramItemRow(list, {});
    } else {
      items.forEach(item => addProgramItemRow(list, item));
    }
    clearSectionDirty('program-day');
  }).catch(err => {
    $('program-items-list').innerHTML = `<p class="field-hint">Could not load this day: ${escapeHtml(err.message)}</p>`;
    showToast('Error loading day.', 'error');
  });
}

function programReorder(srcId, targetId) {
  const container = $('program-items-list');
  const srcRow = container.querySelector(`.program-item-row[data-id="${srcId}"]`);
  const targetRow = container.querySelector(`.program-item-row[data-id="${targetId}"]`);
  if (!srcRow || !targetRow) return;
  container.insertBefore(srcRow, targetRow);
  markSectionDirty('program-day');
}

function addProgramItemRow(container, item) {
  const row = document.createElement('div');
  row.className = 'program-item-row';
  row.dataset.id = 'progrow-' + (++programItemCounter);
  row.innerHTML = `
    <div class="drag-handle" title="Drag to reorder" aria-hidden="true">⠿</div>
    <input type="time" class="program-item-time" aria-label="Time">
    <input type="text" class="program-item-label" placeholder="Program, e.g. Dua Kumayl" aria-label="Program">
    <input type="text" class="program-item-speaker" placeholder="Speaker (optional)" aria-label="Speaker">
    <input type="text" class="program-item-note" placeholder="Note (optional)" aria-label="Note">
    <button type="button" class="icon-btn danger remove-program-item" title="Remove" aria-label="Remove program">${icon('trash')}</button>
  `;
  row.querySelector('.program-item-time').value = item.time || '';
  row.querySelector('.program-item-label').value = item.label || '';
  row.querySelector('.program-item-speaker').value = item.speaker || '';
  row.querySelector('.program-item-note').value = item.note || '';
  row.querySelector('.remove-program-item').addEventListener('click', () => {
    row.remove();
    markSectionDirty('program-day');
  });
  row.querySelectorAll('input').forEach(inp => inp.addEventListener('input', () => markSectionDirty('program-day')));
  container.appendChild(row);
  makeRowDraggable(row, container, programReorder);
  return row;
}

['program-occasion', 'program-hijri'].forEach(id => {
  $(id).addEventListener('input', () => markSectionDirty('program-day'));
});

function getProgramItems() {
  const rows = Array.from(document.querySelectorAll('#program-items-list .program-item-row'))
    .map(row => ({
      time: row.querySelector('.program-item-time').value,
      label: row.querySelector('.program-item-label').value.trim(),
      speaker: row.querySelector('.program-item-speaker').value.trim(),
      note: row.querySelector('.program-item-note').value.trim(),
    }));
  // A row with only one of time/label filled in is a mistake, not an empty
  // row to discard — surface it instead of silently saving an incomplete day.
  const items = rows.filter(item => item.time && item.label);
  const incompleteCount = rows.filter(item => (item.time || item.label) && !(item.time && item.label)).length;
  items.sort((a, b) => a.time.localeCompare(b.time));
  return { items, incompleteCount };
}

function saveProgramDay() {
  if (!currentProgramDate) { showToast('Pick a date first.', 'error'); return; }
  const { items, incompleteCount } = getProgramItems();
  if (incompleteCount > 0) {
    showToast(
      `${incompleteCount} program${incompleteCount === 1 ? ' is' : 's are'} missing a time or a name. Fill in both or remove the row before saving.`,
      'error'
    );
    return;
  }
  const btn = $('btn-save-program-day');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  const dateISO = currentProgramDate;

  const docRef = db.collection('programs').doc(dateISO);
  docRef.get()
    .then(doc => {
      const createdAt = (doc.exists && doc.data().createdAt) ? doc.data().createdAt : firebase.firestore.FieldValue.serverTimestamp();
      return docRef.set({
        date: dateISO,
        specialOccasion: $('program-occasion').value.trim() || null,
        hijriSubtitle: $('program-hijri').value.trim() || null,
        items,
        source: 'manual',
        createdAt,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        rawMessageId: null
      });
    })
    .then(() => {
      showToast('Day saved. The kiosk calendar updates right away.', 'success');
      clearSectionDirty('program-day');
      if (currentProgramDate === dateISO) $('program-editor-source').innerHTML = programSourceChip('manual');
    })
    .catch(() => showToast('Error saving.', 'error'))
    .finally(() => {
      btn.disabled = false;
      btn.textContent = 'Save day';
    });
}

function discardProgramDay() {
  clearSectionDirty('program-day');
  if (currentProgramDate) loadProgramDayIntoEditor(currentProgramDate);
}

function scheduleProgramDayDelete(dateISO) {
  clearSectionDirty('program-day');
  hideProgramEditor();

  const timeoutId = setTimeout(() => {
    db.collection('programs').doc(dateISO).delete();
  }, 5000);

  showToast('Day deleted.', 'success', {
    label: 'Undo',
    onClick: () => {
      clearTimeout(timeoutId);
      loadProgramDayIntoEditor(dateISO);
    }
  });
}

$('btn-load-program-day').addEventListener('click', () => openProgramDay($('program-day-picker').value));
$('btn-add-program-item').addEventListener('click', () => {
  const row = addProgramItemRow($('program-items-list'), {});
  markSectionDirty('program-day');
  row.querySelector('.program-item-time').focus();
});
$('btn-save-program-day').addEventListener('click', saveProgramDay);
$('btn-delete-program-day').addEventListener('click', () => {
  if (!currentProgramDate) return;
  scheduleProgramDayDelete(currentProgramDate);
});
$('btn-editor-back').addEventListener('click', () => $('programs-layout').classList.remove('editing'));

function openImportCard() {
  goTo('programs');
  $('import-card').open = true;
  requestAnimationFrame(() => {
    $('import-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('program-paste-input').focus();
  });
}

/* ============================================================
   IMPORT FROM TEXT — parses a pasted weekly announcement (WhatsApp
   or email) with Gemini, previews the resulting days, and lets the
   admin either publish everything at once or review/edit a
   specific day first (in the day editor above).
   ============================================================ */
const PROGRAM_PARSE_SYSTEM_PROMPT = `You are classifying and extracting data from WhatsApp messages posted by a mosque (Masjid Al Hayy) to its community announcements group. This group posts two different kinds of messages that need different handling, plus occasional unrelated chatter — figure out which one this message is.

=== TYPE 1: Weekly programs schedule — messageType: "program" ===
Looks like this (real example):

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
is sometimes followed by a line naming a special occasion, then a bulleted list of "<time> - <event
label>" lines. If this is what you're looking at, set messageType: "program" and fill the days array —
see the item-extraction rules below.

=== TYPE 2: General community announcement — messageType: "announcement" ===
Looks like this (real example):

Salaamun Alaykum,

We wish to inform the community that Sunday, September 13th will be the first day of the Month of Rabi
al-Akhar 1448 A.H.

This determination is based on the fact there were no verified sightings of the crescent moon on the
evening of Friday, September 11th.

We ask Allah, the Most High, for success in performing good deeds during this blessed month and to
hasten the reappearance of Our Master, Imam Mahdi (atfs).

Important Dates of the Month:
10th Rabi al-Akhar (September 22) – Wiladat of Imam Hassan al-Askari (as)

This kind is prose, not a bulleted schedule — moon-sighting declarations, community notices, condolences,
general news, etc. If this is what you're looking at, set messageType: "announcement" and fill:
- announcementMonthName / announcementDayNumber: the single most important date the announcement is
  centered on (e.g. the new month's start date above). If multiple dates are mentioned, pick the primary
  one the announcement is actually about. If no specific date is central to the announcement, leave
  announcementMonthName as an empty string and announcementDayNumber as 0.
- announcementText: a clear, concise 1-3 sentence summary for a kiosk display — capture the key fact and
  any critical date, but it does not need to be verbatim.

=== TYPE 3: Neither — messageType: "other" ===
Casual chat, a reply, a one-off notice that doesn't fit either pattern above, a flyer caption, etc. Set
messageType: "other" and leave days empty, announcementMonthName as an empty string, announcementDayNumber
as 0, and announcementText as an empty string. Do not guess or force-fit unrelated text into either schema.

--- Program item extraction rules (only relevant when messageType is "program") ---
IMPORTANT — skip routine prayer lines: the kiosk this feeds already has a separate, always-on Prayer
Times display, so do NOT include a bulleted line that is only a routine obligatory prayer announcement
(Fajr Salaat, Zohrain Salaat, Asr Salaat, Maghribain Salaat, Isha Salaat), even if it has
a jamaat-time note in parentheses like "(6:30 AM Jamaat)". EXCEPTION: always KEEP the Friday Jumu'ah
Salaat line (any spelling, e.g. Jummah, Juma, Jumu'ah) — it is a weekly congregational event the masjid
wants on the calendar. Apart from Jumu'ah, only include lines that name something beyond
the routine prayer itself — a lecture, dua, recitation, ziyarat, class, breakfast, or other named activity.
If a routine prayer is bundled with something extra on the same line (e.g. "Fajr Salaat, Dua Sabah,
Breakfast"), keep the line since it contains real content beyond the prayer. If, after excluding pure
routine-prayer lines, a day has no items left AND no special occasion, omit that day from the days array
entirely — a day with nothing but routine prayers isn't worth a calendar entry. But if the day still has a
named special occasion (e.g. "Wiladat Imam Hassan Al Askari (as)"), keep that day even with an empty items
list, since the occasion itself is worth showing.

For each day found:
- monthName: full month name (e.g. "September")
- dayNumber: the day of month as an integer (e.g. 17)
- hijriSubtitle: the "Nth Night of Hijri-month" text if present, else an empty string
- specialOccasion: the special occasion line if present, else an empty string
- items: each qualifying bulleted line (per the routine-prayer rule above), with:
  - time24: the time converted to 24-hour "HH:MM" (e.g. "1:22 PM" -> "13:22")
  - label: the event name, with any trailing "- Speaker Name" and any parenthetical removed
  - speaker: the trailing "- Name" if present, else an empty string
  - note: the parenthetical content if present (without the parentheses), else an empty string`;

const PROGRAM_PARSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    messageType: { type: 'STRING' },
    days: {
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
    announcementMonthName: { type: 'STRING' },
    announcementDayNumber: { type: 'INTEGER' },
    announcementText: { type: 'STRING' }
  },
  required: ['messageType', 'days', 'announcementMonthName', 'announcementDayNumber', 'announcementText']
};

const PROGRAM_MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

// Same Dec -> Jan rollover logic as the (unused, kept for reference)
// whatsapp-bot/src/dateResolution.js — duplicated here since this is a
// no-build-process, browser-only page with no shared module system.
function resolveProgramYear(monthName, dayNumber, referenceDate) {
  const refYear = referenceDate.getFullYear();
  const refMonthIdx = referenceDate.getMonth();
  const eventMonthIdx = PROGRAM_MONTH_NAMES.indexOf(String(monthName || '').toLowerCase());
  let year = refYear;
  if (eventMonthIdx !== -1 && eventMonthIdx < refMonthIdx - 1) year = refYear + 1;
  const mm = String((eventMonthIdx === -1 ? refMonthIdx : eventMonthIdx) + 1).padStart(2, '0');
  const dd = String(dayNumber).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

const GEMINI_MAX_ATTEMPTS = 4;

// Tried in order when the main model is overloaded (503) or out of
// free-tier quota (429, counted per model). Picked from the models this
// API key can actually call, same rules as pickFallbackModels_() in
// newsletter-bot/Code.gs, so renamed/retired models can't break it.
const GEMINI_FALLBACK_COUNT = 3;
const GEMINI_FALLBACK_MAX_ATTEMPTS = 2;
let geminiFallbackModels = null;

async function getGeminiFallbackModels(apiKey) {
  if (geminiFallbackModels) return geminiFallbackModels;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${apiKey}`);
    if (!res.ok) return [];
    const names = ((await res.json()).models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace('models/', ''));
    const version = n => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0');
    const isLite = n => /lite/.test(n) ? 1 : 0;
    const isPreview = n => /preview|exp/.test(n) ? 1 : 0;
    const isNewer = n => version(n) > version(GEMINI_MODEL) ? 1 : 0;
    geminiFallbackModels = names
      .filter(n => n !== GEMINI_MODEL && /^gemini-.*flash/.test(n) && !/image|tts|audio|live|embed|thinking/.test(n))
      .sort((a, b) => isNewer(a) - isNewer(b) || version(b) - version(a) || isPreview(a) - isPreview(b) || isLite(a) - isLite(b) || a.localeCompare(b))
      .slice(0, GEMINI_FALLBACK_COUNT);
    return geminiFallbackModels;
  } catch (err) {
    return [];
  }
}

// Gemini's free tier gets deprioritized under high demand and can return
// several 503s in a row (observed a real streak of 3 straight 503s taking
// ~80s total during testing) — retry the main model with growing delays,
// then fall back to lighter models instead of surfacing that as a failure
// the admin has to notice and manually redo.
async function callGeminiParse(text) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error('No Gemini API key found — check the admin_config/gemini document in Firestore.');
  }
  const status = document.getElementById('program-parse-status');
  const setStatus = msg => { if (status) status.textContent = msg; };
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: PROGRAM_PARSE_SYSTEM_PROMPT }] },
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: PROGRAM_PARSE_SCHEMA
    }
  });

  let models = [GEMINI_MODEL];
  let lastProblem = '';
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const maxAttempts = i === 0 ? GEMINI_MAX_ATTEMPTS : GEMINI_FALLBACK_MAX_ATTEMPTS;
    if (i > 0) setStatus(`Main AI model is busy — trying a lighter one (${model})…`);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });

      if (res.ok) {
        const data = await res.json();
        const outText = data.candidates && data.candidates[0] && data.candidates[0].content.parts[0].text;
        if (!outText) throw new Error('No response from Gemini.');
        return JSON.parse(outText);
      }
      // 503 = temporarily overloaded, worth retrying. 429 = this model's
      // quota is used up and retrying won't help, but the free-tier quota
      // is per model, so a fallback model may still have some left.
      if (res.status === 503) {
        lastProblem = 'busy';
        if (attempt < maxAttempts) {
          setStatus(`Gemini is busy — retrying (${attempt}/${maxAttempts - 1})… this can take a minute during high demand.`);
          await new Promise(resolve => setTimeout(resolve, Math.min(attempt * 2000, 10000)));
          continue;
        }
        break;
      }
      if (res.status === 429) { lastProblem = 'quota'; break; }
      if (res.status === 404) break;
      const errText = await res.text();
      throw new Error(`Gemini API error (${model}, ${res.status}): ${errText.slice(0, 200)}`);
    }
    // Only looked up once the main model has failed, so the normal path
    // costs no extra request.
    if (i === 0) models = models.concat(await getGeminiFallbackModels(apiKey));
  }

  if (lastProblem === 'quota') {
    throw new Error("Gemini's free-tier quota is used up for now — this isn't a bug, it just needs time to reset (usually within a day). Try again later.");
  }
  throw new Error("Every Gemini model is busy right now — this is on Google's side. Try again in a few minutes.");
}

let lastParsedDays = [];

async function parseWhatsAppPaste() {
  const text = $('program-paste-input').value.trim();
  if (!text) { showToast('Paste some text first.', 'error'); return; }

  const btn = $('btn-parse-paste');
  const status = $('program-parse-status');
  btn.disabled = true;
  status.textContent = 'Reading with AI…';
  $('program-parse-preview').innerHTML = '';

  try {
    const result = await callGeminiParse(text);
    if (result.messageType === 'program' && result.days && result.days.length > 0) {
      renderParsePreview(result.days);
    } else if (result.messageType === 'announcement') {
      handleParsedAnnouncement(result);
    } else {
      status.textContent = "This doesn't look like a programs schedule or a general announcement, so there's nothing to add.";
    }
  } catch (err) {
    status.textContent = '';
    showToast('AI reading failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// General (non-schedule) announcements don't get their own publish path —
// they're added as a new, unsaved card on the Announcements page, reusing
// its normal edit/Save flow rather than a separate write path.
function handleParsedAnnouncement(result) {
  let dateLabel = '';
  if (result.announcementMonthName && result.announcementDayNumber) {
    const isoDate = resolveProgramYear(result.announcementMonthName, result.announcementDayNumber, new Date());
    dateLabel = formatDateForDisplay(isoDate);
  }

  $('program-parse-status').textContent = 'That was an announcement, so it was added to the Announcements page. Check it and click Save there.';
  $('program-parse-preview').innerHTML = '';
  $('program-paste-input').value = '';
  addNewAnnouncement({ date: dateLabel, text: result.announcementText || '' });
  showToast('Added to Announcements. Check it, then click Save.', 'success');
}

function renderParsePreview(rawDays) {
  const referenceDate = new Date();
  lastParsedDays = rawDays.map(day => {
    const isoDate = resolveProgramYear(day.monthName, day.dayNumber, referenceDate);
    const items = (day.items || [])
      .map(item => ({
        time: item.time24 || '',
        label: item.label || '',
        speaker: item.speaker || '',
        note: item.note || ''
      }))
      .filter(item => item.time && item.label)
      .sort((a, b) => a.time.localeCompare(b.time));
    return {
      isoDate,
      hijriSubtitle: day.hijriSubtitle || null,
      specialOccasion: day.specialOccasion || null,
      items
    };
  })
  // Safety net alongside the prompt instructions: drop a day entirely if
  // it has nothing worth showing (no items and no special occasion) — e.g.
  // if the AI ever still lets a pure-routine-prayer day through.
  .filter(day => day.items.length > 0 || day.specialOccasion);

  if (lastParsedDays.length === 0) {
    $('program-parse-status').textContent = 'Only routine prayer times were found, so there is nothing to add to the calendar.';
    $('program-parse-preview').innerHTML = '';
    return;
  }

  $('program-parse-status').textContent =
    `Found ${plural(lastParsedDays.length, 'day')}. Check them below, then publish. Publishing replaces whatever is already on those days.`;

  const container = $('program-parse-preview');
  container.innerHTML = `
    <div class="parse-preview-list">
      ${lastParsedDays.map((day, i) => `
        <div class="parse-preview-card">
          <div class="parse-preview-info">
            <div class="parse-preview-date">${formatProgramDateLabel(day.isoDate)}</div>
            ${day.specialOccasion ? `<div class="parse-preview-occasion">${escapeHtml(day.specialOccasion)}</div>` : ''}
            <div class="parse-preview-count">${day.items.length ? day.items.map(item => escapeHtml(item.label)).join(' · ') : 'No programs, occasion only'}</div>
          </div>
          <button type="button" class="btn btn-sm btn-secondary parse-preview-edit" data-index="${i}">Review / edit</button>
        </div>
      `).join('')}
    </div>
    <div class="parse-actions">
      <button type="button" class="btn btn-primary" id="btn-publish-all-parsed">Publish all ${plural(lastParsedDays.length, 'day')}</button>
    </div>
  `;

  container.querySelectorAll('.parse-preview-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      loadParsedDayIntoEditor(lastParsedDays[parseInt(btn.dataset.index, 10)]);
    });
  });
  $('btn-publish-all-parsed').addEventListener('click', publishAllParsedDays);
}

// Pre-fills the day editor with parsed-but-unsaved data, so the admin can
// tweak it and use the normal Save day button (with its incomplete-row
// validation) rather than a separate save path.
async function loadParsedDayIntoEditor(day) {
  if (dirtySections.has('program-day') && day.isoDate !== currentProgramDate) {
    const ok = await confirmDialog({
      title: 'Discard unsaved changes?',
      message: `Your changes to ${formatProgramDateLabel(currentProgramDate)} haven't been saved.`,
      confirmLabel: 'Discard changes'
    });
    if (!ok) return;
  }
  showProgramEditor(day.isoDate, '<span class="chip chip-amber">From AI, not saved yet</span>');
  $('program-occasion').value = day.specialOccasion || '';
  $('program-hijri').value = day.hijriSubtitle || '';

  const list = $('program-items-list');
  list.innerHTML = '';
  if (day.items.length === 0) {
    addProgramItemRow(list, {});
  } else {
    day.items.forEach(item => addProgramItemRow(list, item));
  }
  markSectionDirty('program-day');
  $('program-day-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function publishAllParsedDays() {
  if (lastParsedDays.length === 0) return;
  const btn = $('btn-publish-all-parsed');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Publishing…';

  const batch = db.batch();
  const timestamp = firebase.firestore.FieldValue.serverTimestamp();
  lastParsedDays.forEach(day => {
    batch.set(db.collection('programs').doc(day.isoDate), {
      date: day.isoDate,
      hijriSubtitle: day.hijriSubtitle,
      specialOccasion: day.specialOccasion,
      items: day.items,
      source: 'manual',
      createdAt: timestamp,
      updatedAt: timestamp,
      rawMessageId: null
    });
  });

  batch.commit()
    .then(() => {
      showToast(`Published ${plural(lastParsedDays.length, 'day')} to the calendar.`, 'success');
      $('program-paste-input').value = '';
      $('program-parse-preview').innerHTML = '';
      $('program-parse-status').textContent = '';
      lastParsedDays = [];
    })
    .catch(err => showToast('Error publishing: ' + err.message, 'error'))
    .finally(() => {
      btn.disabled = false;
      btn.textContent = originalLabel;
    });
}

$('btn-parse-paste').addEventListener('click', parseWhatsAppPaste);

/* ============================================================
   GEMINI API KEY — stored in Firestore (admin_config/gemini), set once
   and not editable here. To change/rotate it, edit the apiKey field of
   that document in the Firebase Console (Firestore Database -> Data).
   ============================================================ */
let currentGeminiApiKey = '';

function getGeminiApiKey() {
  return currentGeminiApiKey;
}

function setAiKeyStatus(level, headline, desc) {
  $('ai-key-dot').className = 'dot' + (level ? ' dot-' + level : '');
  $('ai-key-headline').textContent = headline;
  $('ai-key-desc').textContent = desc;
}

function loadGeminiApiKey() {
  db.collection('admin_config').doc('gemini').get().then(doc => {
    currentGeminiApiKey = (doc.exists && doc.data().apiKey) || '';
    if (currentGeminiApiKey) {
      setAiKeyStatus('green', 'Connected', 'Used by "Import a schedule from text" on the Programs page and by the newsletter bot.');
    } else {
      setAiKeyStatus('red', 'No key found', 'Add a Gemini API key in the Firebase Console: Firestore → admin_config → gemini → apiKey. The newsletter bot uses the same key.');
    }
  }).catch(() => {
    // Likely means the admin_config Firestore rule isn't set up — parsing
    // will surface a clear "no API key" error if this ends up empty.
    setAiKeyStatus('amber', "Can't check the key", 'The Firestore rules may not allow reading admin_config/gemini.');
  });
}

/* ============================================================
   NEWSLETTER BOT STATUS — heartbeat written by newsletter-bot/Code.gs
   on every run (every 30 minutes) to admin_config/newsletter_status
   ============================================================ */
let botStatus; // undefined = loading, null = never run, 'unreadable' = rules block it

function loadNewsletterBotStatus() {
  db.collection('admin_config').doc('newsletter_status').onSnapshot(doc => {
    botStatus = doc.exists ? doc.data() : null;
    renderBotStatus();
  }, () => {
    // Most likely the admin_config rule only covers the gemini doc.
    botStatus = 'unreadable';
    renderBotStatus();
  });
}

const tsToDate = ts => (ts && ts.toDate ? ts.toDate() : null);

function botHealth() {
  if (botStatus === undefined) return { level: '', headline: 'Checking…', detail: '' };
  if (botStatus === 'unreadable') {
    return { level: 'amber', headline: "Can't read status", detail: "The Firestore rules don't allow reading admin_config/newsletter_status." };
  }
  if (!botStatus) {
    return { level: 'red', headline: 'Not set up', detail: 'The bot has never run. Setup steps are in newsletter-bot/README.md.' };
  }
  const lastRun = tsToDate(botStatus.lastRunAt);
  const age = lastRun ? Date.now() - lastRun.getTime() : Infinity;
  if (age > 6 * 60 * 60 * 1000) {
    return { level: 'red', headline: 'Stopped', detail: `Last check was ${timeAgo(lastRun)}. It normally checks every 30 minutes. Open Apps Script → Executions to see why.` };
  }
  if (botStatus.lastError) {
    return { level: 'amber', headline: 'Working, with a problem', detail: botStatus.lastError };
  }
  if (age > 75 * 60 * 1000) {
    return { level: 'amber', headline: 'Running late', detail: `Last check was ${timeAgo(lastRun)}. It normally checks every 30 minutes.` };
  }
  return { level: 'green', headline: 'Working', detail: `Checked for new emails ${timeAgo(lastRun)}.` };
}

function renderBotStatus() {
  const health = botHealth();
  const dotClass = 'dot' + (health.level ? ' dot-' + health.level : '');
  const s = botStatus && typeof botStatus === 'object' ? botStatus : null;
  const lastPublished = s && s.lastProcessedSubject
    ? `Last added from "${s.lastProcessedSubject}", ${timeAgo(tsToDate(s.lastProcessedAt))}.`
    : '';

  // Home card
  $('home-bot-dot').className = dotClass;
  $('home-bot-value').textContent = health.headline;
  $('home-bot-desc').textContent = [health.detail, lastPublished].filter(Boolean).join(' ');

  // Programs page line
  $('programs-bot-dot').className = dotClass;
  $('programs-bot-text').textContent = s && s.lastRunAt
    ? `Newsletter bot: ${health.headline.toLowerCase()} · last checked ${timeAgo(tsToDate(s.lastRunAt))}`
    : `Newsletter bot: ${health.headline.toLowerCase()}`;

  // Settings card
  $('settings-bot-dot').className = dotClass;
  $('settings-bot-headline').textContent = health.headline;
  const fmt = ts => {
    const d = tsToDate(ts);
    return d ? `${d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} (${timeAgo(d)})` : 'Never';
  };
  const rows = [];
  if (s) {
    rows.push(['Last check', fmt(s.lastRunAt)]);
    rows.push(['Last newsletter added', s.lastProcessedSubject ? `"${s.lastProcessedSubject}"` : 'None yet']);
    if (s.lastProcessedAt) rows.push(['Added on', fmt(s.lastProcessedAt)]);
    if (s.lastSummary) rows.push(['What it added', s.lastSummary]);
    if (s.lastError) rows.push(['Last problem', s.lastError, 'error']);
  } else if (health.detail) {
    rows.push(['Status', health.detail]);
  }
  $('settings-bot-details').innerHTML = rows.map(([label, value, cls]) =>
    `<dt>${label}</dt><dd${cls ? ` class="${cls}"` : ''}>${escapeHtml(value)}</dd>`).join('');
}

/* ============================================================
   DELETE ALL EVENTS — two-step "arm, then confirm" instead of a
   blocking dialog. First click turns the button into an explicit
   warning; a second click within 5s deletes everything in `programs`
   (no undo — this is a genuinely destructive, bulk action).
   ============================================================ */
let deleteAllProgramsArmed = false;
let deleteAllProgramsArmTimeout = null;

function disarmDeleteAllPrograms() {
  deleteAllProgramsArmed = false;
  clearTimeout(deleteAllProgramsArmTimeout);
  const btn = $('btn-delete-all-programs');
  btn.textContent = 'Delete all events';
  btn.classList.remove('btn-armed');
}

$('btn-delete-all-programs').addEventListener('click', () => {
  const btn = $('btn-delete-all-programs');

  if (!deleteAllProgramsArmed) {
    deleteAllProgramsArmed = true;
    btn.textContent = '⚠️ Click again to delete everything';
    btn.classList.add('btn-armed');
    deleteAllProgramsArmTimeout = setTimeout(disarmDeleteAllPrograms, 5000);
    return;
  }

  disarmDeleteAllPrograms();
  btn.disabled = true;

  db.collection('programs').get()
    .then(snapshot => {
      if (snapshot.empty) {
        showToast('There are no events to delete.', 'success');
        return;
      }
      const docs = snapshot.docs;
      const chunks = [];
      for (let i = 0; i < docs.length; i += 500) chunks.push(docs.slice(i, i + 500));

      return chunks.reduce((promise, chunk) => promise.then(() => {
        const batch = db.batch();
        chunk.forEach(doc => batch.delete(doc.ref));
        return batch.commit();
      }), Promise.resolve()).then(() => {
        showToast(`Deleted ${plural(docs.length, 'day')} of events.`, 'success');
        clearSectionDirty('program-day');
        hideProgramEditor();
      });
    })
    .catch(err => showToast('Error deleting events: ' + err.message, 'error'))
    .finally(() => { btn.disabled = false; });
});
