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

// Enable CORS for all origins and headers
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health Check Endpoints
app.all(['/api/health', '/api/ping', '/health', '/ping'], (req, res) => {
  res.json({ status: 'ok', success: true, timestamp: new Date().toISOString() });
});

// Access / Auth / Password Verification Endpoints (Prevents Connection error in UI)
app.all(['/api/verify', '/api/login', '/api/auth', '/api/verify-password', '/api/check-auth', '/verify', '/login'], (req, res) => {
  res.json({
    success: true,
    authenticated: true,
    status: 'ok',
    message: 'Access granted',
  });
});

// Single or Bulk Email Dispatch API Endpoint
app.post(['/api/send-emails', '/api/send-email', '/api/send', '/send-emails', '/send-email', '/api/bulk-send'], async (req, res) => {
  try {
    const { accounts, recipients, subject, body, isHtml = false, delayMs = 300 } = req.body;

    // Support both structured accounts array or direct single user/pass
    let senderAccounts = accounts;
    if (!senderAccounts && (req.body.email || req.body.user)) {
      senderAccounts = [{
        email: req.body.email || req.body.user,
        appPassword: req.body.appPassword || req.body.pass || req.body.password,
        senderName: req.body.senderName,
      }];
    }

    // Validation
    if (!senderAccounts || !Array.isArray(senderAccounts) || senderAccounts.length === 0) {
      return res.status(400).json({
        error: 'At least one sender account (email/user and appPassword/pass) is required.',
      });
    }

    let recipientList = recipients;
    if (!recipientList && (req.body.to || req.body.recipient)) {
      recipientList = Array.isArray(req.body.to) ? req.body.to : [req.body.to || req.body.recipient];
    }

    if (!recipientList || !Array.isArray(recipientList) || recipientList.length === 0) {
      return res.status(400).json({ error: 'Recipients list is required and must be a non-empty array.' });
    }

    if (!subject || typeof subject !== 'string' || !subject.trim()) {
      return res.status(400).json({ error: 'Subject is required.' });
    }

    if (!body || typeof body !== 'string' || !body.trim()) {
      return res.status(400).json({ error: 'Email content/body is required.' });
    }

    const results = [];
    let accountIndex = 0;

    // Iterate through recipients and send using rotating sender accounts
    for (let i = 0; i < recipientList.length; i++) {
      const recipient = recipientList[i];
      const account = senderAccounts[accountIndex % senderAccounts.length];
      accountIndex++;

      const senderEmail = account.email || account.user;
      const senderPassword = account.appPassword || account.pass || account.password;

      if (!senderEmail || !senderPassword) {
        results.push({
          recipient,
          sender: senderEmail || 'unknown',
          status: 'failed',
          error: 'Sender account is missing email or App Password.',
        });
        continue;
      }

      // Configure transport for Gmail / SMTP with optimized deliverability and timeouts
      const isGmail = (account.service === 'gmail' || !account.host || String(account.host).includes('gmail'));
      
      const transporter = nodemailer.createTransport({
        service: account.service || (isGmail ? 'gmail' : undefined),
        host: account.host || (isGmail ? 'smtp.gmail.com' : undefined),
        port: account.port ? Number(account.port) : (isGmail ? 465 : 587),
        secure: account.secure !== undefined ? Boolean(account.secure) : (account.port === 465 || isGmail),
        auth: {
          user: senderEmail,
          pass: senderPassword,
        },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
      });

      const mailOptions = {
        from: account.senderName ? `"${account.senderName}" <${senderEmail}>` : senderEmail,
        to: recipient,
        subject: subject,
        [isHtml ? 'html' : 'text']: body,
        replyTo: senderEmail,
        headers: {
          'X-Mailer': 'Nodemailer Multi-Sender',
        },
      };

      try {
        const info = await transporter.sendMail(mailOptions);
        results.push({
          recipient,
          sender: senderEmail,
          status: 'success',
          messageId: info.messageId,
        });
      } catch (err) {
        results.push({
          recipient,
          sender: senderEmail,
          status: 'failed',
          error: err instanceof Error ? err.message : 'Failed to send email',
        });
      }

      // Add controlled throttling delay between emails (bounded to prevent Vercel timeout)
      if (i < recipientList.length - 1 && delayMs > 0) {
        const safeDelay = Math.min(Math.max(Number(delayMs), 50), 3000);
        await new Promise((resolve) => setTimeout(resolve, safeDelay));
      }
    }

    const successCount = results.filter((r) => r.status === 'success').length;
    const failedCount = results.filter((r) => r.status === 'failed').length;

    return res.json({
      message: 'Batch processing completed',
      total: recipientList.length,
      successCount,
      failedCount,
      results,
    });
  } catch (error) {
    console.error('Error during email dispatch:', error);
    return res.status(500).json({
      error: 'Server error processing email request: ' + (error instanceof Error ? error.message : String(error)),
    });
  }
});

// Serve Static Files and Root Handler
const distPath = path.join(process.cwd(), 'dist');
const publicPath = path.join(process.cwd(), 'public');

if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}
if (fs.existsSync(publicPath)) {
  app.use(express.static(publicPath));
}

// Global Catch-all Error Handler
app.use((err, req, res, next) => {
  console.error('Global Server Error:', err);
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

// Fallback Route Handler for GET *
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
          body { font-family: sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem; display: flex; justify-content: center; align-items: center; min-height: 80vh; }
          .card { background: #1e293b; border: 1px solid #334155; padding: 2rem; border-radius: 12px; max-width: 600px; width: 100%; text-align: center; }
          h1 { color: #38bdf8; margin-top: 0; }
          code { background: #0f172a; color: #a5f3fc; padding: 4px 8px; border-radius: 4px; font-size: 0.9em; }
          .status { color: #4ade80; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Bulk Email Sender API</h1>
          <p>Status: <span class="status">Online & Ready</span></p>
          <p>Endpoints:</p>
          <p><code>GET /api/health</code> - Check server health</p>
          <p><code>POST /api/send-emails</code> - Send bulk emails via Gmail App Passwords</p>
        </div>
      </body>
    </html>
  `);
});

// If running in traditional Node server environment (not Vercel serverless)
if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

export default app;

