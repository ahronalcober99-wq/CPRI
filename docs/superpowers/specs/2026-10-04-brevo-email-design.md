# Brevo Email Delivery Design

## Goal

Replace outbound Gmail SMTP delivery with Brevo's HTTPS API so email delivery
works from Render's free tier without exposing verification codes in logs.

## Scope and behavior

- Send verification email through `https://api.brevo.com/v3/smtp/email` using
  the built-in Node.js `fetch`, `BREVO_API_KEY`, and `BREVO_SENDER_EMAIL`.
- Retain the current six-digit verification-code generation and 10-minute
  expiry. If email delivery fails, remove the pending code and return an
  explicit HTTP 500 response with `{ ok: false, message }`.
- Return `{ ok: true, message }` after successful verification-email delivery;
  leave the separate code-verification endpoint response unchanged.
- Move password-reset email delivery to Brevo as well. Preserve the
  forgot-password route's generic response and avoid logging reset links.
- Remove Gmail SMTP startup diagnostics and replace them with boolean-only
  Brevo configuration diagnostics.
- Remove logs containing verification codes, including mismatch diagnostics.
- Update the registration UI to handle unsuccessful HTTP responses and
  `{ ok: false }` errors, restore the send button after failure, and abort the
  request after 60 seconds.
- Update the standalone mail test utilities to use Brevo and remove Nodemailer
  from the dependency manifest and lockfile.

## Error handling

Brevo non-2xx responses and request failures must reject the send operation.
Verification delivery errors are logged without code values and reported to
the registration client with a generic retry message. Password-reset delivery
failures remain non-enumerating to callers and are logged without reset URLs.
Frontend timeout and connection failures are shown to the user and restore the
send-code button.

## Validation

Check the edited JavaScript for syntax errors, run available targeted project
checks, and search for remaining Gmail SMTP/Nodemailer code and any
verification-code logging. Confirm the lockfile no longer declares Nodemailer.
