'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createPairing, handlePairingUpdate, readPairingStatus } = require('./pairing')

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/
const TEN_MINUTES = 10 * 60 * 1000
// Every test starts its fixed clock here.
const START = Date.UTC(2026, 8, 23, 10)
const BOT = 'acme_companion_bot'

const stateDirectory = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pairing-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

const fixedClock = (value = START) => () => value

// Draws the given alphabet indices in order, and checks each draw is over the whole alphabet.
const draws = (indices) => {
  let next = 0
  return (max) => {
    assert.equal(max, ALPHABET.length)
    const value = indices[next % indices.length]
    next += 1
    return value
  }
}

const pairingPath = (directory) => path.join(directory, 'pairing.json')
const resultPath = (directory) => path.join(directory, 'pairing-result.json')
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const modeOf = (file) => fs.statSync(file).mode & 0o777
const snapshot = (directory) => Object.fromEntries(fs.readdirSync(directory).sort()
  .map((name) => [name, fs.readFileSync(path.join(directory, name), 'utf8')]))

// A `/pair` message as Telegram delivers it in a private forum supergroup.
const pairingUpdate = (text, { chat = {}, from = {} } = {}) => ({
  update_id: 7,
  message: {
    message_id: 3,
    message_thread_id: 1,
    date: START / 1000,
    text,
    from: { id: 42, is_bot: false, first_name: 'Owner', ...from },
    chat: { id: -100123, type: 'supergroup', is_forum: true, title: 'Acme alerts', ...chat },
  },
})

const memberLookup = (membership = (chatId, userId) => ({ status: 'administrator', user: { id: userId } })) => {
  const calls = []
  const getChatMember = async (chatId, userId) => {
    calls.push([chatId, userId])
    return membership(chatId, userId)
  }
  return { calls, getChatMember }
}

const pair = (directory, text, { update, lookup = memberLookup(), clock = fixedClock(START + 1000) } = {}) =>
  handlePairingUpdate({
    stateDir: directory,
    update: update || pairingUpdate(text),
    botUsername: BOT,
    getChatMember: lookup.getChatMember,
    clock,
  })

test('a pairing code is eight characters from the unambiguous alphabet, hyphenated after four', (t) => {
  const directory = stateDirectory(t)

  assert.deepEqual(createPairing(directory, { clock: fixedClock(), random: draws([0, 1, 2, 3, 4, 5, 6, 7]) }), {
    code: 'ABCD-EFGH',
    expiresAt: '2026-09-23T10:10:00.000Z',
  })
  assert.equal(createPairing(directory, { clock: fixedClock(), random: draws([31]) }).code, '9999-9999')
  assert.equal(createPairing(directory, { clock: fixedClock(), random: draws([8, 9, 10, 11, 12, 13, 14, 15]) }).code, 'JKLM-NPQR')
  for (let index = 0; index < 200; index += 1) {
    assert.match(createPairing(directory, { clock: fixedClock() }).code, CODE)
  }
})

test('pairing codes are drawn with crypto.randomInt by default', (t) => {
  const directory = stateDirectory(t)
  const randomInt = t.mock.method(crypto, 'randomInt', () => 30)

  assert.equal(createPairing(directory, { clock: fixedClock() }).code, '8888-8888')
  assert.equal(randomInt.mock.callCount(), 8)
  for (const call of randomInt.mock.calls) assert.deepEqual(call.arguments, [ALPHABET.length])
})

test('a random source outside the alphabet is refused and writes nothing', (t) => {
  const directory = stateDirectory(t)

  for (const value of [-1, 32, 1.5, NaN, '3']) {
    assert.throws(() => createPairing(directory, { clock: fixedClock(), random: () => value }))
  }
  assert.throws(() => createPairing(directory, { clock: () => 'now', random: draws([0]) }))
  assert.deepEqual(fs.readdirSync(directory), [])
})

