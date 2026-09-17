const test = require('node:test');
const assert = require('node:assert/strict');
const { extractValue } = require('../src/values');
const { looksLikeKudos, nominationsFrom, applyPolicy, replyText } = require('../src/votes');

/** Builds a Chat-like message where "@Name" tokens in the text become mentions at their real index. */
function msg(text, people = {}) {
  const mentions = [];
  const re = /@(\w+)/g;
  let m;
  while ((m = re.exec(text))) {
    const name = m[1];
    mentions.push({
      userId: people[name] || `users/${name.toLowerCase()}`,
      displayName: name,
      type: name === 'Buddy' ? 'BOT' : 'HUMAN',
      startIndex: m.index,
      length: m[0].length,
    });
  }
  return { text, mentions, sender: { userId: 'users/robin', displayName: 'Robin' } };
}

test('values: the forms people write are recognised', () => {
  const cases = {
    'for owning it': 'Own it', 'she owned it': 'Own it', 'owns it every day': 'Own it', '#ownit': 'Own it',
    'thinking big': 'Think big', 'thought big on this': 'Think big', 'think big': 'Think big',
    'going beyond': 'Go beyond', 'went above and beyond': 'Go beyond', 'goes beyond': 'Go beyond',
    'going above & beyond': 'Go beyond', 'went above n beyond': 'Go beyond',
    'being curious': 'Be curious', 'so much curiosity': 'Be curious',
  };
  for (const [text, value] of Object.entries(cases)) assert.equal(extractValue(text), value, text);
});

test('values: loose matches from the old script are no longer counted', () => {
  for (const text of ['I am down with it', 'known it for ages', 'good work, beyond that nothing', 'thinks the budget is big', 'the owner said it']) {
    assert.equal(extractValue(text), null, text);
  }
});

test('which messages count as kudos attempts', () => {
  assert.equal(looksLikeKudos(msg('@Buddy kudos to @Eve for thinking big')), true);
  assert.equal(looksLikeKudos(msg('@Buddy @Eve really owned it')), true);
  assert.equal(looksLikeKudos(msg('@Buddy summarise what @Eve said')), false, 'normal requests go to Claude');
  assert.equal(looksLikeKudos(msg('@Buddy what does think big mean?')), false);
  assert.equal(looksLikeKudos(msg('@Buddy kudos for thinking big')), true, 'forgot to tag someone: answer with a hint');
  assert.deepEqual(
    nominationsFrom(msg('@Buddy id like to give a kudos to @Eve for going above and beyond')).map(n => [n.name, n.value]),
    [['Eve', 'Go beyond']],
    'natural phrasing works',
  );
});

test('each nominee gets the value written after their name, or the shared one', () => {
  assert.deepEqual(
    nominationsFrom(msg('@Buddy kudos to @Eve for think big and @Leo for owning it')).map(n => [n.name, n.value]),
    [['Eve', 'Think big'], ['Leo', 'Own it']],
  );
  assert.deepEqual(
    nominationsFrom(msg('@Buddy kudos to @Eve and @Leo for going beyond')).map(n => [n.name, n.value]),
    [['Eve', 'Go beyond'], ['Leo', 'Go beyond']],
  );
  assert.equal(nominationsFrom(msg('@Buddy kudos @Eve @Eve for curiosity')).length, 1, 'tagging someone twice is one vote');
  assert.equal(nominationsFrom(msg('@Buddy kudos to @Eve for think big')).some(n => n.name === 'Buddy'), false, 'bots are ignored');
});

const sender = { userId: 'users/robin', displayName: 'Robin' };
const row = (nomineeId, nominee = 'X') => ({ voter: 'Robin', voterId: 'users/robin', nominee, nomineeId });

test('policy: self-votes are blocked', () => {
  const r = applyPolicy({ nominations: [{ userId: 'users/robin', name: 'Robin', value: 'Own it' }], sender, monthRows: [], isLeader: false });
  assert.deepEqual(r.rejected, [{ name: 'Robin', reason: 'self' }]);
  assert.match(replyText({ voterName: 'Robin', ...r }), /can't give kudos to yourself/);
});

test('policy: 5 per month, counting votes in this same message', () => {
  const monthRows = [row('users/a'), row('users/b'), row('users/c'), row('users/d')];
  const nominations = [{ userId: 'users/e', name: 'Eve', value: 'Own it' }, { userId: 'users/f', name: 'Fay', value: 'Own it' }];
  const r = applyPolicy({ nominations, sender, monthRows, isLeader: false });
  assert.deepEqual(r.accepted.map(a => a.name), ['Eve']);
  assert.deepEqual(r.rejected, [{ name: 'Fay', reason: 'month_limit' }]);
  assert.match(replyText({ voterName: 'Robin', ...r }), /Logged 1 kudos[\s\S]*That's your 5 kudos for this month already[\s\S]*Fay/);
});

test('policy: 3 per person per month, matching old rows by name when they have no ids', () => {
  const monthRows = [row('users/eve'), row('users/eve'), { voter: 'Robin', voterId: '', nominee: 'Eve', nomineeId: '' }];
  const r = applyPolicy({ nominations: [{ userId: 'users/eve', name: 'Eve', value: 'Think big' }], sender, monthRows, isLeader: false });
  assert.deepEqual(r.rejected, [{ name: 'Eve', reason: 'person_limit' }]);
});

test('policy: leadership voters are exempt from the limits, but not from the self-vote rule', () => {
  const monthRows = Array.from({ length: 9 }, () => row('users/eve'));
  const r = applyPolicy({
    nominations: [{ userId: 'users/eve', name: 'Eve', value: 'Own it' }, { userId: 'users/robin', name: 'Robin', value: 'Own it' }],
    sender, monthRows, isLeader: true,
  });
  assert.deepEqual(r.accepted.map(a => a.name), ['Eve']);
  assert.deepEqual(r.rejected, [{ name: 'Robin', reason: 'self' }]);
});

test('reply wording matches the original bot for the common cases', () => {
  assert.equal(
    replyText({ voterName: 'Robin', accepted: [{ name: 'Eve', value: 'Think big' }], rejected: [{ name: 'Leo', reason: 'no_value' }] }),
    'Yessss! Logged 1 kudos from Robin:\n• Eve: "Think big"\n\nCouldn\'t spot a value for: Leo',
  );
  assert.equal(
    replyText({ voterName: 'Robin', accepted: [], rejected: [{ name: 'Leo', reason: 'no_value' }] }),
    'Oh no, I couldn\'t spot a company value in there. Try Own it, Think big, Go beyond or Be curious.',
  );
});
