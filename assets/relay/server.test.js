'use strict'

const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { readConfig } = require('./config')
const { openAudit } = require('./audit')
const { formatMessage } = require('./format')
const { openQueue } = require('./queue')
const { createPairing } = require('./pairing')
const { callbackKeyFor, createRelayServer } = require('./server')
const { RELAY_VERSION } = require('./version')

const SECOND = 1000
const MIB = 1024 * 1024
const BOT_TOKEN = '987654321:CANARY_bot_token_do_not_leak'
const API_TOKEN = 'gt_canary_api_token_do_not_leak'
const BODY_CANARY = 'raw-body-canary-7f3a'
const LATEST_EVENT_ID = '4b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e'
const ENRICHED_ID = `${LATEST_EVENT_ID}:error`
const TEN_MINUTES = 10 * 60 * SECOND
// Every relay in these tests starts its clock here, at the start of a 10-minute bucket.
const START = Date.UTC(2026, 8, 23, 10)
const BUCKET = START / TEN_MINUTES
// The delivery ID of a payload-only GlitchTip webhook: GlitchTip's error color, the issue, and the
// 10-minute bucket of the receive time.
const issueKey = (issueId, { bucket = BUCKET, state = 'error' } = {}) => `issue-${issueId}-${bucket}:${state}`
const counts = (accepted, duplicates = 0, ignored = 0) => ({ status: 'accepted', accepted, duplicates, ignored })

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
  environments: ['production'],
}

const configFor = (directory, overrides = {}) => readConfig({
  COMPANION_WORKSPACE_ID: 'acme',
  COMPANION_LOCALE: 'en',
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_CHAT_ID: '-100123',
  ALLOWED_MEMBER_IDS: '[42]',
  APPLICATIONS_JSON: JSON.stringify([billing, storefront]),
  QUEUE_PATH: path.join(directory, 'state.json'),
  AUDIT_PATH: path.join(directory, 'audit.jsonl'),
  QUEUE_LIMIT: '10',
  GLITCHTIP_API_BASE: 'http://glitchtip.internal:8080/',
  COMPANION_CONFIG_REVISION: 'rev-7',
  ...overrides,
})

// Sets or, with null, removes one attachment field; undefined leaves the fixture's value.
const setField = (payload, title, value) => {
  if (value === undefined) return
  const fields = payload.attachments[0].fields
  const index = fields.findIndex((field) => field.title === title)
  if (value === null) {
    if (index !== -1) fields.splice(index, 1)
  } else if (index === -1) {
    fields.push({ title, value, short: true })
  } else {
    fields[index].value = value
  }
}

// The body GlitchTip's generic webhook recipient POSTs (send_issue_as_webhook in
// apps/alerts/webhooks.py; see fixtures/glitchtip-webhook.json and domain.test.js). The Project
// field carries the project NAME; there is no top-level environment and no event ID.
const glitchtipWebhook = ({ project, environment, release, issueId, title } = {}) => {
  const payload = structuredClone(require('./fixtures/glitchtip-webhook.json'))
  setField(payload, 'Project', project)
  setField(payload, 'Environment', environment)
  setField(payload, 'Release', release)
  if (issueId !== undefined) payload.attachments[0].title_link = `https://errors.example.test/acme/issues/${issueId}`
  if (title !== undefined) payload.attachments[0].title = title
  return payload
}

// A multi-issue alert: send_issue_as_webhook adds one attachment per issue and counts them in text.
const multiIssueWebhook = (issues) => {
  const payload = glitchtipWebhook()
  payload.text = `GlitchTip Alert (${issues.length} issues)`
  payload.attachments = issues.map((issue) => glitchtipWebhook(issue).attachments[0])
  return payload
}

// Companion's own synthetic events: the same attachment fields plus a state and a producer ID.
const companionEvent = ({ state = 'test', eventId = 'test-5f0c2a9e41d7b388', project, environment, title } = {}) => {
  const payload = structuredClone(require('./fixtures/companion-event.json'))
  payload.companion_state = state
  payload.event_id = eventId
  setField(payload, 'Project', project)
  setField(payload, 'Environment', environment)
  if (title !== undefined) payload.attachments[0].title = title
  return payload
}

// GlitchTip's enrichment responses as its API serializes them (apps/issue_events/schema.py; see
// domain.test.js). The issue carries `level`; the latest event carries `eventID` and no `level`.
const issueBody = require('./fixtures/glitchtip-issue.json')
const latestEventBody = require('./fixtures/glitchtip-latest-event.json')

const queuedEvent = (id, applicationId) => ({
  id,
  applicationId,
  applicationName: '',
  projectSlug: '',
  environment: 'production',
  state: 'error',
  title: 'Failure',
  issueId: '',
  issueUrl: '',
  release: '',
  eventCount: null,
  affectedUsers: null,
  windowMinutes: null,
  threshold: null,
  firstSeen: '',
  lastSeen: '',
  incidentMinutes: null,
  quietMinutes: null,
})

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body })

const glitchtipFetch = (calls, { issue = issueBody, event = latestEventBody } = {}) => async (url, init) => {
  calls.push({ url, init })
  if (url.endsWith('/events/latest/')) return jsonResponse(structuredClone(event))
  if (url.endsWith('/issues/1842/')) return jsonResponse(structuredClone(issue))
  return jsonResponse({}, { ok: false, status: 404 })
}

const unexpectedFetch = async () => {
  throw new Error('GlitchTip must not be called')
}

const networkError = { code: 'network-error', retryAfterSeconds: null, description: 'Telegram network request failed' }

// A long poll that only ends when the relay aborts it, as fetch does.
const waitForAbort = (signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(networkError)
  signal.addEventListener('abort', () => reject(networkError), { once: true })
})

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const fakeTelegram = (behaviour = {}) => {
  const calls = { getMe: 0, sendEvent: [], pollUpdates: [], answerCallbackQuery: [], createTopic: [], getChatMember: [] }
  return {
    calls,
    async getMe() {
      calls.getMe += 1
      if (behaviour.getMe) return behaviour.getMe(calls.getMe)
      return { id: 987654321, username: 'acme_companion_bot' }
    },
    async sendEvent(request) {
      calls.sendEvent.push(request)
      if (behaviour.sendEvent) return behaviour.sendEvent(request, calls.sendEvent.length)
      return 800 + calls.sendEvent.length
    },
    async pollUpdates(request) {
      calls.pollUpdates.push(request)
      if (behaviour.pollUpdates) return behaviour.pollUpdates(request, calls.pollUpdates.length)
      return waitForAbort(request.signal)
    },
    async answerCallbackQuery(id) {
      calls.answerCallbackQuery.push(id)
    },
    async createTopic(request) {
      calls.createTopic.push(request)
      return 99
    },
    async getChatMember(chatId, userId) {
      calls.getChatMember.push([chatId, userId])
      if (behaviour.getChatMember) return behaviour.getChatMember(chatId, userId)
      return { status: 'member', user: { id: userId } }
    },
  }
}

const recordingLogger = () => {
  const lines = []
  return {
    lines,
    info: (...args) => lines.push(args.map(String).join(' ')),
    error: (...args) => lines.push(args.map(String).join(' ')),
  }
}

const waitFor = async (predicate, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('condition was not met in time')
}

const startRelay = async (t, options = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-server-'))
  let relay = null
  t.after(async () => {
    if (relay) await relay.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const now = { value: START }
  const clock = () => now.value
  const config = configFor(directory, options.env)
  const queue = openQueue({
    path: config.queuePath,
    limit: config.queueLimit,
    retentionHours: config.retentionHours,
    clock,
  })
  if (options.seed) options.seed(queue)
  const audit = openAudit({ path: config.auditPath })
  const telegram = options.telegram || fakeTelegram()
  const logger = options.logger === undefined ? recordingLogger() : options.logger
  const deps = {
    config,
    telegram,
    queue: options.wrapQueue ? options.wrapQueue(queue, () => relay) : queue,
    audit,
    clock,
    fetchFn: options.fetchFn || unexpectedFetch,
    sleep: options.sleep || (async () => {}),
    deliveryIntervalMs: options.deliveryIntervalMs ?? 5,
  }
  if (logger) deps.logger = logger
  if (options.handleUpdate) deps.handleUpdate = options.handleUpdate
  if (options.handlePairingUpdate) deps.handlePairingUpdate = options.handlePairingUpdate
  if (options.shutdownTimeoutMs) deps.shutdownTimeoutMs = options.shutdownTimeoutMs
  if (options.enrichmentBudgetMs) deps.enrichmentBudgetMs = options.enrichmentBudgetMs
  relay = createRelayServer(deps)
  const { port } = await relay.start({ port: 0, host: '127.0.0.1' })
  const auditRecords = () => fs.existsSync(config.auditPath)
    ? fs.readFileSync(config.auditPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : []
  return { relay, url: `http://127.0.0.1:${port}`, port, queue, config, telegram, logger, now, directory, auditRecords }
}

const request = async (url, init) => {
  const response = await fetch(url, init)
  const text = await response.text()
  return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : null }
}

const postEvent = (url, body) => request(`${url}/v1/glitchtip/events`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
})

const readiness = (url) => request(`${url}/health/ready`)

test('callback keys are short, stable, workspace-scoped digests of the event ID', () => {
  const expected = `brief:${createHash('sha256').update('acme:evt-1').digest('hex').slice(0, 16)}`

  assert.equal(callbackKeyFor('acme', 'evt-1'), expected)
  assert.match(callbackKeyFor('acme', 'evt-1'), /^brief:[0-9a-f]{16}$/)
  assert.notEqual(callbackKeyFor('globex', 'evt-1'), expected)
  assert.ok(Buffer.byteLength(callbackKeyFor('acme', 'x'.repeat(5000)), 'utf8') <= 64)
})

test('requiring the server module starts nothing', () => {
  const result = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', path.join(__dirname, 'server.js')], {
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
    timeout: 10 * SECOND,
  })

  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

test('running the server with invalid configuration exits 1 and names fields only', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      PATH: process.env.PATH,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      GLITCHTIP_API_TOKEN: `${API_TOKEN} with spaces`,
      TELEGRAM_CHAT_ID: 'not-a-chat',
    },
    encoding: 'utf8',
    timeout: 10 * SECOND,
  })

  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /COMPANION_WORKSPACE_ID/)
  assert.match(result.stderr, /GLITCHTIP_API_TOKEN/)
  assert.doesNotMatch(result.stderr, /CANARY|canary|not-a-chat/)
})

