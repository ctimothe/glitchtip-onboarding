'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { createTelegramClient } = require('./telegram')

const TOKEN = '123456789:AAExampleBotToken_1234567890'
const BOT_URL = `https://api.telegram.org/bot${TOKEN}`
const TOPIC_COLORS = [7322096, 16766590, 13338331, 9367192, 16749490, 16478047]

const response = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body,
})

const recordingFetch = (...responses) => {
  const calls = []
  const fetchFn = async (url, init) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (next instanceof Error) throw next
    if (typeof next === 'function') return next(url, init)
    return next
  }
  return { calls, fetchFn }
}

const bodyAt = (calls, index = 0) => JSON.parse(calls[index].init.body)

test('sendEvent posts escaped HTML to one topic with one callback button', async () => {
  const { calls, fetchFn } = recordingFetch(response({
    ok: true,
    result: { message_id: 801 },
  }))
  const telegram = createTelegramClient({ token: TOKEN, fetchFn })

  const messageId = await telegram.sendEvent({
    chatId: -100123,
    topicId: 44,
    message: '<b>ERROR · Billing API · production</b>\n...',
    callbackKey: 'brief:4d8b1d9c8eaf2b4a',
    actionText: 'Prepare agent brief',
  })

  assert.equal(messageId, 801)
  assert.equal(calls[0].url, `${BOT_URL}/sendMessage`)
  assert.deepEqual(calls[0].init, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: -100123,
      message_thread_id: 44,
      text: '<b>ERROR · Billing API · production</b>\n...',
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [[{
          text: 'Prepare agent brief',
          callback_data: 'brief:4d8b1d9c8eaf2b4a',
        }]],
      },
    }),
  })
})

test('sendEvent omits the keyboard when no callback key is supplied', async () => {
  const { calls, fetchFn } = recordingFetch(response({
    ok: true,
    result: { message_id: 802 },
  }))
  const telegram = createTelegramClient({ token: TOKEN, fetchFn })

  await telegram.sendEvent({ chatId: -100123, topicId: 44, message: '<b>TEST</b>' })

  assert.deepEqual(bodyAt(calls), {
    chat_id: -100123,
    message_thread_id: 44,
    text: '<b>TEST</b>',
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  })
})

test('sendEvent labels the callback button with the supplied localized action text', async () => {
  const { calls, fetchFn } = recordingFetch(response({
    ok: true,
    result: { message_id: 803 },
  }))
  const telegram = createTelegramClient({ token: TOKEN, fetchFn })

  await telegram.sendEvent({
    chatId: -100123,
    topicId: 44,
    message: '<b>XATO</b>',
    callbackKey: 'brief:4d8b1d9c8eaf2b4a',
    actionText: 'Agent uchun maʼlumot tayyorlash',
  })

  assert.deepEqual(bodyAt(calls).reply_markup, {
    inline_keyboard: [[{
      text: 'Agent uchun maʼlumot tayyorlash',
      callback_data: 'brief:4d8b1d9c8eaf2b4a',
    }]],
  })
})

test('sendEvent requires action text exactly when a callback key is supplied', async () => {
  const { calls, fetchFn } = recordingFetch()
  const telegram = createTelegramClient({ token: TOKEN, fetchFn })
  const base = { chatId: -100123, topicId: 44, message: 'event' }

  for (const options of [
    { ...base, callbackKey: 'brief:4d8b1d9c8eaf2b4a' },
    { ...base, callbackKey: 'brief:4d8b1d9c8eaf2b4a', actionText: '   ' },
    { ...base, callbackKey: 'brief:4d8b1d9c8eaf2b4a', actionText: 42 },
    { ...base, actionText: 'Prepare agent brief' },
  ]) {
    await assert.rejects(
      telegram.sendEvent(options),
      { code: 'invalid-input', retryAfterSeconds: null, description: 'Invalid actionText' },
    )
  }
  assert.equal(calls.length, 0)
})

