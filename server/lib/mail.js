async function sendBrevoEmail(to, subject, htmlContent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': process.env.BREVO_API_KEY,
      },
      body: JSON.stringify({
        sender: { name: 'CPRI', email: process.env.BREVO_SENDER_EMAIL },
        to: [{ email: to }],
        subject,
        htmlContent,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Brevo ${res.status}: ${await res.text()}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function sendResetEmail(email, token, baseUrl) {
  const link = `${baseUrl}/reset.html?token=${encodeURIComponent(token)}`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #e2e8f0;border-radius:8px;">
    <h2 style="margin-top:0;color:#0f172a;">${process.env.MAIL_FROM_NAME || 'CPRI'} — Password Reset</h2>
    <p style="color:#334155;">You requested a password reset for your CPRI account. Click the button below to choose a new password.</p>
    <p style="text-align:center;margin:24px 0;">
      <a href="${link}" style="display:inline-block;background:#1e3a8a;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;">Reset Password</a>
    </p>
    <p style="color:#94a3b8;font-size:12px;margin-top:20px;">This link expires in 1 hour. If you did not request this, you can safely ignore this email.</p>
  </div>`;

  try {
    await sendBrevoEmail(email, 'Reset Your CPRI Password', html);
    console.log('[mail] password reset email sent to', email);
  } catch (err) {
    console.error('[mail] password reset email failed for', email, ':', err.message);
  }
}

export async function sendVerificationEmail(to, code) {
  await sendBrevoEmail(
    to,
    'Your CPRI verification code',
    `<p>Your verification code is <b>${code}</b>.</p><p>It expires in 10 minutes.</p>`
  );
  console.log('[mail] verification email sent to', to);
}