// Loaded with --require into a real relay process: every fsync of the data directory fails with an
// error that names the directory, and outbound fetch fails, so nothing reaches Telegram.
const DURABILITY_PRELOAD = `
  const fs = require('node:fs')
  const directory = process.env.RELAY_TEST_DIRECTORY
  const { openSync, closeSync, fsyncSync } = fs
  const directories = new Set()
  fs.openSync = function (file, ...rest) {
    const descriptor = openSync.call(fs, file, ...rest)
    if (file === directory) directories.add(descriptor)
    return descriptor
  }
  fs.closeSync = function (descriptor, ...rest) {
    directories.delete(descriptor)
    return closeSync.call(fs, descriptor, ...rest)
  }
  fs.fsyncSync = function (descriptor, ...rest) {
    if (directories.has(descriptor)) throw Object.assign(new Error('EIO: i/o error, fsync ' + directory), { code: 'EIO' })
    return fsyncSync.call(fs, descriptor, ...rest)
  }
  globalThis.fetch = async () => { throw new TypeError('fetch failed') }
`

const freePort = () => new Promise((resolve, reject) => {
  const probe = http.createServer()
  probe.on('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})

test('the server reports failed post-commit directory flushes once per store, as fixed text', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-server-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const auditPath = path.join(directory, 'audit.jsonl')
  // A finished rotation: opening the audit log cleans it up, which ends in a post-commit flush.
  fs.writeFileSync(`${auditPath}.rotation.json`, JSON.stringify({
    version: 2,
    phase: 'completed',
    slots: [0, 1, 2, 3].map((index) => ({ index, file: index === 0 ? auditPath : `${auditPath}.${index}`, existed: false, backup: null })),
  }), { mode: 0o600 })
  const preload = path.join(directory, 'preload.js')
  fs.writeFileSync(preload, DURABILITY_PRELOAD)
  const port = await freePort()
  const child = spawn(process.execPath, ['--require', preload, path.join(__dirname, 'server.js')], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      RELAY_TEST_DIRECTORY: directory,
      COMPANION_WORKSPACE_ID: 'acme',
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_CHAT_ID: '-100123',
      ALLOWED_MEMBER_IDS: '[42]',
      APPLICATIONS_JSON: JSON.stringify([billing]),
      QUEUE_PATH: path.join(directory, 'state.json'),
      AUDIT_PATH: auditPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })

  await waitFor(() => stdout.includes('relay: listening'), 5 * SECOND)
  for (const eventId of ['evt-a', 'evt-b']) {
    const response = await postEvent(`http://127.0.0.1:${port}`, companionEvent({ eventId }))
    assert.deepEqual(response.body, counts(1))
  }
  child.kill('SIGTERM')
  assert.deepEqual(await exited, { code: 0, signal: null })

  const lines = stderr.split('\n')
  assert.equal(lines.filter((line) => line === 'relay: audit directory flush failed; recent changes may not survive a power loss').length, 1)
  assert.equal(lines.filter((line) => line === 'relay: queue directory flush failed; recent changes may not survive a power loss').length, 1)
  assert.doesNotMatch(`${stdout}${stderr}`, /EIO|i\/o error|CANARY/)
  assert.equal(`${stdout}${stderr}`.includes(directory), false)
  // Both events were committed although every flush failed.
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'))
  assert.deepEqual(saved.records.map((record) => record.id).sort(), ['evt-a:test', 'evt-b:test'])
})

test('liveness and readiness expose only status, version, and configuration revision', async (t) => {
  const identity = deferred()
  const telegram = fakeTelegram({ getMe: () => identity.promise })
  const { url } = await startRelay(t, { telegram })

  const live = await request(`${url}/health/live`)
  assert.equal(live.status, 200)
  assert.deepEqual(live.body, { status: 'live', version: RELAY_VERSION, configRevision: 'rev-7' })
  assert.match(live.headers.get('content-type'), /^application\/json/)
  assert.equal(live.headers.get('cache-control'), 'no-store')

  const starting = await readiness(url)
  assert.equal(starting.status, 503)
  assert.deepEqual(starting.body, { status: 'starting', version: RELAY_VERSION, configRevision: 'rev-7' })
  assert.equal(telegram.calls.pollUpdates.length, 0)

  identity.resolve({ id: 987654321, username: 'acme_companion_bot' })
  await waitFor(async () => (await readiness(url)).status === 200)
  assert.deepEqual((await readiness(url)).body, { status: 'ready', version: RELAY_VERSION, configRevision: 'rev-7' })
  assert.equal(RELAY_VERSION, '1.0.0')
  assert.equal(telegram.calls.pollUpdates.length, 1)
  assert.equal(telegram.calls.pollUpdates[0].offset, 0)
  assert.equal(telegram.calls.pollUpdates[0].timeoutSeconds, 25)
  assert.ok(telegram.calls.pollUpdates[0].signal instanceof AbortSignal)

  for (const body of [live.text, starting.text]) {
    assert.doesNotMatch(body, /acme|billing|storefront|-100123|CANARY|glitchtip\.internal/)
  }
})

test('readiness retries a failed Telegram identity check after a five-second back-off', async (t) => {
  const sleeps = []
  const telegram = fakeTelegram({
    getMe: (attempt) => {
      if (attempt === 1) throw networkError
      return { id: 987654321, username: 'acme_companion_bot' }
    },
  })
  const { url } = await startRelay(t, { telegram, sleep: async (ms) => { sleeps.push(ms) } })

  await waitFor(async () => (await readiness(url)).status === 200)
  assert.equal(telegram.calls.getMe, 2)
  assert.deepEqual(sleeps, [5 * SECOND])
})

test('a rejected bot token during the identity check degrades readiness and starts no loops', async (t) => {
  const telegram = fakeTelegram({
    getMe: () => { throw { code: 401, retryAfterSeconds: null, description: 'Unauthorized' } },
  })
  const { url } = await startRelay(t, { telegram })

  await waitFor(async () => (await readiness(url)).status === 503 && (await readiness(url)).body.status === 'degraded')
  assert.deepEqual((await readiness(url)).body, { status: 'degraded', version: RELAY_VERSION, configRevision: 'rev-7' })
  assert.equal(telegram.calls.getMe, 1)
  assert.equal(telegram.calls.pollUpdates.length, 0)
})

test('unknown routes return 404 without event or configuration data', async (t) => {
  const { url } = await startRelay(t)

  for (const [method, route] of [
    ['GET', '/'],
    ['GET', '/v1/glitchtip'],
    ['GET', '/v1/glitchtip/events/extra'],
    ['POST', '/'],
    ['POST', '/health'],
    ['GET', '/state.json'],
    ['GET', '/audit.jsonl'],
  ]) {
    const response = await request(`${url}${route}`, method === 'POST'
      ? { method, body: JSON.stringify(glitchtipWebhook({ title: BODY_CANARY })) }
      : { method })
    assert.equal(response.status, 404, `${method} ${route}`)
    assert.deepEqual(response.body, { error: 'not-found' })
  }
})

test('the event route accepts POST only and health routes accept GET only', async (t) => {
  const { url } = await startRelay(t)

  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    const response = await request(`${url}/v1/glitchtip/events`, { method })
    assert.equal(response.status, 405, method)
    assert.equal(response.headers.get('allow'), 'POST')
    assert.deepEqual(response.body, { error: 'method-not-allowed' })
  }
  for (const route of ['/health/live', '/health/ready']) {
    const response = await request(`${url}${route}`, { method: 'POST', body: '{}' })
    assert.equal(response.status, 405, route)
    assert.equal(response.headers.get('allow'), 'GET')
    assert.deepEqual(response.body, { error: 'method-not-allowed' })
  }
})

test('invalid JSON and non-object documents are rejected with 400 invalid-json', async (t) => {
  const { url, queue } = await startRelay(t)

  for (const body of ['{not json', '', `{"title":"${BODY_CANARY}"`, '[1,2]', 'null', '"text"', '42']) {
    const response = await postEvent(url, body)
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.deepEqual(response.body, { error: 'invalid-json' })
  }
  assert.equal(queue.size(), 0)
})

test('bodies over 1 MiB are rejected with 413 whether declared or streamed', async (t) => {
  const { url, port, queue } = await startRelay(t)

  const declared = await postEvent(url, `"${'x'.repeat(MIB - 1)}"`)
  assert.equal(declared.status, 413)
  assert.deepEqual(declared.body, { error: 'payload-too-large' })

  const streamed = await new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/glitchtip/events',
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
      agent: false,
    }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }))
    })
    outgoing.on('error', reject)
    outgoing.write(`{"padding":"${'x'.repeat(MIB / 2)}`)
    outgoing.write('x'.repeat(MIB / 2))
    outgoing.end('"}')
  })
  assert.equal(streamed.status, 413)
  assert.deepEqual(streamed.body, { error: 'payload-too-large' })

  const padding = 'x'.repeat(MIB - JSON.stringify({ padding: '' }).length)
  const exact = JSON.stringify({ padding })
  assert.equal(Buffer.byteLength(exact), MIB)
  const atLimit = await postEvent(url, exact)
  assert.equal(atLimit.status, 422)
  assert.equal(queue.size(), 0)
})