test('the code is stored atomically in pairing.json with mode 0600', (t) => {
  const directory = stateDirectory(t)
  // A world-readable file in the way is replaced, not rewritten in place.
  fs.writeFileSync(pairingPath(directory), 'stale', { mode: 0o644 })
  fs.chmodSync(pairingPath(directory), 0o644)

  createPairing(directory, { clock: fixedClock(), random: draws([0, 1, 2, 3, 4, 5, 6, 7]) })

  assert.deepEqual(readJson(pairingPath(directory)), {
    version: 1,
    code: 'ABCD-EFGH',
    createdAt: '2026-09-23T10:00:00.000Z',
    used: false,
  })
  assert.equal(modeOf(pairingPath(directory)), 0o600)
  assert.deepEqual(fs.readdirSync(directory), ['pairing.json'])
})

test('a new code replaces the previous one and clears an earlier pairing result', async (t) => {
  const directory = stateDirectory(t)
  createPairing(directory, { clock: fixedClock(), random: draws([0, 1, 2, 3, 4, 5, 6, 7]) })
  assert.equal((await pair(directory, '/pair ABCD-EFGH')).ok, true)
  assert.equal(readPairingStatus(directory, fixedClock(START + 2000)).status, 'paired')

  assert.deepEqual(createPairing(directory, { clock: fixedClock(START + 5000), random: draws([8, 9, 10, 11, 12, 13, 14, 15]) }), {
    code: 'JKLM-NPQR',
    expiresAt: '2026-09-23T10:10:05.000Z',
  })
  assert.deepEqual(readJson(pairingPath(directory)), {
    version: 1,
    code: 'JKLM-NPQR',
    createdAt: '2026-09-23T10:00:05.000Z',
    used: false,
  })
  assert.equal(fs.existsSync(resultPath(directory)), false)
  assert.deepEqual(readPairingStatus(directory, fixedClock(START + 6000)), { status: 'pending' })
  assert.deepEqual(await pair(directory, '/pair ABCD-EFGH', { clock: fixedClock(START + 6000) }), { ok: false, reason: 'code' })
})

test('status is none, then pending, then expired at exactly ten minutes', (t) => {
  const directory = stateDirectory(t)

  assert.deepEqual(readPairingStatus(directory, fixedClock()), { status: 'none' })
  createPairing(directory, { clock: fixedClock(), random: draws([0]) })
  assert.deepEqual(readPairingStatus(directory, fixedClock(START)), { status: 'pending' })
  assert.deepEqual(readPairingStatus(directory, fixedClock(START + TEN_MINUTES - 1)), { status: 'pending' })
  assert.deepEqual(readPairingStatus(directory, fixedClock(START + TEN_MINUTES)), { status: 'expired' })
  assert.deepEqual(readPairingStatus(directory, fixedClock(START + 24 * 60 * TEN_MINUTES)), { status: 'expired' })
})

test('a code is refused at exactly ten minutes and accepted a millisecond before', async (t) => {
  const expired = stateDirectory(t)
  createPairing(expired, { clock: fixedClock(), random: draws([0, 1, 2, 3, 4, 5, 6, 7]) })
  assert.deepEqual(await pair(expired, '/pair ABCD-EFGH', { clock: fixedClock(START + TEN_MINUTES) }), { ok: false, reason: 'expired' })
  assert.equal(fs.existsSync(resultPath(expired)), false)

  const live = stateDirectory(t)
  createPairing(live, { clock: fixedClock(), random: draws([0, 1, 2, 3, 4, 5, 6, 7]) })
  assert.equal((await pair(live, '/pair ABCD-EFGH', { clock: fixedClock(START + TEN_MINUTES - 1) })).ok, true)
})