test('sendEvent rejects callback data over 64 UTF-8 bytes before fetching', async () => {
  const { calls, fetchFn } = recordingFetch()
  const telegram = createTelegramClient({ token: TOKEN, fetchFn })
  const callbackKey = `${'🤖'.repeat(16)}x`

  await assert.rejects(
    telegram.sendEvent({ chatId: -100123, topicId: 44, message: 'event', callbackKey }),
    { code: 'invalid-input', retryAfterSeconds: null, description: 'Invalid callbackKey' },
  )
  assert.equal(Buffer.byteLength(callbackKey, 'utf8'), 65)
  assert.equal(calls.length, 0)
})

test('createTopic posts a Telegram-supported native topic color', async () => {
  for (const iconColor of TOPIC_COLORS) {
    const { calls, fetchFn } = recordingFetch(response({
      ok: true,
      result: { message_thread_id: 44 },
    }))
    const telegram = createTelegramClient({ token: TOKEN, fetchFn })

    assert.equal(await telegram.createTopic({
      chatId: -100123,
      name: 'Billing API',
      iconColor,
    }), 44)
    assert.equal(calls[0].url, `${BOT_URL}/createForumTopic`)
    assert.deepEqual(bodyAt(calls), {
      chat_id: -100123,
      name: 'Billing API',
      icon_color: iconColor,
    })
  }
})

test('createTopic rejects colors outside Telegram native topic colors', async () => {
  const { calls, fetchFn } = recordingFetch()
  const telegram = createTelegramClient({ token: TOKEN, fetchFn })

  await assert.rejects(
    telegram.createTopic({ chatId: -100123, name: 'Billing API', iconColor: 0x123456 }),
    { code: 'invalid-input', retryAfterSeconds: null, description: 'Invalid iconColor' },
  )
  assert.equal(calls.length, 0)
})

test('pollUpdates defaults timeout, pins allowed updates, and advances from the maximum id', async () => {
  const { calls, fetchFn } = recordingFetch(response({
    ok: true,
    result: [
      { update_id: 12, message: { text: 'newer' } },
      { update_id: 9, callback_query: { id: 'older' } },
    ],
  }))
  const telegram = createTelegramClient({ token: TOKEN, fetchFn })

  assert.deepEqual(await telegram.pollUpdates({ offset: 8 }), {
    updates: [
      { update_id: 12, message: { text: 'newer' } },
      { update_id: 9, callback_query: { id: 'older' } },
    ],
    nextOffset: 13,
  })
  assert.equal(calls[0].url, `${BOT_URL}/getUpdates`)
  assert.deepEqual(bodyAt(calls), {
    offset: 8,
    timeout: 25,
    allowed_updates: ['message', 'callback_query', 'my_chat_member'],
  })
})

test('pollUpdates accepts timeout 25, passes the signal, and never moves offset backwards', async () => {
  const controller = new AbortController()
  const { calls, fetchFn } = recordingFetch(
    response({ ok: true, result: [{ update_id: 12 }] }),
    response({ ok: true, result: [] }),
  )
  const telegram = createTelegramClient({ token: TOKEN, fetchFn })

  assert.deepEqual(await telegram.pollUpdates({
    offset: 20,
    timeoutSeconds: 25,
    signal: controller.signal,
  }), { updates: [{ update_id: 12 }], nextOffset: 20 })
  assert.equal(calls[0].init.signal, controller.signal)
  assert.deepEqual(bodyAt(calls), {
    offset: 20,
    timeout: 25,
    allowed_updates: ['message', 'callback_query', 'my_chat_member'],
  })

  assert.deepEqual(await telegram.pollUpdates({ offset: 20 }), {
    updates: [],
    nextOffset: 20,
  })
})