test('a multi-issue alert queues each issue on its own and answers once with counts', async (t) => {
  const { url, queue } = await startRelay(t, { deliveryIntervalMs: 60 * SECOND })
  const payload = multiIssueWebhook([
    { issueId: '1842' },
    { issueId: '1843', environment: 'staging' },
    { issueId: '1844' },
  ])

  const first = await postEvent(url, payload)
  assert.equal(first.status, 202)
  assert.deepEqual(first.body, counts(2, 0, 1))
  assert.equal(queue.size(), 2)
  assert.equal(queue.inspect(issueKey(1842)).issueId, '1842')
  assert.equal(queue.inspect(issueKey(1844)).issueId, '1844')
  assert.equal(queue.inspect(issueKey(1843)), null)

  assert.deepEqual((await postEvent(url, payload)).body, counts(0, 2, 1))
  assert.equal(queue.size(), 2)
})

test('each attachment of a multi-issue alert is enriched on its own', async (t) => {
  const calls = []
  const { url, queue } = await startRelay(t, {
    fetchFn: async (target, init) => {
      calls.push({ url: target, init })
      const [, issueId, latest] = target.match(/\/issues\/([0-9]+)\/(events\/latest\/)?$/)
      return latest
        ? jsonResponse({ ...latestEventBody, eventID: `latest${issueId}` })
        : jsonResponse({ ...issueBody, id: issueId })
    },
    env: { GLITCHTIP_API_TOKEN: API_TOKEN },
    deliveryIntervalMs: 60 * SECOND,
  })

  const response = await postEvent(url, multiIssueWebhook([{ issueId: '1842' }, { issueId: '1844' }]))

  assert.deepEqual(response.body, counts(2))
  assert.deepEqual(calls.map((call) => call.url).sort(), [
    'http://glitchtip.internal:8080/api/0/issues/1842/',
    'http://glitchtip.internal:8080/api/0/issues/1842/events/latest/',
    'http://glitchtip.internal:8080/api/0/issues/1844/',
    'http://glitchtip.internal:8080/api/0/issues/1844/events/latest/',
  ])
  assert.equal(queue.inspect('latest1842:error').issueId, '1842')
  assert.equal(queue.inspect('latest1844:error').issueId, '1844')
})

test('an enriched warning is delivered as a warning although GlitchTip sends no color and no event level', async (t) => {
  const calls = []
  const { url, queue } = await startRelay(t, {
    fetchFn: glitchtipFetch(calls, { issue: { ...issueBody, level: 'warning' } }),
    env: { GLITCHTIP_API_TOKEN: API_TOKEN },
    deliveryIntervalMs: 60 * SECOND,
  })
  const payload = glitchtipWebhook()
  delete payload.attachments[0].color

  assert.deepEqual((await postEvent(url, payload)).body, counts(1))

  const record = queue.inspect(`${LATEST_EVENT_ID}:warning`)
  assert.equal(record.state, 'warning')
  assert.equal(record.eventCount, 47)
  assert.equal(record.affectedUsers, 18)
})

test('a producer ID on a multi-issue webhook is ignored in favour of per-issue identities', async (t) => {
  const { url, queue } = await startRelay(t, { deliveryIntervalMs: 60 * SECOND })
  const payload = { ...multiIssueWebhook([{ issueId: '1842' }, { issueId: '1844' }]), event_id: 'producer-1' }

  assert.deepEqual((await postEvent(url, payload)).body, counts(2))
  assert.ok(queue.inspect(issueKey(1842)))
  assert.ok(queue.inspect(issueKey(1844)))
  assert.equal(queue.inspect('producer-1:error'), null)
})

test('enrichment looks up each issue once per request and runs at most four GlitchTip calls at a time', async (t) => {
  const calls = []
  let active = 0
  let peak = 0
  const { url, queue } = await startRelay(t, {
    fetchFn: async (target) => {
      calls.push(target)
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
      const [, issueId, latest] = target.match(/\/issues\/([0-9]+)\/(events\/latest\/)?$/)
      return latest
        ? jsonResponse({ ...latestEventBody, eventID: `latest${issueId}` })
        : jsonResponse({ ...issueBody, id: issueId })
    },
    env: { GLITCHTIP_API_TOKEN: API_TOKEN },
    deliveryIntervalMs: 60 * SECOND,
  })
  // Six distinct issues, each sent twice in the same alert.
  const issues = ['1842', '1843', '1844', '1845', '1846', '1847']
  const payload = multiIssueWebhook([...issues, ...issues].map((issueId) => ({ issueId })))

  const response = await postEvent(url, payload)

  assert.deepEqual(response.body, counts(6, 6))
  assert.equal(calls.length, 12)
  assert.equal(new Set(calls).size, 12)
  assert.equal(peak, 4)
  for (const issueId of issues) assert.ok(queue.inspect(`latest${issueId}:error`), issueId)
})

// A GlitchTip lookup that answers at once for most issues and never answers for `slowIssues`
// until the relay aborts it, the way a real request to an overloaded GlitchTip would.
const budgetFetch = (calls, slowIssues) => async (target, init) => {
  calls.push({ url: target, init })
  const [, issueId, latest] = target.match(/\/issues\/([0-9]+)\/(events\/latest\/)?$/)
  if (slowIssues.includes(issueId)) {
    await new Promise((resolve, reject) => {
      if (init.signal.aborted) return reject(init.signal.reason)
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    })
  }
  return latest
    ? jsonResponse({ ...latestEventBody, eventID: `latest${issueId}` })
    : jsonResponse({ ...issueBody, id: issueId })
}

test('a slow GlitchTip cannot hold the answer past the enrichment budget', async (t) => {
  const calls = []
  const budget = 300
  const { url, queue } = await startRelay(t, {
    enrichmentBudgetMs: budget,
    fetchFn: budgetFetch(calls, ['1844']),
    env: { GLITCHTIP_API_TOKEN: API_TOKEN },
    deliveryIntervalMs: 60 * SECOND,
  })

  const started = Date.now()
  const response = await postEvent(url, multiIssueWebhook([{ issueId: '1842' }, { issueId: '1844' }]))
  const elapsed = Date.now() - started

  assert.deepEqual(response.body, counts(2))
  assert.ok(elapsed >= budget - 50 && elapsed < budget + 700, `answered after ${elapsed} ms`)
  // The issue that answered in time keeps its enrichment; the other falls back to the webhook.
  const enriched = queue.inspect('latest1842:error')
  assert.equal(enriched.eventCount, 47)
  assert.equal(enriched.affectedUsers, 18)
  const fallback = queue.inspect(issueKey(1844))
  assert.equal(fallback.eventCount, null)
  assert.equal(fallback.title, 'OperationalError: database unavailable')
  // The calls still in flight at the deadline were aborted.
  const slow = calls.filter((call) => call.url.includes('/issues/1844/'))
  assert.equal(slow.length, 2)
  for (const call of slow) assert.equal(call.init.signal.aborted, true)
})

test('the budget holds even against a GlitchTip call that ignores its abort signal', async (t) => {
  const { url, queue } = await startRelay(t, {
    enrichmentBudgetMs: 200,
    fetchFn: () => new Promise(() => {}),
    env: { GLITCHTIP_API_TOKEN: API_TOKEN },
    deliveryIntervalMs: 60 * SECOND,
  })

  const started = Date.now()
  const response = await postEvent(url, glitchtipWebhook())
  const elapsed = Date.now() - started

  assert.deepEqual(response.body, counts(1))
  assert.ok(elapsed < 200 + 700, `answered after ${elapsed} ms`)
  assert.equal(queue.inspect(issueKey(1842)).eventCount, null)
})

test('no GlitchTip call starts after the enrichment budget is spent', async (t) => {
  const calls = []
  const { url } = await startRelay(t, {
    enrichmentBudgetMs: 200,
    fetchFn: budgetFetch(calls, ['1842', '1843', '1844']),
    env: { GLITCHTIP_API_TOKEN: API_TOKEN },
    deliveryIntervalMs: 60 * SECOND,
  })

  const response = await postEvent(url, multiIssueWebhook([{ issueId: '1842' }, { issueId: '1843' }, { issueId: '1844' }]))
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.deepEqual(response.body, counts(3))
  // Four calls ran at once; the two still queued at the deadline never started.
  assert.equal(calls.length, 4)
  for (const call of calls) assert.equal(call.init.signal.aborted, true)
})