test('a successful pairing writes the result with mode 0600 and marks the code used', async (t) => {
  const directory = stateDirectory(t)
  createPairing(directory, { clock: fixedClock(), random: draws([0, 1, 2, 3, 4, 5, 6, 7]) })
  const lookup = memberLookup()

  assert.deepEqual(await pair(directory, '/pair ABCD-EFGH', { lookup, clock: fixedClock(START + 90_000) }), {
    ok: true,
    chatId: -100123,
    adminUserId: 42,
  })
  assert.deepEqual(lookup.calls, [[-100123, 42]])
  assert.deepEqual(readJson(resultPath(directory)), {
    version: 1,
    chatId: -100123,
    chatTitle: 'Acme alerts',
    adminUserId: 42,
    pairedAt: '2026-09-23T10:01:30.000Z',
  })
  assert.equal(modeOf(resultPath(directory)), 0o600)
  assert.deepEqual(readJson(pairingPath(directory)), {
    version: 1,
    code: 'ABCD-EFGH',
    createdAt: '2026-09-23T10:00:00.000Z',
    used: true,
  })
  assert.equal(modeOf(pairingPath(directory)), 0o600)
  assert.deepEqual(fs.readdirSync(directory).sort(), ['pairing-result.json', 'pairing.json'])
  assert.deepEqual(readPairingStatus(directory, fixedClock(START + 24 * 60 * TEN_MINUTES)), {
    status: 'paired',
    chatId: -100123,
    chatTitle: 'Acme alerts',
    adminUserId: 42,
    pairedAt: '2026-09-23T10:01:30.000Z',
  })
})

for (const text of [
  '/pair ABCD-EFGH',
  '/pair abcd-efgh',
  '/pair aBcD-eFgH',
  '/pair ABCDEFGH',
  '/pair abcdefgh',
  `/pair@${BOT} ABCD-EFGH`,
  `/pair@${BOT.toUpperCase()} abcd-efgh`,
  `/pair@${BOT} abcdefgh`,
  '/pair   ABCD-EFGH  ',
  '/pair\tABCD-EFGH\n',
]) {
  test(`accepts the pairing message ${JSON.stringify(text)}`, async (t) => {
    const directory = stateDirectory(t)
    createPairing(directory, { clock: fixedClock(), random: draws([0, 1, 2, 3, 4, 5, 6, 7]) })

    assert.deepEqual(await pair(directory, text), { ok: true, chatId: -100123, adminUserId: 42 })
    assert.equal(readJson(resultPath(directory)).chatId, -100123)
  })
}

for (const [label, update] of [
  ['ordinary text', pairingUpdate('hello team')],
  ['another bot', pairingUpdate('/pair@other_bot ABCD-EFGH')],
  ['a bot name prefix', pairingUpdate(`/pair@${BOT}x ABCD-EFGH`)],
  ['no code', pairingUpdate('/pair')],
  ['a short code', pairingUpdate('/pair ABCD-EFG')],
  ['a long code', pairingUpdate('/pair ABCD-EFGHJ')],
  ['a misplaced hyphen', pairingUpdate('/pair ABC-DEFGH')],
  ['two hyphens', pairingUpdate('/pair ABCD--EFGH')],
  ['no separator', pairingUpdate('/pairABCD-EFGH')],
  ['trailing words', pairingUpdate('/pair ABCD-EFGH now')],
  ['leading text', pairingUpdate('please /pair ABCD-EFGH')],
  ['a caption-only message', { update_id: 7, message: { ...pairingUpdate('x').message, text: undefined, caption: '/pair ABCD-EFGH' } }],
  ['a callback query', { update_id: 7, callback_query: { id: 'cb', data: '/pair ABCD-EFGH' } }],
  ['an empty update', {}],
  ['no update', null],
]) {
  test(`ignores ${label} without touching pairing state`, async (t) => {
    const directory = stateDirectory(t)
    createPairing(directory, { clock: fixedClock(), random: draws([0, 1, 2, 3, 4, 5, 6, 7]) })
    const before = snapshot(directory)
    const lookup = memberLookup()

    assert.equal(await pair(directory, null, { update, lookup }), null)
    assert.deepEqual(lookup.calls, [])
    assert.deepEqual(snapshot(directory), before)
  })
}

