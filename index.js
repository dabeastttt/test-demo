require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const os = require('os');

// CommonJS-safe fetch
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Twilio client
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// OpenAI client
const OpenAI = require('openai').default;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
  if (!phone) return '';
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) return `+61${cleaned.slice(1)}`;
  if (cleaned.startsWith('61')) return `+${cleaned}`;
  if (phone.startsWith('+')) return phone;
  return `+${cleaned}`;
}

function isValidAUSMobile(phone) {
  return /^\+61[0-9]{9}$/.test(phone);
}

// Memory store for ongoing conversations (for demo purposes)
const conversations = {};

// ========== ROUTES ==========

// Onboarding SMS
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

// Call-status handler (missed/busy)
app.post('/call-status', async (req, res) => {
  const callStatus = req.body.CallStatus;
  const from = formatPhone(req.body.From || '');
  const tradieNumber = process.env.TRADIE_PHONE_NUMBER;

  if (!from) return res.status(400).send('Missing caller number');

  if (['no-answer', 'busy'].includes(callStatus)) {
    try {
      const introMsg = `👷 The tradie is busy right now. Please reply with your *name* and whether you’re after a quote, booking, or something else.`;

      await client.messages.create({ body: introMsg, from: process.env.TWILIO_PHONE, to: from });

      await client.messages.create({
        body: `⚠️ Missed call from ${from}. Assistant is asking for details.`,
        from: process.env.TWILIO_PHONE,
        to: tradieNumber
      });

      // Initialize conversation memory
      conversations[from] = { step: 'awaiting_details' };

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

// Transcribe recording helper
async function transcribeRecording(url) {
  if (!url) throw new Error('No recording URL provided');
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

  if (!from) return res.status(400).send('Missing caller number');

  let transcription = '[Unavailable]';
  try {
    transcription = await transcribeRecording(recordingUrl);
  } catch (err) {
    console.error('❌ Transcription failed:', err.message);
  }

  // Store transcription as part of conversation
  conversations[from] = { step: 'voicemail_received', transcription };

  let reply = '';
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: `
You are an Aussie tradie assistant handling voicemails.
1. Ask caller for name + quote/booking/other if not provided.
2. Offer to schedule a call between 1–3 pm.
3. Confirm proposed time.
4. Keep replies short.
5. Notify tradie with details and proposed time.
        `},
        { role: 'user', content: transcription },
      ],
    });
    reply = response.choices?.[0]?.message?.content?.trim() || '';
  } catch (err) {
    console.error('❌ OpenAI error:', err.message);
  }

  try {
    if (reply && isValidAUSMobile(from)) {
      await client.messages.create({ body: reply, from: process.env.TWILIO_PHONE, to: from });
    }

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

// ================= SMS webhook =================
app.post('/sms', async (req, res) => {
  const from = formatPhone(req.body.From || '');
  const body = req.body.Body || '';
  const tradieNumber = process.env.TRADIE_PHONE_NUMBER;

  if (!from || !body) return res.status(400).send('Missing SMS data');

  console.log(`📩 Received SMS from ${from}: "${body}"`);

  // Retrieve conversation state
  const convo = conversations[from] || { step: 'new' };

  let aiPrompt = '';

  if (convo.step === 'awaiting_details') {
    aiPrompt = `Customer replied with details: "${body}". Ask for preferred call time between 1-3pm and confirm.`;
    convo.step = 'scheduling';
  } else if (convo.step === 'scheduling') {
    aiPrompt = `Customer proposed call time: "${body}". Confirm it back to customer and notify tradie.`;
    convo.step = 'done';
  } else {
    aiPrompt = `Customer sent: "${body}". Respond appropriately as a tradie assistant.`;
  }

  // Generate AI reply
  let reply = '';
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a helpful Aussie tradie assistant.' },
        { role: 'user', content: aiPrompt },
      ],
    });
    reply = response.choices?.[0]?.message?.content?.trim() || '';
  } catch (err) {
    console.error('❌ OpenAI SMS error:', err.message);
  }

  try {
    if (reply) {
      await client.messages.create({ body: reply, from: process.env.TWILIO_PHONE, to: from });
    }

    await client.messages.create({
      body: `💬 SMS from ${from}: "${body}"\nAI replied: "${reply}"`,
      from: process.env.TWILIO_PHONE,
      to: tradieNumber,
    });

    conversations[from] = convo; // Save updated state

    res.status(200).send('<Response></Response>'); // Twilio requires XML response
  } catch (err) {
    console.error('❌ SMS handler failed:', err.message);
    res.status(500).send('Failed SMS handling');
  }
});

// Start server
const host = process.env.HOST || '0.0.0.0';
app.listen(port, host, () => {
  console.log(`🚀 Server running at http://${host}:${port}`);
});

