require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const os = require('os');

// CommonJS-safe fetch
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// Twilio client
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// OpenAI client
const OpenAI = require('openai').default;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();
const port = process.env.PORT || 3001;

app.set('trust proxy', 1);
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

const conversations = {}; // store ongoing conversations

// Improved time parser that handles all common formats
function parseTime(text) {
  text = text.toLowerCase().replace(/\s/g, '');
  const timeRegex = /^(1|2|3|1[0-2])[:.]?([0-5][0-9])?(am|pm)?$/i;
  const match = text.match(timeRegex);
  if (!match) return null;

  let hour = parseInt(match[1]);
  let minutes = match[2] ? parseInt(match[2]) : 0;
  const ampm = match[3] ? match[3].toLowerCase() : null;

  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  return `${hour % 24}:${minutes.toString().padStart(2, '0')}`;
}

// GPT-powered name + intent + description extraction
async function parseNameAndIntent(text) {
  try {
    const gptResp = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: `
You are an AI that extracts structured info from a customer SMS.
Return a JSON object with:
- name: if given, otherwise "Customer"
- intent: short phrase (quote, booking, plumbing issue, electrical job, leaking tap, etc.)
- description: concise 1-sentence summary of what they want
          `
        },
        { role: 'user', content: text }
      ],
      temperature: 0
    });

    const raw = gptResp.choices[0].message.content.trim();
    return JSON.parse(raw);
  } catch (err) {
    console.error('❌ parseNameAndIntent failed:', err.message);
    return { name: 'Customer', intent: 'other', description: text };
  }
}

// ================= Onboarding SMS =================
app.post('/send-sms', smsLimiter, async (req, res) => {
  const { name, phone } = req.body;
  if (!phone) return res.status(400).send('Phone number required');
  const formattedPhone = formatPhone(phone);
  if (!isValidAUSMobile(formattedPhone)) return res.status(400).send('Invalid Australian mobile number');

  try {
    const assistantNumber = process.env.TWILIO_PHONE;
    await client.messages.create({ body: `⚡️Hi ${name}, your 24/7 assistant is now active ✅`, from: assistantNumber, to: formattedPhone });
    await client.messages.create({ body: `📲 Please forward your mobile number to ${assistantNumber} so we can handle missed calls.`, from: assistantNumber, to: formattedPhone });
    await client.messages.create({ body: `Tip: Set forwarding to "When Busy" or "When Unanswered". You're all set ⚡️`, from: assistantNumber, to: formattedPhone });

    console.log(`✅ Onboarding SMS sent to ${formattedPhone}`);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ Error in /send-sms:', err.message);
    res.status(500).send('Failed to send SMS');
  }
});

// ================= Call-status handler (missed/busy) =================
app.post('/call-status', async (req, res) => {
  const callStatus = req.body.CallStatus;
  const from = formatPhone(req.body.From || '');
  const tradieNumber = process.env.TRADIE_PHONE_NUMBER;
  if (!from) return res.status(400).send('Missing caller number');

  const convo = conversations[from];
  if (convo && convo.type === 'voicemail' && convo.transcription) {
    console.log(`ℹ️ Skipping constant follow-up for ${from} because voicemail already handled`);
    return res.status(200).send('Voicemail already handled');
  }

  if (['no-answer', 'busy'].includes(callStatus)) {
    try {
      const introMsg = `G’day, this is ${process.env.TRADIE_NAME} from ${process.env.TRADES_BUSINESS}. Can I grab your name and whether you’re after a quote, booking, or something else? If you’d like, we can schedule a call between 1-3 pm. Cheers.`;
      await client.messages.create({ body: introMsg, from: process.env.TWILIO_PHONE, to: from });

      conversations[from] = { step: 'awaiting_details', type: 'missed_call', tradie_notified: false };

      await client.messages.create({ body: `⚠️ Missed call from ${from}. Assistant sent initial follow-up.`, from: process.env.TWILIO_PHONE, to: tradieNumber });
      console.log(`✅ Missed call handled for ${from}`);
    } catch (err) {
      console.error('❌ Error handling call-status:', err.message);
    }
  }
  res.status(200).send('Call status processed');
});

// ================= Voice handler =================
app.post('/voice', (req, res) => {
  const response = new twilio.twiml.VoiceResponse();
  response.say("Hi! The tradie is unavailable. Leave a message after the beep.");
  response.record({
    maxLength: 60,
    playBeep: true,
    transcribe: true,
    transcribeCallback: process.env.BASE_URL + '/voicemail'
  });
  response.hangup();
  res.type('text/xml').send(response.toString());
});

