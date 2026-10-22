/* ============================================================
   CLIENT PORTAL — script for portal.html (plain browser JS, no build).
   Clients create an account (status "pending" until an admin approves it
   in admin.html), then submit posters/videos to Firestore `submissions`
   for admin review. Files go straight to Cloudinary, like admin uploads.
   See firestore.rules for what clients are (and aren't) allowed to touch.
   ============================================================ */
// A named app keeps the portal's sign-in separate from admin.html's. Both pages
// share one origin, so with the default app a client session in one tab and an
// admin session (or admin.js's "not an admin" sign-out) in another would clobber each other.
const portalApp = firebase.initializeApp(firebaseConfig, 'portal');
const auth = portalApp.auth();
const db = portalApp.firestore();

const $ = id => document.getElementById(id);

document.querySelectorAll('.js-masjid-name').forEach(el => { el.textContent = KIOSK_CONFIG.masjidName; });

/* ============================================================
   SMALL HELPERS
   ============================================================ */
function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// "2026-10-31" (an <input type="date"> value) -> "Oct 31"
function formatIsoShort(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatDateShort(date) {
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function showToast(msg, type = 'success') {
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  const text = document.createElement('span');
  text.textContent = msg;
  toast.appendChild(text);
  $('toast-container').appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, 3500);
}

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
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
});

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

function authErrorMessage(err) {
  switch (err.code) {
    case 'auth/invalid-credential':
    case 'auth/user-not-found':
    case 'auth/wrong-password':
      return 'Incorrect email or password.';
    case 'auth/email-already-in-use':
      return 'An account with that email already exists. Try signing in instead.';
    case 'auth/weak-password':
      return 'Choose a longer password (at least 6 characters).';
    case 'auth/invalid-email':
      return 'That email address doesn\'t look right.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a few minutes and try again.';
    default:
      return err.message;
  }
}

/* ============================================================
   SIGN IN / CREATE ACCOUNT
   ============================================================ */
let signingUp = false; // the clients/{uid} doc doesn't exist for a moment after sign-up

function showAuthTab(which) {
  const signup = which === 'signup';
  $('tab-signin').classList.toggle('active', !signup);
  $('tab-signup').classList.toggle('active', signup);
  $('tab-signin').setAttribute('aria-selected', String(!signup));
  $('tab-signup').setAttribute('aria-selected', String(signup));
  $('signin-form').classList.toggle('hidden', signup);
  $('signup-form').classList.toggle('hidden', !signup);
  $('auth-error').textContent = '';
}

$('tab-signin').addEventListener('click', () => showAuthTab('signin'));
$('tab-signup').addEventListener('click', () => showAuthTab('signup'));

$('signin-form').addEventListener('submit', e => {
  e.preventDefault();
  $('auth-error').textContent = '';
  auth.signInWithEmailAndPassword($('signin-email').value.trim(), $('signin-password').value)
    .catch(err => { $('auth-error').textContent = authErrorMessage(err); });
});

$('btn-reset-password').addEventListener('click', () => {
  const email = $('signin-email').value.trim();
  if (!email) {
    $('auth-error').textContent = 'Enter your email above first, then click "Forgot your password?".';
    return;
  }
  auth.sendPasswordResetEmail(email)
    .then(() => showToast('If that email has an account, a reset link is on its way.', 'success'))
    .catch(err => { $('auth-error').textContent = authErrorMessage(err); });
});

