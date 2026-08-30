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
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';

// Global Transporter Cache & Session State
const activeSessions = new Map();
const poolMap = new Map();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(process.cwd(), 'public')));

io.on('connection', () => {});

/* ==========================================================================
   1. Modern Nodemailer Transporter (STARTTLS Port 587)
   ========================================================================== */
function getTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPass = appPassword.replace(/\s+/g, '').trim();
  const key = `${cleanEmail}_${cleanPass}`;

  if (!poolMap.has(key)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // STARTTLS use karein (Gmail Primary Inbox ke liye best)
      requireTLS: true,
      auth: {
        user: cleanEmail,
        pass: cleanPass
      },
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      socketTimeout: 30000,
      connectionTimeout: 30000
    });

    poolMap.set(key, transporter);
  }
  return poolMap.get(key);
}

/* ==========================================================================
   2. Plain Text Generator (Primary Inbox Boost)
   ========================================================================== */
function generatePlainText(htmlContent) {
  if (!htmlContent) return '';
  return htmlContent
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

/* ==========================================================================
   3. Email Streaming Route (Human Behavior Emulation)
   ========================================================================== */
app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const { email, appPassword, senderName, subject, messageBody, recipients, sessionId } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: 'Invalid Input Data' })}\n\n`);
    res.end();
    return;
  }

  const cleanEmail = email.toLowerCase().trim();
  const currentSessionId = sessionId || cleanEmail;
  activeSessions.set(currentSessionId, false);

  req.on('close', () => {
    activeSessions.set(currentSessionId, true);
  });

  const transporter = getTransporter(email, appPassword);
  
  // High Inbox Delays: Ek baar mein 1 mail + Random Human Delay
  for (let i = 0; i < recipients.length; i++) {
    if (activeSessions.get(currentSessionId) === true) {
      res.write(`data: ${JSON.stringify({ success: false, error: 'Stopped by User' })}\n\n`);
      break;
    }

    const rawTarget = recipients[i];
    const targetEmail = (typeof rawTarget === 'object' ? rawTarget.email : rawTarget).trim();

    if (!targetEmail || !targetEmail.includes('@')) continue;

    // RFC Compliant Unique Message ID Generator
    const domainName = cleanEmail.split('@')[1] || 'gmail.com';
    const uniqueMessageId = `<${crypto.randomBytes(12).toString('hex')}.${Date.now()}@${domainName}>`;

    const mailOptions = {
      from: senderName ? `"${senderName}" <${cleanEmail}>` : cleanEmail,
      to: targetEmail,
      replyTo: cleanEmail,
      subject: subject,
      html: `<div style="font-family: sans-serif; font-size: 15px; color: #111111;">${messageBody}</div>`,
      text: generatePlainText(messageBody), // Plain text fallback
      messageId: uniqueMessageId,
      date: new Date(),
      headers: {
        'X-Mailer': 'Microsoft Outlook 16.0', // Standard mail client header
        'Importance': 'normal'
      }
    };

    try {
      await transporter.sendMail(mailOptions);
      const result = { success: true, recipient: targetEmail };
      io.emit('mail_sent', result);
      res.write(`data: ${JSON.stringify(result)}\n\n`);
    } catch (err) {
      const errResult = { success: false, recipient: targetEmail, error: err.message };
      io.emit('mail_error', errResult);
      res.write(`data: ${JSON.stringify(errResult)}\n\n`);
    }

    // Natural Delay: Har mail ke beech 1.0 se 1.5 second ka gap (Human Behavior)
    if (i < recipients.length - 1) {
      const humanDelay = Math.floor(1000 + Math.random() * 1000);
      await new Promise((resolve) => setTimeout(resolve, humanDelay));
    }
  }

  activeSessions.delete(currentSessionId);
  res.write('data: [DONE]\n\n');
  res.end();
});

app.post('/api/stop', (req, res) => {
  const { sessionId, email } = req.body;
  const targetId = sessionId || (email ? email.toLowerCase().trim() : null);
  if (targetId) activeSessions.set(targetId, true);
  return res.json({ success: true, message: 'Stopped' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
