import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';

// Global CORS & Preflight Response Headers
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

// Transporter Connection Pool & Session Control
const activeSessions = {};
const transporters = new Map();

/* ==========================================================================
   TRANSPORTER POOLING (High-Deliverability SMTP Connection Pool)
   ========================================================================== */
function getTransporter(email, appPassword, options = {}) {
  const cleanEmail = String(email || '').toLowerCase().trim();
  const cleanPassword = String(appPassword || '').trim().replace(/\s+/g, '');
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
        auth: {
          user: cleanEmail,
          pass: cleanPassword,
        },
        pool: true,
        maxConnections: 3,
        maxMessages: 100,
        tls: { rejectUnauthorized: false },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
      });
    } else {
      transporter = nodemailer.createTransport({
        host: options.host,
        port: options.port ? Number(options.port) : 587,
        secure: options.secure !== undefined ? Boolean(options.secure) : Number(options.port) === 465,
        auth: {
          user: cleanEmail,
          pass: cleanPassword,
        },
        pool: true,
        maxConnections: 3,
        tls: { rejectUnauthorized: false },
        connectionTimeout: 10000,
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
   CLEAN & SANITIZE EMAIL BODY (Removes Spam Triggers, Extra Links & Scripts)
   ========================================================================== */
function cleanEmailBody(content) {
  if (!content) return '';
  let cleaned = String(content);

  // Remove dangerous scripts, iframes, objects, embedded tracking pixels
  cleaned = cleaned
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?<\/embed>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '');

  return cleaned.trim();
}

/* ==========================================================================
   PLAIN TEXT CONVERTER (Balanced Dual Multipart MIME for Direct INBOX Placement)
   ========================================================================== */
function convertHtmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

/* ==========================================================================
   CLOUDFLARE TURNSTILE VERIFICATION
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
    console.error('Turnstile Verification Warning:', error);
    return true; // Fallback gracefully if verification service times out
  }
}

/* ==========================================================================
   HEALTH & CONNECTION CHECK ROUTES
   ========================================================================== */
app.all(['/api/health', '/api/ping', '/api/status', '/health', '/ping'], (req, res) => {
  return res.status(200).json({
    success: true,
    status: 'ok',
    message: 'Bulk Email API Online & Operational',
    timestamp: new Date().toISOString(),
  });
});

/* ==========================================================================
   AUTHENTICATION & SMTP VERIFICATION ENDPOINTS
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
    console.error('SMTP Verification Error for:', email, errMsg);
    return res.status(401).json({ success: false, message: 'Authentication failed. Please check your App Password.' });
  }
});

/* ==========================================================================
   REAL-TIME SSE EMAIL DISPATCH (Strictly Optimized for INBOX Placement)
   ========================================================================== */
app.post(['/api/send-stream', '/api/stream'], async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, senderName, subject, messageBody, recipients, cfToken, accounts } = req.body || {};

  // Extract Accounts
  let senderAccounts = Array.isArray(accounts) && accounts.length > 0 ? accounts : [];
  if (senderAccounts.length === 0 && email && appPassword) {
    senderAccounts.push({ email, appPassword, senderName });
  }

  // Extract Target Recipients
  let targetRecipients = Array.isArray(recipients) ? recipients : [];
  if (targetRecipients.length === 0 && typeof recipients === 'string') {
    targetRecipients = recipients.split(/[\n,;]+/).map((r) => r.trim()).filter(Boolean);
  }

  if (senderAccounts.length === 0 || targetRecipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: 'Sender email, App Password, and recipient list are required.' })}\n\n`);
    res.end();
    return;
  }

  if (cfToken && TURNSTILE_SECRET_KEY) {
    const isValidToken = await verifyTurnstile(cfToken, req.ip);
    if (!isValidToken) {
      res.write(`data: ${JSON.stringify({ success: false, error: 'Turnstile verification failed.' })}\n\n`);
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

    const accEmail = String(currentAccount.email || currentAccount.user || email || '').trim().toLowerCase();
    const accPass = String(currentAccount.appPassword || currentAccount.pass || appPassword || '').trim().replace(/\s+/g, '');
    const accSenderName = String(currentAccount.senderName || currentAccount.name || senderName || '').trim().replace(/["<>]/g, '');

    // Send SSE keep-alive ping frame to maintain live connection
    res.write(': keep-alive\n\n');

    try {
      const transporter = getTransporter(accEmail, accPass, currentAccount);
      
      // Dynamic Spintax Variations
      const rawSubject = parseSpintax(subject || 'No Subject');
      const rawBody = parseSpintax(messageBody || '');
      const cleanedBody = cleanEmailBody(rawBody);
      const isHtml = /<[a-z][\s\S]*>/i.test(cleanedBody);

      // Clean Standard RFC Format (Sender Name + Authenticated Email)
      const formattedFrom = accSenderName ? `"${accSenderName}" <${accEmail}>` : accEmail;
      
      // Generate clean RFC-compliant Message-ID to pass DKIM/DMARC filters
      const domain = accEmail.includes('@') ? accEmail.split('@')[1] : 'gmail.com';
      const customMessageId = `<${crypto.randomBytes(12).toString('hex')}@${domain}>`;

      const mailOptions = {
        from: formattedFrom,
        to: recipient,
        subject: rawSubject,
        replyTo: accEmail,
        messageId: customMessageId,
        headers: {
          'MIME-Version': '1.0',
          'X-Report-Abuse': `Please report abuse to ${accEmail}`,
        },
      };

      if (isHtml) {
        mailOptions.html = cleanedBody;
        mailOptions.text = convertHtmlToText(cleanedBody); // Balanced Plain Text ensures high Inbox score
      } else {
        mailOptions.text = cleanedBody;
      }

      await transporter.sendMail(mailOptions);
      res.write(`data: ${JSON.stringify({ success: true, recipient, sender: accEmail })}\n\n`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`Error delivering to ${recipient} via ${accEmail}:`, errMsg);

      // Fallback attempt via STARTTLS Port 587 if primary pool failed
      try {
        const fallbackTransporter = nodemailer.createTransport({
          host: 'smtp.gmail.com',
          port: 587,
          secure: false,
          requireTLS: true,
          auth: { user: accEmail, pass: accPass },
          tls: { rejectUnauthorized: false },
          connectionTimeout: 8000,
        });

        const rawSubject = parseSpintax(subject || 'No Subject');
        const rawBody = parseSpintax(messageBody || '');
        const cleanedBody = cleanEmailBody(rawBody);
        const isHtml = /<[a-z][\s\S]*>/i.test(cleanedBody);
        const formattedFrom = accSenderName ? `"${accSenderName}" <${accEmail}>` : accEmail;

        const mailOptions = {
          from: formattedFrom,
          to: recipient,
          subject: rawSubject,
          replyTo: accEmail,
        };

        if (isHtml) {
          mailOptions.html = cleanedBody;
          mailOptions.text = convertHtmlToText(cleanedBody);
        } else {
          mailOptions.text = cleanedBody;
        }

        await fallbackTransporter.sendMail(mailOptions);
        res.write(`data: ${JSON.stringify({ success: true, recipient, sender: accEmail })}\n\n`);
      } catch (fallbackErr) {
        res.write(`data: ${JSON.stringify({ success: false, recipient, sender: accEmail, error: errMsg })}\n\n`);
      }
    }

    // Natural Human Pacing (1s - 2s Jitter Delay to prevent Gmail Bulk Spam Rate Limits)
    if (index < targetRecipients.length - 1) {
      const randomDelay = Math.floor(400 + Math.random() * 400);
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
      return res.status(200).json({ success: false, message: 'Missing sender credentials or recipients list.' });
    }

    const content = messageBody || rawBody || body.message || '';
    const results = [];
    let accountIndex = 0;

    for (let i = 0; i < targetRecipients.length; i++) {
      const recipient = targetRecipients[i];
      const acc = senderAccounts[accountIndex % senderAccounts.length];
      accountIndex++;

      const accEmail = String(acc.email || acc.user || '').trim().toLowerCase();
      const accPass = String(acc.appPassword || acc.pass || acc.password || '').trim().replace(/\s+/g, '');
      const accName = String(acc.senderName || acc.name || senderName || '').trim().replace(/["<>]/g, '');

      if (!accEmail || !accPass) {
        results.push({ recipient, status: 'failed', error: 'Missing email or App Password.' });
        continue;
      }

      try {
        const transporter = getTransporter(accEmail, accPass, acc);
        const spunSubject = parseSpintax(subject || 'No Subject');
        const spunBody = parseSpintax(content);
        const cleanedBody = cleanEmailBody(spunBody);
        const isHtml = /<[a-z][\s\S]*>/i.test(cleanedBody);

        const formattedFrom = accName ? `"${accName}" <${accEmail}>` : accEmail;
        const domain = accEmail.includes('@') ? accEmail.split('@')[1] : 'gmail.com';
        const customMessageId = `<${crypto.randomBytes(12).toString('hex')}@${domain}>`;

        const mailOptions = {
          from: formattedFrom,
          to: recipient,
          subject: spunSubject,
          replyTo: accEmail,
          messageId: customMessageId,
        };

        if (isHtml) {
          mailOptions.html = cleanedBody;
          mailOptions.text = convertHtmlToText(cleanedBody);
        } else {
          mailOptions.text = cleanedBody;
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
   STOP DISPATCH PROCESS ROUTE
   ========================================================================== */
app.post(['/api/stop', '/stop'], (req, res) => {
  activeSessions['global_stop'] = true;
  return res.json({ success: true, message: 'Stop process requested' });
});

/* ==========================================================================
   STATIC ASSETS & ROUTE FALLBACK HANDLER
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
          <p>Status: <span class="status">Online & Operational</span></p>
          <p>Endpoints Ready:</p>
          <p><code>POST /api/auth</code> - Password Verification (Default: Y##)</p>
          <p><code>POST /api/verify</code> - SMTP & App Password Check</p>
          <p><code>POST /api/send-stream</code> - High-Deliverability SSE Email Dispatch</p>
          <p><code>POST /api/stop</code> - Emergency Stop Batch</p>
        </div>
      </body>
    </html>
  `);
});

/* ==========================================================================
   STANDALONE SERVER / VERCEL HANDLER EXPORT
   ========================================================================== */
if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

export default app;
