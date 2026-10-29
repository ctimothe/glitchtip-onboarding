'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { findLeaks, parseCanaries } = require('./security-scan-lib')

const canaries = parseCanaries([
  '# comment',
  'bearer=Bearer canaryBearerTok3n9f2a7c1d',
  'query-token=access_token=canaryQueryTokenb82e',
  'email=canary.user.7f3a@example.invalid',
  '',
].join('\n'))

test('parses name=value lines and skips comments and blanks', () => {
  assert.deepEqual(canaries.map((canary) => canary.name), ['bearer', 'query-token', 'email'])
  assert.equal(canaries[1].value, 'access_token=canaryQueryTokenb82e')
})

test('flags a full canary value in output', () => {
  assert.deepEqual(findLeaks('hello canary.user.7f3a@example.invalid', canaries), ['email'])
})

test('flags the bare secret after a scheme or key', () => {
  assert.deepEqual(findLeaks('token=canaryBearerTok3n9f2a7c1d', canaries), ['bearer'])
  assert.deepEqual(findLeaks({ q: 'canaryQueryTokenb82e' }, canaries), ['query-token'])
})

test('clean output has no leaks', () => {
  assert.deepEqual(findLeaks('ERROR · Shop · production', canaries), [])
})
