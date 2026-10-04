require('dotenv').config();

const hasApiKey = Boolean(process.env.BREVO_API_KEY);
const hasSenderEmail = Boolean(process.env.BREVO_SENDER_EMAIL);
console.log('[test-email] BREVO_API_KEY set:', hasApiKey);
console.log('[test-email] BREVO_SENDER_EMAIL set:', hasSenderEmail);

if (!hasApiKey || !hasSenderEmail) {
  console.error('BREVO_API_KEY and BREVO_SENDER_EMAIL must be set.');
  process.exit(1);
}

const recipient = process.argv[2] || process.env.BREVO_SENDER_EMAIL;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 10000);

fetch('https://api.brevo.com/v3/smtp/email', {
  method: 'POST',
  headers: {
    accept: 'application/json',
    'content-type': 'application/json',
    'api-key': process.env.BREVO_API_KEY,
  },
  body: JSON.stringify({
    sender: { name: 'CPRI', email: process.env.BREVO_SENDER_EMAIL },
    to: [{ email: recipient }],
    subject: 'CPRI Test Email',
    htmlContent: '<p>If you can read this, Brevo email delivery is working.</p>',
  }),
  signal: controller.signal,
})
  .then(async (res) => {
    if (!res.ok) {
      throw new Error(`Brevo ${res.status}: ${await res.text()}`);
    }
    console.log('[test-email] email sent to', recipient);
  })
  .catch((err) => {
    console.error('[test-email] failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(timer);
  });
