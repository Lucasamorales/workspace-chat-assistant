/**
 * Leave: books and cancels out-of-office, on the person's own calendar.
 *
 * This is the only module that acts *as* someone. The rule it exists to enforce:
 * the calendar touched is always the Chat-verified sender's, unless the person asking
 * holds the `admin` role. Claude proposes; the person clicks Approve; only then does
 * anything happen — and the subject is never taken from what Claude produced.
 *
 * Replaces the Sheet dialog in legacy/ooo-appsscript/. Reading "who's out" is the
 * separate, read-only `ooo` module.
 */

const { createImpersonator } = require('./impersonate');
const { createLeaveCalendar } = require('./calendar');
const { SHIFTS, TYPES, timesFor, personalEvent, teamEvent, at } = require('./shifts');

const DEFAULT_TEAM_EMAIL = 'wholeteam@example.com';
const DEFAULT_SHIFT = 'ARG_8_5';
const MAX_BLOCKS = 10;
const MAX_DAYS = 60;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const bad = message => Object.assign(new Error(message), { expose: true });
const dayCount = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;

/** Rejects anything malformed before it can reach a calendar. */
function checkLeave(leave) {
  const from = String(leave.from || leave.start || '');
  const to = String(leave.to || leave.end || from);
  const type = String(leave.type || 'full').toLowerCase();
  if (!DATE.test(from) || !DATE.test(to)) throw bad('I need dates as YYYY-MM-DD to book leave.');
  if (!TYPES[type]) throw bad('Leave can be a full day, a morning (am) or an afternoon (pm).');
  if (to < from) throw bad('That leave ends before it starts — could you say the dates again?');
  if (type !== 'full' && to !== from) throw bad('A half-day is one day only.');
  if (dayCount(from, to) > MAX_DAYS) throw bad(`That's more than ${MAX_DAYS} days in one go. Book it in smaller chunks?`);
  return { from, to, type };
}

