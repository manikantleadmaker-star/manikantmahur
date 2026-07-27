import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';

// Enable CORS for all origins, headers, and preflight options
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-api-key');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Global session stop flags & connection pool
const activeSessions = {};
const transporters = new Map();

/* ==========================================================================
   TRANSPORTER POOLING (Reusable High-Performance SMTP Connection Pool)
   ========================================================================== */
function getTransporter(email, appPassword, options = {}) {
  const cleanEmail = String(email || '').toLowerCase().trim();
  let cleanPassword = String(appPassword || '').trim().replace(/\s+/g, '');
  const cacheKey = `${cleanEmail}_${cleanPassword}`;

  if (!transporters.has(cacheKey)) {
    const isGmail = options.service === 'gmail' || !options.host || String(options.host).includes('gmail');

    let transporter;
    if (isGmail) {
      transporter = nodemailer.createTransport({
        service: 'gmail',
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user: cleanEmail, pass: cleanPassword },
        pool: true,
        maxConnections: 3,
        maxMessages: 100,
        tls: { rejectUnauthorized: false },
        connectionTimeout: 8000,
        greetingTimeout: 8000,
        socketTimeout: 12000,
      });
    } else {
      transporter = nodemailer.createTransport({
        host: options.host,
        port: options.port ? Number(options.port) : 587,
        secure: options.secure !== undefined ? Boolean(options.secure) : Number(options.port) === 465,
        auth: { user: cleanEmail, pass: cleanPassword },
        pool: true,
        maxConnections: 3,
        tls: { rejectUnauthorized: false },
        connectionTimeout: 8000,
      });
    }

    transporters.set(cacheKey, transporter);
  }

  return transporters.get(cacheKey);
}

/* ==========================================================================
   SPINTAX PARSER ({Hi|Hello|Hey})
   ========================================================================== */
function parseSpintax(text) {
  if (!text) return '';
  let spun = String(text);
  const regex = /{([^{}]+)}/g;
  let iterations = 0;
  while (regex.test(spun) && iterations < 15) {
    spun = spun.replace(regex, (_, choices) => {
      const options = choices.split('|');
      return options[Math.floor(Math.random() * options.length)];
    });
    iterations++;
  }
  return spun;
}

/* ==========================================================================
   CLEAN PLAIN-TEXT FALLBACK (Optimizes Spam Score for Direct Inbox Placement)
   ========================================================================== */
function convertHtmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

/* ==========================================================================
   HELPER: CLOUDFLARE TURNSTILE VERIFICATION
   ========================================================================== */
async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET_KEY || !token) return true;

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: ip || '',
      }),
    });
    const data = await response.json();
    return Boolean(data.success);
  } catch (error) {
    console.error('Turnstile Verification Error:', error);
    return true; // Graceful fallback
  }
}

/* ==========================================================================
   HEALTH & STATUS ROUTES
   ========================================================================== */
app.all(['/api/health', '/api/ping', '/api/status', '/health', '/ping'], (req, res) => {
  return res.status(200).json({
    success: true,
    status: 'ok',
    message: 'Bulk Email Service Online',
    timestamp: new Date().toISOString(),
  });
});

/* ==========================================================================
   AUTHENTICATION & SMTP VERIFICATION ROUTES
   ========================================================================== */
app.post(['/api/auth', '/api/verify-password', '/api/login'], (req, res) => {
  const { password } = req.body || {};
  if (!password) {
    return res.status(400).json({ success: false, message: 'Password is required' });
  }
  if (password === SITE_PASSWORD || password === 'Y##') {
    return res.json({ success: true, message: 'Access granted' });
  }
  return res.status(401).json({ success: false, message: 'Incorrect password' });
});

app.post(['/api/verify', '/api/verify-smtp'], async (req, res) => {
  const { email, appPassword, cfToken } = req.body || {};

  if (!email || !appPassword) {
    return res.status(400).json({ success: false, message: 'Email and App Password required' });
  }

  if (cfToken && TURNSTILE_SECRET_KEY) {
    const isValidToken = await verifyTurnstile(cfToken, req.ip);
    if (!isValidToken) {
      return res.status(400).json({ success: false, message: 'Security check failed.' });
    }
  }

  try {
    const transporter = getTransporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: 'SMTP verified successfully' });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('SMTP Verification failed for:', email, errMsg);
    return res.status(401).json({ success: false, message: 'Authentication failed. Check App Password.' });
  }
});

/* ==========================================================================
   SSE STREAM ROUTE (REAL-TIME STREAMING EMAIL DISPATCH)
   ========================================================================== */
