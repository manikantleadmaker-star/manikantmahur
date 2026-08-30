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

const activeSessions = new Map();
const poolMap = new Map();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(process.cwd(), 'public')));

io.on('connection', () => {});

function getTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPass = appPassword.replace(/\s+/g, '').trim();
  const key = `${cleanEmail}_${cleanPass}`;

  if (!poolMap.has(key)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: {
        user: cleanEmail,
        pass: cleanPass
      },
      pool: true,
      maxConnections: 10,
      maxMessages: 1000,
      socketTimeout: 20000,
      connectionTimeout: 20000
    });

    poolMap.set(key, transporter);
  }
  return poolMap.get(key);
}

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

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) {
    return res.json({ success: true, message: 'Authorized' });
  }
  return res.status(401).json({ success: false, message: 'Unauthorized Password' });
});

app.post('/api/verify', async (req, res) => {
  const { email, appPassword } = req.body;
  if (!email || !appPassword) {
    return res.status(400).json({ success: false, message: 'Credentials missing' });
  }

  try {
    const transporter = getTransporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: 'SMTP Verified Successfully' });
  } catch (error) {
    return res.status(401).json({ success: false, message: error.message });
  }
});

app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const { email, appPassword, senderName, subject, messageBody, recipients, sessionId } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: 'Invalid Input Data' })}\n\n`);
    res.write('data: [DONE]\n\n');
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
  const BATCH_SIZE = 5;

  const sendSingleMail = async (rawTarget) => {
    let targetEmail = '';
    try {
      targetEmail = (typeof rawTarget === 'object' ? rawTarget.email : rawTarget).trim();
      if (!targetEmail || !targetEmail.includes('@')) {
        return { success: false, recipient: targetEmail || 'Invalid', error: 'Invalid Email Address' };
      }

      const domainName = cleanEmail.split('@')[1] || 'gmail.com';
      const uniqueMessageId = `<${crypto.randomBytes(12).toString('hex')}.${Date.now()}@${domainName}>`;

      const mailOptions = {
        from: senderName ? `"${senderName}" <${cleanEmail}>` : cleanEmail,
        to: targetEmail,
        replyTo: cleanEmail,
        subject: subject,
        html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family: sans-serif; font-size: 15px; color: #111111;"><div dir="ltr">${messageBody}</div></body></html>`,
        text: generatePlainText(messageBody),
        messageId: uniqueMessageId,
        date: new Date(),
        headers: {
          'X-Mailer': 'Microsoft Outlook Express 16.0',
          'X-Priority': '3',
          'Importance': 'Normal'
        }
      };

      await transporter.sendMail(mailOptions);
      const result = { success: true, recipient: targetEmail };
      io.emit('mail_sent', result);
      return result;
    } catch (err) {
      const errResult = { success: false, recipient: targetEmail || 'Failed', error: err.message || 'Send Error' };
      io.emit('mail_error', errResult);
      return errResult;
    }
  };

  // 1 Glitch = 5 Emails Parallel. Runs continuously until ALL emails (e.g. 23/25) are finished.
  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    if (activeSessions.get(currentSessionId) === true) {
      res.write(`data: ${JSON.stringify({ success: false, error: 'Stopped by User' })}\n\n`);
      break;
    }

    const currentBatch = recipients.slice(i, i + BATCH_SIZE);
    const batchPromises = currentBatch.map(recipient => sendSingleMail(recipient));
    const batchResults = await Promise.allSettled(batchPromises);

    for (const resItem of batchResults) {
      if (resItem.status === 'fulfilled' && resItem.value) {
        res.write(`data: ${JSON.stringify(resItem.value)}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ success: false, recipient: 'Error', error: 'Batch Failed' })}\n\n`);
      }
    }

    if (i + BATCH_SIZE < recipients.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
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

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

export default app;