function createLeaveModule({ impersonator, calendar, now = () => new Date() } = {}) {
  let api = calendar;
  const calendarFor = () => {
    if (!api) {
      const { GoogleAuth } = require('google-auth-library');
      const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
      api = createLeaveCalendar({ tokenFor: (impersonator || createImpersonator({ auth })).tokenFor });
    }
    return api;
  };

  const teamEmail = ctx => ctx.settings.LEAVE_TEAM_EMAIL || DEFAULT_TEAM_EMAIL;
  const profiles = ctx => ctx.store.collection('profiles');

  const key = email => String(email || '').toLowerCase();

  /** "remy.lee" → "Remy Lee", so a colleague's name is never just an email stem. */
  const nameFromEmail = email => key(email).split('@')[0].split(/[._-]+/)
    .filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

  /**
   * Whose hours and name go on the event — the person the leave is for, never the person
   * asking. An admin booking for a UK colleague must not stamp their own shift on it.
   */
  async function profileOf(ctx, subject = ctx.userEmail, given = {}) {
    const saved = (await profiles(ctx).get(key(subject))) || {};
    const self = key(subject) === key(ctx.userEmail);
    const asked = String(given.shift || '').toUpperCase();
    return {
      shift: SHIFTS[asked] ? asked : (SHIFTS[saved.shift] ? saved.shift : null),
      nickname: given.nickname || saved.nickname || (self ? (ctx.userDisplayName || nameFromEmail(subject)) : nameFromEmail(subject)),
      known: Boolean(SHIFTS[saved.shift]),
      self,
    };
  }

  const defaultShift = ctx => (SHIFTS[ctx.settings.LEAVE_DEFAULT_SHIFT] ? ctx.settings.LEAVE_DEFAULT_SHIFT : DEFAULT_SHIFT);

  /**
   * Half-days depend on the shift, so guessing one for a colleague would put the wrong hours
   * in their calendar. Full days run 00:00–23:59 whatever the shift, so a default is safe there.
   */
  function shiftFor(ctx, profile, leave) {
    if (profile.shift) return profile.shift;
    if (leave.type === 'full' || profile.self) return defaultShift(ctx);
    throw bad('I don\'t know what hours they work, so I\'d get a half-day wrong. Tell me their shift ('
      + `${Object.keys(SHIFTS).join(', ')}) and I'll remember it.`);
  }

  /**
   * THE security boundary: whose calendar this touches.
   * `person` is only honoured for admins; for everyone else the verified sender wins,
   * whatever Claude put in the tool call.
   */
  function subjectFor(ctx, person) {
    const asked = String(person || '').trim().toLowerCase();
    if (!asked || asked === String(ctx.userEmail || '').toLowerCase()) return ctx.userEmail;
    if (!ctx.hasRole('admin')) {
      throw bad('I can only book or cancel leave on your own calendar. Ask an HR admin to do it for someone else.');
    }
    if (!/^[^@\s]+@[^@\s]+$/.test(asked)) throw bad('That doesn\'t look like a work email address.');
    return asked;
  }

  /** Already booked? Same title and same start means the same leave. */
  async function existing(ctx, subject, event, window) {
    const events = await calendarFor().listOoo(subject, window);
    const startOf = ev => (ev.start || {}).dateTime || (ev.start || {}).date || '';
    const want = startOf(event);
    return events.find(ev => ev.summary === event.summary && startOf(ev) === want);
  }

  async function book(ctx, leave, input) {
    const subject = subjectFor(ctx, input.person);
    const profile = await profileOf(ctx, subject, input);
    const shiftKey = shiftFor(ctx, profile, leave);
    const { nickname } = profile;
    const shift = SHIFTS[shiftKey];
    // Remember it, so the accounts team types a colleague's details once, not every time.
    if (input.shift || input.nickname) await profiles(ctx).set(key(subject), { shift: shiftKey, nickname });
    const { start, end } = timesFor(leave, shift);
    const window = { timeMin: start, timeMax: end };

    const personal = personalEvent(leave, shift, nickname);
    if (await existing(ctx, subject, personal, window)) {
      return `Already booked: ${nickname} is down as out on ${leave.from}${leave.to !== leave.from ? ` to ${leave.to}` : ''}. Nothing changed.`;
    }

    await calendarFor().create(subject, personal);
    if (input.team_invite !== false) await calendarFor().create(subject, teamEvent(leave, shift, nickname, teamEmail(ctx)));
    ctx.log.info('leave booked', { by: ctx.userEmail, subject, from: leave.from, to: leave.to, type: leave.type, shift: shiftKey });
    const span = leave.to !== leave.from ? `${leave.from} to ${leave.to}` : leave.from;
    const invited = input.team_invite === false ? 'no team invite' : 'the team is invited';
    return `Booked: ${nickname} out ${span} (${TYPES[leave.type].toLowerCase()}), ${invited}.`;
  }

  async function cancel(ctx, { from, to, person }) {
    const subject = subjectFor(ctx, person);
    const profile = await profileOf(ctx, subject);
    const { tz } = SHIFTS[profile.shift || defaultShift(ctx)];
    // Exactly the days asked for: the Apps Script searched two days past the end and deleted
    // leave the person never asked to cancel.
    const events = await calendarFor().listOoo(subject, {
      timeMin: at(from, '00:00:00', tz),
      timeMax: at(to, '23:59:59', tz),
    });
    if (!events.length) return `No out-of-office found between ${from} and ${to}. Nothing changed.`;

    let removed = 0;
    const failed = [];
    for (const ev of events) {
      try {
        await calendarFor().remove(subject, ev.id);
        removed += 1;
      } catch (error) {
        ctx.log.warn('leave cancel failed', { subject, event: ev.id, error });
        failed.push(ev.summary || ev.id);
      }
    }
    ctx.log.info('leave cancelled', { by: ctx.userEmail, subject, from, to, removed, failed: failed.length });
    // Partial failures are reported, not swallowed as success.
    return failed.length
      ? `Removed ${removed} out-of-office event(s), but ${failed.length} wouldn't budge. Try again, or remove them in Calendar.`
      : `Removed ${removed} out-of-office event(s) between ${from} and ${to}.`;
  }

  async function whoLine(ctx, person) {
    const subject = subjectFor(ctx, person);
    return subject === ctx.userEmail ? 'You' : subject;
  }

  return {
    name: 'leave',
    description: 'Record leave: book or cancel out-of-office',
    allowedIn: ['DM'],
    roles: ['admin'],
    needsConversation: true,
    settings: ['LEAVE_TEAM_EMAIL'],
    examples: ['Book Remy out 12–16 October', 'Riley is off Friday morning', 'Cancel Charlie\'s leave on the 3rd'],
    instructions: 'book_leave and cancel_leave. Dates YYYY-MM-DD; type full, am or pm. Never guess a date — ask. '
      + 'Accounts records leave for colleagues, so "person" is usually someone else\'s work email; without the admin '
      + 'role a person can only book their own, so do not offer otherwise. Hours come from their saved shift; for a '
      + 'half-day with no shift known, ask which one rather than inventing hours.',

    commands: {
      leave: {
        description: 'Your leave settings',
        usage: '/leave [shift <key>|name <nickname>|check]',
        async run(ctx, args) {
          const text = String(args || '').trim();
          const [sub, ...rest] = text.split(/\s+/);
          const value = rest.join(' ').trim();
          const saved = await profileOf(ctx);
          const savedShift = saved.shift || defaultShift(ctx);

          if (sub === 'shift') {
            const wanted = value.toUpperCase();
            if (!SHIFTS[wanted]) {
              return {
                title: 'Which shift?',
                text: Object.entries(SHIFTS).map(([k, s]) => `• **${k}** — ${s.label}`).join('\n')
                  + '\n\nSet it with /leave shift ARG_8_5',
              };
            }
            await profiles(ctx).set(key(ctx.userEmail), { shift: wanted, nickname: saved.nickname });
            return `Righto, your half-days now run on ${SHIFTS[wanted].label}.`;
          }

          if (sub === 'name') {
            if (!value) return 'Tell me the name to show on the calendar: /leave name Robin';
            await profiles(ctx).set(key(ctx.userEmail), { shift: saved.shift || undefined, nickname: value });
            return `Sorted, your leave will show as "${value} (OOO)".`;
          }

          if (sub === 'check') {
            const lines = [];
            try {
              await calendarFor().listOoo(ctx.userEmail, {
                timeMin: at('2026-01-01', '00:00:00', SHIFTS[savedShift].tz),
                timeMax: at('2026-01-02', '00:00:00', SHIFTS[savedShift].tz),
              });
              lines.push('✅ Buddy can act on your calendar.');
            } catch (error) {
              ctx.log.warn('leave check failed', { error });
              lines.push(`❌ ${error.expose ? error.message : 'Buddy can\'t reach your calendar.'}`);
            }
            lines.push(`Shift: ${SHIFTS[savedShift].label} · Shown as: ${saved.nickname} · Team invite: ${teamEmail(ctx)}`);
            return { title: 'Leave setup check', text: lines.join('\n') };
          }

          return {
            title: 'Booking leave',
            text: [
              `Shift: **${SHIFTS[savedShift].label}** · shown as **${saved.nickname} (OOO)**`,
              '',
              'Just tell me, e.g. "I\'m off next Thursday" or "book me out 12–16 October, mornings only".',
              'I\'ll show you exactly what I\'m about to put in your calendar before anything happens.',
              '',
              'Change your hours with /leave shift, or your name with /leave name.',
            ].join('\n'),
          };
        },
      },
    },

    quickActions: async () => [{ text: 'Leave settings', command: 'leave' }],

    async tools(ctx) {
      return {
        definitions: [
          {
            name: 'book_leave',
            description: 'Book out-of-office on the person\'s own calendar and invite the team. Needs their approval.',
            input_schema: {
              type: 'object',
              properties: {
                leaves: {
                  type: 'array',
                  description: 'One entry per block of leave',
                  items: {
                    type: 'object',
                    properties: {
                      from: { type: 'string', description: 'First day, YYYY-MM-DD' },
                      to: { type: 'string', description: 'Last day, YYYY-MM-DD. Same as from for one day' },
                      type: { type: 'string', enum: ['full', 'am', 'pm'], description: 'Full day, morning or afternoon' },
                    },
                    required: ['from', 'type'],
                  },
                },
                person: { type: 'string', description: 'HR admins only: whose calendar. Leave empty for the person asking' },
                shift: {
                  type: 'string',
                  enum: Object.keys(SHIFTS),
                  description: 'Their working hours, needed for a half-day when I don\'t know them yet. Remembered afterwards',
                },
                nickname: { type: 'string', description: 'The name to show on the calendar, if it should differ from theirs' },
                team_invite: { type: 'boolean', description: 'Set false to skip inviting the team. Defaults to true' },
              },
              required: ['leaves'],
            },
          },
          {
            name: 'cancel_leave',
            description: 'Remove out-of-office events between two dates. Needs their approval.',
            input_schema: {
              type: 'object',
              properties: {
                from: { type: 'string', description: 'First day to clear, YYYY-MM-DD' },
                to: { type: 'string', description: 'Last day to clear, YYYY-MM-DD' },
                person: { type: 'string', description: 'HR admins only: whose calendar' },
              },
              required: ['from', 'to'],
            },
          },
        ],

        // Both tools write to a real calendar, so both always wait for a click.
        needsApproval: () => true,

        /** One approval section per block of leave, so half of a request can be cancelled. */
        split: (name, input) => (name === 'book_leave' && Array.isArray(input.leaves) && input.leaves.length > 1
          ? input.leaves.map(leave => ({ ...input, leaves: [leave] }))
          : [input]),

        async describe(name, input) {
          // The card must show the details of the person the leave is FOR, so an approver
          // can catch a wrong name or the wrong hours before anything is written.
          const subject = subjectFor(ctx, input.person);
          const profile = await profileOf(ctx, subject, input);
          const { nickname } = profile;
          if (name === 'cancel_leave') {
            if (!DATE.test(String(input.from)) || !DATE.test(String(input.to))) throw bad('I need dates as YYYY-MM-DD to cancel leave.');
            return {
              title: 'Cancel out-of-office',
              effect: 'delete',
              fields: [
                { label: 'Whose calendar', value: await whoLine(ctx, input.person) },
                { label: 'Clearing', value: `${input.from} to ${input.to}` },
              ],
            };
          }
          const leave = checkLeave((input.leaves || [])[0] || {});
          const shift = SHIFTS[shiftFor(ctx, profile, leave)];
          const { start, end } = timesFor(leave, shift);
          return {
            title: 'Book out-of-office',
            effect: 'create',
            fields: [
              { label: 'Whose calendar', value: await whoLine(ctx, input.person) },
              { label: 'Shows as', value: `${nickname} (OOO)` },
              { label: 'Dates', value: leave.from === leave.to ? leave.from : `${leave.from} to ${leave.to}` },
              { label: 'Type', value: TYPES[leave.type] },
              ...(leave.type === 'full' ? [] : [{ label: 'Hours', value: `${start.slice(11, 16)}–${end.slice(11, 16)} (${shift.label})` }]),
              ...(input.team_invite === false ? [] : [{ label: 'Team invite', value: teamEmail(ctx) }]),
            ],
          };
        },

        async execute(name, input) {
          if (name === 'cancel_leave') {
            if (!DATE.test(String(input.from)) || !DATE.test(String(input.to))) throw bad('I need dates as YYYY-MM-DD to cancel leave.');
            if (input.to < input.from) throw bad('That range ends before it starts.');
            return { content: await cancel(ctx, input) };
          }
          const leaves = Array.isArray(input.leaves) ? input.leaves : [];
          if (!leaves.length) throw bad('Tell me which days you\'re taking off.');
          if (leaves.length > MAX_BLOCKS) throw bad(`That's a lot at once — ${MAX_BLOCKS} blocks of leave is my limit per request.`);
          const done = [];
          for (const raw of leaves) done.push(await book(ctx, checkLeave(raw), input));
          return { content: done.join('\n') };
        },
      };
    },
  };
}

module.exports = { createLeaveModule, checkLeave, SHIFTS };
