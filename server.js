import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '1x0000000000000000000000000000000AA';

const globalSession = { stopRequested: false };
const poolMap = new Map();
const accountLimitMap = new Map();

// High Deliverability Threshold Settings
const MAX_MAILS_PER_ACCOUNT = 500; // Scaled for high-volume dispatches
const WINDOW_DURATION_MS = 12 * 60 * 60 * 1000;

function checkAndIncrementLimit(email) {
  const cleanEmail = email.toLowerCase().trim();
  const now = Date.now();

  let record = accountLimitMap.get(cleanEmail);
  if (!record || (now - record.startTime > WINDOW_DURATION_MS)) {
    record = { count: 0, startTime: now };
    accountLimitMap.set(cleanEmail, record);
  }

  if (record.count >= MAX_MAILS_PER_ACCOUNT) {
    const remainingMinutes = Math.ceil((WINDOW_DURATION_MS - (now - record.startTime)) / 60000);
    return {
      allowed: false,
      message: `Quota Reached for ${cleanEmail} (${MAX_MAILS_PER_ACCOUNT}/${MAX_MAILS_PER_ACCOUNT}). Resets in ${remainingMinutes}m.`
    };
  }

  record.count += 1;
  return { allowed: true, remaining: MAX_MAILS_PER_ACCOUNT - record.count };
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(process.cwd(), 'public')));
app.use(express.static(path.join(__dirname, 'public')));

function getPort587Transporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPass = appPassword.replace(/\s+/g, '').trim();
  const key = `inbox_pro_${cleanEmail}_${cleanPass}`;

  if (!poolMap.has(key)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: cleanEmail, pass: cleanPass },
      pool: true,
      maxConnections: 6, // Dedicated 6 Socket Pool
      maxMessages: 200,
      socketTimeout: 45000,
      connectionTimeout: 30000
    });
    poolMap.set(key, transporter);
  }
  return poolMap.get(key);
}

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
    } else {
      email = str;
    }
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
  const regex = /\{([^{}]+)\}/s;
  let iterations = 0;

  while (regex.test(spun) && iterations < 35) {
    spun = spun.replace(regex, (_, choices) => {
      if (!choices.includes('|')) return choices;
      const options = choices.split('|');
      return options[Math.floor(Math.random() * options.length)].trim();
    });
    iterations++;
  }
  return spun.replace(/[\{\}]/g, '').trim();
}

function personalizeContent(template, recipient) {
  if (!template) return '';
  let content = parseSpintax(template);
  const fallback = recipient.firstName || recipient.name || 'there';

  content = content.replace(/{Name}/gi, recipient.name || fallback);
  content = content.replace(/{FirstName}/gi, recipient.firstName || fallback);
  content = content.replace(/{Email}/gi, recipient.email);
  return content;
}

/* ==========================================================================
   DIRECT 6 PARALLEL DISPATCH STREAM ENGINE
   ========================================================================== */
app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const { email, appPassword, senderName, subject, messageBody, recipients } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: 'Invalid Input Data' })}\n\n`);
    res.end();
    return;
  }

  const cleanEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || '').replace(/["\r\n]/g, '').trim();
  const domainHost = cleanEmail.split('@')[1] || 'gmail.com';
  globalSession.stopRequested = false;

  const transporter = getPort587Transporter(email, appPassword);
  const BATCH_SIZE = 6; // Guaranteed 6-mail parallel engine

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    if (globalSession.stopRequested) {
      res.write(`data: ${JSON.stringify({ success: false, error: 'Stopped by User' })}\n\n`);
      break;
    }

    const batch = recipients.slice(i, i + BATCH_SIZE);

    const sendPromises = batch.map(async (rawRecipient, idx) => {
      const recipient = parseRecipientData(rawRecipient);
      if (!recipient.email) return { success: false, recipient: '', error: 'Invalid Address' };

      const quota = checkAndIncrementLimit(cleanEmail);
      if (!quota.allowed) {
        const limitPayload = { success: false, recipient: recipient.email, error: quota.message };
        io.emit('mail_error', limitPayload);
        return limitPayload;
      }

      try {
        if (idx > 0) {
          await new Promise(resolve => setTimeout(resolve, Math.floor(80 + Math.random() * 120)));
        }

        const personalizedSubject = personalizeContent(subject, recipient) || 'Update';
        const personalizedBody = personalizeContent(messageBody, recipient);
        const uniqueMsgId = `<${Date.now()}.${crypto.randomBytes(6).toString('hex')}@${domainHost}>`;

        const mailOptions = {
          from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
          to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
          subject: personalizedSubject,
          text: personalizedBody.replace(/<[^>]+>/g, ''),
          html: `<div dir="ltr" style="font-family: sans-serif; font-size: 14px; color: #111;">${personalizedBody}</div>`,
          messageId: uniqueMsgId,
          headers: {
            'X-Mailer': 'Gmail Interface Engine',
            'X-Priority': '3 (Normal)'
          }
        };

        await transporter.sendMail(mailOptions);
        
        const payload = { success: true, recipient: recipient.email, name: recipient.name };
        io.emit('mail_sent', payload);
        return payload;

      } catch (err) {
        const errPayload = { success: false, recipient: recipient.email, error: err.message };
        io.emit('mail_error', errPayload);
        return errPayload;
      }
    });

    const results = await Promise.allSettled(sendPromises);

    for (const resItem of results) {
      if (resItem.status === 'fulfilled' && resItem.value.recipient) {
        res.write(`data: ${JSON.stringify(resItem.value)}\n\n`);
      }
    }

    if (i + BATCH_SIZE < recipients.length) {
      await new Promise(resolve => setTimeout(resolve, 1200 + Math.floor(Math.random() * 800)));
    }
  }

  res.write('data: [DONE]\n\n');
  res.end();
});

app.post('/api/stop', (req, res) => {
  globalSession.stopRequested = true;
  res.json({ success: true, message: 'Process Interrupted' });
});

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  server.listen(PORT, () => console.log(`🚀 Dispatch Engine Live on Port ${PORT}`));
}

export default app;