test('pollUpdates rejects non-positive, non-integer, and missing update IDs', async () => {
  const invalidUpdates = [
    { update_id: 0 },
    { update_id: -1 },
    { update_id: 1.5 },
    {},
  ]
  const { fetchFn } = recordingFetch(...invalidUpdates.map((update) => response({
    ok: true,
    result: [update],
  })))
  const telegram = createTelegramClient({ token: TOKEN, fetchFn })

  for (const update of invalidUpdates) {
    await assert.rejects(
      telegram.pollUpdates({ offset: 0 }),
      { code: 'invalid-response', retryAfterSeconds: null, description: 'Invalid Telegram response' },
      `update_id ${String(update.update_id)} must fail closed`,
    )
  }
})

test('getMe returns only the bot identity', async () => {
  const { calls, fetchFn } = recordingFetch(response({
    ok: true,
    result: {
      id: 123456789,
      is_bot: true,
      first_name: 'Companion',
      username: 'acme_companion_bot',
      can_join_groups: true,
    },
  }))
  const telegram = createTelegramClient({ token: TOKEN, fetchFn })

  assert.deepEqual(await telegram.getMe(), { id: 123456789, username: 'acme_companion_bot' })
  assert.equal(calls[0].url, `${BOT_URL}/getMe`)
  assert.deepEqual(bodyAt(calls), {})
})

test('getMe fails closed on malformed identities and normalizes Telegram failures', async () => {
  const malformed = [
    null,
    true,
    { username: 'acme_companion_bot' },
    { id: 0, username: 'acme_companion_bot' },
    { id: 1.5, username: 'acme_companion_bot' },
    { id: '123456789', username: 'acme_companion_bot' },
    { id: 123456789 },
    { id: 123456789, username: '' },
    { id: 123456789, username: 42 },
  ]
  const { fetchFn } = recordingFetch(
    ...malformed.map((result) => response({ ok: true, result })),
    response({
      ok: false,
      error_code: 401,
      description: `Unauthorized ${TOKEN}`,
    }, { ok: false, status: 401 }),
  )
  const telegram = createTelegramClient({ token: TOKEN, fetchFn })

  for (const result of malformed) {
    await assert.rejects(
      telegram.getMe(),
      { code: 'invalid-response', retryAfterSeconds: null, description: 'Invalid Telegram response' },
      `getMe result ${JSON.stringify(result)} must fail closed`,
    )
  }
  await assert.rejects(telegram.getMe(), (failure) => {
    assert.equal(failure.code, 401)
    assert.doesNotMatch(failure.description, /123456789|AAExample/)
    return true
  })
})

test('answerCallbackQuery acknowledges only the supplied callback id', async () => {
  const { calls, fetchFn } = recordingFetch(response({ ok: true, result: true }))
  const telegram = createTelegramClient({ token: TOKEN, fetchFn })

  assert.equal(await telegram.answerCallbackQuery('callback-42'), undefined)
  assert.equal(calls[0].url, `${BOT_URL}/answerCallbackQuery`)
  assert.deepEqual(bodyAt(calls), { callback_query_id: 'callback-42' })
})

test('normalizes HTTP and Telegram failures without leaking request URLs or tokens', async () => {
  const description = `Bad Request for ${TOKEN} at ${BOT_URL}/sendMessage ${'x'.repeat(240)}`
  const { fetchFn } = recordingFetch(
    response({
      ok: false,
      error_code: 429,
      description,
      parameters: { retry_after: 17 },
    }, { ok: false, status: 429 }),
    response({ ok: false, error_code: 400, description }, { status: 200 }),
  )
  const telegram = createTelegramClient({ token: TOKEN, fetchFn })

  for (const expectedCode of [429, 400]) {
    await assert.rejects(
      telegram.sendEvent({ chatId: -100123, topicId: 44, message: 'event' }),
      (failure) => {
        assert.deepEqual(Object.keys(failure), ['code', 'retryAfterSeconds', 'description'])
        assert.equal(failure.code, expectedCode)
        assert.equal(failure.retryAfterSeconds, expectedCode === 429 ? 17 : null)
        assert.ok(failure.description.length <= 200)
        assert.doesNotMatch(failure.description, /123456789|AAExample|api\.telegram\.org|sendMessage/)
        assert.match(failure.description, /\[redacted\]/)
        return true
      },
    )
  }
})