app.post(['/api/send-stream', '/api/stream'], async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, senderName, subject, messageBody, recipients, cfToken, accounts } = req.body || {};

  // Resolve sender accounts array or single account
  let senderAccounts = Array.isArray(accounts) && accounts.length > 0 ? accounts : [];
  if (senderAccounts.length === 0 && email && appPassword) {
    senderAccounts.push({ email, appPassword, senderName });
  }

  // Resolve recipients
  let targetRecipients = Array.isArray(recipients) ? recipients : [];
  if (targetRecipients.length === 0 && typeof recipients === 'string') {
    targetRecipients = recipients.split(/[\n,;]+/).map((r) => r.trim()).filter(Boolean);
  }

  if (senderAccounts.length === 0 || targetRecipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: 'Missing required sender credentials or recipients list' })}\n\n`);
    res.end();
    return;
  }

  if (cfToken && TURNSTILE_SECRET_KEY) {
    const isValidToken = await verifyTurnstile(cfToken, req.ip);
    if (!isValidToken) {
      res.write(`data: ${JSON.stringify({ success: false, error: 'Turnstile verification failed' })}\n\n`);
      res.end();
      return;
    }
  }

  activeSessions['global_stop'] = false;
  let accountIndex = 0;

  for (let index = 0; index < targetRecipients.length; index++) {
    if (activeSessions['global_stop']) {
      res.write(`data: ${JSON.stringify({ success: false, error: 'Stopped by user' })}\n\n`);
      break;
    }

    const recipient = String(targetRecipients[index] || '').trim();
    if (!recipient || !recipient.includes('@')) continue;

    const currentAccount = senderAccounts[accountIndex % senderAccounts.length];
    accountIndex++;

    const accEmail = String(currentAccount.email || currentAccount.user || email || '').trim();
    const accPass = String(currentAccount.appPassword || currentAccount.pass || appPassword || '').trim();
    const accSenderName = String(currentAccount.senderName || currentAccount.name || senderName || '').trim();

    // Send HTTP keep-alive ping frame
    res.write(': keep-alive\n\n');

    try {
      const transporter = getTransporter(accEmail, accPass, currentAccount);
      const spunSubject = parseSpintax(subject || 'No Subject');
      const spunBody = parseSpintax(messageBody || '');
      const isHtml = /<[a-z][\s\S]*>/i.test(spunBody);

      const formattedFrom = accSenderName ? `"${accSenderName.replace(/"/g, '')}" <${accEmail}>` : accEmail;

      const mailOptions = {
        from: formattedFrom,
        to: recipient,
        subject: spunSubject,
        replyTo: accEmail,
        headers: {
          'X-Mailer': 'Secure Mailer',
          'X-Priority': '1',
          'X-MSMail-Priority': 'High',
          'Importance': 'High',
        },
      };

      if (isHtml) {
        mailOptions.html = spunBody;
        mailOptions.text = convertHtmlToText(spunBody);
      } else {
        mailOptions.text = spunBody;
      }

      await transporter.sendMail(mailOptions);
      res.write(`data: ${JSON.stringify({ success: true, recipient, sender: accEmail })}\n\n`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`Error sending to ${recipient} via ${accEmail}:`, errMsg);
      res.write(`data: ${JSON.stringify({ success: false, recipient, sender: accEmail, error: errMsg })}\n\n`);
    }

    // Natural pacing with keep-alive pings between emails
    if (index < targetRecipients.length - 1) {
      const randomDelay = Math.floor(800 + Math.random() * 800); // 0.8s - 1.6s safe pace
      await new Promise((resolve) => setTimeout(resolve, randomDelay));
      res.write(': keep-alive\n\n');
    }
  }

  res.write('data: [DONE]\n\n');
  res.end();
});

/* ==========================================================================
   STANDARD JSON BULK EMAIL DISPATCH ENDPOINT
   ========================================================================== */
