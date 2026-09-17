/**
 * Company values, detected in free text.
 *
 * The Apps Script version matched loose substrings ("own" … anything … "it"), so phrases like
 * "down with it" or "good, beyond that" counted as votes. These patterns require the value's
 * own words, in order, as whole words, allowing the common verb forms people actually write.
 * Checked in this order, like the original, so the first value found in a segment wins.
 */

const VALUES = [
  { name: 'Own it', pattern: /\bown(?:s|ed|ing)?\s*it\b/i },
  { name: 'Think big', pattern: /\b(?:think(?:s|ing)?|thought)\s*big\b/i },
  { name: 'Go beyond', pattern: /\b(?:go(?:es|ing)?|went|gone)\s*(?:above\s+and\s+)?beyond\b/i },
  { name: 'Be curious', pattern: /\bcurio(?:us|sity)\b/i },
];

function extractValue(text) {
  if (!text) return null;
  const found = VALUES.find(v => v.pattern.test(text));
  return found ? found.name : null;
}

module.exports = { extractValue, VALUE_NAMES: VALUES.map(v => v.name) };
