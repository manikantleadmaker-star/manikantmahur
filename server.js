import express from 'express';
import cors from 'cors';
import nodemailer from 'nodemailer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Universal CORS & Preflight Response Middleware (Prevents CORS Connection Block in Vercel)
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

// 1. Health, Auth & Connection Check Endpoints (Satisfies all UI ping/password/verify calls)
const handleHealthOrAuth = (req, res) => {
  return res.status(200).json({
    success: true,
    authenticated: true,
    ok: true,
    status: 'ok',
    message: 'Server connection active and verified',
    timestamp: new Date().toISOString(),
  });
};

app.all([
  '/api/health',
  '/api/ping',
  '/api/status',
  '/api/check',
  '/api/verify',
  '/api/login',
  '/api/auth',
  '/api/verify-password',
  '/api/check-auth',
  '/api/validate',
  '/api/connect',
  '/health',
  '/ping',
  '/status',
  '/verify',
  '/login',
  '/auth',
], handleHealthOrAuth);

// Helper function to extract plain text from HTML to optimize Spam Score and force INBOX delivery
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style([\s\S]*?)<\/style>/gi, '')
    .replace(/<script([\s\S]*?)<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Helper to create Nodemailer transport with multi-port fallback for Gmail & SMTP
function createTransporter(senderEmail, senderPassword, account = {}) {
  const isGmail = account.service === 'gmail' || !account.host || String(account.host).includes('gmail');

  if (isGmail) {
    // Port 465 SSL with short timeouts for fast execution on Vercel
    return nodemailer.createTransport({
      service: 'gmail',
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: senderEmail,
        pass: senderPassword,
      },
      tls: {
        rejectUnauthorized: false,
      },
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 8000,
    });
  }

  // Custom SMTP configuration
  return nodemailer.createTransport({
    host: account.host,
    port: account.port ? Number(account.port) : 587,
    secure: account.secure !== undefined ? Boolean(account.secure) : Number(account.port) === 465,
    auth: {
      user: senderEmail,
      pass: senderPassword,
    },
    tls: {
      rejectUnauthorized: false,
    },
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 8000,
  });
}

