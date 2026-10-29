'use strict'
/**
 * GlitchTip Companion relay: the composition root.
 *
 * GlitchTip reaches this process only over the private Compose network. Accepted events are
 * normalized, routed to one application, and written to the durable queue before the webhook is
 * answered. One delivery loop sends queued events to their Telegram topics, and one long-polling
 * loop receives Telegram updates, so no public inbound endpoint is needed.
 *
 * Until TELEGRAM_CHAT_ID, ALLOWED_MEMBER_IDS, and APPLICATIONS_JSON are configured the relay runs
 * unpaired: it has no applications, the delivery loop stays idle, and the poller hands `message`
 * updates to the pairing handler, which records a `/pair CODE` sent by a forum administrator. The
 * relay never answers pairing attempts in Telegram.
 *
 * Nothing here logs request bodies, update contents, tokens, or URLs. Log lines carry fixed text
 * and normalized failure codes only.
 */
const { createHash, randomInt } = require('node:crypto')
const http = require('node:http')
const path = require('node:path')

const { openAudit } = require('./audit')
const { DEFAULT_PORT, applicationForEvent, readConfig, readPort } = require('./config')
const { authorizeUpdate } = require('./authorize')
const { incidentReference, normalizeEvent, webhookEvents, webhookProject } = require('./domain')
const { normalizeFailureCode } = require('./failure-code')
const { formatMessage } = require('./format')
const { PROVIDER_CODES, assertPromptSafe, buildPrompt, providerKeyboard } = require('./prompts')
const { handlePairingUpdate: defaultHandlePairingUpdate } = require('./pairing')
const { openQueue } = require('./queue')
const { createTelegramClient } = require('./telegram')
const { RELAY_VERSION } = require('./version')

const SECOND = 1000
const CALLBACK_TTL_MS = 10 * 60 * SECOND
const EXPIRED_ANSWER = 'Brief expired; request a new one.'
const BRIEF_DATA = /^brief:([0-9a-f]{16})$/
const PROVIDER_DATA = /^provider:([0-9a-f]{16}):([cho])$/
const MAX_BODY_BYTES = 1024 * 1024
const EVENTS_PATH = '/v1/glitchtip/events'
const LIVE_PATH = '/health/live'
const READY_PATH = '/health/ready'
const DELIVERY_BATCH = 10
const DEFAULT_DELIVERY_INTERVAL_MS = SECOND
const LONG_POLL_SECONDS = 25
const BACKOFF_MS = 5 * SECOND
const ENRICHMENT_TIMEOUT_MS = 5 * SECOND
// GlitchTip gives up on a webhook after about 10 s and never retries it, so all enrichment for one
// request must finish well inside that.
const DEFAULT_ENRICHMENT_BUDGET_MS = 4 * SECOND
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8 * SECOND
const REQUEST_TIMEOUT_MS = 15 * SECOND
const TELEGRAM_REQUEST_TIMEOUT_MS = 10 * SECOND
const TELEGRAM_POLL_REQUEST_TIMEOUT_MS = (LONG_POLL_SECONDS + 10) * SECOND
const NUMERIC_ISSUE_ID = /^[0-9]{1,19}$/
// GlitchTip sends one attachment per issue (3 by default); anything past this is ignored.
const MAX_ATTACHMENTS = 50
// GlitchTip API calls one webhook request may have in flight at once.
const MAX_CONCURRENT_LOOKUPS = 4
// consumePairingCode's rejection reasons; they are logged, nothing else about an attempt is.
const PAIRING_REASONS = new Set(['expired', 'used', 'chat-type', 'not-admin', 'code'])

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Opaque callback data for the agent-brief button. It identifies the event without exposing it.
 *
 * @param {string} workspaceId
 * @param {string} eventId
 * @returns {string}
 */
const callbackKeyFor = (workspaceId, eventId) => `brief:${createHash('sha256')
  .update(`${workspaceId}:${eventId}`)
  .digest('hex')
  .slice(0, 16)}`

const failureOf = (error) => ({
  code: isObject(error) ? error.code : null,
  retryAfterSeconds: isObject(error) && Number.isSafeInteger(error.retryAfterSeconds)
    ? error.retryAfterSeconds
    : null,
})

const failureCodeOf = (error) => normalizeFailureCode(failureOf(error).code)

