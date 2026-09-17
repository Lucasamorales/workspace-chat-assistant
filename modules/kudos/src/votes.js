/**
 * Pure voting logic: which tagged people get which value, and which votes the policy allows.
 * No I/O here, so every rule is unit-tested directly.
 */

const { extractValue } = require('./values');

const DEFAULT_LIMITS = { perMonth: 5, perPerson: 3 };

/** Is this message a kudos attempt Buddy should answer, rather than pass to Claude? */
function looksLikeKudos(message) {
  const humans = message.mentions.filter(m => m.type === 'HUMAN');
  const mentionsValue = Boolean(extractValue(message.text));
  const saysKudos = /\bkudos?\b/i.test(message.text);
  return humans.length > 0 ? (mentionsValue || saysKudos) : mentionsValue && saysKudos;
}

/**
 * Splits the message into one segment per tagged teammate: from their mention to the next
 * one. A value written in their segment applies to them; otherwise a value anywhere in the
 * message applies to everyone (e.g. "kudos to @Eve and @Leo for thinking big").
 */
function nominationsFrom(message) {
  const text = message.text;
  const globalValue = extractValue(text);
  const humans = message.mentions.filter(m => m.type === 'HUMAN');
  const seen = new Set();
  const out = [];

  humans.forEach((m, i) => {
    const end = i < humans.length - 1 ? humans[i + 1].startIndex : text.length;
    const value = extractValue(text.substring(m.startIndex, end)) || globalValue;
    if (seen.has(m.userId)) return; // tagging someone twice in one message is one vote
    seen.add(m.userId);
    out.push({ userId: m.userId, name: m.displayName || m.userId, value });
  });
  return out;
}

const sameVoter = (row, sender) => (row.voterId ? row.voterId === sender.userId : row.voter === sender.displayName);
const sameNominee = (row, nominee) => (row.nomineeId ? row.nomineeId === nominee.userId : row.nominee === nominee.name);

/**
 * @param nominations  from nominationsFrom
 * @param sender       {userId, displayName}
 * @param monthRows    rows already logged this month (older rows without ids match by name)
 * @param isLeader     leadership voters are exempt from the giving limits
 * @returns {accepted: [...], rejected: [{name, reason}]}
 */
function applyPolicy({ nominations, sender, monthRows, isLeader, limits = DEFAULT_LIMITS }) {
  const mine = monthRows.filter(r => sameVoter(r, sender));
  let given = mine.length;
  const accepted = [];
  const rejected = [];

  for (const n of nominations) {
    if (n.userId === sender.userId) {
      rejected.push({ name: n.name, reason: 'self' });
      continue;
    }
    if (!n.value) {
      rejected.push({ name: n.name, reason: 'no_value' });
      continue;
    }
    if (!isLeader) {
      if (given >= limits.perMonth) {
        rejected.push({ name: n.name, reason: 'month_limit' });
        continue;
      }
      const toThem = mine.filter(r => sameNominee(r, n)).length;
      if (toThem >= limits.perPerson) {
        rejected.push({ name: n.name, reason: 'person_limit' });
        continue;
      }
    }
    accepted.push(n);
    given += 1;
  }
  return { accepted, rejected };
}

function replyText({ voterName, accepted, rejected, limits = DEFAULT_LIMITS }) {
  const lines = [];
  if (accepted.length) {
    lines.push(`✅ Got it! Logged ${accepted.length} vote(s) from ${voterName}:`);
    for (const a of accepted) lines.push(`• ${a.name}: "${a.value}"`);
  }

  const names = reason => rejected.filter(r => r.reason === reason).map(r => r.name);
  const notes = [];
  if (names('self').length) notes.push('🚫 Nice try! You can\'t give kudos to yourself.');
  if (names('month_limit').length) {
    notes.push(`🚫 You've already given ${limits.perMonth} kudos this month (the limit), so these weren't logged: ${names('month_limit').join(', ')}.`);
  }
  if (names('person_limit').length) {
    notes.push(`🚫 You've already given ${limits.perPerson} kudos this month to: ${names('person_limit').join(', ')} (the limit per person).`);
  }
  if (names('no_value').length) {
    notes.push(accepted.length || notes.length
      ? `⚠️ Could not detect a valid value for: ${names('no_value').join(', ')}`
      : '❌ I couldn\'t detect a valid company value (Own it, Think big, Go beyond, Be curious) in your message.');
  }

  return [lines.join('\n'), notes.join('\n')].filter(Boolean).join('\n\n');
}

module.exports = { looksLikeKudos, nominationsFrom, applyPolicy, replyText, DEFAULT_LIMITS };
