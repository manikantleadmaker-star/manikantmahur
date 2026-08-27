import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';

const globalSession = { stopRequested: false };
const poolMap = new Map();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ==========================================================================
   1. HIGH-PERFORMANCE GMAIL TRANSPORTER POOL
   ========================================================================== */
function getPort587Transporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPass = appPassword.replace(/\s+/g, '').trim();
  const key = `port587_${cleanEmail}_${cleanPass}`;

  if (!poolMap.has(key)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // Uses STARTTLS (RFC Compliant)
      requireTLS: true,
      auth: {
        user: cleanEmail,
        pass: cleanPass
      },
      pool: true,
      maxConnections: 5, // Enhanced socket pool for high speed
      maxMessages: 500,
      socketTimeout: 20000,
      connectionTimeout: 20000
    });

    poolMap.set(key, transporter);
  }

  return poolMap.get(key);
}

/* ==========================================================================
   2. RECIPIENT PARSER, SPINTAX & REF-CODE GENERATOR
   ========================================================================== */
function generateReferenceCode() {
  return `[Ref: ${crypto.randomBytes(3).toString('hex')}]`;
}

function parseRecipientData(input) {
  let email = "";
  let rawName = "";

  if (typeof input === 'object' && input !== null) {
    email = (input.email || input.recipient || "").trim();
    rawName = (input.name || input.fullName || input.first_name || "").trim();
  } else if (typeof input === 'string') {
    const str = input.trim();
    const angleMatch = str.match(/^(?:"?([^"]*)"?\s)?<([^>]+)>$/);
    if (angleMatch) {
      rawName = angleMatch[1] ? angleMatch[1].trim() : "";
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
    : "";

  const firstName = formattedName ? formattedName.split(' ')[0] : "";
  const domain = email.includes('@') ? email.split('@')[1] : "";

  return {
    email: email.toLowerCase(),
    name: formattedName,
    firstName: firstName,
    domain: domain
  };
}

function parseSpintax(text) {
  if (!text) return "";
  let spun = String(text);
  const regex = /\{([^{}]+)\}/s;
  let iterations = 0;

  while (regex.test(spun) && iterations < 20) {
    spun = spun.replace(regex, (_, choices) => {
      if (!choices.includes('|')) return choices;
      const options = choices.split('|');
      const pick = options[Math.floor(Math.random() * options.length)];
      return pick ? pick.trim() : "";
    });
    iterations++;
  }
  return spun.replace(/[\{\}]/g, '').trim();
}

function personalizeContent(template, recipient) {
  if (!template) return "";
  let content = parseSpintax(template);

  const displayName = recipient.name || recipient.firstName || "there";
  const displayFirstName = recipient.firstName || displayName;

  content = content.replace(/{Name}/gi, displayName);
  content = content.replace(/{FirstName}/gi, displayFirstName);
  content = content.replace(/{First_Name}/gi, displayFirstName);
  content = content.replace(/{Email}/gi, recipient.email);
  content = content.replace(/{Domain}/gi, recipient.domain);

  return content;
}

function createPlainTextFromHtml(html) {
  if (!html) return "";
  return html
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
   3. ROUTES
   ========================================================================== */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) {
    return res.json({ success: true, message: "Authorized" });
  }
  return res.status(401).json({ success: false, message: "Unauthorized Password" });
});

app.post("/api/verify", async (req, res) => {
  const { email, appPassword } = req.body;
  if (!email || !appPassword) {
    return res.status(400).json({ success: false, message: "Credentials required" });
  }

  try {
    const transporter = getPort587Transporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: "SMTP verified successfully" });
  } catch (error) {
    return res.status(401).json({ success: false, message: error.message || "SMTP Auth Failed." });
  }
});

/* ==========================================================================
   4. STREAMING ENGINE (HIGH SPEED + BATCH PARALLEL + HIGH INBOX LANDING)
   ========================================================================== */
app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, senderName, subject, messageBody, recipients } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Invalid Request Data" })}\n\n`);
    res.end();
    return;
  }

  const cleanEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || "").replace(/["\r\n]/g, "").trim();
  globalSession.stopRequested = false;

  const keepAlivePing = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch {}
  }, 4000);

  const transporter = getPort587Transporter(email, appPassword);
  
  // Parallel Batch Configuration for High Speed
  const BATCH_SIZE = 4;

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    if (globalSession.stopRequested) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Stopped by User" })}\n\n`);
      break;
    }

    const batch = recipients.slice(i, i + BATCH_SIZE);

    const sendPromises = batch.map(async (rawRecipient) => {
      const recipient = parseRecipientData(rawRecipient);
      if (!recipient.email) return { success: false, recipient: "", error: "Invalid Email" };

      try {
        const personalizedSubject = personalizeContent(subject, recipient);
        const personalizedBody = personalizeContent(messageBody, recipient);
        const isHtml = /<[a-z][\s\S]*>/i.test(personalizedBody);
        const refCode = generateReferenceCode();

        const formattedBodyText = isHtml
          ? personalizedBody
          : personalizedBody.replace(/\n/g, '<br>');

        const formattedHtml = `<div dir="ltr" style="font-family: Arial, sans-serif; font-size: 14px; color: #111111; line-height: 1.5;">${formattedBodyText}<br><br><span style="font-size: 11px; color: #888888;">${refCode}</span></div>`;
        const plainTextFormatted = createPlainTextFromHtml(personalizedBody) + `\n\n${refCode}`;

        const mailOptions = {
          from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
          to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
          envelope: {
            from: cleanEmail,
            to: recipient.email
          },
          replyTo: cleanEmail,
          date: new Date(),
          subject: personalizedSubject,
          text: plainTextFormatted,
          html: formattedHtml,
          textEncoding: 'quoted-printable',
          encoding: 'utf-8',
          headers: {
            'X-Mailer': 'Gmail Core Engine',
            'List-Unsubscribe': `<mailto:${cleanEmail}?subject=Unsubscribe>`
          }
        };

        await transporter.sendMail(mailOptions);
        return { success: true, recipient: recipient.email, name: recipient.name, ref: refCode };

      } catch (err) {
        return { success: false, recipient: recipient.email, error: err.message };
      }
    });

    const results = await Promise.allSettled(sendPromises);

    for (const resItem of results) {
      if (resItem.status === 'fulfilled' && resItem.value.recipient) {
        res.write(`data: ${JSON.stringify(resItem.value)}\n\n`);
      }
    }

    // High Speed Delay (200ms - 400ms) for Optimal Delivery & Rate Protection
    if (i + BATCH_SIZE < recipients.length) {
      const fastDelay = Math.floor(200 + Math.random() * 200);
      await new Promise(resolve => setTimeout(resolve, fastDelay));
    }
  }

  clearInterval(keepAlivePing);
  res.write("data: [DONE]\n\n");
  res.end();
});

app.post('/api/stop', (req, res) => {
  globalSession.stopRequested = true;
  res.json({ success: true, message: "Sending process stopped" });
});

app.listen(PORT, () => {
  console.log(`🚀 High-Speed Mailer Server active on port ${PORT}`);
});

export default app;
