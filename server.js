import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '1x0000000000000000000000000000000AA';

// Active Sessions Map (Prevents Cross-User Stop Overrides)
const activeSessions = new Set();

// Connection Pool with TTL Cleanup (Fixes Memory Leak)
const poolMap = new Map();
const POOL_TTL = 10 * 60 * 1000; // 10 minutes idle TTL

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

/* ==========================================================================
   1. CLOUDFLARE TURNSTILE VERIFICATION
   ========================================================================== */
async function verifyTurnstileToken(token, remoteIp) {
  if (!token || TURNSTILE_SECRET_KEY.startsWith('1x0000000000000000000000000000000AA')) {
    return true;
  }

  try {
    const formData = new URLSearchParams({
      secret: TURNSTILE_SECRET_KEY,
      response: token,
      ...(remoteIp && { remoteip: remoteIp })
    });

    const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    });
    const outcome = await result.json();
    return outcome.success === true;
  } catch {
    return false;
  }
}

/* ==========================================================================
   2. TRANSPORTER POOL (SAFE MEMORY MANAGEMENT)
   ========================================================================== */
function getPort587Transporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPass = appPassword.replace(/\s+/g, '').trim();
  const key = crypto.createHash('sha256').update(`${cleanEmail}:${cleanPass}`).digest('hex');

  if (poolMap.has(key)) {
    const entry = poolMap.get(key);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => closeTransporter(key), POOL_TTL);
    return entry.transporter;
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // STARTTLS
    requireTLS: true,
    auth: { user: cleanEmail, pass: cleanPass },
    pool: true,
    maxConnections: 3, // Lower connections to avoid rate limit flags
    maxMessages: 100,
    socketTimeout: 30000,
    connectionTimeout: 30000
  });

  const timer = setTimeout(() => closeTransporter(key), POOL_TTL);
  poolMap.set(key, { transporter, timer });

  return transporter;
}

function closeTransporter(key) {
  if (poolMap.has(key)) {
    const { transporter, timer } = poolMap.get(key);
    clearTimeout(timer);
    transporter.close();
    poolMap.delete(key);
  }
}

/* ==========================================================================
   3. SAFE DATA PARSING & SPINTAX
   ========================================================================== */
function parseRecipientData(input) {
  let email = '';
  let rawName = '';

  if (typeof input === 'object' && input !== null) {
    email = (input.email || input.recipient || '').trim();
    rawName = (input.name || input.fullName || input.first_name || '').trim();
  } else if (typeof input === 'string') {
    const str = input.trim();
    if (str.includes('<') && str.endsWith('>')) {
      const parts = str.split('<');
      rawName = parts[0].replace(/"/g, '').trim();
      email = parts[1].replace('>', '').trim();
    } else if (str.includes(',')) {
      const parts = str.split(',');
      if (parts[0].includes('@')) {
        email = parts[0].trim();
        rawName = parts[1].trim();
      } else {
        rawName = parts[0].trim();
        email = parts[1].trim();
      }
    } else {
      email = str;
    }
  }

  if (!rawName && email.includes('@')) {
    const prefix = email.split('@')[0];
    rawName = prefix.replace(/[0-9_.-]/g, ' ').trim();
  }

  const formattedName = rawName
    ? rawName.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
    : '';

  return {
    email: email.toLowerCase(),
    name: formattedName,
    firstName: formattedName ? formattedName.split(' ')[0] : '',
    domain: email.includes('@') ? email.split('@')[1] : ''
  };
}

function parseSpintax(text) {
  if (!text) return '';
  let spun = String(text);
  const regex = /\{([^{}]+)\}/;
  let iterations = 0;

  while (regex.test(spun) && iterations < 30) {
    spun = spun.replace(regex, (_, choices) => {
      if (!choices.includes('|')) return choices;
      const options = choices.split('|');
      return options[Math.floor(Math.random() * options.length)].trim();
    });
    iterations++;
  }
  return spun.replace(/[{}]/g, '').trim();
}

function personalizeContent(template, recipient) {
  if (!template) return '';
  let content = parseSpintax(template);

  const displayName = recipient.name || recipient.firstName || 'there';
  const displayFirstName = recipient.firstName || displayName;

  return content
    .replace(/{Name}/gi, displayName)
    .replace(/{FirstName}/gi, displayFirstName)
    .replace(/{First_Name}/gi, displayFirstName)
    .replace(/{Email}/gi, recipient.email)
    .replace(/{Domain}/gi, recipient.domain);
}

function createCleanPlainText(text) {
  if (!text) return '';
  return text
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

/* ==========================================================================
   4. API ROUTES
   ========================================================================== */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) return res.json({ success: true, message: 'Authorized' });
  return res.status(401).json({ success: false, message: 'Unauthorized Password' });
});

