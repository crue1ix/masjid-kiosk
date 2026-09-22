const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const path = require('path');

const config = require('./config');
const { parseAnnouncement } = require('./geminiParser');
const { resolveYear } = require('./dateResolution');
const { writeProgramDays, writeAd } = require('./firestoreWriter');
const { uploadBuffer } = require('./cloudinaryUpload');

const AUTH_DIR = path.join(__dirname, '..', 'data', 'baileys_auth');
const logger = pino({ level: 'warn' });

async function connectToWhatsApp(opts = {}) {
  const listGroupsOnly = !!opts.listGroupsOnly;
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nScan this QR code with WhatsApp (Settings -> Linked Devices -> Link a Device):\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('WhatsApp connected.');
      if (listGroupsOnly) {
        const groups = await sock.groupFetchAllParticipating();
        console.log('\nJoined groups (copy the right one\'s id into .env as WHATSAPP_GROUP_JID):\n');
        Object.values(groups).forEach(g => console.log(`${g.id}  —  ${g.subject}`));
        console.log('\nThen restart normally with `npm start` (without --list-groups).\n');
        process.exit(0);
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode
        : null;

      if (statusCode === DisconnectReason.loggedOut) {
        console.error('WhatsApp session logged out. Delete whatsapp-bot/data/baileys_auth and restart to re-link with a QR code.');
        process.exit(1);
      }

      const reason = (lastDisconnect && lastDisconnect.error && lastDisconnect.error.message) || 'unknown reason';
      console.warn(`Connection closed (${reason}), reconnecting in 5s...`);
      setTimeout(() => connectToWhatsApp(opts), 5000);
    }
  });

  if (!listGroupsOnly) {
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try {
          await handleMessage(sock, msg);
        } catch (err) {
          console.error('Error handling message:', err);
        }
      }
    });
  }

  return sock;
}

async function handleMessage(sock, msg) {
  if (!msg.message || msg.key.fromMe) return;
  if (msg.key.remoteJid !== config.whatsappGroupJid) return;

  const messageId = msg.key.id;
  const postedAtIso = new Date(
    (msg.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000
  ).toISOString();

  const text = msg.message.conversation || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text);
  if (text) {
    await handleTextMessage(text, postedAtIso, messageId);
    return;
  }

  if (msg.message.imageMessage) {
    await handleMediaMessage(sock, msg, 'image', messageId);
  } else if (msg.message.videoMessage) {
    await handleMediaMessage(sock, msg, 'video', messageId);
  }
}

async function handleTextMessage(text, postedAtIso, messageId) {
  const result = await parseAnnouncement(text, postedAtIso);
  if (!result || !result.isAnnouncement || !result.days || result.days.length === 0) {
    console.log(`Message ${messageId} ignored (not a program announcement).`);
    return;
  }

  const resolvedDays = result.days.map(day => {
    const isoDate = resolveYear(day.monthName, day.dayNumber, postedAtIso);
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
  });

  await writeProgramDays(resolvedDays, messageId);
  console.log(`Wrote ${resolvedDays.length} program day(s) from message ${messageId}.`);
}

async function handleMediaMessage(sock, msg, type, messageId) {
  const mediaInfo = type === 'image' ? msg.message.imageMessage : msg.message.videoMessage;
  const buffer = await downloadMediaMessage(
    msg,
    'buffer',
    {},
    { logger, reuploadRequest: sock.updateMediaMessage }
  );
  const mimetype = mediaInfo.mimetype || (type === 'image' ? 'image/jpeg' : 'video/mp4');
  const caption = mediaInfo.caption || '';

  const url = await uploadBuffer(buffer, mimetype);
  const expiresAt = new Date(Date.now() + config.adExpiryDays * 24 * 60 * 60 * 1000);

  await writeAd({
    url,
    type,
    title: caption || 'WhatsApp flyer',
    duration: config.defaultAdDurationSeconds,
    expiresAt,
    rawMessageId: messageId
  });
  console.log(`Wrote ${type} ad from message ${messageId} (expires ${expiresAt.toISOString()}).`);
}

module.exports = { connectToWhatsApp };
