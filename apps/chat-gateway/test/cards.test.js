const test = require('node:test');
const assert = require('node:assert/strict');
const { renderReply, simpleCard } = require('../src/cards');

const textOf = card => JSON.stringify(card.cardsV2[0].card);

/**
 * Module text reaches a card after being escaped, and only then are a few fixed markers turned
 * into HTML. Modules get bold, code and links; nothing else can become markup, whoever wrote it.
 */

test('a module can make text bold, code and links', () => {
  const card = renderReply({ title: 'Access', text: 'Set **kudos** in `config.env` — see [the manual](https://example.com/x)' });
  const body = textOf(card);
  assert.match(body, /<b>kudos<\/b>/);
  assert.match(body, /<b>config\.env<\/b>/);
  assert.match(body, /<a href=\\"https:\/\/example\.com\/x\\">the manual<\/a>/);
});

test('markup in the text itself is shown, never rendered', () => {
  // A Drive document title, an Asana task name, a line someone typed into a policy.
  const nasty = '<b>not bold</b> <img src=x onerror=alert(1)> <a href="https://evil.test">click</a>';
  const body = textOf(renderReply({ title: 'Docs', text: nasty }));
  assert.match(body, /&lt;b&gt;not bold&lt;\/b&gt;/);
  assert.match(body, /&lt;img src=x/);
  assert.ok(!body.includes('<img'), 'no tag survives from module text');
  assert.ok(!/<a /.test(body), 'no link survives from module text');
});

test('a link marker cannot smuggle a javascript: URL', () => {
  const body = textOf(renderReply({ text: '[tap](javascript:alert(1)) and [ok](https://example.com)' }));
  assert.equal((body.match(/<a /g) || []).length, 1, 'only the https link became a link');
  assert.match(body, /<a href=\\"https:\/\/example\.com\\">ok<\/a>/);
});

test('newlines become line breaks, so a list reads as a list', () => {
  const body = textOf(simpleCard('x', { text: 'one\ntwo' }));
  assert.match(body, /one<br>two/);
});

test('an unmatched marker is left alone rather than eating the rest of the text', () => {
  const body = textOf(renderReply({ text: 'a ** b ** c `d' }));
  assert.match(body, /a <b> b <\/b> c `d|a \*\* b \*\* c `d/);
  assert.ok(!body.includes('undefined'));
});

test('a link URL cannot break out of the href attribute', () => {
  const body = textOf(renderReply({ text: '[x](https://a.test/" onmouseover="bad) and [y](https://b.test/ok)' }));
  assert.ok(!/<a [^>]*onmouseover/.test(body), 'a quote in a URL must not start a new attribute');
  assert.equal((body.match(/<a /g) || []).length, 1, 'only the clean URL became a link');
});
