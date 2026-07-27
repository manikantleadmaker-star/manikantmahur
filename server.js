import express from 'express';
import cors from 'cors';
import nodemailer from 'nodemailer';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Health Check Endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Single or Bulk Email Dispatch API Endpoint
app.post('/api/send-emails', async (req, res) => {
  try {
    const { accounts, recipients, subject, body, isHtml = false, delayMs = 1000 } = req.body;

    // Validation
    if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
      return res.status(400).json({
        error: 'At least one sender account (email/user and appPassword/pass) is required.',
      });
    }

    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
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
    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i];
      const account = accounts[accountIndex % accounts.length];
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

      // Configure transport for current sender account
      const transporter = nodemailer.createTransport({
        service: account.service || 'gmail',
        host: account.host || 'smtp.gmail.com',
        port: account.port ? Number(account.port) : 465,
        secure: account.secure !== undefined ? Boolean(account.secure) : true,
        auth: {
          user: senderEmail,
          pass: senderPassword,
        },
        connectionTimeout: 10000,
      });

      const mailOptions = {
        from: account.senderName ? `"${account.senderName}" <${senderEmail}>` : senderEmail,
        to: recipient,
        subject: subject,
        [isHtml ? 'html' : 'text']: body,
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

      // Add controlled throttling delay between emails
      if (i < recipients.length - 1 && delayMs > 0) {
        const safeDelay = Math.min(Math.max(Number(delayMs), 100), 10000);
        await new Promise((resolve) => setTimeout(resolve, safeDelay));
      }
    }

    const successCount = results.filter((r) => r.status === 'success').length;
    const failedCount = results.filter((r) => r.status === 'failed').length;

    return res.json({
      message: 'Batch processing completed',
      total: recipients.length,
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

// Start Express Server with Vite Dev / Prod Static Handling
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
