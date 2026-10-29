'use strict'
/**
 * GlitchTip Companion relay control commands.
 *
 * The Mac runs these over SSH as
 * `docker compose exec -T companion-relay node control.js <command> [--flag value ...]`.
 * Every run reads the relay's own environment through readConfig. It prints exactly one JSON line
 * on stdout and exits 0, or exactly one `{"error":"<code>"}` line on stderr and exits 1.
 *
 *   pairing-create                             {"code":"XXXX-XXXX","expiresAt":"<ISO>"}
 *   pairing-status                             {"status":"none"|"pending"|"expired"|"paired", ...}
 *   topic-create --name <text> --color <int>   {"topicId":<int>}
 *   send-test --application <id>               {"eventId":"<delivery id>"}
 *   send-setup-complete --application <id>     {"eventId":"<delivery id>"}
 *   audit-tail --lines <1..200>                {"records":[...]}
 *
 * Error codes: unknown-command, invalid-arguments, invalid-config, not-paired,
 * unknown-application, not-accepted, internal-error, and for topic-create the Telegram failure
 * (telegram-400/401/403/404/429/500, telegram-error, network-error, invalid-response).
 *
 * The server process owns the HTTP listener, the poller, and the queue; this process starts or
 * opens none of them. No output carries a token, an environment value, or a raw Telegram response.
 */
const { randomBytes } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { readConfig, readPort } = require('./config')
const { normalizeEvent } = require('./domain')
const { normalizeFailureCode } = require('./failure-code')
const { createPairing, readPairingStatus } = require('./pairing')
const { createTelegramClient, isTopicColor } = require('./telegram')

const LOCALES = { en: require('./locales/en'), ru: require('./locales/ru'), uz: require('./locales/uz') }
const EVENTS_PATH = '/v1/glitchtip/events'
const TELEGRAM_TIMEOUT_MS = 10 * 1000
const RELAY_TIMEOUT_MS = 15 * 1000
const MAX_AUDIT_LINES = 200

class ControlError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

const fail = (code) => {
  throw new ControlError(code)
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const stateDirOf = (config) => path.dirname(config.queuePath)

// `--flag value` pairs, each flag exactly once, every listed flag required and no other.
const readFlags = (args, flags) => {
  const values = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = [args[index], args[index + 1]]
    if (!flags.includes(flag) || values.has(flag) || value === undefined) fail('invalid-arguments')
    values.set(flag, value)
  }
  if (flags.some((flag) => !values.has(flag))) fail('invalid-arguments')
  return values
}

// ---------------------------------------------------------------------------------------------
// Commands. `parse` validates the arguments before the configuration is read; `run` does the work.
// ---------------------------------------------------------------------------------------------

const pairingCreate = {
  flags: [],
  parse: () => ({}),
  run: ({ config }) => createPairing(stateDirOf(config), { clock: Date.now }),
}

const pairingStatus = {
  flags: [],
  parse: () => ({}),
  run: ({ config }) => readPairingStatus(stateDirOf(config), Date.now),
}

const telegramFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS) })

// Telegram's status travels as a fixed code; its description never leaves the client.
const topicFailure = (error) => {
  const code = normalizeFailureCode(isObject(error) ? error.code : null)
  return code === 'delivery-failed' ? 'telegram-error' : code
}

const topicCreate = {
  flags: ['--name', '--color'],
  parse: (flags) => {
    const name = flags.get('--name')
    const color = flags.get('--color')
    if (name.trim() === '' || !/^\d{1,8}$/.test(color) || !isTopicColor(Number(color))) fail('invalid-arguments')
    return { name, iconColor: Number(color) }
  },
  run: async ({ config }, { name, iconColor }) => {
    if (!config.paired) fail('not-paired')
    let telegram
    try {
      telegram = createTelegramClient({ token: config.botToken, fetchFn: telegramFetch })
    } catch {
      fail('invalid-config')
    }
    let topicId
    try {
      topicId = await telegram.createTopic({ chatId: config.chatId, name, iconColor })
    } catch (error) {
      fail(topicFailure(error))
    }
    return { topicId }
  },
}

