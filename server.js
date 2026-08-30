import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = Number(process.env.PORT) || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || '';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';

const activeSessions = new Map();
const poolMap = new Map();
const MAX_POOLS = 50;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(process.cwd(), 'public')));

io.on('connection', (socket) => {
  socket.on('disconnect', () => {});
});

/* ==========================================================================
   1. Cloudflare Turnstile Verification
   ========================================================================== */
async function verifyTurnstileToken(token, remoteIp) {
  if (!token || !TURNSTILE_SECRET_KEY) return true;

  try {
    const formData = new URLSearchParams();
    formData.append('secret', TURNSTILE_SECRET_KEY);
    formData.append('response', token);
    if (remoteIp) formData.append('remoteip', remoteIp);

    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    });
    const outcome = await response.json();
    return outcome.success === true;
  } catch {
    return false;
  }
}

/* ==========================================================================
   2. Transporter Pool Configuration
   ========================================================================== */
function getTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPass = appPassword.replace(/\s+/g, '').trim();
  const key = `smtp_${cleanEmail}`;

  if (!poolMap.has(key)) {
    if (poolMap.size >= MAX_POOLS) {
      const firstKey = poolMap.keys().next().value;
      const oldTrans = poolMap.get(firstKey);
      if (oldTrans && typeof oldTrans.close === 'function') {
        try { oldTrans.close(); } catch {}
      }
      poolMap.delete(firstKey);
    }

    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // TLS via STARTTLS
      requireTLS: true,
      auth: {
        user: cleanEmail,
        pass: cleanPass
      },
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
      socketTimeout: 30000,
      connectionTimeout: 30000
    });

    poolMap.set(key, transporter);
  }
  return poolMap.get(key);
}

/* ==========================================================================
   3. Utility & Parsing Functions
   ========================================================================== */
function parseRecipientData(input) {
  let email = '';
  let rawName = '';

  if (typeof input === 'object' && input !== null) {
    email = (input.email || input.recipient || '').trim();
    rawName = (input.name || input.fullName || '').trim();
  } else if (typeof input === 'string') {
    const str = input.trim();
    const match = str.match(/^(?:"?([^"]*)"?\s)?<([^>]+)>$/);
    if (match) {
      rawName = match[1] ? match[1].trim() : '';
      email = match[2].trim();
    } else {
      email = str;
    }
  }

  return {
    email: email.toLowerCase(),
    name: rawName
  };
}

function createCleanPlainText(htmlText) {
  if (!htmlText) return '';
  return htmlText
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/* ==========================================================================
   4. API Routes
   ========================================================================== */
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (SITE_PASSWORD && password === SITE_PASSWORD) {
    return res.json({ success: true, message: 'Authorized' });
  }
  return res.status(401).json({ success: false, message: 'Unauthorized' });
});

app.post('/api/verify', async (req, res) => {
  const { email, appPassword, cfToken } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!email || !appPassword) {
    return res.status(400).json({ success: false, message: 'Credentials missing' });
  }

  if (cfToken) {
    const isHuman = await verifyTurnstileToken(cfToken, clientIp);
    if (!isHuman) {
      return res.status(403).json({ success: false, message: 'Verification failed' });
    }
  }

  try {
    const transporter = getTransporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: 'SMTP credentials valid' });
  } catch (error) {
    return res.status(401).json({ success: false, message: error.message });
  }
});

/* ==========================================================================
   5. Email Streaming Route (With Rate Control & Batching)
   ========================================================================== */
app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const { email, appPassword, senderName, subject, messageBody, recipients, cfToken, sessionId } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: 'Invalid payload' })}\n\n`);
    res.end();
    return;
  }

  if (cfToken) {
    const isHuman = await verifyTurnstileToken(cfToken, clientIp);
    if (!isHuman) {
      res.write(`data: ${JSON.stringify({ success: false, error: 'Turnstile check failed' })}\n\n`);
      res.end();
      return;
    }
  }

  const cleanEmail = email.toLowerCase().trim();
  const currentSessionId = sessionId || cleanEmail;
  activeSessions.set(currentSessionId, false);

  req.on('close', () => {
    activeSessions.set(currentSessionId, true);
  });

  const transporter = getTransporter(email, appPassword);
  const BATCH_SIZE = 2; // Controlled rate processing

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    if (activeSessions.get(currentSessionId) === true) {
      res.write(`data: ${JSON.stringify({ success: false, error: 'Session stopped' })}\n\n`);
      break;
    }

    const batch = recipients.slice(i, i + BATCH_SIZE);
    
    const promises = batch.map(async (rawRecipient) => {
      const recipient = parseRecipientData(rawRecipient);
      if (!recipient.email) {
        return { success: false, recipient: '', error: 'Invalid address' };
      }

      const domainName = cleanEmail.split('@')[1] || 'domain.com';
      const customMessageId = `<${crypto.randomBytes(12).toString('hex')}@${domainName}>`;

      const mailOptions = {
        from: senderName ? `"${senderName}" <${cleanEmail}>` : cleanEmail,
        to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
        replyTo: cleanEmail,
        date: new Date(),
        messageId: customMessageId,
        subject: subject || 'Notice',
        html: messageBody,
        text: createCleanPlainText(messageBody),
        textEncoding: 'quoted-printable',
        encoding: 'utf-8'
      };

      try {
        await transporter.sendMail(mailOptions);
        const resPayload = { success: true, recipient: recipient.email };
        io.emit('mail_sent', resPayload);
        return resPayload;
      } catch (err) {
        const errPayload = { success: false, recipient: recipient.email, error: err.message };
        io.emit('mail_error', errPayload);
        return errPayload;
      }
    });

    const results = await Promise.allSettled(promises);

    for (const item of results) {
      if (item.status === 'fulfilled') {
        res.write(`data: ${JSON.stringify(item.value)}\n\n`);
      }
    }

    // Delay between processing chunks to manage load
    if (i + BATCH_SIZE < recipients.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  activeSessions.delete(currentSessionId);
  res.write('data: [DONE]\n\n');
  res.end();
});

app.post('/api/stop', (req, res) => {
  const { sessionId, email } = req.body;
  const targetId = sessionId || (email ? email.toLowerCase().trim() : null);
  if (targetId) {
    activeSessions.set(targetId, true);
  }
  return res.json({ success: true, message: 'Stop signal registered' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

export default app;
