import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateEmail,
  validatePassword,
  validatePhoneNumber,
  validateURL,
  validateDate
} from '../utils/input-validator.js';

test('validateEmail validates email addresses correctly', () => {
  // Valid emails
  assert.equal(validateEmail('test@example.com').isValid, true);
  assert.equal(validateEmail('user.name+tag@sub.domain.org').isValid, true);

  // Invalid emails
  assert.equal(validateEmail('').isValid, false);
  assert.equal(validateEmail('   ').isValid, false);
  assert.equal(validateEmail('plain-string').isValid, false);
  assert.equal(validateEmail('missing-domain@').isValid, false);
  assert.equal(validateEmail('@missing-local.com').isValid, false);
  assert.equal(validateEmail('double@@example.com').isValid, false);
});

test('validatePassword validates password strength according to rules and options', () => {
  // Valid default password (min 8, upper, lower, number, special)
  const validResult = validatePassword('Password123!');
  assert.equal(validResult.isValid, true);
  assert.deepEqual(validResult.errors, []);

  // Too short
  const shortResult = validatePassword('Pass1!');
  assert.equal(shortResult.isValid, false);
  assert.ok(shortResult.errors.some(e => e.includes('at least 8 characters')));

  // Missing uppercase
  assert.equal(validatePassword('password123!').isValid, false);

  // Missing lowercase
  assert.equal(validatePassword('PASSWORD123!').isValid, false);

  // Missing number
  assert.equal(validatePassword('PasswordABC!').isValid, false);

  // Missing special char
  assert.equal(validatePassword('Password123').isValid, false);

  // Custom options
  const customOptions = { minLength: 6, requireUppercase: false, requireLowercase: false, requireSpecialChars: false };
  assert.equal(validatePassword('abc12345', customOptions).isValid, true);
  assert.equal(validatePassword('abc', customOptions).isValid, false);
});

test('validatePhoneNumber validates phone numbers across country formats', () => {
  // Valid US
  assert.equal(validatePhoneNumber('5551234567', 'US').isValid, true);
  assert.equal(validatePhoneNumber('(555) 123-4567', 'US').isValid, true);
  assert.equal(validatePhoneNumber('+15551234567', 'US').isValid, true);

  // Invalid US
  assert.equal(validatePhoneNumber('12345', 'US').isValid, false);

  // Valid PH
  assert.equal(validatePhoneNumber('9171234567', 'PH').isValid, true);
  assert.equal(validatePhoneNumber('+639171234567', 'PH').isValid, true);

  // Default international
  assert.equal(validatePhoneNumber('+442079460901').isValid, true);
  assert.equal(validatePhoneNumber('invalid-phone').isValid, false);
});

test('validateURL validates URL format', () => {
  // Valid URLs
  assert.equal(validateURL('https://example.com').isValid, true);
  assert.equal(validateURL('http://localhost:3000/path?query=1').isValid, true);

  // Invalid URLs
  assert.equal(validateURL('').isValid, false);
  assert.equal(validateURL('ftp://example.com').isValid, false);
  assert.equal(validateURL('not-a-url').isValid, false);
});

test('validateDate validates date strings across formats and calendar rules', () => {
  // Valid YYYY-MM-DD
  assert.equal(validateDate('2026-10-12').isValid, true);
  // Invalid calendar date (Feb 30)
  assert.equal(validateDate('2026-02-30').isValid, false);
  // Invalid month
  assert.equal(validateDate('2026-13-01').isValid, false);
  // Wrong format
  assert.equal(validateDate('12-10-2026', 'YYYY-MM-DD').isValid, false);

  // Valid MM/DD/YYYY
  assert.equal(validateDate('10/12/2026', 'MM/DD/YYYY').isValid, true);
  assert.equal(validateDate('02/29/2024', 'MM/DD/YYYY').isValid, true); // Leap year
  assert.equal(validateDate('02/29/2025', 'MM/DD/YYYY').isValid, false); // Non-leap year

  // Valid DD/MM/YYYY
  assert.equal(validateDate('12/10/2026', 'DD/MM/YYYY').isValid, true);
  assert.equal(validateDate('31/01/2026', 'DD/MM/YYYY').isValid, true);
  assert.equal(validateDate('31/04/2026', 'DD/MM/YYYY').isValid, false); // April has 30 days
});
