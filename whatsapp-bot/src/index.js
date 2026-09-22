const config = require('./config');
const { connectToWhatsApp } = require('./whatsapp');
const { runCleanup } = require('./cleanup');

const isListGroups = process.argv.includes('--list-groups');

process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught exception:', err));

function validateFullModeConfig() {
  const missing = [];
  if (!config.whatsappGroupJid) missing.push('WHATSAPP_GROUP_JID (run `npm run list-groups` first, see README.md)');
  if (!config.geminiApiKey) missing.push('GEMINI_API_KEY');
  if (!config.cloudinaryCloudName) missing.push('CLOUDINARY_CLOUD_NAME');
  if (!config.cloudinaryUploadPreset) missing.push('CLOUDINARY_UPLOAD_PRESET');

  if (missing.length > 0) {
    console.error('Missing required .env values:');
    missing.forEach(m => console.error(` - ${m}`));
    process.exit(1);
  }
}

async function main() {
  if (isListGroups) {
    // Only needs a WhatsApp connection — no Firebase/Gemini/Cloudinary
    // config required yet, so nothing is validated here.
    await connectToWhatsApp({ listGroupsOnly: true });
    return;
  }

  validateFullModeConfig();
  await connectToWhatsApp({ listGroupsOnly: false });

  runCleanup().catch(err => console.error('Cleanup error:', err));
  setInterval(() => {
    runCleanup().catch(err => console.error('Cleanup error:', err));
  }, config.cleanupIntervalMs);
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
