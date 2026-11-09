// The one place the backend sends email (OTP codes, corporate registration links).
//
// EMAIL_PROVIDER = smtp | console
//   smtp    — any mail server; for Google Workspace use smtp.gmail.com:465 with an App
//             Password (SMTP_USER / SMTP_PASS). EMAIL_FROM sets the sender shown.
//   console — prints the email to the server log for local testing; refused when
//             NODE_ENV=production.
// Blank = smtp if SMTP_USER/SMTP_PASS are set, else console.
//
// A message with `sensitive: true` carries a secret (e.g. a one-time invitation link). The
// console provider never prints its content - only the recipient and subject - so a secret
// cannot end up in a server log or terminal scrollback. SMTP sends it normally.
//
// Switching sender (e.g. crm@ -> a real noreply@ mailbox later) is only an .env change.
const nodemailer = require('nodemailer');

function providerName() {
  if (process.env.EMAIL_PROVIDER) return process.env.EMAIL_PROVIDER;
  return process.env.SMTP_USER && process.env.SMTP_PASS ? 'smtp' : 'console';
}

let transport = null;
function smtpTransport() {
  if (!transport) {
    const { SMTP_HOST = 'smtp.gmail.com', SMTP_PORT = '465', SMTP_USER, SMTP_PASS } = process.env;
    if (!SMTP_USER || !SMTP_PASS) throw new Error('SMTP_USER / SMTP_PASS is not set');
    transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465, // 465 = TLS from the start; 587 upgrades via STARTTLS
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return transport;
}

const providers = {
  async smtp({ to, subject, text, html }) {
    await smtpTransport().sendMail({ from: process.env.EMAIL_FROM || process.env.SMTP_USER, to, subject, text, html });
  },
  // Development only — never reachable in production (see sendMail).
  async console({ to, subject, text, sensitive }) {
    const body = sensitive === true ? '[content hidden: sensitive message]' : text;
    console.log(`[DEV ONLY — no email provider configured] to ${to} | ${subject}\n${body}`);
  },
};

async function sendMail(message) {
  const name = providerName();
  if (name === 'console' && process.env.NODE_ENV === 'production') {
    throw new Error('Email provider is "console" in production — set SMTP_USER / SMTP_PASS');
  }
  const provider = providers[name];
  if (!provider) throw new Error(`Unknown EMAIL_PROVIDER "${name}"`);
  await provider(message);
}

module.exports = { sendMail };
