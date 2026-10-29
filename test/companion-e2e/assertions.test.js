'use strict'
/**
 * Companion end to end, hermetic and in-process: the real relay (assets/relay/server.js) runs
 * against a fake GlitchTip and a fake Telegram on ephemeral loopback ports. run.sh runs this file
 * inside Compose; `node --test test/companion-e2e/assertions.test.js` runs it without Docker.
 */
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { openAudit } = require('../../assets/relay/audit')
const { readConfig } = require('../../assets/relay/config')
const { formatMessage } = require('../../assets/relay/format')
const { openQueue } = require('../../assets/relay/queue')
const { createRelayServer } = require('../../assets/relay/server')
const { createTelegramClient } = require('../../assets/relay/telegram')
const { createFakeGlitchTip } = require('./fake-glitchtip')
const { createFakeTelegram } = require('./fake-telegram')

const BOT_TOKEN = '123456:SYNTHETIC_token_for_example_test'
const API_TOKEN = 'synthetic-api-token'
const CHAT_ID = -1001234567890
const MEMBER_ID = 4242
const companionFixture = require('../../assets/relay/fixtures/companion-event.json')
const webhookFixture = require('../../assets/relay/fixtures/glitchtip-webhook.json')

const waitFor = async (predicate, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('condition was not met in time')
}

const companionEvent = (state, eventId) => ({ ...structuredClone(companionFixture), companion_state: state, event_id: eventId })

