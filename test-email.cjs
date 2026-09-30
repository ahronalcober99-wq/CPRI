// Standalone Gmail test — CommonJS version (works with `require`).
// Run: node test-email.cjs
// Sends one test email to the GMAIL_USER address to isolate whether
// Gmail/credentials are the problem vs. the app request flow.
require('dotenv').config();
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// Startup check: does Gmail accept our credentials?
transporter.verify((err, success) => {
  if (err) console.error('❌ Gmail auth failed:', err);
  else console.log('✅ Gmail SMTP ready');
});

transporter.sendMail({
  from: process.env.GMAIL_USER,
  to: process.env.GMAIL_USER, // send to yourself first
  subject: 'Test email',
  text: 'If you got this, Gmail sending works.',
}, (err, info) => {
  if (err) return console.error('❌ FAILED:', err);
  console.log('✅ SENT:', info.response);
});
