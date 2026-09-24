/**
 * OOO: who's out of the office, read from the `accounts@` calendar.
 *
 * Read-only by design. It answers commands without Claude, so anyone in the domain can use it,
 * and offers the same lookup as a tool so the assistant can answer naturally.
 * Booking and cancelling leave is the separate `leave` module.
 *
 * Built by a factory so tests can inject a fake Calendar client and clock.
 */

const { createOooCalendar } = require('./calendar');
const { createReadTokens, readAs } = require('./token');
const { WHEN, rangeFor, instantsFor } = require('./range');
const { entriesFrom, replyFor, textFor } = require('./present');

const DEFAULT_CALENDAR = 'accounts@example.com';
const DEFAULT_TZ = 'America/Argentina/Buenos_Aires';
const DEFAULT_TZ_LABEL = 'ARG';

function defaultTokens(log) {
  // Required lazily so tests and other modules never load the Google client.
  const { GoogleAuth } = require('google-auth-library');
  return createReadTokens({ auth: new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }), log });
}

/**
 * Questions this module can answer on its own, without Claude.
 *
 * "Who's out today?" has one right answer and a fixed shape, so paying a language model to
 * format a list nobody argues about is waste — at company scale it is the most-asked question
 * there is. Nobody types commands, so the match is on how people actually write, in both
 * languages the team uses. Anything not obviously this question falls through to Claude.
 */
