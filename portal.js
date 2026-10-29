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
const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100MB
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;  // Cloudinary's free plan rejects larger images
const MAX_IMAGE_EDGE = 3840;               // the kiosk screen is 3840 x 2160, so more pixels are wasted

// The file that actually gets uploaded: the chosen file, or a shrunk copy
// of it when an image is over MAX_IMAGE_BYTES. null while still shrinking.
let uploadFile = null;
let preparingFile = false;

function validateUploadFile(file) {
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
    return 'Only image or video files are supported.';
  }
  if (file.type.startsWith('video/') && file.size > MAX_VIDEO_BYTES) {
    return `File is too large (${formatBytes(file.size)}). Max size for videos is ${formatBytes(MAX_VIDEO_BYTES)}.`;
  }
  return null;
}

// Redraws a big image as a JPEG (at most MAX_IMAGE_EDGE px on the long
// side) at the highest quality that fits under MAX_IMAGE_BYTES.
// Transparent areas become white, since JPEG has no transparency.
async function shrinkImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.92, 0.85, 0.75, 0.65, 0.5]) {
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size <= MAX_IMAGE_BYTES) {
      return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
    }
  }
  throw new Error('too big');
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

  uploadFile = null;
  preparingFile = false;
  if (!file) {
    hint.classList.remove('hidden');
    preview.classList.add('hidden');
    thumb.innerHTML = '';
    showUploadError(null);
    return;
  }

  const problem = validateUploadFile(file);
  showUploadError(problem);
  const isVideo = file.type.startsWith('video');
  const objectUrl = URL.createObjectURL(file);
  thumb.innerHTML = isVideo
    ? `<video src="${objectUrl}" muted></video>`
    : `<img src="${objectUrl}" alt="">`;
  $('upload-preview-name').textContent = file.name;
  const meta = $('upload-preview-meta');
  meta.textContent = `${isVideo ? 'Video' : 'Image'} · ${formatBytes(file.size)} · click to change`;
  hint.classList.add('hidden');
  preview.classList.remove('hidden');
  if (problem) return;

  if (isVideo || file.size <= MAX_IMAGE_BYTES) {
    uploadFile = file;
    return;
  }
  // Over the image limit: shrink it. `file` is checked again afterwards in
  // case a different file was picked while this one was being shrunk.
  preparingFile = true;
  meta.textContent = `Image · ${formatBytes(file.size)} · shrinking for upload…`;
  shrinkImage(file).then(small => {
    if (fileInput.files[0] !== file) return;
    uploadFile = small;
    preparingFile = false;
    meta.textContent = `Image · ${formatBytes(small.size)} (shrunk from ${formatBytes(file.size)}) · click to change`;
  }).catch(() => {
    if (fileInput.files[0] !== file) return;
    preparingFile = false;
    showUploadError(`Couldn't shrink this image (${formatBytes(file.size)}). Please save it as a smaller JPG or PNG and try again.`);
  });
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
  // The rates intro and "Submit your ad" heading sit outside the form.
  document.querySelectorAll('.intro, .form-heading, .form-sub').forEach(el => el.classList.toggle('hidden', done));
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

  if (preparingFile) {
    showToast('Still shrinking your image — try again in a moment.', 'error');
    return;
  }
  const file = uploadFile;
  if (!file) {
    showToast(fileInput.files[0] ? 'There\'s a problem with the chosen file — see the message above.' : 'Choose a file first.', 'error');
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
      let reason = '';
      try { reason = JSON.parse(xhr.responseText).error.message; } catch (e) { /* not JSON */ }
      showToast('Upload failed' + (reason ? ': ' + reason : '. Please try again.'), 'error');
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