test('redacts every accepted token shape from Telegram failure descriptions', async () => {
  const shortToken = '12345:a'
  const description = `Telegram rejected ${shortToken}; surrounding prose remains safe.`
  const { fetchFn } = recordingFetch(response({
    ok: false,
    error_code: 401,
    description,
  }, { ok: false, status: 401 }))
  const telegram = createTelegramClient({ token: shortToken, fetchFn })

  await assert.rejects(
    telegram.sendEvent({ chatId: -100123, topicId: 44, message: 'event' }),
    (failure) => {
      assert.equal(failure.code, 401)
      assert.equal(failure.retryAfterSeconds, null)
      assert.ok(failure.description.length <= 200)
      assert.doesNotMatch(failure.description, /12345:a/)
      assert.match(failure.description, /\[redacted\]/)
      return true
    },
  )
})

test('normalizes malformed JSON, malformed result shapes, and network errors', async () => {
  const { fetchFn } = recordingFetch(
    { ok: true, status: 200, json: async () => { throw new SyntaxError('bad json') } },
    response({ ok: true, result: { message_id: 'not-an-id' } }),
    new Error(`fetch failed for ${BOT_URL}/sendMessage`),
  )
  const telegram = createTelegramClient({ token: TOKEN, fetchFn })
  const event = { chatId: -100123, topicId: 44, message: 'event' }

  await assert.rejects(telegram.sendEvent(event), {
    code: 'invalid-response',
    retryAfterSeconds: null,
    description: 'Invalid Telegram response',
  })
  await assert.rejects(telegram.sendEvent(event), {
    code: 'invalid-response',
    retryAfterSeconds: null,
    description: 'Invalid Telegram response',
  })
  await assert.rejects(telegram.sendEvent(event), {
    code: 'network-error',
    retryAfterSeconds: null,
    description: 'Telegram network request failed',
  })
})

test('validates token, IDs, text, offsets, timeouts, and callback ids before fetching', async () => {
  assert.throws(
    () => createTelegramClient(),
    { code: 'invalid-input', retryAfterSeconds: null, description: 'Invalid token' },
  )
  assert.throws(
    () => createTelegramClient({ token: '', fetchFn: async () => {} }),
    { code: 'invalid-input', retryAfterSeconds: null, description: 'Invalid token' },
  )
  assert.throws(
    () => createTelegramClient({ token: TOKEN, fetchFn: null }),
    { code: 'invalid-input', retryAfterSeconds: null, description: 'Invalid fetchFn' },
  )
  for (const token of [
    'bot:secret',
    '123:',
    ':secret',
    '123:secret/path',
    '123:secret?query',
    '123:secret#fragment',
    '123:se\ncret',
    '123:sëcret',
    '123:\ud800',
  ]) {
    assert.throws(
      () => createTelegramClient({ token, fetchFn: async () => {} }),
      { code: 'invalid-input', retryAfterSeconds: null, description: 'Invalid token' },
      `invalid token ${JSON.stringify(token)} must not reach URI construction`,
    )
  }

  const { calls, fetchFn } = recordingFetch()
  const telegram = createTelegramClient({ token: TOKEN, fetchFn })
  const invalidCalls = [
    telegram.sendEvent({ chatId: -100123.5, topicId: 44, message: 'event' }),
    telegram.sendEvent({ chatId: -123, topicId: 44, message: 'event' }),
    telegram.createTopic({ chatId: -100, name: 'Billing API', iconColor: TOPIC_COLORS[0] }),
    telegram.sendEvent({ chatId: -100123, topicId: 0, message: 'event' }),
    telegram.sendEvent({ chatId: -100123, topicId: 44, message: '' }),
    telegram.createTopic({ chatId: 123, name: 'Billing API', iconColor: TOPIC_COLORS[0] }),
    telegram.createTopic({ chatId: -100123, name: ' ', iconColor: TOPIC_COLORS[0] }),
    telegram.pollUpdates({ offset: -1 }),
    telegram.pollUpdates({ offset: 0, timeoutSeconds: 51 }),
    telegram.answerCallbackQuery(''),
  ]

  for (const call of invalidCalls) {
    await assert.rejects(call, (failure) => {
      assert.deepEqual(Object.keys(failure), ['code', 'retryAfterSeconds', 'description'])
      assert.equal(failure.code, 'invalid-input')
      return true
    })
  }
  assert.equal(calls.length, 0)
})

