const config = require('./config');

// Same unsigned upload endpoint/preset admin.html already uses from the
// browser — no new Cloudinary credentials needed. Requires Node 18+ for
// global fetch/FormData/Blob.
async function uploadBuffer(buffer, mimetype) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype }));
  form.append('upload_preset', config.cloudinaryUploadPreset);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudinaryCloudName}/auto/upload`, {
    method: 'POST',
    body: form
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Cloudinary upload failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.secure_url;
}

module.exports = { uploadBuffer };
