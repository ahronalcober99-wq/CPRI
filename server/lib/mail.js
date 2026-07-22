import nodemailer from 'nodemailer';

let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined
  });
}

export async function sendResetEmail(email, token, baseUrl) {
  const link = `${baseUrl}/reset.html?token=${encodeURIComponent(token)}`;
  const text = `You requested a password reset for your CPRI account.\n\nReset your password here: ${link}\n\nIf you did not request this, you can ignore this email. This link expires in 1 hour.`;

  if (!transporter) {
    // Dev fallback: no SMTP configured, print the link to the server console.
    console.log(`[DEV] Password reset link for ${email}: ${link}`);
    return;
  }

  await transporter.sendMail({
    from: process.env.MAIL_FROM || 'no-reply@cpri.edu',
    to: email,
    subject: 'CPRI Password Reset',
    text
  });
}