test('enrichment leaves no timer or request behind, so the process exits on its own', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-server-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  // Two relays in one child process. The first has a long budget and finishes early: its budget
  // timer must be cleared, and the latest-event call left hanging after the issue lookup failed
  // must be aborted. The second spends its short budget on calls that never answer, and must abort
  // them. Every hanging call holds a 20-second timer until it is aborted, as a socket would.
  const child = `
    const http = require('node:http')
    const path = require('node:path')
    const [directory, relayDirectory] = process.argv.slice(1)
    const load = (name) => require(path.join(relayDirectory, name))
    const { readConfig } = load('config')
    const { openQueue } = load('queue')
    const { openAudit } = load('audit')
    const { createRelayServer } = load('server')
    const webhook = load('fixtures/glitchtip-webhook.json')
    const hang = (init) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ ok: true, json: async () => ({}) }), 20000)
      init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason) }, { once: true })
    })
    const telegram = {
      getMe: async () => ({ id: 1, username: 'bot' }),
      sendEvent: async () => 1,
      pollUpdates: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject({ code: 'network-error' }), { once: true })
      }),
    }
    const post = (port) => new Promise((resolve, reject) => {
      const body = JSON.stringify(webhook)
      const request = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/v1/glitchtip/events', agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (response) => {
        let text = ''
        response.on('data', (chunk) => { text += chunk })
        response.on('end', () => resolve(response.statusCode + ' ' + text))
      })
      request.on('error', reject)
      request.end(body)
    })
    const run = async (name, budget, fetchFn) => {
      const config = readConfig({
        COMPANION_WORKSPACE_ID: 'acme',
        TELEGRAM_BOT_TOKEN: '1:token',
        TELEGRAM_CHAT_ID: '-100123',
        ALLOWED_MEMBER_IDS: '[42]',
        APPLICATIONS_JSON: JSON.stringify([{ id: 'billing-api', name: 'Billing API', projectSlug: 'billing-api', projectName: 'Billing API', topicId: 44, environments: ['production'] }]),
        QUEUE_PATH: path.join(directory, name + '-state.json'),
        AUDIT_PATH: path.join(directory, name + '-audit.jsonl'),
        GLITCHTIP_API_TOKEN: 'token',
      })
      const queue = openQueue({ path: config.queuePath, limit: config.queueLimit, retentionHours: config.retentionHours, clock: Date.now })
      const audit = openAudit({ path: config.auditPath })
      const relay = createRelayServer({ config, telegram, queue, audit, fetchFn, enrichmentBudgetMs: budget, logger: { info() {}, error() {} } })
      const { port } = await relay.start({ port: 0, host: '127.0.0.1' })
      const answer = await post(port)
      await relay.close()
      console.log(name + ' ' + answer)
    }
    ;(async () => {
      await run('early', 20000, async (url, init) => url.endsWith('/events/latest/') ? hang(init) : { ok: false, status: 404 })
      await run('spent', 200, async (url, init) => hang(init))
    })().catch((error) => { console.error(error); process.exitCode = 1 })
  `
  const started = Date.now()
  const result = spawnSync(process.execPath, ['-e', child, directory, __dirname], { encoding: 'utf8', timeout: 15 * SECOND })
  const elapsed = Date.now() - started

  assert.equal(result.stderr, '')
  assert.equal(result.signal, null)
  assert.equal(result.status, 0)
  assert.match(result.stdout, /^early 202 \{"status":"accepted","accepted":1,"duplicates":0,"ignored":0\}\nspent 202 /)
  assert.ok(elapsed < 4 * SECOND, `the child process took ${elapsed} ms to exit`)
})

test('failed enrichment of a multi-issue alert is logged once for the request', async (t) => {
  const logger = recordingLogger()
  const { url, queue } = await startRelay(t, {
    logger,
    fetchFn: async () => { throw new Error(`refused ${API_TOKEN}`) },
    env: { GLITCHTIP_API_TOKEN: API_TOKEN },
    deliveryIntervalMs: 60 * SECOND,
  })

  const response = await postEvent(url, multiIssueWebhook([{ issueId: '1842' }, { issueId: '1843' }, { issueId: '1844' }]))

  assert.deepEqual(response.body, counts(3))
  assert.ok(queue.inspect(issueKey(1843)))
  assert.deepEqual(logger.lines, ['relay: GlitchTip enrichment unavailable; using webhook fields'])
})

test('a multi-issue alert is refused with 422 only when no attachment routes', async (t) => {
  const { url, queue } = await startRelay(t, { deliveryIntervalMs: 60 * SECOND })

  const partly = await postEvent(url, multiIssueWebhook([{ issueId: '1842', project: 'Unknown' }, { issueId: '1844' }]))
  assert.equal(partly.status, 202)
  assert.deepEqual(partly.body, counts(1, 0, 1))
  assert.equal(queue.inspect(issueKey(1842)), null)
  assert.ok(queue.inspect(issueKey(1844)))

  const none = await postEvent(url, multiIssueWebhook([{ issueId: '1845', project: 'Unknown' }, { issueId: '1846', project: 'Storefront' }]))
  assert.equal(none.status, 422)
  assert.equal(none.text, '{"error":"unknown-application"}')
  assert.equal(queue.size(), 1)
})

test('at most 50 attachments of one request are processed', async (t) => {
  const { url, queue } = await startRelay(t, { env: { QUEUE_LIMIT: '100' }, deliveryIntervalMs: 60 * SECOND })
  const payload = multiIssueWebhook(Array.from({ length: 51 }, (_, index) => ({ issueId: String(2000 + index) })))

  const response = await postEvent(url, payload)

  assert.deepEqual(response.body, counts(50))
  assert.equal(queue.size(), 50)
  assert.ok(queue.inspect(issueKey(2049)))
  assert.equal(queue.inspect(issueKey(2050)), null)
})

test('a queue that fills during a multi-issue alert answers 503 and keeps what it queued', async (t) => {
  const { url, queue } = await startRelay(t, { deliveryIntervalMs: 60 * SECOND })
  for (let index = 0; index < 9; index += 1) {
    assert.deepEqual((await postEvent(url, companionEvent({ eventId: `evt-${index}` }))).body, counts(1))
  }

  const response = await postEvent(url, multiIssueWebhook([{ issueId: '1842' }, { issueId: '1843' }, { issueId: '1844' }]))

  assert.equal(response.status, 503)
  assert.deepEqual(response.body, { error: 'queue-full' })
  assert.equal(queue.size(), 10)
  assert.ok(queue.inspect(issueKey(1842)))
  assert.equal(queue.inspect(issueKey(1843)), null)
})

test('without enrichment the webhook color sets the state and the brief button', async (t) => {
  const { url, queue, telegram } = await startRelay(t)
  const warning = glitchtipWebhook({ issueId: '1843' })
  warning.attachments[0].color = '#e9b949'
  const unknown = glitchtipWebhook({ issueId: '1844' })
  unknown.attachments[0].color = '#123456'

  for (const payload of [glitchtipWebhook(), warning, unknown]) {
    assert.deepEqual((await postEvent(url, payload)).body, counts(1))
  }
  const ids = [issueKey(1842), issueKey(1843, { state: 'warning' }), issueKey(1844, { state: 'info' })]
  await waitFor(() => ids.every((id) => queue.inspect(id) && queue.inspect(id).status === 'delivered'))

  assert.deepEqual(ids.map((id) => queue.inspect(id).state), ['error', 'warning', 'info'])
  assert.equal(telegram.calls.sendEvent[0].callbackKey, callbackKeyFor('acme', issueKey(1842)))
  assert.equal(telegram.calls.sendEvent[2].callbackKey, undefined)
})

test('repeat alerts for one issue are separate deliveries once a new 10-minute window starts', async (t) => {
  const { url, queue, now } = await startRelay(t, { deliveryIntervalMs: 60 * SECOND })

  assert.deepEqual((await postEvent(url, glitchtipWebhook())).body, counts(1))
  now.value = START + TEN_MINUTES - 1
  assert.deepEqual((await postEvent(url, glitchtipWebhook())).body, counts(0, 1))
  now.value = START + TEN_MINUTES
  assert.deepEqual((await postEvent(url, glitchtipWebhook())).body, counts(1))

  assert.ok(queue.inspect(issueKey(1842)))
  assert.ok(queue.inspect(issueKey(1842, { bucket: BUCKET + 1 })))
  assert.equal(queue.size(), 2)
})

test('a project name equal to another application\'s slug routes to the slug\'s application', async (t) => {
  // Accepted by decision: slugs match before names, and the operator controls both. A GlitchTip
  // project named "storefront" therefore lands in the storefront application, not in the one
  // that configured that name, unless enrichment supplies the real slug.
  const catalog = { id: 'catalog', name: 'Catalog', projectSlug: 'catalog-api', projectName: 'storefront', topicId: 46, environments: ['production'] }
  const { url, queue } = await startRelay(t, {
    env: { APPLICATIONS_JSON: JSON.stringify([billing, storefront, catalog]) },
    deliveryIntervalMs: 60 * SECOND,
  })

  assert.deepEqual((await postEvent(url, glitchtipWebhook({ project: 'storefront' }))).body, counts(1))
  assert.equal(queue.inspect(issueKey(1842)).applicationId, 'storefront')
})

test('an unknown project is refused with 422 and the payload is not echoed', async (t) => {
  const { url, queue } = await startRelay(t)

  for (const project of [`unknown-${BODY_CANARY}`, 'Storefront', 'billing api', null]) {
    const response = await postEvent(url, glitchtipWebhook({ project, title: BODY_CANARY }))

    assert.equal(response.status, 422, JSON.stringify(project))
    assert.equal(response.text, '{"error":"unknown-application"}')
  }
  assert.equal(queue.size(), 0)
})

test('a real GlitchTip webhook routes by project name without enrichment and is delivered', async (t) => {
  const { url, queue, telegram } = await startRelay(t)

  const response = await postEvent(url, glitchtipWebhook())
  assert.equal(response.status, 202)
  assert.deepEqual(response.body, counts(1))
  await waitFor(() => queue.inspect(issueKey(1842)).status === 'delivered')

  const record = queue.inspect(issueKey(1842))
  assert.equal(record.applicationId, 'billing-api')
  assert.equal(record.environment, 'production')
  assert.equal(record.release, 'a81c2f7')
  assert.equal(record.title, 'OperationalError: database unavailable')
  assert.equal(record.issueUrl, 'https://errors.example.test/acme/issues/1842')
  assert.equal(telegram.calls.sendEvent[0].topicId, 44)
})

