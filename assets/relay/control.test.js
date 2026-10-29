'use strict'

const assert = require('node:assert/strict')
const { execFile, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { openAudit } = require('./audit')
const { readConfig } = require('./config')
const { openQueue } = require('./queue')
const { createRelayServer } = require('./server')
const { RELAY_VERSION } = require('./version')

const CONTROL = path.join(__dirname, 'control.js')
const SECOND = 1000
const TEN_MINUTES = 10 * 60 * SECOND
// Every secret the control process can see carries this marker; no output may contain it.
const CANARY = 'SECRET_CANARY_7c1d'
const BOT_TOKEN = `987654321:${CANARY}_bot_token`
const API_TOKEN = `gt_${CANARY}_api_token`
const CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const billing = {
  id: 'billing-api',
  name: 'Billing API',
  projectSlug: 'billing-api',
  projectName: 'Billing API',
  topicId: 44,
  environments: ['production'],
}
const storefront = {
  id: 'storefront',
  name: 'Storefront',
  projectSlug: 'storefront',
  topicId: 45,
  environments: ['staging', 'production'],
}
const PAIRED = { TELEGRAM_CHAT_ID: '-100123', ALLOWED_MEMBER_IDS: '[42]', APPLICATIONS_JSON: JSON.stringify([billing, storefront]) }
const UNPAIRED = { TELEGRAM_CHAT_ID: '', ALLOWED_MEMBER_IDS: '', APPLICATIONS_JSON: '' }

const workspace = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-control-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

const envFor = (directory, overrides = {}) => ({
  PATH: process.env.PATH,
  COMPANION_WORKSPACE_ID: 'acme',
  COMPANION_LOCALE: 'en',
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  GLITCHTIP_API_TOKEN: API_TOKEN,
  QUEUE_PATH: path.join(directory, 'state.json'),
  AUDIT_PATH: path.join(directory, 'audit.jsonl'),
  COMPANION_CONFIG_REVISION: 'rev-7',
  ...PAIRED,
  ...overrides,
})

// Runs `node control.js <args>` as `docker compose exec -T` would, with a hard timeout. A child
// that has not exited on its own by then is killed, and `signal` reports it.
const control = (args, env, { preload } = {}) => new Promise((resolve) => {
  const argv = preload ? ['--require', preload, CONTROL, ...args] : [CONTROL, ...args]
  const child = execFile(process.execPath, argv, {
    env,
    encoding: 'utf8',
    timeout: 10 * SECOND,
    killSignal: 'SIGKILL',
  }, (error, stdout, stderr) => {
    resolve({ status: child.exitCode, signal: child.signalCode, stdout, stderr })
  })
})

const assertClean = (result) => {
  assert.equal(result.signal, null, 'control did not exit on its own')
  assert.equal(`${result.stdout}${result.stderr}`.includes(CANARY), false, 'a secret reached the output')
}

// Exactly one JSON line on stdout, nothing on stderr, exit 0.
const succeeded = (result) => {
  assertClean(result)
  assert.equal(result.stderr, '')
  assert.equal(result.status, 0)
  assert.match(result.stdout, /^[^\n]+\n$/)
  return JSON.parse(result.stdout)
}

// Exactly one `{ "error": code }` line on stderr, nothing on stdout, exit 1.
const failedWith = (result, code) => {
  assertClean(result)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, `${JSON.stringify({ error: code })}\n`)
  assert.equal(result.status, 1)
}

// A local HTTP server standing in for the relay or for Telegram; `respond` returns [status, body].
const stubServer = async (t, respond) => {
  const requests = []
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const entry = { method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') }
      requests.push(entry)
      const [status, reply] = respond(entry, requests.length)
      const text = typeof reply === 'string' ? reply : JSON.stringify(reply)
      response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
      response.end(text)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  }))
  return { requests, port: server.address().port }
}

// Loaded with --require: sends the Telegram client's requests to a local stub instead.
const telegramPreload = (directory, port) => {
  const file = path.join(directory, 'telegram-preload.js')
  fs.writeFileSync(file, `
    const realFetch = globalThis.fetch
    globalThis.fetch = (url, init) => realFetch(String(url).replace('https://api.telegram.org/', 'http://127.0.0.1:${port}/'), init)
  `)
  return file
}

