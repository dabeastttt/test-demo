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

function parseTime(text) {
  const match = text.match(/\b([1-3]|1[0-2]):?([0-5][0-9])?\s?(am|pm)?\b/i);
  return match ? match[0] : null;
}

function parseNameAndIntent(text) {
  // crude extraction using keywords
  const nameMatch = text.match(/my name is (\w+)/i);
  const intentMatch = text.match(/quote|booking|other/i);
  return {
    name: nameMatch ? nameMatch[1] : 'Customer',
    intent: intentMatch ? intentMatch[0] : 'other'
  };
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

  if (['no-answer', 'busy'].includes(callStatus)) {
    try {
      const introMsg = `G’day, this is ${process.env.TRADIE_NAME} from ${process.env.TRADES_BUSINESS}. Can I grab your name and whether you’re after a quote, booking, or something else? If you’d like, we can schedule a call between 1-3 pm. Cheers.`;
      await client.messages.create({ body: introMsg, from: process.env.TWILIO_PHONE, to: from });

      await client.messages.create({ body: `⚠️ Missed call from ${from}. Assistant sent initial follow-up.`, from: process.env.TWILIO_PHONE, to: tradieNumber });

      conversations[from] = { step: 'awaiting_details', tradie_notified: false };

      console.log(`✅ Missed call handled for ${from}`);
    } catch (err) {
      console.error('❌ Error handling call-status:', err.message);
    }
  }

  res.status(200).send('Call status processed');
});

// ================= SMS webhook =================
app.post('/sms', async (req, res) => {
  const from = formatPhone(req.body.From || '');
  const body = (req.body.Body || '').trim();
  const tradieNumber = process.env.TRADIE_PHONE_NUMBER;
  if (!from || !body) return res.status(400).send('Missing SMS data');

  console.log(`📩 Received SMS from ${from}: "${body}"`);

  let convo = conversations[from] || { step: 'new', tradie_notified: false };
  let reply = '';

  if (convo.step === 'awaiting_details') {
    // Parse name & intent automatically
    const info = parseNameAndIntent(body);
    convo.customer_info = info;

    // Notify tradie immediately
    await client.messages.create({
      body: `📩 Missed call from ${from}. Name: ${info.name}, Intent: ${info.intent}. Waiting for call time.`,
      from: process.env.TWILIO_PHONE,
      to: tradieNumber
    });

    reply = `Thanks ${info.name}! What time works for a call between 1-3 pm?`;
    convo.step = 'scheduling';

  } else if (convo.step === 'scheduling') {
    let proposedTime = parseTime(body);
    if (proposedTime) {
      reply = `Thanks! Everything is confirmed. We will see you at ${proposedTime}.`;

      await client.messages.create({
        body: `✅ Booking confirmed for ${from}: Name: ${convo.customer_info.name}, Intent: ${convo.customer_info.intent}, Call at ${proposedTime}`,
        from: process.env.TWILIO_PHONE,
        to: tradieNumber
      });

      convo.step = 'done';
    } else {
      // GPT handles edge case times
      try {
        const gptResp = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'You are a concise Aussie tradie assistant. Suggest rescheduling between 1-3pm if customer time is invalid.' },
            { role: 'user', content: `Customer proposed call time: "${body}".` }
          ]
        });
        reply = gptResp.choices[0].message.content.trim();
      } catch (err) { console.error(err); }
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