test('a webhook project that equals a slug routes to that application', async (t) => {
  const { url, queue } = await startRelay(t, { deliveryIntervalMs: 60 * SECOND })

  assert.equal((await postEvent(url, glitchtipWebhook({ project: 'storefront', issueId: '77' }))).status, 202)
  assert.equal(queue.inspect(issueKey(77)).applicationId, 'storefront')
})

test('the enriched issue slug decides the application over the webhook project name', async (t) => {
  const calls = []
  const { url, queue } = await startRelay(t, {
    fetchFn: glitchtipFetch(calls, { issue: { ...issueBody, project: { ...issueBody.project, slug: 'storefront' } } }),
    env: { GLITCHTIP_API_TOKEN: API_TOKEN },
    deliveryIntervalMs: 60 * SECOND,
  })

  assert.equal((await postEvent(url, glitchtipWebhook())).status, 202)
  assert.equal(queue.inspect(ENRICHED_ID).applicationId, 'storefront')
})

test('an enriched slug that no application watches is refused even if the name matches', async (t) => {
  const calls = []
  const { url, queue } = await startRelay(t, {
    fetchFn: glitchtipFetch(calls, { issue: { ...issueBody, project: { ...issueBody.project, slug: 'billing-api-v2' } } }),
    env: { GLITCHTIP_API_TOKEN: API_TOKEN },
  })

  const response = await postEvent(url, glitchtipWebhook())
  assert.equal(response.status, 422)
  assert.equal(response.text, '{"error":"unknown-application"}')
  assert.equal(calls.length, 2)
  assert.equal(queue.size(), 0)
})

test('events outside the application environments are acknowledged and ignored', async (t) => {
  const { url, queue } = await startRelay(t)

  for (const environment of ['staging', 'Production']) {
    const response = await postEvent(url, glitchtipWebhook({ environment }))
    assert.equal(response.status, 202, JSON.stringify(environment))
    assert.deepEqual(response.body, counts(0, 0, 1))
    const synthetic = await postEvent(url, companionEvent({ environment, eventId: `evt-${environment}` }))
    assert.deepEqual(synthetic.body, counts(0, 0, 1))
  }
  assert.equal(queue.size(), 0)
})

test('an event without an environment is delivered rather than silently dropped', async (t) => {
  const { url, queue, telegram } = await startRelay(t)

  assert.deepEqual((await postEvent(url, glitchtipWebhook({ environment: null }))).body, counts(1))
  assert.deepEqual((await postEvent(url, glitchtipWebhook({ environment: '', issueId: '1843' }))).body, counts(1))
  await waitFor(() => queue.inspect(issueKey(1842)).status === 'delivered' &&
    queue.inspect(issueKey(1843)).status === 'delivered')

  assert.equal(queue.inspect(issueKey(1842)).environment, '')
  assert.equal(telegram.calls.sendEvent.length, 2)
})

test('an accepted event is answered 202 before Telegram delivery completes', async (t) => {
  const release = deferred()
  const telegram = fakeTelegram({ sendEvent: () => release.promise })
  const calls = []
  const { url, queue, auditRecords } = await startRelay(t, {
    telegram,
    fetchFn: glitchtipFetch(calls),
    env: { GLITCHTIP_API_TOKEN: API_TOKEN },
  })

  const response = await postEvent(url, glitchtipWebhook())
  assert.equal(response.status, 202)
  assert.deepEqual(response.body, counts(1))
  assert.notEqual(queue.inspect(ENRICHED_ID).status, 'delivered')
  assert.deepEqual(auditRecords(), [])

  await waitFor(() => telegram.calls.sendEvent.length === 1)
  release.resolve(801)
  await waitFor(() => queue.inspect(ENRICHED_ID).status === 'delivered')
  assert.equal(queue.inspect(ENRICHED_ID).telegramMessageId, 801)
})

test('GlitchTip enrichment uses bearer auth, a timeout, and no redirects before enqueue', async (t) => {
  const calls = []
  const { url, queue } = await startRelay(t, {
    fetchFn: glitchtipFetch(calls),
    env: { GLITCHTIP_API_TOKEN: API_TOKEN },
    deliveryIntervalMs: 60 * SECOND,
  })

  const response = await postEvent(url, glitchtipWebhook({ environment: null, release: null }))

  assert.equal(response.status, 202)
  assert.deepEqual(calls.map((call) => call.url).sort(), [
    'http://glitchtip.internal:8080/api/0/issues/1842/',
    'http://glitchtip.internal:8080/api/0/issues/1842/events/latest/',
  ])
  for (const { init } of calls) {
    assert.equal(init.method, 'GET')
    assert.equal(init.redirect, 'manual')
    assert.equal(init.headers.Authorization, `Bearer ${API_TOKEN}`)
    assert.ok(init.signal instanceof AbortSignal)
  }
  const record = queue.inspect(ENRICHED_ID)
  assert.equal(record.applicationId, 'billing-api')
  assert.equal(record.environment, 'production')
  assert.equal(record.state, 'error')
  assert.equal(record.release, 'a81c2f7')
  assert.equal(record.eventCount, 47)
})

for (const [name, fetchFn] of [
  ['a network error', async () => { throw new Error(`connect ECONNREFUSED ${API_TOKEN}`) }],
  ['an HTTP error', async () => jsonResponse({ detail: BODY_CANARY }, { ok: false, status: 500 })],
  ['a redirect', async () => jsonResponse({}, { ok: false, status: 302 })],
  ['malformed JSON', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError(BODY_CANARY) } })],
  ['a non-object body', async () => jsonResponse([issueBody])],
  ['one failed lookup', async (url) => url.endsWith('/events/latest/')
    ? jsonResponse({}, { ok: false, status: 404 })
    : jsonResponse(issueBody)],
]) {
  test(`enrichment falls back to webhook fields after ${name}`, async (t) => {
    const logger = recordingLogger()
    const { url, queue } = await startRelay(t, {
      fetchFn,
      logger,
      env: { GLITCHTIP_API_TOKEN: API_TOKEN },
      deliveryIntervalMs: 60 * SECOND,
    })

    const response = await postEvent(url, glitchtipWebhook())

    assert.equal(response.status, 202)
    assert.deepEqual(response.body, counts(1))
    const record = queue.inspect(issueKey(1842))
    assert.equal(record.applicationId, 'billing-api')
    assert.equal(record.title, 'OperationalError: database unavailable')
    assert.equal(record.environment, 'production')
    assert.equal(record.release, 'a81c2f7')
    assert.equal(record.eventCount, null)
    assert.doesNotMatch(logger.lines.join('\n'), /canary|CANARY/)
  })
}

test('enrichment is skipped without an API token or a numeric issue ID', async (t) => {
  const calls = []
  const { url, queue } = await startRelay(t, { fetchFn: glitchtipFetch(calls), deliveryIntervalMs: 60 * SECOND })
  assert.equal((await postEvent(url, glitchtipWebhook())).status, 202)

  const tokenCalls = []
  const withToken = await startRelay(t, {
    fetchFn: glitchtipFetch(tokenCalls),
    env: { GLITCHTIP_API_TOKEN: API_TOKEN },
    deliveryIntervalMs: 60 * SECOND,
  })
  const response = await postEvent(withToken.url, glitchtipWebhook({ issueId: '..%2F..%2Fadmin/' }))

  assert.equal(response.status, 202)
  assert.deepEqual(calls, [])
  assert.deepEqual(tokenCalls, [])
  assert.equal(queue.size(), 1)
})

test('repeated webhook deliveries are acknowledged as duplicates and queued once', async (t) => {
  const { url, queue } = await startRelay(t, { deliveryIntervalMs: 60 * SECOND })

  assert.deepEqual((await postEvent(url, companionEvent({ eventId: 'evt-1' }))).body, counts(1))
  const repeated = await postEvent(url, companionEvent({ eventId: 'evt-1' }))
  assert.equal(repeated.status, 202)
  assert.deepEqual(repeated.body, counts(0, 1))

  assert.deepEqual((await postEvent(url, glitchtipWebhook())).body, counts(1))
  assert.deepEqual((await postEvent(url, glitchtipWebhook())).body, counts(0, 1))
  assert.equal(queue.size(), 2)
  assert.ok(queue.inspect('evt-1:test'))
  assert.ok(queue.inspect(issueKey(1842)))
})

test('one enriched GlitchTip event yields a separate delivery for each state', async (t) => {
  const calls = []
  const { url, queue } = await startRelay(t, {
    fetchFn: glitchtipFetch(calls),
    env: { GLITCHTIP_API_TOKEN: API_TOKEN },
    deliveryIntervalMs: 60 * SECOND,
  })

  assert.deepEqual((await postEvent(url, glitchtipWebhook())).body, counts(1))
  const resolved = { ...glitchtipWebhook(), companion_state: 'resolved' }
  assert.deepEqual((await postEvent(url, resolved)).body, counts(1))

  assert.equal(queue.inspect(ENRICHED_ID).state, 'error')
  assert.equal(queue.inspect(`${LATEST_EVENT_ID}:resolved`).state, 'resolved')
})

