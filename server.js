import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

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

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(process.cwd(), 'public')));
app.use(express.static(path.join(__dirname, 'public')));

// Configure connection pool with 6 parallel connections
function getParallelTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPass = appPassword.replace(/\s+/g, '').trim();
  const key = `fast_pool_${cleanEmail}_${cleanPass}`;

  if (!poolMap.has(key)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // TLS
      requireTLS: true,
      auth: { user: cleanEmail, pass: cleanPass },
      pool: true,
      maxConnections: 6, // Opens 6 simultaneous socket connections
      maxMessages: 500,
      socketTimeout: 15000,
      connectionTimeout: 15000
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

  return {
    email: email.toLowerCase(),
    name: rawName || email.split('@')[0],
    domain: email.includes('@') ? email.split('@')[1] : ''
  };
}

function parseSpintax(text) {
  if (!text) return '';
  let spun = String(text);
  const regex = /\{([^{}]+)\}/s;
  let iterations = 0;
  while (regex.test(spun) && iterations < 20) {
    spun = spun.replace(regex, (_, choices) => {
      const options = choices.split('|');
      return options[Math.floor(Math.random() * options.length)].trim();
    });
    iterations++;
  }
  return spun.replace(/[\{\}]/g, '').trim();
}

app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const { email, appPassword, senderName, subject, messageBody, recipients } = req.body;
  const cleanEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || '').trim();
  globalSession.stopRequested = false;

  const transporter = getParallelTransporter(email, appPassword);
  const BATCH_SIZE = 6; // Process 6 recipients concurrently

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    if (globalSession.stopRequested) break;

    const batch = recipients.slice(i, i + BATCH_SIZE);

    // Fire 6 emails in parallel
    const parallelSends = batch.map(async (rawRecipient) => {
      const recipient = parseRecipientData(rawRecipient);
      if (!recipient.email) return;

      const personalizedSubject = parseSpintax(subject).replace(/{Name}/gi, recipient.name);
      const personalizedBody = parseSpintax(messageBody).replace(/{Name}/gi, recipient.name);

      const randomId = Math.random().toString(36).substring(2, 11);
      const customMessageId = `<${Date.now()}.${randomId}@${cleanEmail.split('@')[1] || 'gmail.com'}>`;

      const mailOptions = {
        from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
        to: recipient.email,
        replyTo: cleanEmail,
        date: new Date(),
        messageId: customMessageId,
        subject: personalizedSubject,
        html: `<div style="font-family: Arial, sans-serif; font-size: 11pt; color: #111;">${personalizedBody}</div>`,
        text: personalizedBody.replace(/<[^>]+>/g, ''),
        textEncoding: 'quoted-printable'
      };

      try {
        await transporter.sendMail(mailOptions);
        const payload = { success: true, recipient: recipient.email };
        io.emit('mail_sent', payload);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch (err) {
        const errPayload = { success: false, recipient: recipient.email, error: err.message };
        io.emit('mail_error', errPayload);
        res.write(`data: ${JSON.stringify(errPayload)}\n\n`);
      }
    });

    await Promise.all(parallelSends);
  }

  res.write('data: [DONE]\n\n');
  res.end();
});

app.post('/api/stop', (req, res) => {
  globalSession.stopRequested = true;
  res.json({ success: true, message: 'Stopped' });
});

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  server.listen(PORT, () => console.log(`Server on port ${PORT}`));
}

export default app;
