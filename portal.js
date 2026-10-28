/* ============================================================
   PUBLIC SUBMISSION FORM — script for portal.html (plain browser JS, no build).
   Anyone can send a poster/video, no account needed. It lands in Firestore
   `submissions` as "pending" for admin review. Files go straight to
   Cloudinary, like admin uploads. See firestore.rules for what the public
   is (and isn't) allowed to write.
   ============================================================ */
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

const $ = id => document.getElementById(id);

document.querySelectorAll('.js-masjid-name').forEach(el => { el.textContent = KIOSK_CONFIG.masjidName; });

/* ============================================================
   SMALL HELPERS
   ============================================================ */
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
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

/* ============================================================
   SUBMIT — upload to Cloudinary, then write the submission doc
   ============================================================ */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB

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
  $('submit-form').reset();
  updateUploadPreview(null);
  $('progress-wrap').classList.add('hidden');
  $('progress-fill').style.width = '0%';
  $('btn-submit').disabled = false;
}

function showDone(done) {
  $('submit-form').classList.toggle('hidden', done);
  $('submit-done').classList.toggle('hidden', !done);
}

$('btn-another').addEventListener('click', () => {
  resetSubmitForm();
  showDone(false);
});

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

$('submit-form').addEventListener('submit', e => {
  e.preventDefault();
  if ($('submit-website').value) return; // honeypot — a bot filled it in

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
  const title = $('submit-title').value.trim();
  if (!title) {
    showToast('Give your submission a title.', 'error');
    $('submit-title').focus();
    return;
  }
  const start = $('submit-start').value;
  const end = $('submit-end').value;
  if (!start) {
    showToast('Choose a "Show from" date.', 'error');
    $('submit-start').focus();
    return;
  }
  if (!end) {
    showToast('Choose a "Show until" date.', 'error');
    $('submit-end').focus();
    return;
  }
  if (end < start) {
    showToast('"Show until" can\'t be before "Show from".', 'error');
    return;
  }
  const name = $('submit-name').value.trim();
  if (!name) {
    showToast('Enter your name.', 'error');
    $('submit-name').focus();
    return;
  }
  const org = $('submit-org').value.trim();
  if (!org) {
    showToast('Enter your business or organization name.', 'error');
    $('submit-org').focus();
    return;
  }
  const phone = $('submit-phone').value.trim();
  if (!phone) {
    showToast('Enter a phone number so the masjid can reach you.', 'error');
    $('submit-phone').focus();
    return;
  }
  const email = $('submit-email').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('That email address doesn\'t look right.', 'error');
    $('submit-email').focus();
    return;
  }

  const saveSubmission = async uploaded => {
    try {
      const doc = {
        clientName: name,
        organization: org,
        email,
        phone,
        requestedStart: start,
        requestedEnd: end,
        title,
        notes: $('submit-notes').value.trim(),
        url: uploaded.secure_url,
        type: file.type.startsWith('video') ? 'video' : 'image',
        bytes: file.size,
        status: 'pending',
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      await db.collection('submissions').add(doc);
      resetSubmitForm();
      showDone(true);
      window.scrollTo(0, 0);
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
      $('btn-submit').disabled = false;
    }
  };

  $('btn-submit').disabled = true;
  const progressFill = $('progress-fill');
  $('progress-wrap').classList.remove('hidden');

  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', CLOUDINARY_CONFIG.uploadPreset);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', `https://api.cloudinary.com/v1_1/${CLOUDINARY_CONFIG.cloudName}/auto/upload`);

  xhr.upload.addEventListener('progress', ev => {
    if (ev.lengthComputable) progressFill.style.width = ((ev.loaded / ev.total) * 100) + '%';
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