test('an unsafe producer ID never reaches the queue, the audit, or Telegram', async (t) => {
  const ID_CANARY = 'id canary/../<b>'
  const { url, queue, telegram, auditRecords, config } = await startRelay(t)

  const response = await postEvent(url, companionEvent({ eventId: ID_CANARY }))
  assert.deepEqual(response.body, counts(1))
  await waitFor(() => auditRecords().length === 1)

  const [audited] = auditRecords()
  assert.match(audited.eventId, /^[a-f0-9]{32}:test$/)
  assert.equal(queue.inspect(audited.eventId).status, 'delivered')
  for (const text of [
    fs.readFileSync(config.auditPath, 'utf8'),
    fs.readFileSync(config.queuePath, 'utf8'),
    JSON.stringify(telegram.calls.sendEvent),
  ]) {
    assert.doesNotMatch(text, /id canary/)
  }
})

test('a full queue refuses new events with 503', async (t) => {
  const { url, queue } = await startRelay(t, { deliveryIntervalMs: 60 * SECOND })

  for (let index = 0; index < 10; index += 1) {
    assert.equal((await postEvent(url, companionEvent({ eventId: `evt-${index}` }))).status, 202)
  }
  const refused = await postEvent(url, companionEvent({ eventId: 'evt-overflow' }))

  assert.equal(refused.status, 503)
  assert.deepEqual(refused.body, { error: 'queue-full' })
  assert.equal(queue.size(), 10)
})

test('delivery formats in the workspace locale and labels the brief button in that locale', async (t) => {
  const { url, queue, telegram, auditRecords, config } = await startRelay(t, {
    env: { COMPANION_LOCALE: 'uz' },
  })

  await postEvent(url, companionEvent({ eventId: 'evt-error', state: 'error' }))
  await waitFor(() => queue.inspect('evt-error:error').status === 'delivered')
  await postEvent(url, companionEvent({ eventId: 'evt-info', state: 'info' }))
  await waitFor(() => queue.inspect('evt-info:info').status === 'delivered')

  const errorRecord = queue.inspect('evt-error:error')
  assert.deepEqual(telegram.calls.sendEvent[0], {
    chatId: -100123,
    topicId: 44,
    message: formatMessage(errorRecord, 'uz').text,
    callbackKey: callbackKeyFor('acme', 'evt-error:error'),
    actionText: 'Agent uchun maʼlumot tayyorlash',
  })
  assert.deepEqual(telegram.calls.sendEvent[1], {
    chatId: -100123,
    topicId: 44,
    message: formatMessage(queue.inspect('evt-info:info'), 'uz').text,
  })
  assert.deepEqual(auditRecords()[0], {
    eventId: 'evt-error:error',
    applicationId: 'billing-api',
    state: 'error',
    status: 'delivered',
    at: new Date(Date.UTC(2026, 8, 23, 10)).toISOString(),
    relayVersion: RELAY_VERSION,
    configRevision: config.configRevision,
    telegramMessageId: 801,
    retryCount: 0,
  })
})

test('failed sends are retried with normalized codes and every transition is audited', async (t) => {
  const telegram = fakeTelegram({
    sendEvent: (request, attempt) => {
      if (attempt === 1) {
        throw { code: 429, retryAfterSeconds: 17, description: `Too Many Requests ${BODY_CANARY}` }
      }
      return 901
    },
  })
  const { url, queue, now, auditRecords, logger } = await startRelay(t, { telegram })

  await postEvent(url, companionEvent({ eventId: 'evt-retry', state: 'warning' }))
  await waitFor(() => queue.inspect('evt-retry:warning').retryCount === 1)
  const retried = queue.inspect('evt-retry:warning')
  assert.equal(retried.status, 'pending')
  assert.equal(retried.failureCode, 'telegram-429')
  assert.equal(retried.nextRetryAt, now.value + 17 * SECOND)

  now.value += 17 * SECOND
  await waitFor(() => queue.inspect('evt-retry:warning').status === 'delivered')

  const [retrying, delivered] = auditRecords()
  assert.deepEqual(retrying, {
    eventId: 'evt-retry:warning',
    applicationId: 'billing-api',
    state: 'warning',
    status: 'retrying',
    at: new Date(Date.UTC(2026, 8, 23, 10)).toISOString(),
    nextRetryAt: new Date(Date.UTC(2026, 8, 23, 10) + 17 * SECOND).toISOString(),
    failureCode: 'telegram-429',
    relayVersion: RELAY_VERSION,
    configRevision: 'rev-7',
    retryCount: 1,
  })
  assert.equal(delivered.status, 'delivered')
  assert.equal(delivered.telegramMessageId, 901)
  assert.equal(delivered.retryCount, 1)
  assert.equal(telegram.calls.sendEvent.length, 2)
  assert.doesNotMatch(logger.lines.join('\n'), /canary|CANARY/)
})

test('an event whose application was removed is retried as delivery-failed without sending', async (t) => {
  const retired = {
    id: 'evt-retired',
    applicationId: 'retired-app',
    applicationName: 'Retired',
    projectSlug: 'retired-app',
    environment: 'production',
    state: 'error',
    title: 'Old failure',
    issueId: '7',
    issueUrl: '',
    release: '',
    eventCount: null,
    affectedUsers: null,
    windowMinutes: null,
    threshold: null,
    firstSeen: '',
    lastSeen: '',
    incidentMinutes: null,
    quietMinutes: null,
  }
  const { queue, telegram, auditRecords } = await startRelay(t, { seed: (queue) => queue.enqueue(retired) })

  await waitFor(() => queue.inspect('evt-retired').retryCount === 1)

  assert.equal(queue.inspect('evt-retired').failureCode, 'delivery-failed')
  assert.equal(telegram.calls.sendEvent.length, 0)
  assert.equal(auditRecords()[0].failureCode, 'delivery-failed')
  assert.equal(auditRecords()[0].status, 'retrying')
})

test('a rejected bot token pauses all sends, degrades readiness, and is audited once', async (t) => {
  const telegram = fakeTelegram({
    sendEvent: () => { throw { code: 401, retryAfterSeconds: null, description: 'Unauthorized' } },
  })
  const { url, queue, auditRecords } = await startRelay(t, {
    telegram,
    deliveryIntervalMs: 60 * SECOND,
    seed: (queue) => {
      queue.enqueue(queuedEvent('evt-a', 'billing-api'))
      queue.enqueue(queuedEvent('evt-b', 'storefront'))
    },
  })

  await waitFor(async () => (await readiness(url)).body.status === 'degraded')
  const degraded = await readiness(url)
  assert.equal(degraded.status, 503)
  assert.deepEqual(degraded.body, { status: 'degraded', version: RELAY_VERSION, configRevision: 'rev-7' })
  // Both applications were sent to in the same tick; only the first refusal is recorded.
  assert.equal(telegram.calls.sendEvent.length, 2)
  const audited = auditRecords()
  assert.equal(audited.length, 1)
  assert.equal(audited[0].failureCode, 'telegram-401')
  assert.equal(audited[0].status, 'retrying')
  const [recorded, released] = audited[0].eventId === 'evt-a' ? ['evt-a', 'evt-b'] : ['evt-b', 'evt-a']
  assert.equal(queue.inspect(recorded).status, 'pending')
  assert.equal(queue.inspect(recorded).retryCount, 1)
  assert.equal(queue.inspect(recorded).failureCode, 'telegram-401')
  // The other item was put back untouched: no retry counted, no failure recorded, no claim left.
  const other = queue.inspect(released)
  assert.equal(other.status, 'pending')
  assert.equal(other.retryCount, 0)
  assert.equal(other.failureCode, null)
  assert.equal(other.claimExpiresAt, null)

  assert.equal((await postEvent(url, companionEvent({ eventId: 'evt-c' }))).status, 202)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(telegram.calls.sendEvent.length, 2)
  assert.equal(auditRecords().length, 1)
})

test('a send refused with 401 is still audited once when the poller saw the rejected token first', async (t) => {
  const send = deferred()
  const poll = deferred()
  const telegram = fakeTelegram({
    sendEvent: () => send.promise,
    pollUpdates: () => poll.promise,
  })
  const unauthorized = { code: 401, retryAfterSeconds: null, description: 'Unauthorized' }
  const { url, queue, auditRecords } = await startRelay(t, {
    telegram,
    seed: (queue) => queue.enqueue(queuedEvent('evt-a', 'billing-api')),
  })

  await waitFor(() => telegram.calls.sendEvent.length === 1)
  poll.reject(unauthorized)
  await waitFor(async () => (await readiness(url)).body.status === 'degraded')
  send.reject(unauthorized)
  await waitFor(() => auditRecords().length === 1)

  assert.equal(auditRecords()[0].failureCode, 'telegram-401')
  assert.equal(auditRecords()[0].eventId, 'evt-a')
  assert.equal(queue.inspect('evt-a').retryCount, 1)
  assert.equal(queue.inspect('evt-a').failureCode, 'telegram-401')
})

test('one tick sends to different applications concurrently, one item per application at a time', async (t) => {
  const sends = []
  const telegram = fakeTelegram({
    sendEvent: () => {
      const send = deferred()
      sends.push(send)
      return send.promise
    },
  })
  const { queue, auditRecords } = await startRelay(t, {
    telegram,
    seed: (queue) => {
      queue.enqueue(queuedEvent('billing-1', 'billing-api'))
      queue.enqueue(queuedEvent('billing-2', 'billing-api'))
      queue.enqueue(queuedEvent('storefront-1', 'storefront'))
    },
  })

  await waitFor(() => telegram.calls.sendEvent.length === 2)
  assert.deepEqual(telegram.calls.sendEvent.map((request) => request.topicId).sort(), [44, 45])
  // Several delivery intervals pass while both sends are in flight: billing-2 waits for billing-1.
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(telegram.calls.sendEvent.length, 2)
  assert.equal(queue.inspect('billing-2').status, 'pending')

  sends[0].resolve(801)
  sends[1].resolve(802)
  await waitFor(() => telegram.calls.sendEvent.length === 3)
  assert.equal(telegram.calls.sendEvent[2].topicId, 44)
  sends[2].resolve(803)
  await waitFor(() => queue.inspect('billing-2').status === 'delivered')
  assert.equal(queue.inspect('billing-1').status, 'delivered')
  assert.equal(queue.inspect('storefront-1').status, 'delivered')
  assert.equal(auditRecords().length, 3)
})