for (const [label, options, reason, lookedUp] of [
  ['a non-forum supergroup', { chat: { is_forum: false } }, 'chat-type', false],
  ['a basic group', { chat: { type: 'group', id: -123 } }, 'chat-type', false],
  ['a private chat', { chat: { type: 'private', id: 42, is_forum: undefined } }, 'chat-type', false],
  ['a public chat', { chat: { username: 'acme_public' } }, 'chat-type', false],
  ['a non-admin sender', { from: { id: 91 } }, 'not-admin', true],
]) {
  test(`rejects pairing from ${label} and writes no result`, async (t) => {
    const directory = stateDirectory(t)
    createPairing(directory, { clock: fixedClock(), random: draws([0, 1, 2, 3, 4, 5, 6, 7]) })
    const before = snapshot(directory)
    const lookup = memberLookup((chatId, userId) => ({ status: userId === 42 ? 'creator' : 'member', user: { id: userId } }))

    assert.deepEqual(await pair(directory, null, { update: pairingUpdate('/pair ABCD-EFGH', options), lookup }), { ok: false, reason })
    assert.equal(lookup.calls.length > 0, lookedUp)
    assert.deepEqual(snapshot(directory), before)
  })
}

test('rejects a wrong code and writes no result', async (t) => {
  const directory = stateDirectory(t)
  createPairing(directory, { clock: fixedClock(), random: draws([0, 1, 2, 3, 4, 5, 6, 7]) })
  const before = snapshot(directory)
  const lookup = memberLookup()

  for (const text of ['/pair ABCD-EFGJ', '/pair EFGH-ABCD', `/pair@${BOT} ZZZZ-ZZZZ`]) {
    assert.deepEqual(await pair(directory, text, { lookup }), { ok: false, reason: 'code' })
  }
  assert.deepEqual(lookup.calls, [])
  assert.deepEqual(snapshot(directory), before)
})

test('rejects a reused code and leaves the first result in place', async (t) => {
  const directory = stateDirectory(t)
  createPairing(directory, { clock: fixedClock(), random: draws([0, 1, 2, 3, 4, 5, 6, 7]) })
  assert.equal((await pair(directory, '/pair ABCD-EFGH')).ok, true)
  const before = snapshot(directory)
  const lookup = memberLookup()

  const reuse = pairingUpdate('/pair ABCD-EFGH', { chat: { id: -100999, title: 'Other forum' }, from: { id: 91 } })
  assert.deepEqual(await pair(directory, null, { update: reuse, lookup }), { ok: false, reason: 'used' })
  assert.deepEqual(lookup.calls, [])
  assert.deepEqual(snapshot(directory), before)
})

test('without a stored code every pairing message is refused and nothing is written', async (t) => {
  const directory = stateDirectory(t)

  assert.deepEqual(await pair(directory, '/pair ABCD-EFGH'), { ok: false, reason: 'code' })
  fs.writeFileSync(pairingPath(directory), '{"version":1,', { mode: 0o600 })
  assert.deepEqual(await pair(directory, '/pair ABCD-EFGH'), { ok: false, reason: 'code' })
  fs.writeFileSync(pairingPath(directory), JSON.stringify({ version: 2, code: 'ABCD-EFGH', createdAt: new Date(START).toISOString(), used: false }))
  assert.deepEqual(await pair(directory, '/pair ABCD-EFGH'), { ok: false, reason: 'code' })
  assert.equal(fs.existsSync(resultPath(directory)), false)
})

test('the stored code is re-read for every message, so a code created by another process applies at once', async (t) => {
  const directory = stateDirectory(t)
  createPairing(directory, { clock: fixedClock(), random: draws([0, 1, 2, 3, 4, 5, 6, 7]) })
  assert.deepEqual(await pair(directory, '/pair JKLM-NPQR'), { ok: false, reason: 'code' })

  createPairing(directory, { clock: fixedClock(), random: draws([8, 9, 10, 11, 12, 13, 14, 15]) })
  assert.equal((await pair(directory, '/pair JKLM-NPQR')).ok, true)
})