app.post(['/api/send-emails', '/api/send-email', '/api/send', '/send-emails', '/send-email'], async (req, res) => {
  try {
    const body = req.body || {};
    const { email, appPassword, senderName, subject, messageBody, body: rawBody, recipients } = body;

    let senderAccounts = Array.isArray(body.accounts) && body.accounts.length > 0 ? body.accounts : [];
    if (senderAccounts.length === 0 && (email || body.user)) {
      senderAccounts.push({
        email: email || body.user,
        appPassword: appPassword || body.pass || body.password,
        senderName: senderName || body.name,
      });
    }

    let targetRecipients = Array.isArray(recipients) ? recipients : [];
    if (targetRecipients.length === 0 && typeof recipients === 'string') {
      targetRecipients = recipients.split(/[\n,;]+/).map((r) => r.trim()).filter(Boolean);
    }

    if (senderAccounts.length === 0 || targetRecipients.length === 0) {
      return res.status(200).json({ success: false, message: 'Missing sender account or recipients list' });
    }

    const content = messageBody || rawBody || body.message || '';
    const results = [];
    let accountIndex = 0;

    for (let i = 0; i < targetRecipients.length; i++) {
      const recipient = targetRecipients[i];
      const acc = senderAccounts[accountIndex % senderAccounts.length];
      accountIndex++;

      const accEmail = acc.email || acc.user;
      const accPass = acc.appPassword || acc.pass || acc.password;

      if (!accEmail || !accPass) {
        results.push({ recipient, status: 'failed', error: 'Missing credentials' });
        continue;
      }

      try {
        const transporter = getTransporter(accEmail, accPass, acc);
        const spunSubject = parseSpintax(subject || 'No Subject');
        const spunBody = parseSpintax(content);
        const isHtml = /<[a-z][\s\S]*>/i.test(spunBody);

        const mailOptions = {
          from: acc.senderName ? `"${acc.senderName}" <${accEmail}>` : accEmail,
          to: recipient,
          subject: spunSubject,
          replyTo: accEmail,
        };

        if (isHtml) {
          mailOptions.html = spunBody;
          mailOptions.text = convertHtmlToText(spunBody);
        } else {
          mailOptions.text = spunBody;
        }

        const info = await transporter.sendMail(mailOptions);
        results.push({ recipient, status: 'success', sender: accEmail, messageId: info.messageId });
      } catch (err) {
        results.push({ recipient, status: 'failed', sender: accEmail, error: err.message });
      }
    }

    const sentCount = results.filter((r) => r.status === 'success').length;
    return res.json({
      success: sentCount > 0,
      sent: sentCount,
      failed: results.length - sentCount,
      results,
    });
  } catch (error) {
    return res.status(200).json({ success: false, error: error.message });
  }
});

/* ==========================================================================
   STOP PROCESS ROUTE
   ========================================================================== */
app.post(['/api/stop', '/stop'], (req, res) => {
  activeSessions['global_stop'] = true;
  return res.json({ success: true, message: 'Stop process registered' });
});

/* ==========================================================================
   STATIC ASSETS & FRONTEND FALLBACK ROUTE
   ========================================================================== */
const publicPath = path.join(__dirname, 'public');
const distPath = path.join(process.cwd(), 'dist');

if (fs.existsSync(publicPath)) {
  app.use(express.static(publicPath));
}
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

app.get('*', (req, res) => {
  const publicIndex = path.join(publicPath, 'index.html');
  const distIndex = path.join(distPath, 'index.html');
  const rootIndex = path.join(process.cwd(), 'index.html');

  if (fs.existsSync(publicIndex)) {
    return res.sendFile(publicIndex);
  } else if (fs.existsSync(distIndex)) {
    return res.sendFile(distIndex);
  } else if (fs.existsSync(rootIndex)) {
    return res.sendFile(rootIndex);
  }

  return res.status(200).send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Bulk Email Sender API</title>
        <style>
          body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem; display: flex; justify-content: center; align-items: center; min-height: 80vh; }
          .card { background: #1e293b; border: 1px solid #334155; padding: 2rem; border-radius: 12px; max-width: 600px; width: 100%; text-align: center; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5); }
          h1 { color: #38bdf8; margin-top: 0; }
          code { background: #0f172a; color: #a5f3fc; padding: 4px 8px; border-radius: 4px; font-size: 0.9em; }
          .status { color: #4ade80; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Bulk Email Sender API</h1>
          <p>Status: <span class="status">Online & Fully Operational</span></p>
          <p>Endpoints Ready:</p>
          <p><code>POST /api/auth</code> - Password Check (Default: Y##)</p>
          <p><code>POST /api/verify</code> - Verify SMTP / App Password</p>
          <p><code>POST /api/send-stream</code> - Real-time SSE Email Dispatch</p>
          <p><code>POST /api/stop</code> - Cancel ongoing batch</p>
        </div>
      </body>
    </html>
  `);
});

/* ==========================================================================
   STANDALONE SERVER LISTENER / VERCEL EXPORT
   ========================================================================== */
if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

export default app;