test('fails closed when an HTTP failure carries an apparent Bot API success', async () => {
  const { fetchFn } = recordingFetch(response({ ok: true, result: { message_id: 801 } }, {
    ok: false,
    status: 503,
  }))
  const telegram = createTelegramClient({ token: TOKEN, fetchFn })

  await assert.rejects(
    telegram.sendEvent({ chatId: -100123, topicId: 44, message: 'event' }),
    { code: 503, retryAfterSeconds: null, description: 'Telegram HTTP request failed' },
  )
})

test('getChatMember posts the chat and user and returns only the status and user id', async () => {
  const { calls, fetchFn } = recordingFetch(response({
    ok: true,
    result: {
      status: 'administrator',
      user: { id: 42, is_bot: false, first_name: 'Owner', username: 'owner' },
      can_manage_topics: true,
      custom_title: 'Lead',
    },
  }))
  const telegram = createTelegramClient({ token: TOKEN, fetchFn })

  assert.deepEqual(await telegram.getChatMember(-100123, 42), { status: 'administrator', user: { id: 42 } })
  assert.equal(calls[0].url, `${BOT_URL}/getChatMember`)
  assert.deepEqual(calls[0].init, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: -100123, user_id: 42 }),
  })
})

test('getChatMember fails closed on malformed memberships', async () => {
  const malformed = [
    null,
    true,
    [],
    { user: { id: 42 } },
    { status: '', user: { id: 42 } },
    { status: 7, user: { id: 42 } },
    { status: 'member' },
    { status: 'member', user: null },
    { status: 'member', user: { id: 0 } },
    { status: 'member', user: { id: '42' } },
    { status: 'member', user: { id: 4.2 } },
  ]
  const { fetchFn } = recordingFetch(...malformed.map((result) => response({ ok: true, result })))
  const telegram = createTelegramClient({ token: TOKEN, fetchFn })

  for (const result of malformed) {
    await assert.rejects(
      telegram.getChatMember(-100123, 42),
      { code: 'invalid-response', retryAfterSeconds: null, description: 'Invalid Telegram response' },
      `getChatMember result ${JSON.stringify(result)} must fail closed`,
    )
  }
})

test('getChatMember validates its arguments before fetching and redacts failures', async () => {
  const { calls, fetchFn } = recordingFetch(response({
    ok: false,
    error_code: 400,
    description: `Bad Request: member not found for ${TOKEN}`,
  }, { ok: false, status: 400 }))
  const telegram = createTelegramClient({ token: TOKEN, fetchFn })

  for (const [chatId, userId] of [[-123, 42], [123, 42], [-100123, 0], [-100123, -42], [-100123, '42'], [-100123, 1.5]]) {
    await assert.rejects(telegram.getChatMember(chatId, userId), (failure) => {
      assert.equal(failure.code, 'invalid-input')
      return true
    })
  }
  assert.equal(calls.length, 0)

  await assert.rejects(telegram.getChatMember(-100123, 42), (failure) => {
    assert.equal(failure.code, 400)
    assert.doesNotMatch(failure.description, /123456789|AAExample/)
    return true
  })
})