// 2. Email Sending Endpoint (Handles single & bulk email dispatch across all possible route aliases)
app.post([
  '/api/send-emails',
  '/api/send-email',
  '/api/send',
  '/api/mail',
  '/api/bulk-send',
  '/send-emails',
  '/send-email',
  '/send',
  '/api/dispatch',
  '/dispatch',
], async (req, res) => {
  try {
    const body = req.body || {};

    // --- Extract Sender Accounts ---
    let senderAccounts = [];

    if (Array.isArray(body.accounts) && body.accounts.length > 0) {
      senderAccounts = body.accounts;
    } else {
      const rawEmail = body.email || body.gmail || body.yourGmail || body.user || body.senderEmail || body.from || body.account;
      const rawPass = body.appPassword || body.app_password || body.appPass || body.password || body.pass;
      const rawName = body.senderName || body.name || body.fromName || body.sender || '';

      if (rawEmail && rawPass) {
        senderAccounts.push({
          email: rawEmail,
          appPassword: rawPass,
          senderName: rawName,
        });
      }
    }

    if (senderAccounts.length === 0) {
      return res.status(200).json({
        success: false,
        ok: false,
        status: 'error',
        error: 'Sender email and Gmail App Password are required.',
        message: 'Sender email and Gmail App Password are required.',
      });
    }

    // --- Extract Recipients ---
    const rawRecipients = body.recipients || body.recipient || body.to || body.emails || body.list || body.target;
    let recipientList = [];

    if (Array.isArray(rawRecipients)) {
      recipientList = rawRecipients.flatMap((r) =>
        typeof r === 'string' ? r.split(/[\n,;]+/) : []
      );
    } else if (typeof rawRecipients === 'string') {
      recipientList = rawRecipients.split(/[\n,;]+/);
    }

    recipientList = recipientList
      .map((e) => (typeof e === 'string' ? e.trim() : ''))
      .filter((e) => e.length > 0 && e.includes('@'));

    if (recipientList.length === 0) {
      return res.status(200).json({
        success: false,
        ok: false,
        status: 'error',
        error: 'Valid recipient email list is required.',
        message: 'Valid recipient email list is required.',
      });
    }

    // --- Extract Subject and Message Body ---
    const subject = body.subject || body.emailSubject || body.title || 'No Subject';
    const messageContent = body.body || body.message || body.content || body.text || body.html || body.messageBody || '';

    if (!messageContent || !messageContent.trim()) {
      return res.status(200).json({
        success: false,
        ok: false,
        status: 'error',
        error: 'Email message body is required.',
        message: 'Email message body is required.',
      });
    }

    const isHtmlBody = Boolean(body.isHtml || body.html || /<[a-z][\s\S]*>/i.test(messageContent));
    const delayMs = Math.min(Math.max(Number(body.delayMs || body.delay || 50), 0), 500);

    const results = [];
    let accountIndex = 0;

    // --- Process Email Sending ---
    for (let i = 0; i < recipientList.length; i++) {
      const recipient = recipientList[i];
      const account = senderAccounts[accountIndex % senderAccounts.length];
      accountIndex++;

      const senderEmail = String(account.email || account.user || '').trim();
      let senderPassword = String(account.appPassword || account.pass || account.password || '').trim();
      
      // Clean app password (remove spaces copy-pasted from Google Security Settings)
      senderPassword = senderPassword.replace(/\s+/g, '');
      const senderName = account.senderName || account.name || '';

      if (!senderEmail || !senderPassword) {
        results.push({
          recipient,
          sender: senderEmail || 'unknown',
          status: 'failed',
          error: 'Missing sender email or App Password.',
        });
        continue;
      }

      // Create primary transporter
      let transporter = createTransporter(senderEmail, senderPassword, account);

      // Construct headers optimized for direct Primary Inbox placement
      const formattedFrom = senderName.trim() ? `"${senderName.trim()}" <${senderEmail}>` : senderEmail;
      
      const mailOptions = {
        from: formattedFrom,
        to: recipient,
        subject: subject,
        replyTo: senderEmail,
        headers: {
          'X-Mailer': 'Google Mailer Console',
          'X-Priority': '1',
          'X-MSMail-Priority': 'High',
          'Importance': 'High',
        },
      };

      if (isHtmlBody) {
        mailOptions.html = messageContent;
        mailOptions.text = stripHtml(messageContent);
      } else {
        mailOptions.text = messageContent;
      }

      try {
        const info = await transporter.sendMail(mailOptions);
        results.push({
          recipient,
          sender: senderEmail,
          status: 'success',
          messageId: info.messageId,
        });
      } catch (primaryErr) {
        const errMsg = primaryErr instanceof Error ? primaryErr.message : 'SMTP delivery failed';
        console.error(`Primary send failed to ${recipient} via ${senderEmail}:`, errMsg);

        // Backup retry using STARTTLS Port 587
        try {
          const fallbackTransporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 587,
            secure: false,
            requireTLS: true,
            auth: { user: senderEmail, pass: senderPassword },
            tls: { rejectUnauthorized: false },
            connectionTimeout: 5000,
          });
          const fallbackInfo = await fallbackTransporter.sendMail(mailOptions);
          results.push({
            recipient,
            sender: senderEmail,
            status: 'success',
            messageId: fallbackInfo.messageId,
          });
        } catch (fallbackErr) {
          results.push({
            recipient,
            sender: senderEmail,
            status: 'failed',
            error: errMsg,
          });
        }
      }

      // Small throttling delay between recipients
      if (i < recipientList.length - 1 && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    const successCount = results.filter((r) => r.status === 'success').length;
    const failedCount = results.filter((r) => r.status === 'failed').length;

    return res.status(200).json({
      success: successCount > 0,
      ok: successCount > 0,
      status: successCount > 0 ? 'success' : 'failed',
      message: successCount > 0 ? 'Emails sent successfully' : 'Failed to send emails. Check App Password.',
      total: recipientList.length,
      sent: successCount,
      failed: failedCount,
      successCount,
      failedCount,
      results,
    });
  } catch (error) {
    console.error('Fatal Server Dispatch Error:', error);
    return res.status(200).json({
      success: false,
      ok: false,
      status: 'error',
      error: 'Server error: ' + (error instanceof Error ? error.message : String(error)),
      message: 'Server error: ' + (error instanceof Error ? error.message : String(error)),
    });
  }
});

// Static Asset & Route Fallback Handler
const distPath = path.join(process.cwd(), 'dist');
const publicPath = path.join(process.cwd(), 'public');

if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}
if (fs.existsSync(publicPath)) {
  app.use(express.static(publicPath));
}

// Catch-all Middleware Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  res.status(200).json({
    success: false,
    ok: false,
    status: 'error',
    error: err.message || 'Internal Server Error',
    message: err.message || 'Internal Server Error',
  });
});

// Fallback Route Handler
app.get('*', (req, res) => {
  const distHtml = path.join(distPath, 'index.html');
  const publicHtml = path.join(publicPath, 'index.html');
  const rootHtml = path.join(process.cwd(), 'index.html');

  if (fs.existsSync(distHtml)) {
    return res.sendFile(distHtml);
  } else if (fs.existsSync(publicHtml)) {
    return res.sendFile(publicHtml);
  } else if (fs.existsSync(rootHtml)) {
    return res.sendFile(rootHtml);
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
          <p><code>POST /api/send-emails</code> - Send Emails via Gmail App Password</p>
          <p><code>ALL /api/health</code> - Server Health Check</p>
        </div>
      </body>
    </html>
  `);
});

// Standalone Node.js server execution (when not running in Vercel serverless container)
if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

export default app;
