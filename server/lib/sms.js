// ============================================================
//  CPRI — SMS delivery wrapper
//
//  One entry point (sendSms) with swappable providers chosen by
//  environment variables, so the gateway can change without
//  touching the verification logic:
//
//    SMS_PROVIDER=semaphore | philsms | twilio | vonage | console
//    SMS_DEV_MODE=1            → print the message to the server console
//
//  With no provider configured the wrapper falls back to console
//  mode, so phone verification is fully testable without credits.
//  No key is ever hardcoded — see .env.example.
// ============================================================

const REQUEST_TIMEOUT_MS = 10000;

const PROVIDERS = {
  semaphore: {
    label: 'Semaphore',
    requiredEnv: ['SEMAPHORE_API_KEY'],
    async send({ to, message }) {
      const body = new URLSearchParams({
        apikey: process.env.SEMAPHORE_API_KEY,
        number: to,
        message
      });
      if (process.env.SEMAPHORE_SENDER_NAME) body.set('sendername', process.env.SEMAPHORE_SENDER_NAME);
      const res = await fetch('https://api.semaphore.co/api/v4/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Semaphore ${res.status}: ${text}`);
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new Error(`Semaphore returned an unexpected response: ${text}`); }
      // Success is a JSON array of queued messages; anything else is a failure
      // (e.g. insufficient credits or a rejected number).
      if (!Array.isArray(parsed) || !parsed.length || !parsed[0].message_id) {
        throw new Error(`Semaphore rejected the message: ${text}`);
      }
      return { id: String(parsed[0].message_id) };
    }
  },
  philsms: {
    label: 'PhilSMS',
    requiredEnv: ['PHILSMS_API_TOKEN'],
    async send({ to, message }) {
      const res = await fetch('https://app.philsms.com/api/v3/sms/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.PHILSMS_API_TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          recipient: to.replace(/^\+/, ''),
          sender_id: process.env.PHILSMS_SENDER_ID || 'PhilSMS',
          type: 'plain',
          message
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`PhilSMS ${res.status}: ${text}`);
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new Error(`PhilSMS returned an unexpected response: ${text}`); }
      if (String(parsed.status || '').toLowerCase() !== 'success') {
        throw new Error(`PhilSMS rejected the message: ${text}`);
      }
      return { id: parsed.data?.uid ? String(parsed.data.uid) : undefined };
    }
  },
  twilio: {
    label: 'Twilio',
    requiredEnv: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'],
    async send({ to, message }) {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          To: to,
          From: process.env.TWILIO_FROM_NUMBER,
          Body: message
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Twilio ${res.status}: ${text}`);
      const parsed = JSON.parse(text);
      return { id: parsed.sid ? String(parsed.sid) : undefined };
    }
  },
  vonage: {
    label: 'Vonage',
    requiredEnv: ['VONAGE_API_KEY', 'VONAGE_API_SECRET'],
    async send({ to, message }) {
      const res = await fetch('https://rest.nexmo.com/sms/json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          api_key: process.env.VONAGE_API_KEY,
          api_secret: process.env.VONAGE_API_SECRET,
          to: to.replace(/^\+/, ''),
          from: process.env.VONAGE_FROM || 'CPRI',
          text: message,
          type: 'unicode'
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Vonage ${res.status}: ${text}`);
      const parsed = JSON.parse(text);
      const first = parsed.messages && parsed.messages[0];
      // Vonage answers HTTP 200 even for failures; status "0" means accepted.
      if (!first || String(first.status) !== '0') {
        throw new Error(`Vonage rejected the message: ${text}`);
      }
      return { id: first['message-id'] ? String(first['message-id']) : undefined };
    }
  }
};

const CONSOLE_PROVIDER = { id: 'console', label: 'Console (development mode)' };

// Which provider would be used right now, and is it usable?
export function smsProviderInfo(env = process.env) {
  const requested = String(env.SMS_PROVIDER || '').trim().toLowerCase();
  const devForced = env.SMS_DEV_MODE === '1' || env.SMS_DEV_MODE === 'true';

  if (devForced || requested === 'console' || requested === 'dev' || requested === 'development') {
    return { ...CONSOLE_PROVIDER, configured: true, dev: true };
  }
  if (requested) {
    const provider = PROVIDERS[requested];
    if (!provider) {
      return {
        id: requested,
        label: requested,
        configured: false,
        missing: [],
        error: `Unknown SMS_PROVIDER "${requested}". Use semaphore, philsms, twilio, vonage or console.`
      };
    }
    const missing = provider.requiredEnv.filter((key) => !env[key]);
    return { id: requested, label: provider.label, configured: missing.length === 0, missing };
  }
  // No explicit choice: first fully-configured provider wins, otherwise dev.
  const found = Object.entries(PROVIDERS).find(([, provider]) => provider.requiredEnv.every((key) => env[key]));
  if (found) return { id: found[0], label: found[1].label, configured: true, missing: [] };
  return { ...CONSOLE_PROVIDER, configured: true, dev: true, autoDev: true };
}

/**
 * Send an SMS through the configured provider.
 * Never logs message bodies for real providers (they carry verification codes).
 * @returns {Promise<{provider: string, id?: string, dev?: boolean}>}
 */
export async function sendSms(phone, message, env = process.env) {
  const info = smsProviderInfo(env);

  if (info.id === 'console') {
    // DEV mode: the code is printed so the flow can be tested without credits.
    console.log(`[sms][dev] ${phone} ← ${message}`);
    return { provider: 'console', dev: true };
  }
  if (!info.configured) {
    throw new Error(
      info.error || `SMS provider ${info.label} is not configured (missing ${info.missing.join(', ')})`
    );
  }

  const result = await PROVIDERS[info.id].send({ to: phone, message });
  console.log(`[sms] message accepted by ${info.label} for ${phone.replace(/^(\+63)\d{6}/, '$1******')}`);
  return { provider: info.id, ...result };
}