app.post('/api/verify', async (req, res) => {
  const { email, appPassword, cfToken } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!email || !appPassword) {
    return res.status(400).json({ success: false, message: 'Credentials required' });
  }

  if (cfToken && !(await verifyTurnstileToken(cfToken, clientIp))) {
    return res.status(403).json({ success: false, message: 'Security Verification Failed' });
  }

  try {
    const transporter = getPort587Transporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: 'SMTP verified successfully' });
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: error.message || 'SMTP Auth Failed.'
    });
  }
});

/* ==========================================================================
   5. STREAMING EMAIL SEND ROUTE
   ========================================================================== */
app.post('/api/send-stream', async (req, res) => {
  const sessionId = crypto.randomUUID();
  activeSessions.add(sessionId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Send Session ID to client for safe cancellation handling
  res.write(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);

  const { email, appPassword, senderName, subject, messageBody, recipients, cfToken } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: 'Invalid Request Data' })}\n\n`);
    activeSessions.delete(sessionId);
    res.end();
    return;
  }

  if (cfToken && !(await verifyTurnstileToken(cfToken, clientIp))) {
    res.write(`data: ${JSON.stringify({ success: false, error: 'Turnstile Verification Failed' })}\n\n`);
    activeSessions.delete(sessionId);
    res.end();
    return;
  }

  const cleanEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || '').replace(/["\r\n]/g, '').trim();

  const keepAlivePing = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 4000);

  req.on('close', () => {
    activeSessions.delete(sessionId);
    clearInterval(keepAlivePing);
  });

  const transporter = getPort587Transporter(email, appPassword);
  const BATCH_SIZE = 3;

  const defaultSubject = '{quick note regarding your site|website feedback|quick question}';
  const defaultBody = "{Hi {Name},|Hello {Name},}\n\n{Hope you are doing well.|Checking in regarding your website.}\n\n{Let me know if you would like more details.|Feel free to reply if interested.}";

  const finalSubjectTemplate = subject?.trim() ? subject : defaultSubject;
  const finalBodyTemplate = messageBody?.trim() ? messageBody : defaultBody;

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    if (!activeSessions.has(sessionId)) {
      res.write(`data: ${JSON.stringify({ success: false, error: 'Stopped by User' })}\n\n`);
      break;
    }

    const batch = recipients.slice(i, i + BATCH_SIZE);

    const sendPromises = batch.map(async (rawRecipient) => {
      const recipient = parseRecipientData(rawRecipient);
      if (!recipient.email) return { success: false, recipient: '', error: 'Invalid Email' };

      try {
        const personalizedSubject = personalizeContent(finalSubjectTemplate, recipient);
        const personalizedBody = personalizeContent(finalBodyTemplate, recipient);
        const isHtml = /<[a-z][\s\S]*>/i.test(personalizedBody);

        const cleanBodyText = isHtml
          ? personalizedBody
          : personalizedBody.replace(/\n/g, '<br>');

        const mailOptions = {
          from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
          to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
          subject: personalizedSubject,
          text: createCleanPlainText(personalizedBody),
          html: `<div dir="ltr">${cleanBodyText}</div>`
        };

        await transporter.sendMail(mailOptions);
        return { success: true, recipient: recipient.email, name: recipient.name };
      } catch (err) {
        return { success: false, recipient: recipient.email, error: err.message };
      }
    });

    const results = await Promise.allSettled(sendPromises);

    for (const resItem of results) {
      if (resItem.status === 'fulfilled' && resItem.value.recipient) {
        res.write(`data: ${JSON.stringify(resItem.value)}\n\n`);
      }
    }

    if (i + BATCH_SIZE < recipients.length && activeSessions.has(sessionId)) {
      await new Promise(resolve => setTimeout(resolve, Math.floor(4000 + Math.random() * 3000)));
    }
  }

  activeSessions.delete(sessionId);
  clearInterval(keepAlivePing);
  res.write('data: [DONE]\n\n');
  res.end();
});

/* ==========================================================================
   6. SESSION STOP ROUTE
   ========================================================================== */
app.post('/api/stop', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId && activeSessions.has(sessionId)) {
    activeSessions.delete(sessionId);
    return res.json({ success: true, message: 'Session stopped successfully' });
  }
  return res.status(400).json({ success: false, message: 'Invalid or expired Session ID' });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

export default app;
