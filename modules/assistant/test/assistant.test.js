const test = require('node:test');
const assert = require('node:assert/strict');
const { validateModule } = require('@buddy/core');
const assistant = require('../src');

test('module satisfies the contract and provides conversation', () => {
  validateModule(assistant);
  assert.equal(assistant.conversation, true);
});