test('shutdown puts back claimed items it has not started sending', async (t) => {
  let closing = null
  const { queue, telegram, auditRecords, config } = await startRelay(t, {
    seed: (queue) => {
      queue.enqueue(queuedEvent('evt-a', 'billing-api'))
      queue.enqueue(queuedEvent('evt-b', 'storefront'))
    },
    // Shutdown begins between the claim and the sends.
    wrapQueue: (queue, relay) => ({
      ...queue,
      claimReady(limit) {
        const items = queue.claimReady(limit)
        if (items.length > 0 && closing === null) closing = relay().close()
        return items
      },
    }),
  })

  await waitFor(() => closing !== null)
  await closing

  assert.deepEqual(telegram.calls.sendEvent, [])
  assert.deepEqual(auditRecords(), [])
  const saved = JSON.parse(fs.readFileSync(config.queuePath, 'utf8'))
  for (const id of ['evt-a', 'evt-b']) {
    const record = queue.inspect(id)
    assert.equal(record.status, 'pending', id)
    assert.equal(record.retryCount, 0, id)
    assert.equal(record.failureCode, null, id)
    assert.equal(record.claimedAt, null, id)
    assert.equal(saved.records.find((item) => item.id === id).status, 'pending', id)
  }
})

test('the poller advances offsets and hands every update to the handler without replying', async (t) => {
  const handled = []
  const telegram = fakeTelegram({
    pollUpdates: (request, attempt) => {
      if (attempt === 1) {
        return {
          updates: [
            { update_id: 5, message: { text: `/pair ${BODY_CANARY}` } },
            { update_id: 6, callback_query: { id: 'cb-1', data: 'brief:0123456789abcdef' } },
          ],
          nextOffset: 7,
        }
      }
      return waitForAbort(request.signal)
    },
  })
  await startRelay(t, { telegram, handleUpdate: async (update) => { handled.push(update.update_id) } })

  await waitFor(() => telegram.calls.pollUpdates.length === 2)
  assert.deepEqual(handled, [5, 6])
  assert.equal(telegram.calls.pollUpdates[1].offset, 7)
  assert.equal(telegram.calls.pollUpdates[1].timeoutSeconds, 25)
  assert.deepEqual(telegram.calls.sendEvent, [])
  assert.deepEqual(telegram.calls.answerCallbackQuery, [])
})

test('the default update handler ignores everything and never replies', async (t) => {
  const telegram = fakeTelegram({
    pollUpdates: (request, attempt) => attempt === 1
      ? { updates: [{ update_id: 1, callback_query: { id: 'cb-1', data: 'brief:0123456789abcdef' } }], nextOffset: 2 }
      : waitForAbort(request.signal),
  })
  const { logger } = await startRelay(t, { telegram })

  await waitFor(() => telegram.calls.pollUpdates.length === 2)
  assert.deepEqual(telegram.calls.answerCallbackQuery, [])
  assert.deepEqual(telegram.calls.sendEvent, [])
  assert.deepEqual(telegram.calls.createTopic, [])
  assert.deepEqual(logger.lines, [])
})

test('poll and handler failures back off five seconds and never log update contents', async (t) => {
  const sleeps = []
  const telegram = fakeTelegram({
    pollUpdates: (request, attempt) => {
      if (attempt === 1) throw { code: 'network-error', retryAfterSeconds: null, description: BODY_CANARY }
      if (attempt === 2) return { updates: [{ update_id: 3, message: { text: BODY_CANARY } }], nextOffset: 4 }
      return waitForAbort(request.signal)
    },
  })
  const { logger } = await startRelay(t, {
    telegram,
    sleep: async (ms) => { sleeps.push(ms) },
    handleUpdate: async (update) => { throw new Error(`handler saw ${update.message.text}`) },
  })

  await waitFor(() => telegram.calls.pollUpdates.length === 3)
  assert.deepEqual(sleeps, [5 * SECOND])
  assert.equal(telegram.calls.pollUpdates[2].offset, 4)
  assert.ok(logger.lines.length >= 2)
  assert.doesNotMatch(logger.lines.join('\n'), /canary|CANARY/)
})

test('console never receives raw request bodies or secrets', async (t) => {
  const captured = []
  for (const method of ['log', 'error', 'warn', 'info', 'debug']) {
    t.mock.method(console, method, (...args) => { captured.push(args) })
  }
  const telegram = fakeTelegram({
    sendEvent: () => { throw { code: 400, retryAfterSeconds: null, description: `Bad Request ${BODY_CANARY}` } },
  })
  const { url, queue } = await startRelay(t, {
    telegram,
    logger: null,
    fetchFn: async () => { throw new Error(`refused ${BODY_CANARY} ${API_TOKEN}`) },
    env: { GLITCHTIP_API_TOKEN: API_TOKEN },
  })

  await postEvent(url, companionEvent({ eventId: `evt-${BODY_CANARY}`, title: BODY_CANARY }))
  await postEvent(url, `{"broken":"${BODY_CANARY}"`)
  await postEvent(url, glitchtipWebhook({ project: BODY_CANARY, title: BODY_CANARY }))
  await postEvent(url, `"${BODY_CANARY}${'x'.repeat(MIB)}"`)
  await request(`${url}/${BODY_CANARY}`, { method: 'POST', body: BODY_CANARY })
  await waitFor(() => queue.inspect(`evt-${BODY_CANARY}:test`).retryCount >= 1)

  const text = captured.map((args) => args.map((value) => {
    try { return typeof value === 'string' ? value : JSON.stringify(value) } catch { return String(value) }
  }).join(' ')).join('\n')
  assert.ok(captured.length > 0)
  assert.doesNotMatch(text, new RegExp(BODY_CANARY))
  assert.doesNotMatch(text, /CANARY|canary_api_token|glitchtip\.internal/)
})

test('graceful shutdown aborts long polling, lets the in-flight delivery persist, and closes within 10 seconds', async (t) => {
  const sending = deferred()
  const telegram = fakeTelegram({
    sendEvent: async () => {
      sending.resolve()
      await new Promise((resolve) => setTimeout(resolve, 200))
      return 777
    },
  })
  const relay = await startRelay(t, { telegram })
  const agent = new http.Agent({ keepAlive: true })
  t.after(() => agent.destroy())
  await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: relay.port, path: '/health/live', agent }, (response) => {
      response.resume()
      response.on('end', resolve)
    }).on('error', reject)
  })
  await waitFor(() => telegram.calls.pollUpdates.length === 1)
  await postEvent(relay.url, companionEvent({ eventId: 'evt-shutdown' }))
  await sending.promise

  const started = Date.now()
  await relay.relay.close()
  const elapsed = Date.now() - started

  assert.ok(elapsed < 10 * SECOND, `shutdown took ${elapsed} ms`)
  assert.equal(telegram.calls.pollUpdates[0].signal.aborted, true)
  assert.equal(relay.queue.inspect('evt-shutdown:test').status, 'delivered')
  const saved = JSON.parse(fs.readFileSync(relay.config.queuePath, 'utf8'))
  assert.equal(saved.records.find((record) => record.id === 'evt-shutdown:test').telegramMessageId, 777)
  await assert.rejects(fetch(`${relay.url}/health/live`))
})

test('shutdown still closes HTTP by its deadline when a send or a request hangs', async (t) => {
  const telegram = fakeTelegram({ sendEvent: () => new Promise(() => {}) })
  const relay = await startRelay(t, { telegram, shutdownTimeoutMs: 300 })
  await postEvent(relay.url, companionEvent({ eventId: 'evt-hung' }))
  await waitFor(() => telegram.calls.sendEvent.length === 1)
  const hung = http.request({
    host: '127.0.0.1',
    port: relay.port,
    method: 'POST',
    path: '/v1/glitchtip/events',
    headers: { 'Content-Length': '100' },
    agent: false,
  })
  const hungClosed = new Promise((resolve) => hung.on('error', resolve).on('close', resolve))
  hung.write('{"partial"')
  await new Promise((resolve) => setTimeout(resolve, 20))

  const started = Date.now()
  await relay.relay.close()
  const elapsed = Date.now() - started

  assert.ok(elapsed < 2 * SECOND, `shutdown took ${elapsed} ms`)
  await hungClosed
  await assert.rejects(fetch(`${relay.url}/health/live`))
})

// ---------------------------------------------------------------------------------------------
// Unpaired mode: the relay is deployed before Telegram pairing and performs the pairing itself.
// ---------------------------------------------------------------------------------------------

const UNPAIRED = { TELEGRAM_CHAT_ID: '', ALLOWED_MEMBER_IDS: '', APPLICATIONS_JSON: '' }
const PAIRING_CODE = 'ABCD-EFGH'
// Draws the alphabet indices of PAIRING_CODE.
const pairingDraws = () => {
  let next = 0
  return () => next++
}

