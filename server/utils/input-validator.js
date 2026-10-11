// Input validation utilities.
// Every function returns a ValidationResult: { isValid: boolean, errors: string[] }.

const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const URL_RE = /^https?:\/\/[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*(?::\d{1,5})?(?:\/[^\s]*)?$/;

export function validateEmail(email) {
  const errors = [];
  if (typeof email !== 'string' || email.trim().length === 0) {
    errors.push('Email is required.');
    return { isValid: false, errors };
  }
  const trimmed = email.trim();
  if (trimmed.length > 254) errors.push('Email must not exceed 254 characters.');
  if (!EMAIL_RE.test(trimmed)) errors.push('Email format is invalid.');
  const parts = trimmed.split('@');
  if (parts.length === 2) {
    if (parts[0].length > 64) errors.push('Email local part must not exceed 64 characters.');
    if (!parts[1].includes('.')) errors.push('Email domain must contain at least one dot.');
  }
  return { isValid: errors.length === 0, errors };
}

export function validatePassword(password, options = {}) {
  const {
    minLength = 8,
    requireUppercase = true,
    requireLowercase = true,
    requireNumbers = true,
    requireSpecialChars = true
  } = options;
  const errors = [];
  if (typeof password !== 'string' || password.length === 0) {
    errors.push('Password is required.');
    return { isValid: false, errors };
  }
  if (password.length < minLength) errors.push(`Password must be at least ${minLength} characters.`);
  if (requireUppercase && !/[A-Z]/.test(password)) errors.push('Password must contain at least one uppercase letter.');
  if (requireLowercase && !/[a-z]/.test(password)) errors.push('Password must contain at least one lowercase letter.');
  if (requireNumbers && !/\d/.test(password)) errors.push('Password must contain at least one number.');
  if (requireSpecialChars && !/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(password)) {
    errors.push('Password must contain at least one special character.');
  }
  return { isValid: errors.length === 0, errors };
}

const PHONE_PATTERNS = {
  US: { re: /^(?:1)?\d{10}$/, label: 'US' },
  PH: { re: /^(?:63)?\d{10}$/, label: 'PH' },
  UK: { re: /^(?:44)?\d{10,11}$/, label: 'UK' },
  DEFAULT: { re: /^\d{7,15}$/, label: 'international' }
};

export function validatePhoneNumber(phone, countryCode) {
  const errors = [];
  if (typeof phone !== 'string' || phone.trim().length === 0) {
    errors.push('Phone number is required.');
    return { isValid: false, errors };
  }
  // Strip spaces, dashes, parentheses and leading '+'
  const cleaned = phone.replace(/[\s\-().]/g, '');
  const digits = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;

  const key = typeof countryCode === 'string' ? countryCode.toUpperCase() : null;
  const pattern = (key && PHONE_PATTERNS[key]) || PHONE_PATTERNS.DEFAULT;
  if (!pattern.re.test(digits)) {
    errors.push(`Phone number is not a valid ${pattern.label} number.`);
  }
  return { isValid: errors.length === 0, errors };
}

export function validateURL(url) {
  const errors = [];
  if (typeof url !== 'string' || url.trim().length === 0) {
    errors.push('URL is required.');
    return { isValid: false, errors };
  }
  const trimmed = url.trim();
  if (trimmed.length > 2083) errors.push('URL must not exceed 2083 characters.');
  if (!URL_RE.test(trimmed)) errors.push('URL format is invalid. Must start with http:// or https://.');
  return { isValid: errors.length === 0, errors };
}

const DATE_FORMATS = {
  'YYYY-MM-DD': {
    re: /^(\d{4})-(\d{2})-(\d{2})$/,
    parse: (m) => ({ year: +m[1], month: +m[2], day: +m[3] })
  },
  'MM/DD/YYYY': {
    re: /^(\d{2})\/(\d{2})\/(\d{4})$/,
    parse: (m) => ({ year: +m[3], month: +m[1], day: +m[2] })
  },
  'DD/MM/YYYY': {
    re: /^(\d{2})\/(\d{2})\/(\d{4})$/,
    parse: (m) => ({ year: +m[3], month: +m[2], day: +m[1] })
  }
};

export function validateDate(date, format = 'YYYY-MM-DD') {
  const errors = [];
  if (typeof date !== 'string' || date.trim().length === 0) {
    errors.push('Date is required.');
    return { isValid: false, errors };
  }
  const spec = DATE_FORMATS[format];
  if (!spec) {
    errors.push(`Unsupported date format: ${format}.`);
    return { isValid: false, errors };
  }
  const match = spec.re.exec(date.trim());
  if (!match) {
    errors.push(`Date must match format ${format}.`);
    return { isValid: false, errors };
  }
  const { year, month, day } = spec.parse(match);
  if (month < 1 || month > 12) errors.push('Month must be between 1 and 12.');
  if (day < 1 || day > 31) errors.push('Day must be between 1 and 31.');
  if (month >= 1 && month <= 12 && day >= 1) {
    const maxDay = new Date(year, month, 0).getDate();
    if (day > maxDay) errors.push(`Day must not exceed ${maxDay} for month ${month}.`);
  }
  return { isValid: errors.length === 0, errors };
}
