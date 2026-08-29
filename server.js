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

const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '1x0000000000000000000000000000000AA';

// Session control for individual users
const activeSessions = new Map();
const poolMap = new Map();
const MAX_POOLS = 50;

// Express Body Parsers (Higher limits for large bulk data)
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(express.static(path.join(process.cwd(), 'public')));

io.on('connection', (socket) => {
  socket.on('disconnect', () => {});
});

/* ==========================================================================
   1. BOT PROTECTION (Cloudflare Turnstile)
   ========================================================================== */
async function verifyTurnstileToken(token, remoteIp) {
  if (!token || TURNSTILE_SECRET_KEY.startsWith('1x0000000000000000000000000000000AA')) {
    return true;
  }

  try {
    const formData = new URLSearchParams();
    formData.append('secret', TURNSTILE_SECRET_KEY);
    formData.append('response', token);
    if (remoteIp) formData.append('remoteip', remoteIp);

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
   2. GMAIL TLS TRANSPORTER POOL (Port 587 STARTTLS)
   ========================================================================== */
function getPort587Transporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPass = appPassword.replace(/\s+/g, '').trim();
  const key = `native_${cleanEmail}_${cleanPass}`;

  if (!poolMap.has(key)) {
    if (poolMap.size >= MAX_POOLS) {
      const firstKey = poolMap.keys().next().value;
      const oldTransporter = poolMap.get(firstKey);
      if (oldTransporter && typeof oldTransporter.close === 'function') {
        try { oldTransporter.close(); } catch {}
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
      maxMessages: 500,
      socketTimeout: 45000,
      connectionTimeout: 45000,
      tls: {
        rejectUnauthorized: true
      }
    });
    poolMap.set(key, transporter);
  }
  return poolMap.get(key);
}

/* ==========================================================================
   3. RECIPIENT PARSING & SPINTAX
   ========================================================================== */
function parseRecipientData(input) {
  let email = '';
  let rawName = '';

  if (typeof input === 'object' && input !== null) {
    email = (input.email || input.recipient || '').trim();
    rawName = (input.name || input.fullName || input.first_name || '').trim();
  } else if (typeof input === 'string') {
    const str = input.trim();
    const angleMatch = str.match(/^(?:"?([^"]*)"?\s)?<([^>]+)>$/);
    if (angleMatch) {
      rawName = angleMatch[1] ? angleMatch[1].trim() : '';
      email = angleMatch[2].trim();
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

  while (regex.test(spun) && iterations < 35) {
    spun = spun.replace(regex, (_, choices) => {
      if (!choices.includes('|')) return choices;
      const options = choices.split('|');
      const pick = options[Math.floor(Math.random() * options.length)];
      return pick ? pick.trim() : '';
    });
    iterations++;
  }
  return spun.replace(/[\{\}]/g, '').trim();
}

function personalizeContent(template, recipient) {
  if (!template) return '';
  let content = parseSpintax(template);
  const fallback = recipient.firstName || recipient.name || '';

  content = content.replace(/{Name}/gi, recipient.name || fallback || 'there');
  content = content.replace(/{FirstName}/gi, recipient.firstName || fallback || 'there');
  content = content.replace(/{First_Name}/gi, recipient.firstName || fallback || 'there');
  content = content.replace(/{Email}/gi, recipient.email);
  content = content.replace(/{Domain}/gi, recipient.domain);

  return content;
}

function createCleanPlainText(text) {
  if (!text) return '';
  return text
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
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

  if (cfToken) {
    const isHuman = await verifyTurnstileToken(cfToken, clientIp);
    if (!isHuman) {
      return res.status(403).json({ success: false, message: 'Security Verification Failed' });
    }
  }

  try {
    const transporter = getPort587Transporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: 'SMTP verified successfully' });
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: error.message || 'SMTP Auth Failed. Ensure 16-character App Password is correct.'
    });
  }
});

/* ==========================================================================
   5. RELIABLE STREAMING SENDER ENGINE
   ========================================================================== */
app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const { email, appPassword, senderName, subject, messageBody, recipients, cfToken, sessionId } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: 'Invalid Request Data' })}\n\n`);
    res.end();
    return;
  }

  if (cfToken) {
    const isHuman = await verifyTurnstileToken(cfToken, clientIp);
    if (!isHuman) {
      res.write(`data: ${JSON.stringify({ success: false, error: 'Turnstile Verification Failed' })}\n\n`);
      res.end();
      return;
    }
  }

  const cleanEmail = email.toLowerCase().trim();
  const currentSessionId = sessionId || cleanEmail;
  activeSessions.set(currentSessionId, false);

  const cleanSenderName = (senderName || '').replace(/["\r\n]/g, '').trim();

  req.on('close', () => {
    activeSessions.set(currentSessionId, true);
  });

  const keepAlivePing = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch {}
  }, 3000);

  const transporter = getPort587Transporter(email, appPassword);
  const BATCH_SIZE = 2; // Optimal concurrency for Gmail 587 limits

  const sendSingleMail = async (rawRecipient, retries = 3) => {
    const recipient = parseRecipientData(rawRecipient);
    if (!recipient.email) {
      const errRes = { success: false, recipient: '', error: 'Invalid Email Address' };
      io.emit('mail_error', errRes);
      return errRes;
    }

    const personalizedSubject = personalizeContent(subject, recipient);
    const personalizedBody = personalizeContent(messageBody, recipient);
    const isHtml = /<[a-z][\s\S]*>/i.test(personalizedBody);

    const cleanBodyText = isHtml
      ? personalizedBody
      : personalizedBody.replace(/\n/g, '<br>');

    const formattedHtml = `<div dir="ltr">${cleanBodyText}</div>`;
    const plainTextFormatted = createCleanPlainText(personalizedBody);
    const domainName = cleanEmail.split('@')[1] || 'gmail.com';
    const customMessageId = `<${crypto.randomBytes(12).toString('hex')}@${domainName}>`;

    const mailOptions = {
      from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
      to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
      replyTo: cleanEmail,
      date: new Date(),
      messageId: customMessageId,
      subject: personalizedSubject || 'Hello',
      html: formattedHtml,
      text: plainTextFormatted,
      textEncoding: 'quoted-printable',
      encoding: 'utf-8',
      headers: {
        'X-Report-Abuse-To': cleanEmail
      }
    };

    // Auto Retry System
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await transporter.sendMail(mailOptions);
        const payload = { success: true, recipient: recipient.email, name: recipient.name };
        io.emit('mail_sent', payload);
        return payload;
      } catch (err) {
        if (attempt === retries) {
          const errPayload = { success: false, recipient: recipient.email, error: err.message };
          io.emit('mail_error', errPayload);
          return errPayload;
        }
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  };

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    if (activeSessions.get(currentSessionId) === true) {
      res.write(`data: ${JSON.stringify({ success: false, error: 'Stopped by User' })}\n\n`);
      break;
    }

    const batch = recipients.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(r => sendSingleMail(r)));

    for (const resItem of results) {
      if (resItem) {
        res.write(`data: ${JSON.stringify(resItem)}\n\n`);
      }
    }

    if (i + BATCH_SIZE < recipients.length) {
      const batchDelay = Math.floor(400 + Math.random() * 300);
      await new Promise(resolve => setTimeout(resolve, batchDelay));
    }
  }

  clearInterval(keepAlivePing);
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
  res.json({ success: true, message: 'Sending process stopped' });
});

// Front-End SPA Catch-All Route
app.get('*', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

// Server Initialization
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  server.listen(PORT, () => {
    console.log(`🚀 Mailer server operational on port ${PORT}`);
  });
}

export default app;
