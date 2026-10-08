// ============================================================
//  CPRI — Philippine mobile number helpers
//
//  The profile page accepts the shapes people actually type
//  (09171234567, 9171234567, +639171234567, with or without
//  spaces / dashes / parentheses) and everything is stored in
//  E.164 (+639171234567) once verified.
//
//  Kept dependency-free and pure so both the API and the browser
//  bundle (public/assets/js/phone-field.js) can mirror the rules.
// ============================================================

// Accepts: 09XXXXXXXXX · 9XXXXXXXXX · 639XXXXXXXXX · +639XXXXXXXXX
// (separators are stripped first). Returns E.164 or null.
export function normalizePhone(input) {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim().replace(/[\s().\-]/g, '');
  if (!raw) return null;
  if (/^\+639\d{9}$/.test(raw)) return raw;            // +639171234567
  if (/^639\d{9}$/.test(raw)) return `+${raw}`;        // 639171234567
  if (/^09\d{9}$/.test(raw)) return `+63${raw.slice(1)}`; // 09171234567
  if (/^9\d{9}$/.test(raw)) return `+63${raw}`;        // 9171234567
  return null;
}

// E.164 → the local 10-digit form shown inside the "+63" prefixed field.
export function phoneNationalDigits(input) {
  const e164 = normalizePhone(input);
  return e164 ? e164.slice(3) : '';
}

// E.164 → "+63 917 *** 4567" for confirmations (never echoes the whole number).
export function maskPhone(input) {
  const e164 = normalizePhone(input);
  if (!e164) return String(input || '');
  const digits = e164.slice(3); // 9XXXXXXXXX
  return `+63 ${digits.slice(0, 3)} *** ${digits.slice(6)}`;
}