// Starts the real relay between the two fakes. `revision` and `port` let a test run two relays.
const startStack = async (t, { revision = 'rev-1', topicId, port = 0, applyConfig } = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-e2e-'))
  const live = {}
  t.after(async () => {
    if (live.relay) await live.relay.close()
    await live.telegramFake.close()
    await live.glitchtip.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const telegramFake = createFakeTelegram({ token: BOT_TOKEN, chatId: CHAT_ID, members: [MEMBER_ID] })
  live.telegramFake = telegramFake
  await telegramFake.start()
  const telegramClient = createTelegramClient({ token: BOT_TOKEN, fetchFn: telegramFake.fetchFn })
  const resolvedTopic = topicId ?? await telegramClient.createTopic({ chatId: CHAT_ID, name: 'billing-api', iconColor: 7322096 })
  const glitchtip = createFakeGlitchTip({ apiToken: API_TOKEN })
  live.glitchtip = glitchtip
  await glitchtip.start()
  const config = readConfig({
    COMPANION_WORKSPACE_ID: 'acme',
    COMPANION_LOCALE: 'en',
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_CHAT_ID: String(CHAT_ID),
    ALLOWED_MEMBER_IDS: JSON.stringify([MEMBER_ID]),
    APPLICATIONS_JSON: JSON.stringify([{
      id: 'billing-api',
      name: 'Billing API',
      projectSlug: 'billing-api',
      projectName: 'Billing API',
      topicId: resolvedTopic,
      environments: ['production'],
    }]),
    QUEUE_PATH: path.join(directory, 'state.json'),
    AUDIT_PATH: path.join(directory, 'audit.jsonl'),
    GLITCHTIP_API_BASE: glitchtip.url,
    GLITCHTIP_API_TOKEN: API_TOKEN,
    COMPANION_CONFIG_REVISION: revision,
    ...applyConfig,
  })
  const queue = openQueue({ path: config.queuePath, limit: config.queueLimit, retentionHours: config.retentionHours, clock: Date.now })
  const relay = createRelayServer({
    config,
    telegram: telegramClient,
    queue,
    audit: openAudit({ path: config.auditPath }),
    fetchFn: fetch,
    sleep: async () => {},
    deliveryIntervalMs: 5,
    logger: { info() {}, error() {} },
  })
  live.relay = relay
  const { port: boundPort } = await relay.start({ port, host: '127.0.0.1' })
  const relayUrl = `http://127.0.0.1:${boundPort}`
  glitchtip.relayUrl = relayUrl
  const poster = createFakeGlitchTip({ apiToken: API_TOKEN, relayEventsUrl: `${relayUrl}/v1/glitchtip/events` })
  return { relay, relayUrl, queue, telegramFake, glitchtip, poster, topicId: resolvedTopic, config }
}

test('1. Setup Complete reaches the created topic', async (t) => {
  const { relayUrl, poster, telegramFake, queue, topicId } = await startStack(t)
  assert.ok(telegramFake.captured.some((call) => call.method === 'createForumTopic'))

  const response = await poster.postWebhook(companionEvent('setup_complete', 'setup-e2e-1'))
  assert.equal(response.status, 202, relayUrl)
  await waitFor(() => queue.inspect('setup-e2e-1:setup_complete')?.status === 'delivered')

  const [sent] = telegramFake.sent()
  assert.equal(sent.message_thread_id, topicId)
  assert.equal(sent.chat_id, CHAT_ID)
  assert.match(sent.text, /SETUP COMPLETE/)
})

test('2. Error, Warning, Resolved, Info and Test match the editorial formatting exactly', async (t) => {
  const { poster, telegramFake, queue } = await startStack(t)
  const labels = { error: 'ERROR', warning: 'WARNING', resolved: 'RESOLVED', info: 'INFO', test: 'TEST' }

  for (const state of Object.keys(labels)) {
    assert.equal((await poster.postWebhook(companionEvent(state, `evt-${state}`))).status, 202)
  }
  await waitFor(() => telegramFake.sent().length === 5)

  for (const [state, label] of Object.entries(labels)) {
    const sent = telegramFake.sent().find((body) => body.text.includes(label))
    assert.ok(sent, `${state} message was not sent`)
    assert.equal(sent.text, formatMessage(queue.inspect(`evt-${state}:${state}`), 'en').text)
    assert.equal(sent.parse_mode, 'HTML')
  }
})

test('3. a duplicate Error webhook sends once', async (t) => {
  const { poster, telegramFake, queue } = await startStack(t)

  const first = await poster.postWebhook(webhookFixture)
  const second = await poster.postWebhook(webhookFixture)
  assert.equal(first.body.accepted, 1)
  assert.equal(second.body.duplicates, 1)
  await waitFor(() => telegramFake.sent().length >= 1)
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.equal(telegramFake.sent().length, 1)
  assert.equal(queue.size(), 1)
})

test('4. a 429 retry_after resumes delivery once, without a duplicate', async (t) => {
  const { poster, telegramFake, queue } = await startStack(t)
  telegramFake.rateLimitNextSends(1)

  await poster.postWebhook(companionEvent('warning', 'evt-429'))
  await waitFor(() => queue.inspect('evt-429:warning')?.retryCount === 1)
  assert.equal(queue.inspect('evt-429:warning').failureCode, 'telegram-429')
  await waitFor(() => queue.inspect('evt-429:warning')?.status === 'delivered', 6000)

  const sends = telegramFake.captured.filter((call) => call.method === 'sendMessage')
  assert.equal(sends.length, 2, 'one rejected attempt and one successful retry')
  assert.equal(queue.inspect('evt-429:warning').retryCount, 1)
})

test.todo('5. an authorized member receives provider selection and a safe Codex prompt (needs assets/relay/prompts.js and the callback flow)')
test.todo('6. wrong chat, member, topic, application, incident, replay and expiry produce no prompt (needs the callback flow)')
// 7. The helper is the Mac app's own executable (apps/desktop/src-tauri/src/helper.rs), which reads
// the Keychain and calls GlitchTip over HTTPS only, so it cannot run in this stack. Its sanitized
// evidence, exit codes and canary refusal are covered by that file's tests (`desktop-cargo`).

test('8. a Mac-side process exit does not stop relay delivery', async (t) => {
  const { poster, telegramFake, queue } = await startStack(t)
  const mac = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await new Promise((resolve) => mac.once('spawn', resolve))
  const exited = new Promise((resolve) => mac.once('exit', resolve))
  mac.kill('SIGKILL')
  await exited

  assert.equal((await poster.postWebhook(companionEvent('error', 'evt-mac-gone'))).status, 202)
  await waitFor(() => queue.inspect('evt-mac-gone:error')?.status === 'delivered')
  assert.equal(telegramFake.sent().length, 1)
})

test('9. a failing candidate relay leaves the prior revision serving', async (t) => {
  const prior = await startStack(t, { revision: 'rev-1' })
  const priorPort = new URL(prior.relayUrl).port

  assert.throws(() => readConfig({ COMPANION_WORKSPACE_ID: 'acme', COMPANION_CONFIG_REVISION: 'not valid!' }))
  const candidate = createRelayServer({
    config: prior.config,
    telegram: createTelegramClient({ token: BOT_TOKEN, fetchFn: prior.telegramFake.fetchFn }),
    queue: prior.queue,
    audit: openAudit({ path: path.join(os.tmpdir(), `companion-e2e-candidate-${process.pid}.jsonl`) }),
    logger: { info() {}, error() {} },
  })
  await assert.rejects(candidate.start({ port: Number(priorPort), host: '127.0.0.1' }), { code: 'EADDRINUSE' })

  await waitFor(async () => (await fetch(`${prior.relayUrl}/health/ready`)).status === 200)
  const ready = await fetch(`${prior.relayUrl}/health/ready`)
  assert.equal((await ready.json()).configRevision, 'rev-1')
  assert.equal((await prior.poster.postWebhook(companionEvent('info', 'evt-after-candidate'))).status, 202)
  await waitFor(() => prior.queue.inspect('evt-after-candidate:info')?.status === 'delivered')
})