const freePort = () => new Promise((resolve, reject) => {
  const probe = http.createServer()
  probe.on('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})

const waitFor = async (predicate, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('condition was not met in time')
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

// ---------------------------------------------------------------------------------------------
// Command surface
// ---------------------------------------------------------------------------------------------

test('requiring the control module starts nothing', () => {
  const result = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', CONTROL], {
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
    timeout: 10 * SECOND,
  })

  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

for (const args of [[], ['nope'], ['--help'], ['PAIRING-CREATE'], ['pairing_create'], ['toString'], ['__proto__'], ['constructor']]) {
  test(`${JSON.stringify(args)} is an unknown command`, async (t) => {
    const directory = workspace(t)
    failedWith(await control(args, envFor(directory)), 'unknown-command')
    failedWith(await control(args, { PATH: process.env.PATH, TELEGRAM_BOT_TOKEN: BOT_TOKEN }), 'unknown-command')
  })
}

for (const args of [
  ['pairing-create'],
  ['pairing-status'],
  ['topic-create', '--name', 'Billing API', '--color', '7322096'],
  ['send-test', '--application', 'billing-api'],
  ['send-setup-complete', '--application', 'billing-api'],
  ['audit-tail', '--lines', '5'],
]) {
  test(`${args[0]} refuses an invalid configuration without naming fields or values`, async (t) => {
    const directory = workspace(t)
    for (const overrides of [
      { COMPANION_WORKSPACE_ID: '' },
      { TELEGRAM_CHAT_ID: '-100123', ALLOWED_MEMBER_IDS: '', APPLICATIONS_JSON: '' },
      { APPLICATIONS_JSON: `[{"id":"${CANARY}"}]` },
      { GLITCHTIP_API_TOKEN: `${CANARY} with spaces` },
    ]) {
      failedWith(await control(args, envFor(directory, overrides)), 'invalid-config')
    }
    assert.deepEqual(fs.readdirSync(directory), [])
  })
}

for (const args of [
  ['pairing-create', 'extra'],
  ['pairing-status', '--lines', '5'],
  ['topic-create', '--name', 'Billing API'],
  ['topic-create', '--color', '7322096'],
  ['topic-create', '--name', 'Billing API', '--color'],
  ['topic-create', '--name', '   ', '--color', '7322096'],
  ['topic-create', '--name', 'Billing API', '--color', 'blue'],
  ['topic-create', '--name', 'Billing API', '--color', '7322096.5'],
  ['topic-create', '--name', 'Billing API', '--color', '123456'],
  ['topic-create', '--name', 'A', '--name', 'B', '--color', '7322096'],
  ['topic-create', '--name', 'Billing API', '--color', '7322096', '--topic', '9'],
  ['send-test'],
  ['send-test', '--application'],
  ['send-test', '--application', 'billing-api', 'extra'],
  ['send-setup-complete', '--app', 'billing-api'],
  ['audit-tail'],
  ['audit-tail', '--lines'],
  ['audit-tail', '--lines', '1', '--lines', '2'],
  ['audit-tail', '--limit', '2'],
]) {
  test(`${JSON.stringify(args)} is refused as invalid arguments`, async (t) => {
    const directory = workspace(t)
    const telegram = await stubServer(t, () => [200, { ok: true, result: { message_thread_id: 77 } }])
    const env = envFor(directory, { PORT: String(telegram.port) })

    failedWith(await control(args, env, { preload: telegramPreload(directory, telegram.port) }), 'invalid-arguments')
    assert.deepEqual(telegram.requests, [])
  })
}

// ---------------------------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------------------------

test('pairing-create prints a fresh code and its expiry and stores it beside the queue', async (t) => {
  const directory = workspace(t)
  const before = Date.now()
  const created = succeeded(await control(['pairing-create'], envFor(directory, UNPAIRED)))
  const after = Date.now()

  assert.deepEqual(Object.keys(created), ['code', 'expiresAt'])
  assert.match(created.code, CODE)
  assert.match(created.expiresAt, ISO)
  const stored = readJson(path.join(directory, 'pairing.json'))
  assert.deepEqual(stored, { version: 1, code: created.code, createdAt: stored.createdAt, used: false })
  assert.ok(Date.parse(stored.createdAt) >= before && Date.parse(stored.createdAt) <= after)
  assert.equal(Date.parse(created.expiresAt) - Date.parse(stored.createdAt), TEN_MINUTES)
  assert.equal(fs.statSync(path.join(directory, 'pairing.json')).mode & 0o777, 0o600)
  // The queue and the audit log belong to the server process; control opens neither.
  assert.deepEqual(fs.readdirSync(directory), ['pairing.json'])

  const replaced = succeeded(await control(['pairing-create'], envFor(directory, UNPAIRED)))
  assert.equal(readJson(path.join(directory, 'pairing.json')).code, replaced.code)
})

test('pairing-status reports none, pending, expired, and paired', async (t) => {
  const directory = workspace(t)
  const env = envFor(directory, UNPAIRED)
  const pairingFile = path.join(directory, 'pairing.json')

  assert.deepEqual(succeeded(await control(['pairing-status'], env)), { status: 'none' })

  succeeded(await control(['pairing-create'], env))
  assert.deepEqual(succeeded(await control(['pairing-status'], env)), { status: 'pending' })

  fs.writeFileSync(pairingFile, JSON.stringify({
    version: 1,
    code: 'ABCD-EFGH',
    createdAt: new Date(Date.now() - TEN_MINUTES).toISOString(),
    used: false,
  }), { mode: 0o600 })
  assert.deepEqual(succeeded(await control(['pairing-status'], env)), { status: 'expired' })

  fs.writeFileSync(path.join(directory, 'pairing-result.json'), JSON.stringify({
    version: 1,
    chatId: -100123,
    chatTitle: 'Acme alerts',
    adminUserId: 42,
    pairedAt: '2026-09-23T10:01:30.000Z',
  }), { mode: 0o600 })
  const paired = await control(['pairing-status'], env)
  assert.equal(paired.stdout, '{"status":"paired","chatId":-100123,"chatTitle":"Acme alerts","adminUserId":42,"pairedAt":"2026-09-23T10:01:30.000Z"}\n')
  succeeded(paired)
  // A paired configuration reads the same files.
  assert.equal(succeeded(await control(['pairing-status'], envFor(directory))).status, 'paired')
})

// ---------------------------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------------------------

test('topic-create creates one native-color forum topic in the paired chat and prints its id', async (t) => {
  const directory = workspace(t)
  const telegram = await stubServer(t, () => [200, {
    ok: true,
    result: { message_thread_id: 77, name: 'Billing API', icon_color: 7322096, secret: CANARY },
  }])

  const result = await control(
    ['topic-create', '--name', 'Billing API', '--color', '7322096'],
    envFor(directory),
    { preload: telegramPreload(directory, telegram.port) },
  )

  assert.equal(result.stdout, '{"topicId":77}\n')
  assert.deepEqual(succeeded(result), { topicId: 77 })
  assert.equal(telegram.requests.length, 1)
  assert.equal(telegram.requests[0].method, 'POST')
  assert.equal(telegram.requests[0].url, `/bot${BOT_TOKEN}/createForumTopic`)
  assert.deepEqual(JSON.parse(telegram.requests[0].body), { chat_id: -100123, name: 'Billing API', icon_color: 7322096 })
})

test('topic-create is refused while unpaired and never calls Telegram', async (t) => {
  const directory = workspace(t)
  const telegram = await stubServer(t, () => [200, { ok: true, result: { message_thread_id: 77 } }])

  failedWith(await control(
    ['topic-create', '--name', 'Billing API', '--color', '7322096'],
    envFor(directory, UNPAIRED),
    { preload: telegramPreload(directory, telegram.port) },
  ), 'not-paired')
  assert.deepEqual(telegram.requests, [])
})

for (const [label, status, body, code] of [
  ['a missing topic permission', 400, { ok: false, error_code: 400, description: `Bad Request: not enough rights ${BOT_TOKEN}` }, 'telegram-400'],
  ['a rejected token', 401, { ok: false, error_code: 401, description: `Unauthorized ${CANARY}` }, 'telegram-401'],
  ['an unexpected Telegram code', 409, { ok: false, error_code: 409, description: `Conflict ${CANARY}` }, 'telegram-error'],
  ['a malformed result', 200, { ok: true, result: { message_thread_id: 'x', secret: CANARY } }, 'invalid-response'],
  ['a non-JSON answer', 200, `<html>${CANARY}</html>`, 'invalid-response'],
]) {
  test(`topic-create reports ${label} as ${code} without the Telegram response`, async (t) => {
    const directory = workspace(t)
    const telegram = await stubServer(t, () => [status, body])

    failedWith(await control(
      ['topic-create', '--name', 'Billing API', '--color', '16766590'],
      envFor(directory),
      { preload: telegramPreload(directory, telegram.port) },
    ), code)
    assert.equal(telegram.requests.length, 1)
  })
}

test('topic-create reports an unreachable Telegram as network-error', async (t) => {
  const directory = workspace(t)
  const port = await freePort()

  failedWith(await control(
    ['topic-create', '--name', 'Billing API', '--color', '7322096'],
    envFor(directory),
    { preload: telegramPreload(directory, port) },
  ), 'network-error')
})

// ---------------------------------------------------------------------------------------------
// Synthetic events
// ---------------------------------------------------------------------------------------------

const accepted = { status: 'accepted', accepted: 1, duplicates: 0, ignored: 0 }

for (const [command, state, application, environment, title] of [
  ['send-test', 'test', billing, 'production', 'Delivery test'],
  ['send-setup-complete', 'setup_complete', storefront, 'staging', 'Monitoring setup verified'],
]) {
  test(`${command} posts a synthetic ${state} webhook to the relay and prints its delivery id`, async (t) => {
    const directory = workspace(t)
    const relay = await stubServer(t, () => [202, accepted])

    const result = await control([command, '--application', application.id], envFor(directory, { PORT: String(relay.port) }))
    const printed = succeeded(result)

    assert.equal(relay.requests.length, 1)
    const [request] = relay.requests
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/v1/glitchtip/events')
    assert.match(request.headers['content-type'], /^application\/json/)
    const payload = JSON.parse(request.body)
    assert.match(payload.event_id, new RegExp(`^${state}-[0-9a-f]{16}$`))
    assert.deepEqual(payload, {
      companion_state: state,
      event_id: payload.event_id,
      attachments: [{
        title,
        fields: [
          { title: 'Project', value: application.projectSlug, short: true },
          { title: 'Environment', value: environment, short: true },
        ],
      }],
    })
    assert.equal(result.stdout, `{"eventId":"${payload.event_id}:${state}"}\n`)
    assert.deepEqual(printed, { eventId: `${payload.event_id}:${state}` })
  })
}

test('synthetic events carry the title in the workspace locale', async (t) => {
  const directory = workspace(t)
  const relay = await stubServer(t, () => [202, accepted])

  succeeded(await control(['send-test', '--application', 'billing-api'], envFor(directory, { PORT: String(relay.port), COMPANION_LOCALE: 'ru' })))
  succeeded(await control(['send-setup-complete', '--application', 'billing-api'], envFor(directory, { PORT: String(relay.port), COMPANION_LOCALE: 'uz' })))

  assert.deepEqual(relay.requests.map((request) => JSON.parse(request.body).attachments[0].title), [
    'Тест доставки',
    'Monitoring sozlamasi tekshirildi',
  ])
  const ids = relay.requests.map((request) => JSON.parse(request.body).event_id)
  assert.notEqual(ids[0].slice(-16), ids[1].slice(-16))
})

for (const [label, status, body] of [
  ['a duplicate', 202, { status: 'accepted', accepted: 0, duplicates: 1, ignored: 0 }],
  ['an ignored environment', 202, { status: 'accepted', accepted: 0, duplicates: 0, ignored: 1 }],
  ['two accepted events', 202, { status: 'accepted', accepted: 2, duplicates: 0, ignored: 0 }],
  ['an unknown application', 422, { error: 'unknown-application' }],
  ['a full queue', 503, { error: 'queue-full' }],
  ['a 200 answer', 200, accepted],
  ['a non-JSON answer', 202, 'accepted'],
]) {
  test(`send-test reports ${label} as not-accepted`, async (t) => {
    const directory = workspace(t)
    const relay = await stubServer(t, () => [status, body])

    failedWith(await control(['send-test', '--application', 'billing-api'], envFor(directory, { PORT: String(relay.port) })), 'not-accepted')
    assert.equal(relay.requests.length, 1)
  })
}

test('send-test reports an unreachable relay as not-accepted', async (t) => {
  const directory = workspace(t)
  const port = await freePort()

  failedWith(await control(['send-test', '--application', 'billing-api'], envFor(directory, { PORT: String(port) })), 'not-accepted')
})

test('synthetic events require a paired relay and a configured application', async (t) => {
  const directory = workspace(t)
  const relay = await stubServer(t, () => [202, accepted])

  for (const command of ['send-test', 'send-setup-complete']) {
    failedWith(await control([command, '--application', 'billing-api'], envFor(directory, { ...UNPAIRED, PORT: String(relay.port) })), 'not-paired')
    failedWith(await control([command, '--application', 'payments'], envFor(directory, { PORT: String(relay.port) })), 'unknown-application')
    failedWith(await control([command, '--application', 'Billing-API'], envFor(directory, { PORT: String(relay.port) })), 'unknown-application')
    failedWith(await control([command, '--application', 'billing-api'], envFor(directory, { PORT: String(relay.port), APPLICATIONS_JSON: '[]' })), 'unknown-application')
  }
  assert.deepEqual(relay.requests, [])
})

// ---------------------------------------------------------------------------------------------
// End to end against a real relay
// ---------------------------------------------------------------------------------------------

const silentLogger = { info: () => {}, error: () => {} }

const relayTelegram = () => {
  const sent = []
  return {
    sent,
    async getMe() { return { id: 987654321, username: 'acme_companion_bot' } },
    async sendEvent(request) {
      sent.push(request)
      return 900 + sent.length
    },
    pollUpdates({ signal }) {
      return new Promise((resolve, reject) => {
        const abort = () => reject({ code: 'network-error', retryAfterSeconds: null, description: 'aborted' })
        if (signal.aborted) return abort()
        signal.addEventListener('abort', abort, { once: true })
      })
    },
    async getChatMember(chatId, userId) { return { status: 'member', user: { id: userId } } },
  }
}

test('the printed delivery id is the one the relay queues, delivers, and audits', async (t) => {
  const directory = workspace(t)
  const env = envFor(directory)
  const config = readConfig(env)
  const queue = openQueue({ path: config.queuePath, limit: config.queueLimit, retentionHours: config.retentionHours, clock: Date.now })
  const audit = openAudit({ path: config.auditPath })
  const telegram = relayTelegram()
  const relay = createRelayServer({ config, telegram, queue, audit, deliveryIntervalMs: 5, logger: silentLogger })
  const { port } = await relay.start({ port: 0, host: '127.0.0.1' })
  t.after(() => relay.close())
  const controlEnv = { ...env, PORT: String(port) }

  const { eventId: testId } = succeeded(await control(['send-test', '--application', 'billing-api'], controlEnv))
  const { eventId: setupId } = succeeded(await control(['send-setup-complete', '--application', 'storefront'], controlEnv))
  assert.match(testId, /^test-[0-9a-f]{16}:test$/)
  assert.match(setupId, /^setup_complete-[0-9a-f]{16}:setup_complete$/)

  await waitFor(() => queue.inspect(testId)?.status === 'delivered' && queue.inspect(setupId)?.status === 'delivered')
  assert.deepEqual(telegram.sent.map((request) => request.topicId).sort(), [44, 45])

  const tail = succeeded(await control(['audit-tail', '--lines', '2'], controlEnv))
  assert.deepEqual(tail.records.map((record) => [record.eventId, record.status]).sort(), [
    [setupId, 'delivered'],
    [testId, 'delivered'],
  ].sort())
  for (const record of tail.records) {
    assert.equal(record.relayVersion, RELAY_VERSION)
    assert.equal(record.configRevision, 'rev-7')
  }
})

// ---------------------------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------------------------

const auditRecord = (index) => ({
  eventId: `evt-${index}:test`,
  applicationId: 'billing-api',
  state: 'test',
  status: 'delivered',
  at: new Date(Date.UTC(2026, 8, 23, 10, index)).toISOString(),
  retryCount: 0,
  relayVersion: RELAY_VERSION,
  configRevision: 'rev-7',
  telegramMessageId: 800 + index,
})
const jsonl = (...indices) => indices.map((index) => `${JSON.stringify(auditRecord(index))}\n`).join('')
const eventIds = (output) => output.records.map((record) => record.eventId)

test('audit-tail prints the last records oldest first, reaching into the previous file only when needed', async (t) => {
  const directory = workspace(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  fs.writeFileSync(`${auditPath}.2`, jsonl(0))
  fs.writeFileSync(`${auditPath}.1`, jsonl(1, 2, 3))
  // Malformed lines, non-object lines, and a torn final append are skipped.
  fs.writeFileSync(auditPath, `${jsonl(4)}not json\n\n[1,2]\n"text"\nnull\n${jsonl(5)}{"eventId":"evt-6`)
  const env = envFor(directory)

  const one = await control(['audit-tail', '--lines', '1'], env)
  assert.equal(one.stdout, `{"records":[${JSON.stringify(auditRecord(5))}]}\n`)
  succeeded(one)
  assert.deepEqual(eventIds(succeeded(await control(['audit-tail', '--lines', '2'], env))), ['evt-4:test', 'evt-5:test'])
  assert.deepEqual(eventIds(succeeded(await control(['audit-tail', '--lines', '3'], env))), ['evt-3:test', 'evt-4:test', 'evt-5:test'])
  assert.deepEqual(eventIds(succeeded(await control(['audit-tail', '--lines', '200'], env))), [
    'evt-1:test', 'evt-2:test', 'evt-3:test', 'evt-4:test', 'evt-5:test',
  ])
  assert.deepEqual(succeeded(await control(['audit-tail', '--lines', '200'], env)).records[0], auditRecord(1))
})

test('audit-tail leaves the previous file unread when the active file is enough', async (t) => {
  const directory = workspace(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  fs.writeFileSync(auditPath, jsonl(1, 2))
  // Reading this would fail.
  fs.mkdirSync(`${auditPath}.1`)

  assert.deepEqual(eventIds(succeeded(await control(['audit-tail', '--lines', '2'], envFor(directory)))), ['evt-1:test', 'evt-2:test'])
  failedWith(await control(['audit-tail', '--lines', '3'], envFor(directory)), 'internal-error')
})

test('audit-tail prints no records when there is no audit log yet', async (t) => {
  const directory = workspace(t)

  const result = await control(['audit-tail', '--lines', '50'], envFor(directory, UNPAIRED))
  assert.equal(result.stdout, '{"records":[]}\n')
  succeeded(result)

  fs.writeFileSync(`${path.join(directory, 'audit.jsonl')}.1`, jsonl(1))
  assert.deepEqual(eventIds(succeeded(await control(['audit-tail', '--lines', '50'], envFor(directory)))), ['evt-1:test'])
})

test('audit-tail accepts 1 through 200 lines only', async (t) => {
  const directory = workspace(t)
  fs.writeFileSync(path.join(directory, 'audit.jsonl'), jsonl(1))
  const env = envFor(directory)

  for (const lines of ['1', '200']) assert.equal(succeeded(await control(['audit-tail', '--lines', lines], env)).records.length, 1)
  for (const lines of ['0', '201', '-1', '1.5', '1e2', '0x10', '007', 'ten', '', ' 5']) {
    failedWith(await control(['audit-tail', '--lines', lines], env), 'invalid-arguments')
  }
})
