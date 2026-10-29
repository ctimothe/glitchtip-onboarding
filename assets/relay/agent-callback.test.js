'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { openAudit } = require('./audit')
const { readConfig } = require('./config')
const { openQueue } = require('./queue')
const { callbackKeyFor, createRelayServer } = require('./server')

const MINUTE = 60 * 1000
const START = Date.UTC(2026, 8, 23, 10)
const BOT_TOKEN = '987654321:CANARY_bot_token_do_not_leak'
const API_TOKEN = 'gt_canary_api_token_do_not_leak'
const EVENT_ID = 'issue-1842-1:error'
const KEY = callbackKeyFor('acme', EVENT_ID).slice('brief:'.length)

const billing = { id: 'billing-api', name: 'Billing API', projectSlug: 'billing-api', topicId: 44, environments: ['production'] }
const storefront = { id: 'storefront', name: 'Storefront', projectSlug: 'storefront', topicId: 45, environments: ['production'] }

const queuedEvent = (title = 'Checkout failed') => ({
  id: EVENT_ID,
  applicationId: 'billing-api',
  applicationName: 'Billing API',
  projectSlug: 'billing-api',
  environment: 'production',
  state: 'error',
  title,
  issueId: '1842',
  issueUrl: '',
  release: '1.4.2',
  eventCount: null,
  affectedUsers: null,
  windowMinutes: null,
  threshold: null,
  firstSeen: '',
  lastSeen: '',
  incidentMinutes: null,
  quietMinutes: null,
})

