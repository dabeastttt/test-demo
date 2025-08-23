require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const os = require('os');
const fetch = require('node-fetch');

// Twilio client
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// OpenAI client
const OpenAI = require('openai').default;
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
const port = process.env.PORT || 3001;

app.set('trust proxy', 1);

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static('public'));

// Logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Rate limiter
const smsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: 'Too many requests. Please try again later.'
});

// Helpers
function formatPhone(phone) {
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) return `+61${cleaned.slice(1)}`;
  if (cleaned.startsWith('61')) return `+${cleaned}`;
  if (phone.startsWith('+')) return phone;
  return `+${cleaned}`;
}

function isValidAUSMobile(phone) {
  return /^\+61[0-9]{9}$/.test(phone);
}

// ========= ROUTES ==========

// Onboarding SMS (signup)
app.post('/send-sms', smsLimiter, async (req, res) => {
  const { name, phone } = req.body;
  console.log('📩 Signup request received:', { name, phone });

  if (!phone) return res.status(400).send('Phone number required');

  const formattedPhone = formatPhone(phone);
  if (!isValidAUSMobile(formattedPhone)) {
    return res.status(400).send('Invalid Australian mobile number');
  }

  try {
    const assistantNumber = process.env.TWILIO_PHONE;

    // Send onboarding SMSs
    await client.messages.create({
      body: `⚡️Hi ${name}, your 24/7 assistant is now active ✅`,
      from: assistantNumber,
      to: formattedPhone,
    });

    await client.messages.create({
      body: `📲 Please forward your mobile number to ${assistantNumber} so we can handle missed calls.`,
      from: assistantNumber,
      to: formattedPhone,
    });

    await client.messages.create({
      body: `Tip: Set forwarding to "When Busy" or "When Unanswered". You're all set ⚡️`,
      from: assistantNumber,
      to: formattedPhone,
    });

    console.log(`✅ Onboarding SMS sent to ${formattedPhone}`);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ Error in /send-sms:', err.message);
    res.status(500).send('Failed to send SMS');
  }
});

// Call status (missed/busy)
app.post('/call-status', async (req, res) => {
  const callStatus = req.body.CallStatus;
  const from = formatPhone(req.body.From || '');
  const tradieNumber = process.env.TRADIE_PHONE_NUMBER;

  if (['no-answer', 'busy'].includes(callStatus)) {
    try {
      // Step 1: Ask caller for details instead of static msg
      const introMsg = `👷 The tradie is busy right now. Can you please reply with your *name* and whether you’re after a quote, booking, or something else?`;
      await client.messages.create({ body: introMsg, from: process.env.TWILIO_PHONE, to: from });

      // Notify tradie a follow-up has started
      await client.messages.create({
        body: `⚠️ Missed call from ${from}. Assistant is asking for details.`,
        from: process.env.TWILIO_PHONE,
        to: tradieNumber
      });

      console.log(`✅ Missed call handled for ${from}`);
    } catch (err) {
      console.error('❌ Error handling call-status:', err.message);
    }
  }

  res.status(200).send('Call status processed');
});

// Incoming call → voicemail
app.post('/voice', (req, res) => {
  const response = new twilio.twiml.VoiceResponse();

  response.say("Hi there! The tradie is currently unavailable. Please leave a message after the beep.");
  response.record({
    maxLength: 60,
    playBeep: true,
    transcribe: true,
    transcribeCallback: process.env.BASE_URL + '/voicemail',
    action: process.env.BASE_URL + '/voicemail',
  });
  response.hangup();

  res.type('text/xml');
  res.send(response.toString());
});

// Helper: transcribe recording
async function transcribeRecording(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Failed to download audio');

  const tempFilePath = path.join(os.tmpdir(), `voicemail_${Date.now()}.mp3`);
  const fileStream = fs.createWriteStream(tempFilePath);
  await new Promise((resolve, reject) => {
    response.body.pipe(fileStream);
    response.body.on('error', reject);
    fileStream.on('finish', resolve);
  });

  const transcriptionResponse = await openai.audio.transcriptions.create({
    file: fs.createReadStream(tempFilePath),
    model: 'whisper-1',
  });

  fs.unlink(tempFilePath, () => {});
  return transcriptionResponse.text;
}

// Voicemail callback
app.post('/voicemail', async (req, res) => {
  const recordingUrl = req.body.RecordingUrl ? `${req.body.RecordingUrl}.mp3` : '';
  const from = formatPhone(req.body.From || '');
  const tradieNumber = process.env.TRADIE_PHONE_NUMBER;

  let transcription = '[Unavailable]';
  try {
    transcription = await transcribeRecording(recordingUrl);
  } catch (err) {
    console.error('❌ Transcription failed:', err.message);
  }

  let reply = '';
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: `
You are an Aussie tradie assistant handling voicemails. 
1. If caller hasn’t given details yet → ask their name + whether it’s a quote, booking or other.
2. Once they answer, offer to schedule a call between 1–3 pm today.
3. If they propose a time → confirm it back.
4. Keep replies short (1–2 SMS max).
5. Always notify the tradie with the details and proposed time.
        `},
        { role: 'user', content: transcription },
      ],
    });
    reply = response.choices?.[0]?.message?.content?.trim() || '';
  } catch (err) {
    console.error('❌ OpenAI error:', err.message);
  }

  try {
    // Send AI reply to caller
    if (reply) {
      await client.messages.create({ body: reply, from: process.env.TWILIO_PHONE, to: from });
    }
    // Notify tradie
    await client.messages.create({
      body: `🎙️ Voicemail from ${from}: "${transcription}"\n\nAI replied: "${reply}"`,
      from: process.env.TWILIO_PHONE,
      to: tradieNumber,
    });

    console.log(`✅ Voicemail processed for ${from}`);
    res.status(200).send('Voicemail processed');
  } catch (err) {
    console.error('❌ Voicemail handler failed:', err.message);
    res.status(500).send('Failed voicemail handling');
  }
});

// Start server
const host = process.env.HOST || '0.0.0.0';
app.listen(port, host, () => {
  console.log(`🚀 Server running at http://${host}:${port}`);
});