const ASKS_WHO_IS_OUT = [
  // English: who is out / off / away / on holiday / on leave / ooo
  /\bwho(?:'s|s| is| are)?\b[^?]{0,20}\b(?:out|off|away|ooo|on (?:holiday|leave|vacation|annual leave))\b/i,
  /\b(?:anyone|anybody|someone)\b[^?]{0,20}\b(?:out|off|away|ooo|on (?:holiday|leave|vacation))\b/i,
  // Spanish: quién está / quiénes están de vacaciones / licencia / fuera / ausente
  /\bqui[eé]n(?:es)?\b[^?]{0,25}\b(?:de (?:vacaciones|licencia)|fuera|ausente|ooo)\b/i,
  /\bqui[eé]n(?:es)?\s+(?:no\s+)?(?:est[aá]|est[aá]n)\b[^?]{0,25}\b(?:hoy|ma[ñn]eve|semana)\b/i,
];

/** A question about the OOO *policy* belongs to the manual, not here. */
const ABOUT_THE_POLICY = /\b(polic|pol[ií]tica|procedure|procedimiento|how do i|c[oó]mo (?:pido|solicito)|request|book|solicitar|pedir)\b/i;

const asksWhoIsOut = text => ASKS_WHO_IS_OUT.some(re => re.test(text)) && !ABOUT_THE_POLICY.test(text);

/** "next week please" → "next week"; anything unrecognised falls back to today. */
function whenFrom(text) {
  const t = String(text || '').toLowerCase();
  if (/\bnext week\b/.test(t)) return 'next week';
  if (/\bnext month\b/.test(t)) return 'next month';
  if (/\btomorrow\b/.test(t)) return 'tomorrow';
  if (/\b(this )?month\b/.test(t)) return 'month';
  if (/\b(this )?week\b/.test(t)) return 'week';
  return 'today';
}

function createOooModule({ calendar, tokenFor, now = () => new Date() } = {}) {
  let tokens = tokenFor;
  const calendarFor = ctx => {
    if (calendar) return calendar; // tests inject a ready-made reader
    if (!tokens) tokens = defaultTokens(ctx.log);
    return createOooCalendar({
      tokenFor: tokens,
      calendarId: ctx.settings.OOO_CALENDAR_ID || DEFAULT_CALENDAR,
      // Settings only: never a user, a message or anything Claude produced.
      readAs: readAs(ctx.settings.OOO_READ_AS),
    });
  };
  const zone = ctx => ({
    timeZone: ctx.settings.OOO_TIMEZONE || DEFAULT_TZ,
    tzLabel: ctx.settings.OOO_TIMEZONE_LABEL || DEFAULT_TZ_LABEL,
  });

  async function lookup(ctx, when) {
    const { timeZone, tzLabel } = zone(ctx);
    const range = rangeFor(when, now(), timeZone);
    const events = await calendarFor(ctx).list(instantsFor(range, timeZone));
    return { entries: entriesFrom(events, timeZone, tzLabel), label: range.label };
  }

  async function check(ctx) {
    const cal = calendarFor(ctx);
    const lines = [];
    try {
      // Reading events is all this module ever does, so that is what the check proves.
      // Calendar *metadata* needs a wider scope than the delegation grants, so it is only
      // a nice-to-have: never let it decide whether the check passes.
      const { entries, label } = await lookup(ctx, 'week');
      lines.push(`✅ I can read the calendar: ${entries.length} OOO entr${entries.length === 1 ? 'y' : 'ies'} ${label}.`);
      const info = await cal.describe().catch(() => null);
      if (info) lines.push(`✅ Calendar: "${info.title}" (time zone ${info.timeZone})`);
    } catch (error) {
      ctx.log.warn('ooo calendar check failed', { error, detail: error.detail });
      lines.push(error.expose ? `❌ ${error.message}` : '❌ I can\'t read the OOO calendar.');
      if (error.detail) lines.push(`Google said: ${error.detail}`);
    }
    lines.push(`Calendar: ${cal.calendarId} · read${cal.readAs ? ` as ${cal.readAs}` : ' with Buddy\'s own access'} · shown in ${zone(ctx).timeZone}`);
    return { title: 'OOO setup check', text: lines.join('\n') };
  }

  return {
    name: 'ooo',
    description: 'See who\'s out of the office',
    settings: ['OOO_CALENDAR_ID'],
    examples: ['Who\'s out today?', 'Who\'s off next week?'],
    instructions: 'Out-of-office information comes from the who_is_out tool: use it instead of guessing, and '
      + 'never invent absences. Buddy can only read leave; booking or cancelling it is done elsewhere.',

    /**
     * Answers "who's out?" directly, without Claude. The reply is the same list the command
     * gives; a question that isn't plainly this one returns null and carries on to Claude.
     */
    async handleMessage(ctx, message) {
      const text = String((message && (message.argumentText || message.text)) || '').trim();
      if (!text || !asksWhoIsOut(text)) return null;
      try {
        const { entries, label } = await lookup(ctx, whenFrom(text));
        ctx.log.info('ooo answered without Claude', { when: label });
        return replyFor(entries, label);
      } catch (error) {
        // Never turn a saving into a failure: if the calendar is unhappy, let Claude try.
        ctx.log.warn('ooo direct answer failed, falling through to Claude', { error });
        return null;
      }
    },

    commands: {
      ooo: {
        description: 'Who\'s out of the office',
        usage: '/ooo [today|tomorrow|week|next week|month|next month|check]',
        async run(ctx, args) {
          const arg = String(args || '').trim().toLowerCase();
          if (arg === 'check') return check(ctx);
          const { entries, label } = await lookup(ctx, arg ? whenFrom(arg) : 'today');
          return replyFor(entries, label);
        },
      },
    },

    quickActions: async () => [
      { text: 'Out today', command: 'ooo', args: 'today' },
      { text: 'Out this week', command: 'ooo', args: 'week' },
    ],

    async tools(ctx) {
      return {
        definitions: [{
          name: 'who_is_out',
          description: 'List who is out of the office for a period. Read-only.',
          input_schema: {
            type: 'object',
            properties: { when: { type: 'string', enum: WHEN, description: 'Which period to look at' } },
            required: ['when'],
          },
        }],
        // Reading a calendar changes nothing, so it never interrupts the user for approval.
        needsApproval: () => false,
        execute: async (name, input) => {
          const { entries, label } = await lookup(ctx, WHEN.includes(input.when) ? input.when : 'today');
          return { content: textFor(entries, label) };
        },
      };
    },
  };
}

module.exports = { createOooModule, whenFrom };
