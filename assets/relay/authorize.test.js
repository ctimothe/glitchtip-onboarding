'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { authorizeUpdate, consumePairingCode } = require('./authorize')

const application = {
  id: 'billing-api',
  name: 'Billing API',
  projectSlug: 'billing-api',
  topicId: 44,
  environments: ['production'],
}

const config = {
  chatId: -100123,
  allowedMemberIds: [42, 91],
  applications: [application],
}

const update = (overrides = {}) => ({
  chatId: -100123,
  memberId: 42,
  topicId: 44,
  applicationId: 'billing-api',
  issueId: '1842',
  ...overrides,
})

const incident = (overrides = {}) => ({
  applicationId: 'billing-api',
  issueId: '1842',
  ...overrides,
})

test('authorizes only a callback matching every workspace boundary', () => {
  assert.deepEqual(authorizeUpdate(config, update(), incident()), {
    ok: true,
    application,
  })
})

for (const [label, overrides, expected] of [
  ['chat', { chatId: -100999 }, 'chat'],
  ['member', { memberId: 777 }, 'member'],
  ['topic', { topicId: 45 }, 'topic'],
  ['application', { applicationId: 'other-api' }, 'application'],
  ['issue', { issueId: '9999' }, 'incident'],
]) {
  test(`rejects a callback with a mismatched ${label} without echoing it`, () => {
    const result = authorizeUpdate(config, update(overrides), incident())
    assert.deepEqual(result, { ok: false, reason: expected })
    assert.equal(JSON.stringify(result).includes(String(Object.values(overrides)[0])), false)
  })
}

test('rejects an incident assigned to another application', () => {
  assert.deepEqual(
    authorizeUpdate(config, update(), incident({ applicationId: 'other-api' })),
    { ok: false, reason: 'incident' },
  )
})

test('accepts the raw Telegram callback fields after trusted callback metadata is resolved', () => {
  const telegramUpdate = {
    callback_query: {
      from: { id: 42 },
      message: {
        chat: { id: -100123 },
        message_thread_id: 44,
      },
    },
    applicationId: 'billing-api',
    issueId: '1842',
  }

  assert.deepEqual(authorizeUpdate(config, telegramUpdate, incident()), {
    ok: true,
    application,
  })
})

test('unknown update shapes fail closed without throwing', () => {
  assert.deepEqual(authorizeUpdate(config, null, incident()), { ok: false, reason: 'chat' })
  assert.deepEqual(authorizeUpdate(config, {}, incident()), { ok: false, reason: 'chat' })
})

const startedAt = Date.parse('2026-09-22T10:00:00.000Z')
const validPairingUpdate = (overrides = {}) => ({
  message: {
    text: 'PAIR-4827',
    from: { id: 42 },
    chat: {
      id: -100123,
      type: 'supergroup',
      is_forum: true,
    },
  },
  ...overrides,
})

const pairingState = (membership = { status: 'administrator', user: { id: 42 } }) => ({
  code: 'PAIR-4827',
  createdAt: startedAt,
  used: false,
  getChatMember: (chatId, userId) => {
    assert.equal(chatId, -100123)
    assert.equal(userId, 42)
    return membership
  },
})

const assertPromiseResult = async (actual, expected) => {
  assert.ok(actual instanceof Promise, 'consumePairingCode must always return a Promise')
  assert.deepEqual(await actual, expected)
}

test('consumes a pairing code once for a forum supergroup administrator', async () => {
  const state = pairingState()
  assert.deepEqual(await consumePairingCode(state, validPairingUpdate(), startedAt + 599_999), {
    ok: true,
    chatId: -100123,
    adminUserId: 42,
  })
  assert.equal(state.used, true)
  assert.deepEqual(await consumePairingCode(state, validPairingUpdate(), startedAt + 599_999), {
    ok: false,
    reason: 'used',
  })
})

test('pairing expires exactly ten minutes after creation', async () => {
  assert.equal((await consumePairingCode(
    pairingState(),
    validPairingUpdate(),
    startedAt + 599_999,
  )).ok, true)
  assert.deepEqual(await consumePairingCode(
    pairingState(),
    validPairingUpdate(),
    startedAt + 600_000,
  ), { ok: false, reason: 'expired' })
})

test('pairing never lets expiresAt replace or extend the ten-minute createdAt window', async () => {
  for (const createdAt of [undefined, 'invalid']) {
    const state = pairingState()
    state.createdAt = createdAt
    state.expiresAt = startedAt + 24 * 60 * 60 * 1_000
    assert.deepEqual(
      await consumePairingCode(state, validPairingUpdate(), startedAt),
      { ok: false, reason: 'expired' },
    )
  }

  const extended = pairingState()
  extended.expiresAt = startedAt + 24 * 60 * 60 * 1_000
  assert.deepEqual(
    await consumePairingCode(extended, validPairingUpdate(), startedAt + 600_000),
    { ok: false, reason: 'expired' },
  )
})

test('pairing rejects a clock before the code was created', async () => {
  assert.deepEqual(await consumePairingCode(
    pairingState(),
    validPairingUpdate(),
    startedAt - 1,
  ), { ok: false, reason: 'expired' })
})

for (const chat of [
  { id: 123, type: 'supergroup', is_forum: true },
  { id: -123, type: 'supergroup', is_forum: true },
  { id: -100123, type: 'group', is_forum: true },
  { id: -100123, type: 'supergroup', is_forum: false },
  { id: -100123, type: 'supergroup', is_forum: true, username: 'public_group' },
]) {
  test(`pairing rejects chat type ${JSON.stringify(chat)}`, async () => {
    assert.deepEqual(await consumePairingCode(
      pairingState(),
      validPairingUpdate({ message: { ...validPairingUpdate().message, chat } }),
      startedAt,
    ), { ok: false, reason: 'chat-type' })
  })
}