// The same GlitchTip webhook shape the relay routes on, with a producer ID, so the relay's own
// identity rule gives `<event_id>:<state>`.
const syntheticEvent = (state, title) => ({
  flags: ['--application'],
  parse: (flags) => ({ applicationId: flags.get('--application') }),
  run: async ({ config, env }, { applicationId }) => {
    if (!config.paired) fail('not-paired')
    const application = config.applications.find((candidate) => candidate.id === applicationId)
    if (!application) fail('unknown-application')
    const port = readPort(env.PORT)
    if (port === null) fail('invalid-config')

    const payload = {
      companion_state: state,
      event_id: `${state}-${randomBytes(8).toString('hex')}`,
      attachments: [{
        title: title(LOCALES[config.locale]),
        fields: [
          { title: 'Project', value: application.projectSlug, short: true },
          { title: 'Environment', value: application.environments[0], short: true },
        ],
      }],
    }
    const eventId = normalizeEvent({ payload, application }).id

    let response
    let body
    try {
      response = await fetch(`http://127.0.0.1:${port}${EVENTS_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      })
      body = await response.json()
    } catch {
      fail('not-accepted')
    }
    // Only a queued event has a delivery the Mac can wait for.
    if (response.status !== 202 || !isObject(body) || body.accepted !== 1) fail('not-accepted')
    return { eventId }
  },
})

// JSONL records of one audit file, in file order. A line that is not a JSON object, such as a
// torn final append, is skipped.
const auditRecords = (file) => {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const records = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const record = JSON.parse(line)
      if (isObject(record)) records.push(record)
    } catch {}
  }
  return records
}

const auditTail = {
  flags: ['--lines'],
  parse: (flags) => {
    const lines = flags.get('--lines')
    if (!/^[1-9]\d{0,2}$/.test(lines) || Number(lines) > MAX_AUDIT_LINES) fail('invalid-arguments')
    return { lines: Number(lines) }
  },
  // The active file first; the previous one only when the active file holds too few records.
  run: ({ config }, { lines }) => {
    const active = auditRecords(config.auditPath)
    const records = active.length >= lines ? active : [...auditRecords(`${config.auditPath}.1`), ...active]
    return { records: records.slice(-lines) }
  },
}

const COMMANDS = new Map([
  ['pairing-create', pairingCreate],
  ['pairing-status', pairingStatus],
  ['topic-create', topicCreate],
  ['send-test', syntheticEvent('test', (messages) => messages.defaultTestTitle)],
  ['send-setup-complete', syntheticEvent('setup_complete', (messages) => messages.defaultSetupCompleteTitle)],
  ['audit-tail', auditTail],
])

/**
 * Run one control command.
 *
 * @param {string[]} argv The command and its arguments.
 * @param {Record<string, string|undefined>} env
 * @returns {Promise<{ output: Object } | { error: string }>}
 */
const run = async (argv, env) => {
  const [name, ...args] = argv
  const command = COMMANDS.get(name)
  if (!command) return { error: 'unknown-command' }
  try {
    const options = command.parse(readFlags(args, command.flags))
    let config
    try {
      config = readConfig(env)
    } catch {
      fail('invalid-config')
    }
    return { output: await command.run({ config, env }, options) }
  } catch (error) {
    return { error: error instanceof ControlError ? error.code : 'internal-error' }
  }
}

// The exit code is set rather than forced, so both streams flush before the process ends.
const main = async () => {
  const result = await run(process.argv.slice(2), process.env)
  if ('error' in result) {
    process.stderr.write(`${JSON.stringify({ error: result.error })}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(`${JSON.stringify(result.output)}\n`)
}

if (require.main === module) {
  main().catch(() => {
    process.exitCode = 1
  })
}

module.exports = { run }
