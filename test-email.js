#!/usr/bin/env node
/**
 * Standalone Gmail SMTP test — verifies that the Gmail credentials in .env
 * actually work and that an email can be delivered, independently of the
 * registration flow / API / frontend.
 *
 * Run:   node test-email.js [recipient@example.com]
 *
 * If no recipient is given, it sends to GMAIL_USER (the authenticated account)
 * so you can check the "Sent" folder / own inbox immediately.
 *
 * Expected output on success:
 *   [test-email] GMAIL_USER set: true
 *   [test-email] GMAIL_APP_PASSWORD set: true
 *   [test-email] Gmail SMTP auth: OK
 *   [test-email] mail sent → {
 *     "messageId": "<...@gmail.com>",
 *     "response": "250 2.0.0 OK  <...>",
 *     ...
 *   }
 */
import 'dotenv/config';
import nodemailer from 'nodemailer';

const hasUser = Boolean(process.env.GMAIL_USER);
const hasPass = Boolean(process.env.GMAIL_APP_PASSWORD);
console.log('[test-email] GMAIL_USER set:', hasUser);
console.log('[test-email] GMAIL_APP_PASSWORD set:', hasPass);

if (!hasUser || !hasPass) {
  console.error('❌ GMAIL_USER and/or GMAIL_APP_PASSWORD are missing in .env');
  console.error('   → Copy .env.example to .env and fill them in.');
  console.error('   → Remember: App Password requires 2-Step Verification enabled.');
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

const recipient = process.argv[2] || process.env.GMAIL_USER;
console.log('[test-email] Recipient:', recipient);

try {
  // 1) Verify the SMTP connection + auth
  console.log('[test-email] Verifying Gmail SMTP auth…');
  await transporter.verify();
  console.log('[test-email] Gmail SMTP auth: OK');

  // 2) Send a test message (blocking — awaits the SMTP response)
  const info = await transporter.sendMail({
    from: `"CPRI Test" <${process.env.GMAIL_USER}>`, // must match auth user
    to: recipient,
    subject: 'CPRI Test Email — Gmail SMTP is working',
    text: 'If you can read this, your Gmail App Password is working and email delivery is confirmed.',
    html: '<p><strong>CPRI Test Email</strong></p><p>If you can read this, your Gmail App Password is working and email delivery is confirmed.</p>'
  });

  console.log('[test-email] mail sent →', JSON.stringify({
    messageId: info.messageId,
    response: info.response,
    accepted: info.accepted,
    rejected: info.rejected,
    envelope: info.envelope
  }, null, 2));

  console.log('\n✅ SUCCESS. Check the inbox (and spam/junk folder) for the test email.');
  console.log('   messageId:', info.messageId);
} catch (err) {
  console.error('\n❌ FAILED to send test email.');
  console.error('Full error object:');
  console.error(err);
  if (err.response) console.error('SMTP response:', err.response);
  if (err.code === 'EAUTH') {
    console.error('\nPossible causes:');
    console.error('  1. 2-Step Verification is NOT enabled on the Google account.');
    console.error('     → Enable it, then create an App Password.');
    console.error('  2. GMAIL_APP_PASSWORD is not a real App Password.');
    console.error('     → Google Account → Security → App passwords.');
    console.error('  3. GMAIL_USER does not match the account that generated the App Password.');
  }
  process.exit(1);
}