for (const status of ['creator', 'administrator']) {
  test(`pairing accepts ${status} membership returned by getChatMember`, async () => {
    const result = await consumePairingCode(
      pairingState({ status, user: { id: 42 } }),
      validPairingUpdate(),
      startedAt,
    )
    assert.equal(result.ok, true)
  })
}

for (const membership of [
  { status: 'member', user: { id: 42 } },
  { status: 'administrator', user: { id: 91 } },
  { status: 'administrator' },
]) {
  test(`pairing rejects non-admin membership ${JSON.stringify(membership)}`, async () => {
    assert.deepEqual(await consumePairingCode(
      pairingState(membership),
      validPairingUpdate(),
      startedAt,
    ), { ok: false, reason: 'not-admin' })
  })
}

test('pairing supports asynchronous getChatMember without leaking failures', async () => {
  const state = pairingState()
  state.getChatMember = async () => ({ status: 'administrator', user: { id: 42 } })
  assert.equal((await consumePairingCode(state, validPairingUpdate(), startedAt)).ok, true)

  const failingState = pairingState()
  failingState.getChatMember = async () => { throw new Error('private Telegram context') }
  assert.deepEqual(
    await consumePairingCode(failingState, validPairingUpdate(), startedAt),
    { ok: false, reason: 'not-admin' },
  )
})

test('pairing rejects cached membership objects without a live getChatMember adapter', async () => {
  const cachedMembership = { status: 'administrator', user: { id: 42 } }
  for (const location of ['state', 'update']) {
    const state = pairingState()
    delete state.getChatMember
    const pairingUpdate = validPairingUpdate()
    if (location === 'state') state.chatMember = cachedMembership
    else pairingUpdate.chatMember = cachedMembership

    assert.deepEqual(
      await consumePairingCode(state, pairingUpdate, startedAt),
      { ok: false, reason: 'not-admin' },
    )
    assert.equal(state.used, false)
  }
})

test('pairing always returns a Promise, including every early rejection path', async () => {
  const usedState = pairingState()
  usedState.used = true
  const expiredState = pairingState()
  const wrongCodeUpdate = validPairingUpdate({
    message: { ...validPairingUpdate().message, text: 'wrong' },
  })
  const wrongChatUpdate = validPairingUpdate({
    message: {
      ...validPairingUpdate().message,
      chat: { id: -100123, type: 'group', is_forum: true },
    },
  })
  const noMemberLookupState = pairingState()
  delete noMemberLookupState.getChatMember

  await assertPromiseResult(
    consumePairingCode(null, validPairingUpdate(), startedAt),
    { ok: false, reason: 'code' },
  )
  await assertPromiseResult(
    consumePairingCode(usedState, validPairingUpdate(), startedAt),
    { ok: false, reason: 'used' },
  )
  await assertPromiseResult(
    consumePairingCode(expiredState, validPairingUpdate(), startedAt + 600_000),
    { ok: false, reason: 'expired' },
  )
  await assertPromiseResult(
    consumePairingCode(pairingState(), wrongCodeUpdate, startedAt),
    { ok: false, reason: 'code' },
  )
  await assertPromiseResult(
    consumePairingCode(pairingState(), wrongChatUpdate, startedAt),
    { ok: false, reason: 'chat-type' },
  )
  await assertPromiseResult(
    consumePairingCode(noMemberLookupState, validPairingUpdate(), startedAt),
    { ok: false, reason: 'not-admin' },
  )
  await assertPromiseResult(
    consumePairingCode(pairingState(), validPairingUpdate(), startedAt),
    { ok: true, chatId: -100123, adminUserId: 42 },
  )
})

test('pairing reserves concurrent consumption and releases the reservation after lookup failure', async () => {
  let rejectLookup
  const state = pairingState()
  state.getChatMember = () => new Promise((resolve, reject) => { rejectLookup = reject })

  const first = consumePairingCode(state, validPairingUpdate(), startedAt)
  assert.deepEqual(
    await consumePairingCode(state, validPairingUpdate(), startedAt),
    { ok: false, reason: 'used' },
  )
  rejectLookup(new Error('private Telegram context'))
  assert.deepEqual(await first, { ok: false, reason: 'not-admin' })
  assert.equal(state.consuming, undefined)
  assert.equal(state.used, false)

  state.getChatMember = async () => ({ status: 'creator', user: { id: 42 } })
  assert.equal((await consumePairingCode(state, validPairingUpdate(), startedAt)).ok, true)
})

test('pairing requires the exact code and does not consume rejected attempts', async () => {
  const state = pairingState()
  const result = await consumePairingCode(
    state,
    validPairingUpdate({ message: { ...validPairingUpdate().message, text: 'PAIR-4827 ' } }),
    startedAt,
  )

  assert.deepEqual(result, { ok: false, reason: 'code' })
  assert.equal(state.used, false)
  assert.doesNotMatch(JSON.stringify(result), /PAIR-4827/)
})

test('pairing rejects an empty configured code', async () => {
  const state = pairingState()
  state.code = ''

  assert.deepEqual(await consumePairingCode(
    state,
    validPairingUpdate({ message: { ...validPairingUpdate().message, text: '' } }),
    startedAt,
  ), { ok: false, reason: 'code' })
  assert.equal(state.used, false)
})
