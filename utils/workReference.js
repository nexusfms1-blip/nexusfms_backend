/**
 * Work Reference Builder
 *
 * Client-specified format (Nexus FMS):
 *   JOB REFERENCE/DOMAIN OF WHO SENT IT-FIRST HALF OF POSTCODE - MAX 4 WORDS OF WHAT JOB ENTITLES
 *
 * Example:
 *   ref: "WO-78123", sender: "lettings@foxtons.co.uk",
 *   address: "Flat 3B, West End Road, London W1D 3QF",
 *   issue: "Kitchen sink leaking water under cabinet"
 *   => "WO-78123/foxtons-W1D - Kitchen sink leaking water"
 */

// Second-level labels used before a country TLD (e.g. foxtons.co.uk, council.gov.uk)
const SECOND_LEVEL_LABELS = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'ltd', 'plc', 'me', 'sch', 'nhs', 'police', 'mod']);

/**
 * Extracts the organisation name from the sender's email domain.
 * "lettings@foxtons.co.uk" -> "foxtons", "john@mail.savills.com" -> "savills"
 */
const extractSenderDomain = (email, fallbackName = '') => {
  if (!email || typeof email !== 'string') {
    if (fallbackName) {
      return fallbackName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 15);
    }
    return '';
  }
  const match = email.match(/@([A-Za-z0-9.-]+)/);
  if (!match) return '';

  const labels = match[1].toLowerCase().replace(/\.+$/, '').split('.').filter(Boolean);
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];

  labels.pop(); // remove TLD (uk, com, ...)
  if (labels.length > 1 && SECOND_LEVEL_LABELS.has(labels[labels.length - 1])) {
    labels.pop(); // remove "co" in co.uk etc.
  }
  const extracted = labels[labels.length - 1] || '';

  // If generic public webmail domain, and fallbackName is given, use fallbackName
  const genericDomains = new Set(['gmail', 'googlemail', 'yahoo', 'hotmail', 'outlook', 'live', 'icloud', 'aol']);
  if (genericDomains.has(extracted) && fallbackName) {
    const cleanName = fallbackName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 15);
    if (cleanName) return cleanName;
  }
  return extracted;
};

/**
 * Extracts the outward code (first half) of a UK postcode from an address.
 * "12 High Street, London SW1A 1AA" -> "SW1A"
 * "Apartment 504 Kettleworks, 126 Pope Street, B1 3DW" -> "B1"
 */
const extractPostcodeOutward = (address) => {
  if (!address || typeof address !== 'string') return '';

  // Full UK Postcode: e.g. SW1A 1AA, B1 3DW, B12 0NF, W1K 2AB
  const fullPostcodeRegex = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/gi;
  let lastMatch = null;
  let m;
  while ((m = fullPostcodeRegex.exec(address)) !== null) {
    lastMatch = m;
  }
  if (lastMatch) {
    return lastMatch[1].toUpperCase();
  }

  // Fallback: standalone outward code
  const outwardRegex = /\b([A-Z]{1,2}\d[A-Z\d]?)\b/gi;
  const matches = [...address.matchAll(outwardRegex)];
  if (matches.length > 0) {
    return matches[matches.length - 1][1].toUpperCase();
  }

  return '';
};

/**
 * Returns at most `maxWords` words describing what the job entails.
 */
const summariseJob = (text, maxWords = 4) => {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\w\s'&-]/g, ' ') // drop punctuation except apostrophes, & and hyphens
    .split(/\s+/)
    .filter((w) => w && w !== '-')
    .slice(0, maxWords)
    .join(' ')
    .trim();
};

/**
 * Attempts to extract a job reference from text (subject / body / title).
 */
const extractReferenceFromText = (text) => {
  if (!text || typeof text !== 'string') return '';
  // Pattern like WO-12345, WO12345, JOB-12345
  const directMatch = text.match(/\b((?:WO|REF|JOB)[-_]?\d{3,10})\b/i);
  if (directMatch) return directMatch[1].trim().toUpperCase();

  // Pattern with keyword and separator e.g. "Works Order: MC-9182", "Ref: 9812", "Job #8821"
  const match = text.match(/\b(?:works?\s*orders?|ref(?:erence)?|job|wo)[-:\s#]+([A-Za-z0-9_-]{2,25})\b/i);
  if (match) return match[1].trim();

  return '';
};

/**
 * Builds the work reference string in client format:
 * JOB REFERENCE/DOMAIN OF WHO SENT IT-FIRST HALF OF POSTCODE - MAX 4 WORDS OF WHAT JOB ENTITLES
 */
const buildWorkReference = ({ reference, senderEmail, address, issue, managerName, defaultJobNumber } = {}) => {
  let ref = (reference || '').toString().trim();

  // If no reference passed, attempt extraction from issue/text
  if (!ref && issue) {
    ref = extractReferenceFromText(issue);
  }

  // If still no reference, use defaultJobNumber (e.g. "JOB-2026-8568")
  if (!ref && defaultJobNumber) {
    ref = defaultJobNumber.toString().trim();
  }

  const domain = extractSenderDomain(senderEmail, managerName);
  const postcode = extractPostcodeOutward(address);

  // Clean issue text: strip manager/sender name, reference, postcodes, common prefixes
  let issueText = (issue || '').toString();
  if (managerName && typeof managerName === 'string') {
    const escaped = managerName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (escaped) {
      issueText = issueText.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), ' ');
    }
  }
  if (ref && ref.length >= 3) {
    const escapedRef = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    issueText = issueText.replace(new RegExp(`\\b${escapedRef}\\b`, 'gi'), ' ');
  }

  issueText = issueText
    .replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi, ' ')
    .replace(/^works?\s+orders?\s*[-:]?\s*/i, '')
    .replace(/^maintenance\s+request\s*[-:]?\s*/i, '')
    .replace(/^job\s+request\s*[-:]?\s*/i, '')
    .replace(/^\s*[-:/|]+\s*/, '')
    .trim();

  // If issueText became empty or too generic, fallback
  let words = summariseJob(issueText, 4);
  if (!words || words.length < 2) {
    words = 'Maintenance Request';
  }

  // Middle part: "domain-POSTCODE" (e.g. "martinco-B12" or "foxtons-W1D")
  const middle = [domain, postcode].filter(Boolean).join('-');

  // Format: "JOB REFERENCE/DOMAIN-POSTCODE - 4 WORDS"
  let head = '';
  if (ref && middle) {
    head = `${ref}/${middle}`;
  } else if (ref) {
    head = ref;
  } else if (middle) {
    head = middle;
  }

  const result = head ? `${head} - ${words}` : words;
  return result.slice(0, 255);
};

module.exports = {
  buildWorkReference,
  extractSenderDomain,
  extractPostcodeOutward,
  summariseJob,
  extractReferenceFromText,
};