// Operators get the Telegram status when there is one (409 means another poller holds the bot).
const logCodeOf = (error) => {
  const { code } = failureOf(error)
  return Number.isSafeInteger(code) && code >= 100 && code <= 599
    ? `telegram-${code}`
    : normalizeFailureCode(code)
}

const isoTime = (milliseconds) => new Date(milliseconds).toISOString()

// The enrichment budget of one request. `signal` aborts when the budget is spent or the request is
// done with enrichment, `expired` settles at that moment, and `remaining()` is the time left.
const startBudget = (milliseconds) => {
  const controller = new AbortController()
  const startedAt = performance.now()
  const timer = setTimeout(() => controller.abort(), milliseconds)
  const expired = new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true }))
  return {
    signal: controller.signal,
    expired,
    remaining: () => milliseconds - (performance.now() - startedAt),
    end: () => {
      clearTimeout(timer)
      controller.abort()
    },
  }
}

// Runs at most `limit` tasks at once, starting the rest in order as earlier ones settle.
const createLimiter = (limit) => {
  let active = 0
  const waiting = []
  const next = () => {
    while (active < limit && waiting.length > 0) {
      const { task, resolve, reject } = waiting.shift()
      active += 1
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active -= 1
          next()
        })
    }
  }
  return (task) => new Promise((resolve, reject) => {
    waiting.push({ task, resolve, reject })
    next()
  })
}

const abortableSleep = (milliseconds, signal) => new Promise((resolve) => {
  if (signal && signal.aborted) return resolve()
  const done = () => {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', done)
    resolve()
  }
  const timer = setTimeout(done, milliseconds)
  if (signal) signal.addEventListener('abort', done, { once: true })
})

const consoleLogger = {
  info: (...args) => console.log(...args),
  error: (...args) => console.error(...args),
}

/**
 * Build the relay around already-opened collaborators. Nothing runs until `start`.
 *
 * @param {Object} deps
 * @param {import('./config').RelayConfig} deps.config
 * @param {{ getMe: Function, sendEvent: Function, pollUpdates: Function, getChatMember: Function }} deps.telegram
 * @param {{ enqueue: Function, claimReady: Function, markDelivered: Function, markRetry: Function, release: Function, inspect: Function }} deps.queue
 * @param {{ writeAudit: Function }} deps.audit
 * @param {Function} [deps.fetchFn] GlitchTip API fetch.
 * @param {() => number} [deps.clock]
 * @param {(milliseconds: number, signal?: AbortSignal) => Promise<void>} [deps.sleep]
 * @param {(update: Object) => Promise<void>|void} [deps.handleUpdate] Handles updates while paired.
 *   Defaults to ignoring every update, `/pair` messages included.
 * @param {Function} [deps.handlePairingUpdate] Handles `message` updates while unpaired; see
 *   pairing.js.
 * @param {number} [deps.deliveryIntervalMs]
 * @param {number} [deps.shutdownTimeoutMs]
 * @param {number} [deps.enrichmentBudgetMs] Total GlitchTip enrichment time per request.
 * @param {{ info: Function, error: Function }} [deps.logger]
 */