const setup = async (t, { title } = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-callback-'))
  const now = { value: START }
  const clock = () => now.value
  const config = readConfig({
    COMPANION_WORKSPACE_ID: 'acme',
    COMPANION_LOCALE: 'en',
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_CHAT_ID: '-100123',
    ALLOWED_MEMBER_IDS: '[42,43]',
    APPLICATIONS_JSON: JSON.stringify([billing, storefront]),
    QUEUE_PATH: path.join(directory, 'state.json'),
    AUDIT_PATH: path.join(directory, 'audit.jsonl'),
    QUEUE_LIMIT: '10',
    GLITCHTIP_API_BASE: 'http://glitchtip.internal:8080/',
    GLITCHTIP_API_TOKEN: API_TOKEN,
    COMPANION_CONFIG_REVISION: 'rev-7',
  })
  const queue = openQueue({ path: config.queuePath, limit: 10, retentionHours: config.retentionHours, clock })
  queue.enqueue(queuedEvent(title))
  const audit = openAudit({ path: config.auditPath })
  const calls = { sendEvent: [], sendPrompt: [], showProviderKeyboard: [], answers: [], polls: 0 }
  const pending = []
  let wake = () => {}
  const telegram = {
    async getMe() { return { id: 987654321, username: 'bot' } },
    async sendEvent(request) { calls.sendEvent.push(request); return 801 },
    async sendPrompt(request) { calls.sendPrompt.push(request); return 802 },
    async showProviderKeyboard(request) { calls.showProviderKeyboard.push(request) },
    async answerCallbackQuery(id, text) { calls.answers.push({ id, text }) },
    async getChatMember() { return { status: 'member', user: { id: 42 } } },
    async pollUpdates(request) {
      calls.polls += 1
      if (pending.length === 0) {
        await new Promise((resolve, reject) => {
          wake = resolve
          request.signal.addEventListener('abort', () => reject({ code: 'network-error' }), { once: true })
        })
      }
      return { updates: pending.splice(0), nextOffset: 100 + calls.polls }
    },
  }
  const relay = createRelayServer({
    config, telegram, queue, audit, clock, sleep: async () => {}, deliveryIntervalMs: 5,
    logger: { info() {}, error() {} },
  })
  await relay.start({ port: 0, host: '127.0.0.1' })
  t.after(async () => {
    await relay.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  await waitFor(() => calls.sendEvent.length === 1)
  let updateId = 0
  const press = async (data, { chat = -100123, member = 42, topic = 44, id } = {}) => {
    updateId += 1
    const before = calls.answers.length
    const callbackId = id || `cb-${updateId}`
    pending.push({
      update_id: updateId,
      callback_query: {
        id: callbackId,
        data,
        from: { id: member },
        message: { message_id: 801, message_thread_id: topic, chat: { id: chat } },
      },
    })
    const polls = calls.polls
    wake()
    await waitFor(() => calls.polls >= polls + 1)
    return { answered: calls.answers.length - before, callbackId }
  }
  const auditText = () => fs.existsSync(config.auditPath) ? fs.readFileSync(config.auditPath, 'utf8') : ''
  return { calls, press, now, auditText }
}

const waitFor = async (predicate, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('condition was not met in time')
}

const EXPIRED = 'Brief expired; request a new one.'

test('the brief button shows the provider keyboard and answers the callback', async (t) => {
  const { calls, press } = await setup(t)
  await press(`brief:${KEY}`)
  assert.equal(calls.showProviderKeyboard.length, 1)
  assert.equal(calls.showProviderKeyboard[0].chatId, -100123)
  assert.equal(calls.showProviderKeyboard[0].messageId, 801)
  const buttons = calls.showProviderKeyboard[0].replyMarkup.inline_keyboard[0]
  assert.deepEqual(buttons.map((b) => b.callback_data), [`provider:${KEY}:c`, `provider:${KEY}:h`, `provider:${KEY}:o`])
  assert.equal(calls.answers.length, 1)
  assert.equal(calls.sendPrompt.length, 0)
})

test('a provider callback sends the prompt to the original topic without a preview and removes the record', async (t) => {
  const { calls, press } = await setup(t)
  await press(`brief:${KEY}`)
  await press(`provider:${KEY}:h`)
  assert.equal(calls.sendPrompt.length, 1)
  assert.equal(calls.sendPrompt[0].chatId, -100123)
  assert.equal(calls.sendPrompt[0].topicId, 44)
  assert.match(calls.sendPrompt[0].text, /^Use \/glitchtip-investigate\./m)
  assert.match(calls.sendPrompt[0].text, /Checkout failed/)
  assert.equal(calls.answers.length, 2)
  // The record is gone: a replay is expired and sends nothing more.
  await press(`provider:${KEY}:h`)
  assert.equal(calls.sendPrompt.length, 1)
  assert.equal(calls.answers.at(-1).text, EXPIRED)
})

test('the selected provider changes only the invocation line', async (t) => {
  const texts = []
  for (const code of ['c', 'h', 'o']) {
    const { calls, press } = await setup(t)
    await press(`brief:${KEY}`)
    await press(`provider:${KEY}:${code}`)
    texts.push(calls.sendPrompt[0].text.split('\n'))
  }
  const differing = texts[0].map((line, index) => index).filter((index) => (
    texts[0][index] !== texts[1][index] || texts[0][index] !== texts[2][index]
  ))
  assert.equal(differing.length, 1)
  assert.match(texts[0][differing[0]], /^Use \$glitchtip-investigate\./)
  assert.match(texts[1][differing[0]], /^Use \/glitchtip-investigate\./)
  assert.match(texts[2][differing[0]], /^Run glitchtip-companion context/)
})

test('unauthorized chats and members get nothing and send no prompt', async (t) => {
  const { calls, press } = await setup(t)
  assert.equal((await press(`brief:${KEY}`, { chat: -100999 })).answered, 0)
  assert.equal((await press(`brief:${KEY}`, { member: 7 })).answered, 0)
  assert.equal((await press(`provider:${KEY}:c`, { member: 7 })).answered, 0)
  assert.equal(calls.showProviderKeyboard.length, 0)
  assert.equal(calls.sendPrompt.length, 0)
})

test('a provider callback cannot be replayed by another member or topic, or skip the first step', async (t) => {
  const { calls, press } = await setup(t)
  await press(`provider:${KEY}:c`)
  assert.equal(calls.answers.at(-1).text, EXPIRED)
  await press(`brief:${KEY}`)
  await press(`provider:${KEY}:c`, { member: 43 })
  assert.equal(calls.answers.at(-1).text, EXPIRED)
  await press(`provider:${KEY}:c`, { topic: 45 })
  assert.equal(calls.answers.at(-1).text, EXPIRED)
  assert.equal(calls.sendPrompt.length, 0)
  // The legitimate member can still finish.
  await press(`provider:${KEY}:c`)
  assert.equal(calls.sendPrompt.length, 1)
})

test('expired and unknown keys return only the generic answer', async (t) => {
  const { calls, press, now } = await setup(t)
  await press('brief:0123456789abcdef')
  assert.equal(calls.answers.at(-1).text, EXPIRED)
  now.value += 11 * MINUTE
  await press(`brief:${KEY}`)
  assert.equal(calls.answers.at(-1).text, EXPIRED)
  assert.equal(calls.showProviderKeyboard.length, 0)
  assert.equal(calls.sendPrompt.length, 0)
})

test('the second step expires ten minutes after the first', async (t) => {
  const { calls, press, now } = await setup(t)
  await press(`brief:${KEY}`)
  now.value += 11 * MINUTE
  await press(`provider:${KEY}:c`)
  assert.equal(calls.answers.at(-1).text, EXPIRED)
  assert.equal(calls.sendPrompt.length, 0)
})

test('secret canaries never reach Telegram calls or the audit log', async (t) => {
  const { calls, press, auditText } = await setup(t, { title: `leak ${API_TOKEN} and ${BOT_TOKEN}` })
  await press(`brief:${KEY}`)
  await press(`provider:${KEY}:o`)
  const everything = JSON.stringify([calls.showProviderKeyboard, calls.sendPrompt, calls.answers]) + auditText()
  assert.equal(calls.sendPrompt.length, 0)
  assert.ok(!everything.includes(API_TOKEN))
  assert.ok(!everything.includes(BOT_TOKEN))
  assert.equal(calls.answers.length, 2)
})