$('signup-form').addEventListener('submit', async e => {
  e.preventDefault();
  const errorBox = $('auth-error');
  errorBox.textContent = '';
  const name = $('signup-name').value.trim();
  if (!name) {
    errorBox.textContent = 'Enter your name.';
    return;
  }
  const button = $('btn-signup');
  button.disabled = true;
  signingUp = true;
  try {
    const cred = await auth.createUserWithEmailAndPassword($('signup-email').value.trim(), $('signup-password').value);
    const profile = {
      name,
      organization: $('signup-org').value.trim(),
      email: cred.user.email,
      status: 'pending',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    const phone = $('signup-phone').value.trim();
    if (phone) profile.phone = phone;
    await db.collection('clients').doc(cred.user.uid).set(profile);
  } catch (err) {
    errorBox.textContent = authErrorMessage(err);
  } finally {
    signingUp = false;
    button.disabled = false;
  }
});

document.querySelectorAll('.js-logout').forEach(btn => btn.addEventListener('click', () => auth.signOut()));

/* ============================================================
   ACCOUNT STATE — follows clients/{uid} live, so the page flips to
   the dashboard the moment an admin approves the account
   ============================================================ */
let unsubscribeClient = null;
let unsubscribeSubmissions = null;
let currentClient = null;
let dashboardUid = null;

function showScreen(name) {
  $('auth-screen').classList.toggle('hidden', name !== 'auth');
  $('gate-screen').classList.toggle('hidden', name !== 'gate');
  $('portal').classList.toggle('hidden', name !== 'portal');
}

function showGate(title, message) {
  $('gate-title').textContent = title;
  $('gate-message').textContent = message;
  showScreen('gate');
}

function stopListeners() {
  if (unsubscribeClient) unsubscribeClient();
  if (unsubscribeSubmissions) unsubscribeSubmissions();
  unsubscribeClient = unsubscribeSubmissions = null;
  currentClient = null;
  dashboardUid = null;
  submissions = [];
}

auth.onAuthStateChanged(user => {
  stopListeners();
  if (!user) {
    showScreen('auth');
    return;
  }
  showGate('Just a moment…', 'Loading your account.');
  unsubscribeClient = db.collection('clients').doc(user.uid).onSnapshot(doc => {
    if (!doc.exists) {
      // Sign-up writes this doc right after creating the user.
      if (!signingUp) {
        showGate('No client account', 'This email isn\'t registered as a client. Sign out and create an account, or use the admin page if you\'re part of the masjid team.');
      }
      return;
    }
    currentClient = doc.data();
    renderAccountState(user);
  }, err => {
    showGate('Couldn\'t load your account', err.message);
  });
});

function renderAccountState(user) {
  const status = currentClient.status;
  if (status === 'approved') {
    $('portal-user-name').textContent = currentClient.name || user.email;
    showScreen('portal');
    if (dashboardUid !== user.uid) {
      dashboardUid = user.uid;
      startSubmissionsListener(user.uid);
    }
    return;
  }
  if (unsubscribeSubmissions) {
    unsubscribeSubmissions();
    unsubscribeSubmissions = null;
    dashboardUid = null;
  }
  if (status === 'rejected') {
    showGate('Account not approved', 'The masjid couldn\'t approve this account.' + (currentClient.rejectReason ? ` Reason: ${currentClient.rejectReason}` : ' Please contact the masjid office if you think this is a mistake.'));
  } else if (status === 'suspended') {
    showGate('Account paused', 'This account has been paused by the masjid. Please contact the office to have it reinstated.');
  } else {
    showGate('Waiting for approval', 'Thanks for signing up! The masjid reviews every new account before it can submit posters. This page updates by itself as soon as you\'re approved.');
  }
}

/* ============================================================
   SUBMISSIONS LIST
   ============================================================ */
let submissions = [];
let subFilter = 'all';

function startSubmissionsListener(uid) {
  // No orderBy: combining it with the clientUid filter would need a
  // composite index, and a client has few enough submissions to sort here.
  unsubscribeSubmissions = db.collection('submissions').where('clientUid', '==', uid).onSnapshot(snapshot => {
    submissions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    submissions.sort((a, b) => submittedAtMillis(b) - submittedAtMillis(a));
    renderSubmissions();
  }, err => {
    $('sub-list').innerHTML = `<p class="field-hint">Could not load your submissions: ${escapeHtml(err.message)}</p>`;
  });
}

// createdAt is briefly null on a just-added doc (pending server timestamp).
function submittedAtMillis(sub) {
  return sub.createdAt ? sub.createdAt.toMillis() : Date.now();
}

// What the client sees for a submission's state.
function describeSubmission(sub) {
  const now = Date.now();
  // A pending submission that already has a live slide is a revised version.
  if (sub.status === 'pending') {
    return { key: 'pending', chip: `<span class="chip chip-amber">${sub.adId ? 'Revised version under review' : 'Under review'}</span>` };
  }
  if (sub.status === 'changes_requested') return { key: 'changes', chip: '<span class="chip chip-blue">Edits requested</span>' };
  if (sub.status === 'rejected') return { key: 'rejected', chip: '<span class="chip chip-red">Not approved</span>' };
  if (sub.status === 'withdrawn') return { key: 'withdrawn', chip: '<span class="chip chip-grey">Withdrawn</span>' };
  if (sub.status === 'approved') {
    const ended = sub.expiresAt && sub.expiresAt.toMillis() <= now;
    const upcoming = sub.startsAt && sub.startsAt.toMillis() > now;
    if (ended) return { key: 'approved', chip: '<span class="chip chip-grey">Ended</span>' };
    if (upcoming) return { key: 'approved', chip: `<span class="chip chip-green">Approved · starts ${formatDateShort(sub.startsAt.toDate())}</span>` };
    return { key: 'approved', chip: '<span class="chip chip-green">Approved · on the screen</span>' };
  }
  return { key: 'other', chip: '' };
}

$('sub-filters').addEventListener('click', e => {
  const chip = e.target.closest('.filter-chip');
  if (!chip) return;
  subFilter = chip.dataset.filter;
  renderSubmissions();
});

function renderSubmissions() {
  const listEl = $('sub-list');
  const counts = { all: submissions.length, pending: 0, approved: 0, changes: 0, rejected: 0 };
  submissions.forEach(sub => {
    const key = describeSubmission(sub).key;
    if (counts[key] !== undefined) counts[key]++;
  });
  const labels = { all: 'All', pending: 'Under review', approved: 'Approved', changes: 'Edits requested', rejected: 'Not approved' };
  document.querySelectorAll('#sub-filters .filter-chip').forEach(chip => {
    const f = chip.dataset.filter;
    chip.classList.toggle('active', f === subFilter);
    chip.innerHTML = `${labels[f]}<span class="count">${counts[f]}</span>`;
  });

  const visible = submissions.filter(sub => subFilter === 'all' || describeSubmission(sub).key === subFilter);
  if (visible.length === 0) {
    listEl.innerHTML = submissions.length === 0
      ? `<div class="empty-state"><div class="empty-state-icon">🖼️</div><p>You haven't submitted anything yet.<br>Click <strong>New submission</strong> to send your first poster or video.</p></div>`
      : `<div class="empty-state"><p>Nothing here.</p></div>`;
    return;
  }

  listEl.innerHTML = '';
  visible.forEach(sub => {
    const info = describeSubmission(sub);
    const card = document.createElement('div');
    card.className = 'sub-card';

    const meta = [];
    meta.push(sub.type === 'video' ? 'Video' : 'Image');
    if (sub.createdAt) meta.push('Sent ' + formatDateShort(sub.createdAt.toDate()));
    if (sub.requestedStart || sub.requestedEnd) {
      const from = sub.requestedStart ? formatIsoShort(sub.requestedStart) : 'any time';
      const to = sub.requestedEnd ? formatIsoShort(sub.requestedEnd) : 'open-ended';
      meta.push(`You asked for: ${from} → ${to}`);
    }

    let note = '';
    if (sub.status === 'rejected') {
      note = `<div class="sub-note sub-note-red"><strong>Not approved.</strong> ${sub.rejectReason ? escapeHtml(sub.rejectReason) : 'No reason was given.'}</div>`;
    } else if (sub.status === 'changes_requested') {
      note = `<div class="sub-note sub-note-blue"><strong>The masjid asked for changes:</strong> ${sub.editRequest ? escapeHtml(sub.editRequest) : 'Please send a revised version.'}</div>`;
    } else if (sub.status === 'approved') {
      const now = Date.now();
      const ended = sub.expiresAt && sub.expiresAt.toMillis() <= now;
      const upcoming = sub.startsAt && sub.startsAt.toMillis() > now;
      const from = upcoming ? ` starting ${formatDateShort(sub.startsAt.toDate())}` : '';
      const until = sub.expiresAt ? ` until ${formatDateShort(sub.expiresAt.toDate())}` : '';
      note = ended
        ? `<div class="sub-note sub-note-green">This ran on the masjid screen${until}.</div>`
        : upcoming
          ? `<div class="sub-note sub-note-green"><strong>Approved!</strong> It will play on the masjid screen${from}${until}.</div>`
          : `<div class="sub-note sub-note-green"><strong>Approved!</strong> It's playing on the masjid screen${until}.</div>`;
    }

    const actions = [];
    // Once a slide is live (adId), the only way to change it is the masjid's edit request.
    if (sub.status === 'pending' && !sub.adId) actions.push('<button type="button" class="btn btn-secondary btn-sm act-withdraw">Withdraw</button>');
    if (sub.status === 'rejected') actions.push('<button type="button" class="btn btn-primary btn-sm act-resubmit">Submit a fixed version</button>');
    if (sub.status === 'changes_requested') actions.push('<button type="button" class="btn btn-primary btn-sm act-revise">Send revised version</button>');

    card.innerHTML = `
      <button type="button" class="slide-thumb" title="View full size" aria-label="View full size">
        ${sub.type === 'video'
          ? `<video src="${escapeHtml(sub.url)}" muted preload="metadata"></video><span class="thumb-badge">▶</span>`
          : `<img src="${escapeHtml(sub.url)}" alt="" loading="lazy">`}
      </button>
      <div class="sub-body">
        <div class="chips">${info.chip}</div>
        <div class="sub-title">${sub.title ? escapeHtml(sub.title) : '<span class="muted">Untitled</span>'}</div>
        <div class="sub-meta">${meta.map(escapeHtml).join(' · ')}</div>
        ${note}
        ${actions.length ? `<div class="sub-actions">${actions.join('')}</div>` : ''}
      </div>
    `;

    card.querySelector('.slide-thumb').addEventListener('click', () => openPreview(sub));
    const withdraw = card.querySelector('.act-withdraw');
    if (withdraw) withdraw.addEventListener('click', () => withdrawSubmission(sub));
    const resubmit = card.querySelector('.act-resubmit');
    if (resubmit) resubmit.addEventListener('click', () => openSubmitDialog(sub, 'resubmit'));
    const revise = card.querySelector('.act-revise');
    if (revise) revise.addEventListener('click', () => openSubmitDialog(sub, 'revise'));
    listEl.appendChild(card);
  });
}

function openPreview(sub) {
  $('modal-media').innerHTML = sub.type === 'video'
    ? `<video src="${escapeHtml(sub.url)}" controls autoplay></video>`
    : `<img src="${escapeHtml(sub.url)}" alt="">`;
  $('modal-title').textContent = sub.title || 'Untitled';
  openDialog('dlg-media');
}

$('dlg-media').addEventListener('close', () => { $('modal-media').innerHTML = ''; });

async function withdrawSubmission(sub) {
  const ok = await confirmDialog({
    title: 'Withdraw this submission?',
    message: `"${sub.title || 'Untitled'}" will be taken out of the review queue. You can always submit it again later.`,
    confirmLabel: 'Withdraw'
  });
  if (!ok) return;
  try {
    await db.collection('submissions').doc(sub.id).update({
      status: 'withdrawn',
      withdrawnAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    showToast('Submission withdrawn.', 'success');
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

/* ============================================================
   NEW SUBMISSION — upload to Cloudinary, then write the submission doc
   ============================================================ */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB
let resubmitOf = null; // the rejected submission being replaced, if any
let reviseOf = null;   // the approved submission the masjid asked edits for, if any

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
}

function resetSubmitForm() {
  $('upload-file').value = '';
  $('submit-title').value = '';
  $('submit-start').value = '';
  $('submit-end').value = '';
  $('submit-notes').value = '';
  updateUploadPreview(null);
  $('progress-wrap').classList.add('hidden');
  $('progress-fill').style.width = '0%';
  $('btn-submit').disabled = false;
}

// `previous` is the earlier submission when mode is 'resubmit' (after a
// rejection: a brand-new submission) or 'revise' (the masjid asked for edits
// on an approved one: updates that same submission, file optional).
function openSubmitDialog(previous, mode) {
  if (!$('btn-submit').disabled) resetSubmitForm(); // keep an upload in progress visible
  resubmitOf = previous && mode === 'resubmit' ? previous : null;
  reviseOf = previous && mode === 'revise' ? previous : null;
  $('submit-heading').textContent = reviseOf ? 'Send a revised version' : previous ? 'Submit a fixed version' : 'New submission';
  $('btn-submit').textContent = reviseOf ? 'Send revised version' : 'Submit for review';
  $('upload-file-hint').textContent = reviseOf
    ? 'Choose a new file only if the poster itself needs to change — otherwise you can just update the details below.'
    : 'Posters look best in portrait (9:16) or landscape (16:9) at least 1080 px wide.';
  const note = $('submit-resubmit-note');
  note.classList.toggle('hidden', !previous);
  if (previous) {
    note.textContent = reviseOf
      ? `The masjid asked: ${previous.editRequest || 'please send a revised version.'}`
      : `Replacing "${previous.title || 'Untitled'}"${previous.rejectReason ? ` — the reviewer said: ${previous.rejectReason}` : ''}. Upload the corrected file below.`;
    $('submit-title').value = previous.title || '';
    $('submit-notes').value = previous.notes || '';
    $('submit-start').value = previous.requestedStart || '';
    $('submit-end').value = previous.requestedEnd || '';
  }
  openDialog('dlg-submit');
}

$('btn-new-submission').addEventListener('click', () => openSubmitDialog(null));

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

$('btn-submit').addEventListener('click', () => {
  const user = auth.currentUser;
  const file = fileInput.files[0];
  if (!user || !currentClient) return;

  // A revision to an approved slide can be details-only; everything else needs a file.
  if (!file && !reviseOf) {
    showToast('Choose a file first.', 'error');
    return;
  }
  if (file) {
    const validationError = validateUploadFile(file);
    if (validationError) {
      showUploadError(validationError);
      showToast(validationError, 'error');
      return;
    }
  }
  const title = $('submit-title').value.trim();
  if (!title) {
    showToast('Give your submission a title.', 'error');
    $('submit-title').focus();
    return;
  }
  const start = $('submit-start').value;
  const end = $('submit-end').value;
  if (start && end && end < start) {
    showToast('"Show until" can\'t be before "Show from".', 'error');
    return;
  }

  const FieldValue = firebase.firestore.FieldValue;

  // `uploaded` is the Cloudinary result, or null for a details-only revision.
  const saveSubmission = async uploaded => {
    try {
      const fileFields = uploaded
        ? { url: uploaded.secure_url, type: file.type.startsWith('video') ? 'video' : 'image', bytes: file.size }
        : {};
      if (reviseOf) {
        await db.collection('submissions').doc(reviseOf.id).update(Object.assign({
          title,
          notes: $('submit-notes').value.trim(),
          requestedStart: start || FieldValue.delete(),
          requestedEnd: end || FieldValue.delete(),
          status: 'pending',
          revisedAt: FieldValue.serverTimestamp()
        }, fileFields));
        showToast('Revised version sent! The masjid will review it.', 'success');
      } else {
        const doc = Object.assign({
          clientUid: user.uid,
          clientName: currentClient.name || '',
          organization: currentClient.organization || '',
          title,
          notes: $('submit-notes').value.trim(),
          status: 'pending',
          createdAt: FieldValue.serverTimestamp()
        }, fileFields);
        if (start) doc.requestedStart = start;
        if (end) doc.requestedEnd = end;
        if (resubmitOf) doc.replacesId = resubmitOf.id;
        await db.collection('submissions').add(doc);
        showToast('Submitted! The masjid will review it shortly.', 'success');
      }
      resetSubmitForm();
      closeDialog('dlg-submit');
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
      $('btn-submit').disabled = false;
    }
  };

  $('btn-submit').disabled = true;
  if (!file) {
    saveSubmission(null);
    return;
  }

  const progressFill = $('progress-fill');
  $('progress-wrap').classList.remove('hidden');

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
      showToast('Upload failed. Please try again.', 'error');
      $('btn-submit').disabled = false;
      return;
    }
    saveSubmission(JSON.parse(xhr.responseText));
  };

  xhr.onerror = () => {
    showToast('Upload failed — check your internet connection.', 'error');
    $('btn-submit').disabled = false;
  };

  xhr.send(formData);
});