function createRelayServer(deps) {
  if (!isObject(deps) || !isObject(deps.config) || !deps.telegram || !deps.queue || !deps.audit) {
    throw new Error('Invalid relay dependencies')
  }
  const {
    config,
    telegram,
    queue,
    audit,
    fetchFn = globalThis.fetch,
    clock = Date.now,
    sleep = abortableSleep,
    handleUpdate: customHandleUpdate,
    handlePairingUpdate = defaultHandlePairingUpdate,
    deliveryIntervalMs = DEFAULT_DELIVERY_INTERVAL_MS,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    enrichmentBudgetMs = DEFAULT_ENRICHMENT_BUDGET_MS,
    logger = consoleLogger,
  } = deps

  // Aborted on shutdown or when Telegram rejects the bot token; it ends polling and back-offs.
  const lifecycle = new AbortController()
  let identityConfirmed = false
  let botUsername = null
  let pollerStarted = false
  let paused = false
  // The first send Telegram refuses with 401 is audited; later refusals of the same token are not.
  let sendRejectionAudited = false
  let stopping = false
  let deliveryTimer = null
  let currentTick = null
  let initializing = null
  let polling = null
  let closing = null

  const health = (status) => ({ status, version: RELAY_VERSION, configRevision: config.configRevision })
  const readiness = () => {
    if (paused) return health('degraded')
    return identityConfirmed && pollerStarted ? health('ready') : health('starting')
  }

  const pauseForAuthentication = () => {
    if (paused) return
    paused = true
    logger.error('relay: Telegram rejected the bot token (telegram-401); delivery paused until restart')
    clearTimeout(deliveryTimer)
    deliveryTimer = null
    lifecycle.abort()
  }

  // ---------------------------------------------------------------------------------------------
  // Ingest
  // ---------------------------------------------------------------------------------------------

  // Each call gets 5 seconds or what is left of the request's budget, whichever is less, and is
  // aborted as soon as the budget is spent. A call that would start after that never starts.
  const glitchtipJson = async (url, budget) => {
    const remaining = budget.remaining()
    if (budget.signal.aborted || remaining <= 0) throw new Error('GlitchTip lookup skipped')
    const response = await fetchFn(url, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${config.glitchtipApiToken}` },
      redirect: 'manual',
      // AbortSignal.timeout takes whole milliseconds; `remaining` is above zero here.
      signal: AbortSignal.any([budget.signal, AbortSignal.timeout(Math.min(ENRICHMENT_TIMEOUT_MS, Math.ceil(remaining)))]),
    })
    if (!response || response.ok !== true || typeof response.json !== 'function') {
      throw new Error('GlitchTip lookup failed')
    }
    const body = await response.json()
    if (!isObject(body)) throw new Error('GlitchTip lookup failed')
    return body
  }

  // Both lookups or neither: a partial answer would mix issue and event identities. Each call goes
  // through the request's limiter, and its timeout starts only when the call does.
  const enrich = async (issueId, limit, budget) => {
    if (!config.glitchtipApiToken || !NUMERIC_ISSUE_ID.test(issueId)) return {}
    const base = `${config.glitchtipApiBase}/api/0/issues/${issueId}`
    try {
      const [issue, event] = await Promise.all([
        limit(() => glitchtipJson(`${base}/`, budget)),
        limit(() => glitchtipJson(`${base}/events/latest/`, budget)),
      ])
      return { issue, event }
    } catch {
      return { failed: true }
    }
  }

  const accept = async (body) => {
    let payload
    try {
      payload = JSON.parse(body.toString('utf8'))
    } catch {
      return [400, { error: 'invalid-json' }]
    }
    if (!isObject(payload)) return [400, { error: 'invalid-json' }]
    // An unpaired relay, or one whose topics do not exist yet, watches no project, so nothing is
    // looked up in GlitchTip.
    if (config.applications.length === 0) return [422, { error: 'unknown-application' }]

    // Every attachment is its own issue. All of them share one receive time, and they are queued
    // in the order GlitchTip sent them.
    const receivedAt = clock()
    const events = webhookEvents(payload, MAX_ATTACHMENTS)
    // One lookup per distinct issue, at most MAX_CONCURRENT_LOOKUPS GlitchTip calls at a time, and
    // all of it within the request's budget. When the budget is spent, every issue not enriched yet
    // uses its webhook fields, and whatever is still in flight or queued is aborted.
    const limit = createLimiter(MAX_CONCURRENT_LOOKUPS)
    const budget = startBudget(enrichmentBudgetMs)
    const outOfTime = budget.expired.then(() => ({ failed: true }))
    const byIssue = new Map()
    const lookupFor = (issueId) => {
      if (!byIssue.has(issueId)) byIssue.set(issueId, Promise.race([enrich(issueId, limit, budget), outOfTime]))
      return byIssue.get(issueId)
    }
    let lookups
    try {
      lookups = await Promise.all(events.map((single) => lookupFor(normalizeEvent({ payload: single }).issueId)))
    } finally {
      budget.end()
    }
    if (lookups.some((lookup) => lookup.failed)) {
      logger.error('relay: GlitchTip enrichment unavailable; using webhook fields')
    }

    const counts = { accepted: 0, duplicates: 0, ignored: 0 }
    let routed = 0
    for (const [index, single] of events.entries()) {
      const { issue, event } = lookups[index]
      const application = applicationForEvent(config, {
        issueProjectSlug: issue && isObject(issue.project) ? issue.project.slug : undefined,
        payloadProject: webhookProject(single),
      })
      // An attachment no application watches is acknowledged with the rest; the request is refused
      // only when none of them routes.
      if (!application) {
        counts.ignored += 1
        continue
      }
      routed += 1

      const normalized = normalizeEvent({ payload: single, issue, event, application, receivedAt })
      // An event with no environment is delivered: its environment is unknown, and a silent drop
      // is worse than one unfiltered alert.
      if (normalized.environment !== '' && !application.environments.includes(normalized.environment)) {
        counts.ignored += 1
        continue
      }

      // A queue failure stops the request. What was already queued stays queued, and a repeat of
      // the request is deduplicated against it.
      let result
      try {
        result = queue.enqueue(normalized)
      } catch {
        logger.error('relay: unable to queue event')
        return [503, { error: 'queue-unavailable' }]
      }
      if (result.accepted) {
        counts.accepted += 1
      } else if (result.duplicate) {
        counts.duplicates += 1
      } else {
        logger.error('relay: delivery queue is full')
        return [503, { error: 'queue-full' }]
      }
    }

    if (routed === 0) return [422, { error: 'unknown-application' }]
    return [202, { status: 'accepted', ...counts }]
  }

  const send = (response, status, body, headers = {}) => {
    if (response.headersSent || response.destroyed) return
    const text = JSON.stringify(body)
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    })
    response.end(text)
  }

  // The body is always read to its end, even past the limit, so the client sees the 413 instead
  // of a reset. Only the first MiB is buffered, and the request timeout bounds the rest.
  const ingest = (request, response) => {
    const declared = Number(request.headers['content-length'])
    let tooLarge = Number.isFinite(declared) && declared > MAX_BODY_BYTES
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      if (tooLarge) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    request.on('error', () => {})
    request.on('end', () => {
      if (tooLarge) {
        send(response, 413, { error: 'payload-too-large' }, { Connection: 'close' })
        return
      }
      accept(Buffer.concat(chunks, size)).then(
        ([status, body]) => send(response, status, body),
        () => {
          logger.error('relay: unable to process event')
          send(response, 500, { error: 'internal-error' })
        },
      )
    })
  }

  const handleRequest = (request, response) => {
    const pathname = String(request.url || '').split('?', 1)[0]
    if (pathname === LIVE_PATH || pathname === READY_PATH) {
      if (request.method !== 'GET') {
        send(response, 405, { error: 'method-not-allowed' }, { Allow: 'GET' })
        return
      }
      if (pathname === LIVE_PATH) {
        send(response, 200, health('live'))
        return
      }
      const body = readiness()
      send(response, body.status === 'ready' ? 200 : 503, body)
      return
    }
    if (pathname === EVENTS_PATH) {
      if (request.method !== 'POST') {
        send(response, 405, { error: 'method-not-allowed' }, { Allow: 'POST' })
        return
      }
      ingest(request, response)
      return
    }
    send(response, 404, { error: 'not-found' })
  }

  const server = http.createServer(handleRequest)
  server.requestTimeout = REQUEST_TIMEOUT_MS
  server.headersTimeout = REQUEST_TIMEOUT_MS

  // ---------------------------------------------------------------------------------------------
  // Delivery
  // ---------------------------------------------------------------------------------------------

  const writeAudit = (item, status, extra) => {
    const stored = queue.inspect(item.id)
    const record = {
      eventId: item.id,
      applicationId: item.applicationId,
      state: item.state,
      status,
      at: isoTime(clock()),
      retryCount: stored ? stored.retryCount : item.retryCount,
      relayVersion: RELAY_VERSION,
      configRevision: config.configRevision,
      ...extra,
    }
    if (status === 'retrying' && stored) {
      record.nextRetryAt = isoTime(stored.nextRetryAt)
      record.failureCode = stored.failureCode
    }
    try {
      audit.writeAudit(record)
    } catch {
      logger.error('relay: unable to write audit record')
    }
  }

  // Puts a claimed item back without counting an attempt. It is used for items never sent because
  // shutdown began or the bot token was rejected, and for sends Telegram refused with a 401 after
  // one such refusal was already recorded. None of them is a delivery failure, so none is audited.
  const release = (item) => {
    try {
      queue.release(item.id)
    } catch {
      logger.error('relay: unable to release a queued event')
    }
  }

  const deliver = async (item) => {
    // claimReady and the start of every send in a tick happen in one synchronous turn, so this
    // runs only when shutdown or a pause began inside that turn: close() called from within a
    // queue call, as the shutdown test does, or any future await added between the claim and
    // this point. It is the guard that keeps a stopping or paused relay from sending.
    if (stopping || paused) {
      release(item)
      return
    }
    const application = config.applications.find((candidate) => candidate.id === item.applicationId)
    let messageId = null
    let failure = null
    let briefKey = null
    if (!application) {
      failure = { code: 'delivery-failed', retryAfterSeconds: null }
    } else {
      const formatted = formatMessage(item, config.locale)
      const request = { chatId: config.chatId, topicId: application.topicId, message: formatted.text }
      if (formatted.action) {
        request.callbackKey = callbackKeyFor(config.workspaceId, item.id)
        briefKey = request.callbackKey.slice('brief:'.length)
        request.actionText = formatted.action.text
      }
      try {
        messageId = await telegram.sendEvent(request)
      } catch (error) {
        failure = failureOf(error)
      }
    }

    if (failure === null) {
      try {
        queue.markDelivered(item.id, messageId)
      } catch {
        logger.error('relay: unable to record delivery')
        return
      }
      if (application && briefKey) rememberCallback(item, application, briefKey)
      writeAudit(item, 'delivered', { telegramMessageId: messageId })
      return
    }

    const code = normalizeFailureCode(failure.code)
    if (code === 'telegram-401') {
      if (sendRejectionAudited) {
        release(item)
        return
      }
      sendRejectionAudited = true
    }
    logger.error(`relay: delivery failed (${code})`)
    try {
      queue.markRetry(item.id, failure)
      writeAudit(item, 'retrying', {})
    } catch {
      logger.error('relay: unable to record delivery retry')
    }
    if (code === 'telegram-401') pauseForAuthentication()
  }

  // A claim holds at most one item per application, so the sends of one tick go to different
  // topics and run together; each application still has only one message in flight.
  const deliverReady = async () => {
    let items
    try {
      items = queue.claimReady(DELIVERY_BATCH)
    } catch {
      logger.error('relay: unable to claim queued events')
      return
    }
    const results = await Promise.allSettled(items.map((item) => deliver(item)))
    if (results.some((result) => result.status === 'rejected')) logger.error('relay: delivery loop failed')
  }

  const runDelivery = () => {
    deliveryTimer = null
    if (stopping || paused) return
    currentTick = deliverReady()
      .catch(() => logger.error('relay: delivery loop failed'))
      .finally(() => {
        currentTick = null
        if (!stopping && !paused) deliveryTimer = setTimeout(runDelivery, deliveryIntervalMs)
      })
  }

  // ---------------------------------------------------------------------------------------------
  // Telegram updates
  // ---------------------------------------------------------------------------------------------

  // Callback records live in memory only: key -> what the brief button may do. Application, incident
  // and state come from here, never from callback data, which carries only the key and a provider.
  const callbackRecords = new Map()

  const rememberCallback = (item, application, key) => {
    const now = clock()
    for (const [stored, record] of callbackRecords) if (record.expiresAt <= now) callbackRecords.delete(stored)
    callbackRecords.set(key, {
      eventId: item.id,
      chatId: config.chatId,
      memberId: null,
      topicId: application.topicId,
      applicationId: application.id,
      issueId: item.issueId,
      state: item.state,
      incident: {
        applicationName: item.applicationName || application.name,
        incidentRef: incidentReference(item),
        state: item.state,
        environment: item.environment,
        release: item.release,
        impact: item.eventCount === null ? '' : String(item.eventCount),
        classification: item.state,
        title: item.title,
      },
      expiresAt: now + CALLBACK_TTL_MS,
    })
  }

  const answerCallback = async (id, text) => {
    try {
      await telegram.answerCallbackQuery(id, text)
    } catch {
      logger.error('relay: unable to answer a callback query')
    }
  }

  const handleCallbackUpdate = async (update) => {
    const callback = isObject(update) ? update.callback_query : null
    if (!isObject(callback) || typeof callback.id !== 'string' || typeof callback.data !== 'string') return
    const brief = BRIEF_DATA.exec(callback.data)
    const provider = PROVIDER_DATA.exec(callback.data)
    if (!brief && !provider) return
    const message = isObject(callback.message) ? callback.message : {}
    const chatId = isObject(message.chat) ? message.chat.id : undefined
    const memberId = isObject(callback.from) ? callback.from.id : undefined
    // Another chat or a member outside the allowlist gets no answer at all.
    if (chatId !== config.chatId || !config.allowedMemberIds.includes(memberId)) return

    const key = (brief || provider)[1]
    const record = callbackRecords.get(key)
    if (!record || record.expiresAt <= clock()) {
      callbackRecords.delete(key)
      await answerCallback(callback.id, EXPIRED_ANSWER)
      return
    }
    const authorization = authorizeUpdate(config, {
      callback_query: callback,
      applicationId: record.applicationId,
      issueId: record.issueId,
    }, record)
    const sameMember = record.memberId === null || record.memberId === memberId
    if (!authorization.ok || !sameMember || (provider && record.memberId === null)) {
      await answerCallback(callback.id, EXPIRED_ANSWER)
      return
    }

    if (brief) {
      record.memberId = memberId
      record.expiresAt = clock() + CALLBACK_TTL_MS
      try {
        await telegram.showProviderKeyboard({
          chatId: record.chatId,
          messageId: message.message_id,
          replyMarkup: providerKeyboard(key),
        })
      } catch {
        logger.error('relay: unable to show the provider keyboard')
      }
      await answerCallback(callback.id)
      return
    }

    let text
    try {
      text = buildPrompt({
        provider: PROVIDER_CODES[provider[2]],
        incident: record.incident,
        locale: config.locale,
      })
      assertPromptSafe(text, [config.botToken, config.glitchtipApiToken].filter(Boolean))
    } catch {
      logger.error('relay: agent prompt refused')
      await answerCallback(callback.id, EXPIRED_ANSWER)
      return
    }
    try {
      await telegram.sendPrompt({ chatId: record.chatId, topicId: record.topicId, text })
    } catch {
      logger.error('relay: unable to send the agent prompt')
      await answerCallback(callback.id, EXPIRED_ANSWER)
      return
    }
    callbackRecords.delete(key)
    writeAudit(
      { id: record.eventId, applicationId: record.applicationId, state: record.state, retryCount: 0 },
      'prompt-sent',
      {},
    )
    await answerCallback(callback.id)
  }
  const handleUpdate = customHandleUpdate || handleCallbackUpdate

  // While unpaired only `message` updates matter: they may carry `/pair CODE`. The pairing state
  // lives beside the queue, and control.js writes the code there from another process.
  const pairingUpdate = async (update) => {
    if (!isObject(update) || !isObject(update.message)) return
    const result = await handlePairingUpdate({
      stateDir: path.dirname(config.queuePath),
      update,
      botUsername,
      getChatMember: (chatId, userId) => telegram.getChatMember(chatId, userId),
      clock,
    })
    if (!isObject(result)) return
    if (result.ok === true) {
      logger.info('relay: Telegram pairing completed')
    } else {
      logger.info(`relay: pairing attempt rejected (${PAIRING_REASONS.has(result.reason) ? result.reason : 'invalid'})`)
    }
  }
  const onUpdate = config.paired ? handleUpdate : pairingUpdate

  const validPoll = (result) => isObject(result) &&
    Array.isArray(result.updates) &&
    Number.isSafeInteger(result.nextOffset) &&
    result.nextOffset >= 0

  const pollLoop = async () => {
    let offset = 0
    while (!lifecycle.signal.aborted) {
      let result
      try {
        result = await telegram.pollUpdates({
          offset,
          timeoutSeconds: LONG_POLL_SECONDS,
          signal: lifecycle.signal,
        })
        if (!validPoll(result)) throw { code: 'invalid-response' }
      } catch (error) {
        if (lifecycle.signal.aborted) break
        if (failureCodeOf(error) === 'telegram-401') {
          pauseForAuthentication()
          break
        }
        logger.error(`relay: Telegram polling failed (${logCodeOf(error)}); retrying in 5 s`)
        await sleep(BACKOFF_MS, lifecycle.signal)
        continue
      }
      offset = result.nextOffset
      for (const update of result.updates) {
        if (lifecycle.signal.aborted) break
        try {
          await onUpdate(update)
        } catch {
          logger.error('relay: Telegram update handler failed')
        }
      }
    }
  }

  const initialize = async () => {
    while (!lifecycle.signal.aborted) {
      try {
        const identity = await telegram.getMe()
        botUsername = isObject(identity) && typeof identity.username === 'string' ? identity.username : null
        break
      } catch (error) {
        if (lifecycle.signal.aborted) return
        if (failureCodeOf(error) === 'telegram-401') {
          pauseForAuthentication()
          return
        }
        logger.error(`relay: Telegram identity check failed (${logCodeOf(error)}); retrying in 5 s`)
        await sleep(BACKOFF_MS, lifecycle.signal)
      }
    }
    if (lifecycle.signal.aborted) return
    identityConfirmed = true
    polling = pollLoop().catch(() => logger.error('relay: Telegram polling stopped'))
    pollerStarted = true
    // An unpaired relay has no chat to deliver to; its delivery loop never starts.
    if (config.paired) runDelivery()
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------

  return {
    /**
     * Listen, then confirm the bot identity and start the polling and delivery loops.
     *
     * @param {{ port?: number, host?: string }} [options]
     * @returns {Promise<{ port: number }>}
     */
    async start({ port = DEFAULT_PORT, host = '0.0.0.0' } = {}) {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          resolve()
        })
      })
      initializing = initialize().catch(() => logger.error('relay: initialization failed'))
      return { port: server.address().port }
    },

    /**
     * Stop polling and delivery, let the current delivery finish its state write, and close HTTP.
     * Claimed items not yet sent are put back instead of sent. Anything still running at the
     * deadline is cut off so the process can exit.
     *
     * @returns {Promise<void>}
     */
    close() {
      if (closing) return closing
      closing = (async () => {
        stopping = true
        clearTimeout(deliveryTimer)
        deliveryTimer = null
        lifecycle.abort()

        const httpClosed = new Promise((resolve) => server.close(() => resolve()))
        server.closeIdleConnections()
        let deadlineTimer
        const deadline = new Promise((resolve) => {
          deadlineTimer = setTimeout(resolve, shutdownTimeoutMs)
        })
        await Promise.race([
          Promise.allSettled([currentTick, polling, initializing, httpClosed]),
          deadline,
        ])
        clearTimeout(deadlineTimer)
        server.closeAllConnections()
        await httpClosed
      })()
      return closing
    },
  }
}

// Only long polls carry an abort signal from the Telegram client, so they get the longer bound.
const telegramFetch = (url, init = {}) => {
  const timeout = AbortSignal.timeout(init.signal
    ? TELEGRAM_POLL_REQUEST_TIMEOUT_MS
    : TELEGRAM_REQUEST_TIMEOUT_MS)
  return fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout })
}

// Up to a fifth of the base delay, so a burst of failures does not retry in lockstep.
const retryJitter = ({ delayMilliseconds }) => randomInt(0, Math.floor(delayMilliseconds / 5) + 1)

const fail = (message) => {
  console.error(`relay: ${message}`)
  process.exitCode = 1
}

// The queue and the audit log each report their first swallowed post-commit directory flush
// failure once. The line is fixed: no path, value, or error message.
const durabilityWarning = (store) => () => {
  console.error(`relay: ${store} directory flush failed; recent changes may not survive a power loss`)
}

async function main() {
  let config
  try {
    config = readConfig(process.env)
  } catch (error) {
    // readConfig names invalid fields only, never their values.
    fail(error && error.message ? error.message : 'Invalid relay configuration')
    return
  }
  const port = readPort(process.env.PORT)
  if (port === null) return fail('Invalid relay configuration: PORT')

  let telegram
  try {
    telegram = createTelegramClient({ token: config.botToken, fetchFn: telegramFetch })
  } catch {
    return fail('Invalid relay configuration: TELEGRAM_BOT_TOKEN')
  }
  let queue
  try {
    queue = openQueue({
      path: config.queuePath,
      limit: config.queueLimit,
      retentionHours: config.retentionHours,
      clock: Date.now,
      jitter: retryJitter,
      onDurabilityWarning: durabilityWarning('queue'),
    })
  } catch {
    return fail('unable to open the delivery queue')
  }
  let audit
  try {
    audit = openAudit({ path: config.auditPath, onDurabilityWarning: durabilityWarning('audit') })
  } catch {
    return fail('unable to open the audit log')
  }

  const relay = createRelayServer({ config, telegram, queue, audit })
  try {
    await relay.start({ port, host: '0.0.0.0' })
  } catch {
    return fail(`unable to listen on port ${port}`)
  }
  console.log(`relay: listening on port ${port} (version ${RELAY_VERSION}, revision ${config.configRevision})`)
  if (!config.paired) console.log('relay: not paired; waiting for a pairing code')

  const shutdown = () => {
    console.log('relay: shutting down')
    relay.close().then(() => process.exit(0), () => process.exit(1))
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}

if (require.main === module) {
  main().catch(() => fail('startup failed'))
}

module.exports = { callbackKeyFor, createRelayServer }
