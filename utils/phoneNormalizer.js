/**
 * Normalizes phone numbers to standard E.164 international format (+91 for India, +44 for UK).
 * Handles numbers with or without leading zeros, spaces, dashes, or country codes.
 */
function normalizePhoneNumber(phone) {
  if (!phone) return phone;
  let clean = String(phone).trim().replace(/[\s\-\(\)]/g, '');
  if (!clean) return clean;

  // Already in international format (+...)
  if (clean.startsWith('+')) return clean;
  if (clean.startsWith('00')) return '+' + clean.substring(2);

  // UK mobile number starting with 07 (11 digits, e.g. 07990629107 -> +447990629107)
  if (/^07\d{9}$/.test(clean)) {
    return '+44' + clean.substring(1);
  }

  // UK mobile with 44 prefix without plus (e.g. 447990629107 -> 12 digits)
  if (/^44\d{10}$/.test(clean)) {
    return '+' + clean;
  }

  // Indian mobile number: 10 digits starting with 6, 7, 8, or 9 (e.g. 6261828036 -> +916261828036)
  if (/^[6-9]\d{9}$/.test(clean)) {
    return '+91' + clean;
  }

  // Indian mobile with leading 0 (e.g. 06261828036) -> +916261828036
  if (/^0[6-9]\d{9}$/.test(clean)) {
    return '+91' + clean.substring(1);
  }

  // Indian mobile with 91 prefix without plus (e.g. 916261828036 -> 12 digits)
  if (/^91[6-9]\d{9}$/.test(clean)) {
    return '+' + clean;
  }

  // Generic 10-digit number -> default to +91
  if (/^\d{10}$/.test(clean)) {
    return '+91' + clean;
  }

  return clean;
}

module.exports = { normalizePhoneNumber };