// One batch of updates, then a long poll that ends only on shutdown.
const pollOnce = (updates) => (request, attempt) => attempt === 1
  ? { updates, nextOffset: Math.max(...updates.map((update) => update.update_id)) + 1 }
  : waitForAbort(request.signal)

const forumMessage = (updateId, text, { chat = {}, from = {} } = {}) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    text,
    from: { id: 42, is_bot: false, first_name: 'Owner', ...from },
    chat: { id: -100123, type: 'supergroup', is_forum: true, title: 'Acme alerts', ...chat },
  },
})

const administrator = (chatId, userId) => ({ status: userId === 42 ? 'creator' : 'member', user: { id: userId } })

test('an unpaired relay is ready, refuses events with 422 without enrichment, and never delivers', async (t) => {
  const fetchCalls = []
  const { url, queue, telegram, config } = await startRelay(t, {
    env: { ...UNPAIRED, GLITCHTIP_API_TOKEN: API_TOKEN },
    fetchFn: glitchtipFetch(fetchCalls),
    seed: (seeded) => seeded.enqueue({ ...queuedEvent('evt-left-over:error', 'billing-api'), receivedAt: START }),
  })

  assert.equal(config.paired, false)
  await waitFor(async () => (await readiness(url)).status === 200)
  assert.deepEqual((await readiness(url)).body, { status: 'ready', version: RELAY_VERSION, configRevision: 'rev-7' })

  for (const payload of [companionEvent(), glitchtipWebhook({ issueId: '1842' })]) {
    const response = await postEvent(url, payload)
    assert.equal(response.status, 422)
    assert.deepEqual(response.body, { error: 'unknown-application' })
  }
  assert.deepEqual(fetchCalls, [])

  // Many delivery intervals pass; the queued item is never claimed.
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(telegram.calls.sendEvent, [])
  assert.equal(queue.inspect('evt-left-over:error').status, 'pending')
  assert.equal(queue.inspect('evt-left-over:error').retryCount, 0)
})

test('while unpaired the poller hands only message updates to the pairing handler', async (t) => {
  const handled = []
  const pairingCalls = []
  const telegram = fakeTelegram({
    pollUpdates: pollOnce([
      forumMessage(5, `/pair ${PAIRING_CODE}`),
      { update_id: 6, callback_query: { id: 'cb-1', data: 'brief:0123456789abcdef' } },
      { update_id: 7, my_chat_member: { chat: { id: -100123 } } },
      forumMessage(8, 'hello team'),
    ]),
    getChatMember: administrator,
  })
  const { directory, logger } = await startRelay(t, {
    env: UNPAIRED,
    telegram,
    handleUpdate: async (update) => { handled.push(update.update_id) },
    handlePairingUpdate: async (input) => {
      pairingCalls.push(input)
      return null
    },
  })

  await waitFor(() => telegram.calls.pollUpdates.length === 2)
  assert.deepEqual(pairingCalls.map((input) => input.update.update_id), [5, 8])
  for (const input of pairingCalls) {
    assert.deepEqual(Object.keys(input).sort(), ['botUsername', 'clock', 'getChatMember', 'stateDir', 'update'])
    assert.equal(input.stateDir, directory)
    assert.equal(input.botUsername, 'acme_companion_bot')
    assert.equal(input.clock(), START)
  }
  assert.deepEqual(await pairingCalls[0].getChatMember(-100123, 42), { status: 'creator', user: { id: 42 } })
  assert.deepEqual(telegram.calls.getChatMember, [[-100123, 42]])
  assert.deepEqual(handled, [])
  assert.deepEqual(telegram.calls.sendEvent, [])
  assert.deepEqual(telegram.calls.answerCallbackQuery, [])
  assert.deepEqual(telegram.calls.createTopic, [])
  assert.deepEqual(logger.lines, [])
})

test('an unpaired relay pairs a private forum from a /pair message and never replies', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-server-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const telegram = fakeTelegram({
    pollUpdates: pollOnce([
      forumMessage(3, `/pair@acme_companion_bot ${BODY_CANARY}`),
      forumMessage(4, '/pair ZZZZ-ZZZZ'),
      forumMessage(5, '/pair abcd-efgh', { from: { id: 91 } }),
      forumMessage(6, '/pair@Acme_Companion_Bot abcdefgh'),
      forumMessage(7, '/pair ABCD-EFGH', { chat: { id: -100999, title: 'Other forum' } }),
    ]),
    getChatMember: administrator,
  })
  // The code exists before the first poll, as it does when the Mac creates it over SSH.
  createPairing(directory, { clock: () => START, random: pairingDraws() })
  const relay = await startRelay(t, {
    env: { ...UNPAIRED, QUEUE_PATH: path.join(directory, 'state.json') },
    telegram,
  })

  await waitFor(() => telegram.calls.pollUpdates.length === 2)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'pairing-result.json'), 'utf8')), {
    version: 1,
    chatId: -100123,
    chatTitle: 'Acme alerts',
    adminUserId: 42,
    pairedAt: new Date(START).toISOString(),
  })
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'pairing.json'), 'utf8')).used, true)
  assert.deepEqual(telegram.calls.getChatMember, [[-100123, 91], [-100123, 42]])
  assert.deepEqual(telegram.calls.sendEvent, [])
  assert.deepEqual(telegram.calls.answerCallbackQuery, [])
  assert.deepEqual(telegram.calls.createTopic, [])
  assert.deepEqual(relay.logger.lines, [
    'relay: pairing attempt rejected (code)',
    'relay: pairing attempt rejected (not-admin)',
    'relay: Telegram pairing completed',
    'relay: pairing attempt rejected (used)',
  ])
})

test('a failing pairing handler is logged as fixed text and polling continues', async (t) => {
  const telegram = fakeTelegram({
    pollUpdates: (request, attempt) => {
      if (attempt <= 2) return { updates: [forumMessage(attempt, `/pair ${BODY_CANARY}`)], nextOffset: attempt + 1 }
      return waitForAbort(request.signal)
    },
  })
  const { logger } = await startRelay(t, {
    env: UNPAIRED,
    telegram,
    handlePairingUpdate: async ({ update }) => { throw new Error(`saw ${update.message.text} ${BOT_TOKEN}`) },
  })

  await waitFor(() => telegram.calls.pollUpdates.length === 3)
  assert.equal(telegram.calls.pollUpdates[2].offset, 3)
  assert.deepEqual(logger.lines, ['relay: Telegram update handler failed', 'relay: Telegram update handler failed'])
})

test('a paired relay ignores /pair messages and leaves the pairing files untouched', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-server-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  createPairing(directory, { clock: () => START, random: pairingDraws() })
  const before = fs.readFileSync(path.join(directory, 'pairing.json'))
  const pairingCalls = []
  const telegram = fakeTelegram({
    pollUpdates: pollOnce([forumMessage(5, `/pair ${PAIRING_CODE}`), forumMessage(6, '/pair@acme_companion_bot abcdefgh')]),
    getChatMember: administrator,
  })
  const { logger } = await startRelay(t, {
    env: { QUEUE_PATH: path.join(directory, 'state.json') },
    telegram,
    handlePairingUpdate: async (input) => { pairingCalls.push(input) },
  })

  await waitFor(() => telegram.calls.pollUpdates.length === 2)
  assert.deepEqual(pairingCalls, [])
  assert.deepEqual(telegram.calls.getChatMember, [])
  assert.deepEqual(fs.readFileSync(path.join(directory, 'pairing.json')), before)
  assert.equal(fs.existsSync(path.join(directory, 'pairing-result.json')), false)
  assert.deepEqual(telegram.calls.sendEvent, [])
  assert.deepEqual(logger.lines, [])
})

// Loaded with --require into a real relay process: Telegram answers getMe, holds every long poll
// until the relay aborts it, and nothing else leaves the process.
const TELEGRAM_PRELOAD = `
  globalThis.fetch = async (url, init = {}) => {
    const method = String(url).split('/').pop()
    const reply = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) })
    if (method === 'getMe') return reply({ id: 987654321, is_bot: true, username: 'acme_companion_bot' })
    if (method === 'getUpdates') {
      return new Promise((resolve, reject) => {
        const abort = () => reject(new TypeError('aborted'))
        if (init.signal.aborted) return abort()
        init.signal.addEventListener('abort', abort, { once: true })
      })
    }
    throw new TypeError('fetch failed')
  }
`

test('the server process starts unpaired, is ready, and shuts down cleanly', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-server-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const preload = path.join(directory, 'preload.js')
  fs.writeFileSync(preload, TELEGRAM_PRELOAD)
  const port = await freePort()
  const child = spawn(process.execPath, ['--require', preload, path.join(__dirname, 'server.js')], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      COMPANION_WORKSPACE_ID: 'acme',
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      GLITCHTIP_API_TOKEN: API_TOKEN,
      TELEGRAM_CHAT_ID: '',
      ALLOWED_MEMBER_IDS: '',
      APPLICATIONS_JSON: '',
      QUEUE_PATH: path.join(directory, 'state.json'),
      AUDIT_PATH: path.join(directory, 'audit.jsonl'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })

  const url = `http://127.0.0.1:${port}`
  await waitFor(() => stdout.includes('relay: listening'), 5 * SECOND)
  await waitFor(async () => (await readiness(url)).status === 200, 5 * SECOND)
  assert.equal((await postEvent(url, companionEvent())).status, 422)
  child.kill('SIGTERM')
  assert.deepEqual(await exited, { code: 0, signal: null })

  assert.match(stdout, /relay: not paired; waiting for a pairing code/)
  assert.equal(stderr, '')
  assert.doesNotMatch(stdout, /CANARY|canary/)
})
