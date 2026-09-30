import nodemailer from 'nodemailer';

// Gmail transporter used for verification codes AND password reset links.
// Configured via GMAIL_USER + GMAIL_APP_PASSWORD (NOT the raw account password).
// NOTE: this is built lazily (per send) so it always reads the CURRENT
// process.env after dotenv has been loaded at the entry point.
let gmailTransporter = null;

function hasGmailConfig() {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

function getGmailTransporter() {
  if (!hasGmailConfig()) return null;
  if (!gmailTransporter) {
    gmailTransporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      }
    });
  }
  return gmailTransporter;
}

/**
 * Verify the Gmail SMTP connection on startup so we can see immediately
 * whether the App Password is accepted (e.g. "Invalid login",
 * "Application-specific password required", etc.).
 */
export async function verifyGmailTransporter() {
  const t = getGmailTransporter();
  if (!t) {
    console.log('[mail] Gmail not configured (GMAIL_USER/GMAIL_APP_PASSWORD missing) — verification codes will be logged to console in DEV mode.');
    return;
  }
  try {
    await t.verify();
    console.log('✅ Gmail SMTP ready (auth OK)');
  } catch (err) {
    console.error('❌ Gmail auth failed:', err && (err.response || err.message || err.code || err));
    throw err;
  }
}

export async function sendResetEmail(email, token, baseUrl) {
  const link = `${baseUrl}/reset.html?token=${encodeURIComponent(token)}`;
  const text = `You requested a password reset for your CPRI account.\n\nReset your password here: ${link}\n\nIf you did not request this, you can ignore this email. This link expires in 1 hour.`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #e2e8f0;border-radius:8px;">
    <h2 style="margin-top:0;color:#0f172a;">${process.env.MAIL_FROM_NAME || 'CPRI'} — Password Reset</h2>
    <p style="color:#334155;">You requested a password reset for your CPRI account. Click the button below to choose a new password.</p>
    <p style="text-align:center;margin:24px 0;">
      <a href="${link}" style="display:inline-block;background:#1e3a8a;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;">Reset Password</a>
    </p>
    <p style="color:#94a3b8;font-size:12px;margin-top:20px;">This link expires in 1 hour. If you did not request this, you can safely ignore this email.</p>
  </div>`;

  if (!hasGmailConfig()) {
    // Dev fallback: no Gmail configured, print the link to the server console.
    console.log(`[DEV] Password reset link for ${email}: ${link}`);
    return;
  }

  const t = getGmailTransporter();
  const fromName = process.env.MAIL_FROM_NAME || 'CPRI';
  // from matches the authenticated account (GMAIL_USER) exactly — Gmail will
  // reject or flag a "from" that doesn't match the SMTP auth user.
  const from = `"${fromName}" <${process.env.GMAIL_USER}>`;
  try {
    // BLOCKING send: await the actual SMTP call and check the returned info.
    const info = await t.sendMail({
      from,
      to: email,
      subject: 'Reset Your CPRI Password',
      text,
      html
    });
    console.log('[mail] Password reset email SENT to', email, '→', JSON.stringify({
      messageId: info.messageId,
      response: info.response,
      accepted: info.accepted,
      rejected: info.rejected
    }));
    return info;
  } catch (err) {
    // Never fail the /forgot response: the endpoint intentionally returns the
    // same generic message for unknown emails, so a delivery failure must not
    // leak an account's existence or turn into a 500. Log the real SMTP error
    // plus the link so dev/ops can still help the user reset manually.
    console.error('[mail] Password reset email FAILED for', email, ':', err);
    console.log(`[DEV] Password reset link for ${email}: ${link}`);
  }
}

/**
 * Send a 6-digit verification code to the given email via Gmail.
 * Falls back to console.log in dev mode when Gmail is not configured.
 *
 * IMPORTANT: this is BLOCKING — it awaits sendMail() to completion and only
 * resolves after Gmail's SMTP server accepts the message. The caller returns
 * { success: true } only after this function resolves (no optimistic success).
 */
export async function sendVerificationCode(email, code) {
  const text = `Your CPRI email verification code is: ${code}\n\nThis code expires in 10 minutes.\n\nIf you did not request this code, please ignore this email.`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #e2e8f0;border-radius:8px;">
    <h2 style="margin-top:0;color:#0f172a;">${process.env.MAIL_FROM_NAME || 'CPRI'} — Email Verification</h2>
    <p style="color:#334155;">Use the code below to verify your email address. It expires in <strong>10 minutes</strong>.</p>
    <div style="background:#f1f5f9;border-radius:8px;padding:20px;text-align:center;font-size:28px;letter-spacing:8px;font-weight:700;color:#0f172a;">${code}</div>
    <p style="color:#94a3b8;font-size:12px;margin-top:20px;">If you did not request this code, you can safely ignore this email.</p>
  </div>`;

  if (!hasGmailConfig()) {
    // Dev fallback: print to console
    console.log(`[DEV] Verification code for ${email}: ${code}`);
    return;
  }

  const t = getGmailTransporter();
  const fromName = process.env.MAIL_FROM_NAME || 'CPRI';
  // from matches the authenticated account (GMAIL_USER) exactly — Gmail will
  // reject or flag a "from" that doesn't match the SMTP auth user.
  const from = `"${fromName}" <${process.env.GMAIL_USER}>`;
  try {
    // BLOCKING send: await the actual SMTP call and check the returned info.
    const info = await t.sendMail({
      from,
      to: email,
      subject: 'Your CPRI Verification Code', // clear, direct subject line
      text,
      html
    });
    // Log the FULL info object — messageId + Gmail SMTP response prove Gmail accepted it.
    console.log('[mail] Verification email SENT to', email, '→', JSON.stringify({
      messageId: info.messageId,
      response: info.response,
      accepted: info.accepted,
      rejected: info.rejected,
      envelope: info.envelope
    }, null, 2));
    return info;
  } catch (err) {
    // Surface the real Gmail error, not a generic message
    console.error('[mail] sendMail failed for', email, ':', err);
    throw err;
  }
}