// Transcribe helper
async function transcribeRecording(url) {
  if (!url) throw new Error('No recording URL provided');

  const response = await fetch(url, {
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')
    }
  });

  if (!response.ok) throw new Error(`Failed to download audio: ${response.statusText}`);

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

// ================= Voicemail callback with AI follow-up =================
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

  conversations[from] = { step: 'awaiting_details', transcription, type: 'voicemail' };

  try {
    await client.messages.create({
      body: `🎙️ Voicemail from ${from}: "${transcription}"`,
      from: process.env.TWILIO_PHONE,
      to: tradieNumber
    });

    const gptResp = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: `
You are a concise Aussie tradie assistant.
Send one follow-up SMS asking for customer name and intent (quote/booking/other).
Offer to schedule a call between 1-3pm.
Keep message short and friendly.
        `},
        { role: 'user', content: `Transcription of voicemail: "${transcription}"` }
      ]
    });

    const aiReply = gptResp.choices[0].message.content.trim();
    if (aiReply && isValidAUSMobile(from)) {
      await client.messages.create({ body: aiReply, from: process.env.TWILIO_PHONE, to: from });
    }

    console.log(`✅ Voicemail processed & AI follow-up sent for ${from}`);
    res.status(200).send('Voicemail processed with AI follow-up');
  } catch (err) {
    console.error('❌ Voicemail handling failed:', err.message);
    res.status(500).send('Failed voicemail handling');
  }
});

// ================= SMS webhook =================
app.post('/sms', async (req, res) => {
  const from = formatPhone(req.body.From || '');
  const body = (req.body.Body || '').trim();
  const tradieNumber = process.env.TRADIE_PHONE_NUMBER;
  if (!from || !body) return res.status(400).send('Missing SMS data');

  console.log(`📩 Received SMS from ${from}: "${body}"`);

  let convo = conversations[from] || { step: 'new', tradie_notified: false, type: 'missed_call' };
  let reply = '';

  if (convo.step === 'awaiting_details') {
    const info = await parseNameAndIntent(body);
    convo.customer_info = info;

    let detailsText = info.description || '';
    if (convo.type === 'voicemail' && convo.transcription) {
      detailsText = `${detailsText} (Voicemail: ${convo.transcription})`;
    }

    await client.messages.create({
      body: `📩 ${convo.type === 'voicemail' ? 'Voicemail received' : 'Missed call from'} ${from}
Name: ${info.name}
Intent: ${info.intent}
Details: ${detailsText}
Waiting for call time...`,
      from: process.env.TWILIO_PHONE,
      to: tradieNumber
    });

    reply = `Thanks ${info.name}! What time works for a call between 1-3 pm?`;
    convo.step = 'scheduling';
  } else if (convo.step === 'scheduling') {
    let proposedTime = parseTime(body);

    if (!proposedTime) {
      try {
        const gptResp = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'You are a concise Aussie tradie assistant. Extract a valid call time between 1-3 pm from the customer message.' },
            { role: 'user', content: `Customer said: "${body}"` }
          ]
        });
        proposedTime = gptResp.choices[0].message.content.trim();
      } catch (err) {
        console.error(err);
      }
    }

    if (proposedTime) {
      reply = `Thanks! Everything is confirmed. We will see you at ${proposedTime}.`;

      await client.messages.create({
        body: `✅ Booking confirmed for ${from}
Name: ${convo.customer_info.name}
Intent: ${convo.customer_info.intent}
Details: ${convo.customer_info.description}
Call at ${proposedTime}`,
        from: process.env.TWILIO_PHONE,
        to: tradieNumber
      });

      convo.step = 'done';
    } else {
      try {
        const gptResp = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'You are a concise Aussie tradie assistant. Suggest rescheduling between 1-3pm if customer time is invalid.' },
            { role: 'user', content: `Customer proposed call time: "${body}".` }
          ]
        });
        reply = gptResp.choices[0].message.content.trim();
      } catch (err) {
        console.error(err);
      }
    }
  }

  try {
    if (reply) await client.messages.create({ body: reply, from: process.env.TWILIO_PHONE, to: from });
    conversations[from] = convo;
    res.status(200).send('<Response></Response>');
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed SMS handling');
  }
});

// ================= Start server =================
const host = process.env.HOST || '0.0.0.0';
app.listen(port, host, () => console.log(`🚀 Server running at http://${host}:${port}`));

