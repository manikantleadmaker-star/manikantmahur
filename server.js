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

// Active Session tracking
const activeSessions = new Set();

// Connection pool TTL (Prevents RAM memory leak)
const poolMap = new Map();
const POOL_TTL = 10 * 60 * 1000; 

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

/* ==========================================================================
   1. SAFE GMAIL TRANSPORTER POOL
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
    maxConnections: 2, // Gmail rate limit se bachne ke liye connections kam rakhe hain
    maxMessages: 50,
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
   2. TEXT SANITIZATION & PERSONALIZATION
   ========================================================================== */
function parseRecipient(input) {
  let email = '';
  let name = '';

  if (typeof input === 'object' && input !== null) {
    email = (input.email || '').trim();
    name = (input.name || '').trim();
  } else if (typeof input === 'string') {
    email = input.trim();
  }

  const cleanEmail = email.toLowerCase();
  const domain = cleanEmail.includes('@') ? cleanEmail.split('@')[1] : '';

  return { email: cleanEmail, name, domain };
}

function createCleanPlainText(htmlOrText) {
  if (!htmlOrText) return '';
  return htmlOrText
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

/* ==========================================================================
   3. INBOX STREAMING ROUTE
   ========================================================================== */
app.post('/api/send-stream', async (req, res) => {
  const sessionId = crypto.randomUUID();
  activeSessions.add(sessionId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  res.write(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);

  const { email, appPassword, senderName, subject, messageBody, recipients } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: 'Invalid Input Data' })}\n\n`);
    activeSessions.delete(sessionId);
    res.end();
    return;
  }

  const cleanEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || '').replace(/["\r\n]/g, '').trim();

  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 4000);

  req.on('close', () => {
    activeSessions.delete(sessionId);
    clearInterval(keepAlive);
  });

  const transporter = getPort587Transporter(email, appPassword);
  
  // High Inbox Placement Rules: Single sending per batch + Human Delays
  const BATCH_SIZE = 1; 

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    if (!activeSessions.has(sessionId)) {
      res.write(`data: ${JSON.stringify({ success: false, error: 'Stopped by User' })}\n\n`);
      break;
    }

    const rawRecipient = recipients[i];
    const recipient = parseRecipient(rawRecipient);

    if (recipient.email) {
      try {
        const bodyContent = messageBody || 'Hello, please find the requested updates.';
        const plainText = createCleanPlainText(bodyContent);

        const mailOptions = {
          // RFC standard compliant headers (Gmail Inbox ke liye zaroori)
          from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
          to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
          replyTo: cleanEmail,
          subject: subject || 'Notice regarding your site',
          text: plainText,
          html: `<div dir="ltr">${bodyContent.replace(/\n/g, '<br>')}</div>`,
          headers: {
            'X-Mailer': 'NodeMailer',
            'X-Priority': '3' // Normal Priority (1 = High Priority flags email as Spam)
          }
        };

        await transporter.sendMail(mailOptions);
        res.write(`data: ${JSON.stringify({ success: true, recipient: recipient.email })}\n\n`);
      } catch (err) {
        res.write(`data: ${JSON.stringify({ success: false, recipient: recipient.email, error: err.message })}\n\n`);
      }
    }

    // Dynamic Human Delay (5 to 10 Seconds between emails to pass spam checks)
    if (i + 1 < recipients.length && activeSessions.has(sessionId)) {
      const delay = Math.floor(5000 + Math.random() * 5000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  activeSessions.delete(sessionId);
  clearInterval(keepAlive);
  res.write('data: [DONE]\n\n');
  res.end();
});

app.post('/api/stop', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId && activeSessions.has(sessionId)) {
    activeSessions.delete(sessionId);
    return res.json({ success: true, message: 'Stopped successfully' });
  }
  return res.status(400).json({ success: false, message: 'Invalid Session ID' });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

export default app;