test('a code replaced while membership is checked is not consumed and writes no result', async (t) => {
  const directory = stateDirectory(t)
  createPairing(directory, { clock: fixedClock(), random: draws([0, 1, 2, 3, 4, 5, 6, 7]) })
  const lookup = memberLookup((chatId, userId) => {
    createPairing(directory, { clock: fixedClock(START + 500), random: draws([8, 9, 10, 11, 12, 13, 14, 15]) })
    return { status: 'administrator', user: { id: userId } }
  })

  assert.deepEqual(await pair(directory, '/pair ABCD-EFGH', { lookup }), { ok: false, reason: 'code' })
  assert.equal(fs.existsSync(resultPath(directory)), false)
  assert.deepEqual(readJson(pairingPath(directory)), {
    version: 1,
    code: 'JKLM-NPQR',
    createdAt: '2026-09-23T10:00:00.500Z',
    used: false,
  })
})

test('top-level update fields cannot stand in for the Telegram message', async (t) => {
  const directory = stateDirectory(t)
  createPairing(directory, { clock: fixedClock(), random: draws([0, 1, 2, 3, 4, 5, 6, 7]) })
  const lookup = memberLookup((chatId, userId) => ({ status: userId === 42 ? 'member' : 'administrator', user: { id: userId } }))
  const update = { ...pairingUpdate('/pair ABCD-EFGH'), code: 'ABCD-EFGH', chatId: -100999, adminUserId: 7, userId: 7 }

  assert.deepEqual(await pair(directory, null, { update, lookup }), { ok: false, reason: 'not-admin' })
  assert.deepEqual(lookup.calls, [[-100123, 42]])
  assert.equal(fs.existsSync(resultPath(directory)), false)
})

test('a missing or malformed chat title is stored as empty text', async (t) => {
  for (const title of [undefined, 42, { text: 'x' }]) {
    const directory = stateDirectory(t)
    createPairing(directory, { clock: fixedClock(), random: draws([0, 1, 2, 3, 4, 5, 6, 7]) })
    assert.equal((await pair(directory, null, { update: pairingUpdate('/pair ABCD-EFGH', { chat: { title } }) })).ok, true)
    assert.equal(readJson(resultPath(directory)).chatTitle, '')
  }
})

test('an invalid pairing result is not reported as paired', (t) => {
  const directory = stateDirectory(t)
  const valid = { version: 1, chatId: -100123, chatTitle: 'Acme alerts', adminUserId: 42, pairedAt: '2026-09-23T10:01:30.000Z' }

  for (const result of [
    '{"version":1,',
    JSON.stringify([valid]),
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, chatId: -123 }),
    JSON.stringify({ ...valid, chatId: '-100123' }),
    JSON.stringify({ ...valid, adminUserId: 0 }),
    JSON.stringify({ ...valid, chatTitle: 7 }),
    JSON.stringify({ ...valid, pairedAt: 'yesterday' }),
  ]) {
    fs.writeFileSync(resultPath(directory), result, { mode: 0o600 })
    assert.deepEqual(readPairingStatus(directory, fixedClock()), { status: 'none' }, result)
  }
  fs.writeFileSync(resultPath(directory), JSON.stringify(valid), { mode: 0o600 })
  assert.deepEqual(readPairingStatus(directory, fixedClock()), { status: 'paired', ...Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'version')) })
})

test('an invalid stored code reads as no pairing', (t) => {
  const directory = stateDirectory(t)
  const valid = { version: 1, code: 'ABCD-EFGH', createdAt: '2026-09-23T10:00:00.000Z', used: false }

  for (const stored of [
    '',
    'null',
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, code: 'abcd-efgh' }),
    JSON.stringify({ ...valid, code: 'ABCDEFGH' }),
    JSON.stringify({ ...valid, code: 'ABCD-EFG0' }),
    JSON.stringify({ ...valid, createdAt: 'soon' }),
    JSON.stringify({ ...valid, used: 'no' }),
  ]) {
    fs.writeFileSync(pairingPath(directory), stored, { mode: 0o600 })
    assert.deepEqual(readPairingStatus(directory, fixedClock()), { status: 'none' }, stored)
  }
  fs.writeFileSync(pairingPath(directory), JSON.stringify({ ...valid, used: true }), { mode: 0o600 })
  assert.deepEqual(readPairingStatus(directory, fixedClock()), { status: 'none' })
})
