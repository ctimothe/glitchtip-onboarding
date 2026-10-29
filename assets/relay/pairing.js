'use strict'
/**
 * Telegram pairing for a relay deployed before it has a chat.
 *
 * `control.js` creates a ten-minute code in `pairing.json`; a forum administrator posts
 * `/pair CODE` in the private forum; the relay's poller hands that message to
 * `handlePairingUpdate`, which checks it with `consumePairingCode` and records the chat in
 * `pairing-result.json`. The Mac reads the outcome through `readPairingStatus`; the relay never
 * answers in Telegram.
 *
 * Both files live in the state directory (the directory of QUEUE_PATH), are mode 0600, and are
 * replaced atomically. The server and `control.js` are separate processes, so the stored code is
 * read from disk on every use and never cached.
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { consumePairingCode } = require('./authorize')

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8
const PAIRING_TTL_MS = 10 * 60 * 1000
const VERSION = 1
const PAIRING_FILE = 'pairing.json'
const RESULT_FILE = 'pairing-result.json'
const PAIRING_KEYS = ['version', 'code', 'createdAt', 'used']
const RESULT_KEYS = ['version', 'chatId', 'chatTitle', 'adminUserId', 'pairedAt']
const STORED_CODE = new RegExp(`^[${ALPHABET}]{4}-[${ALPHABET}]{4}$`)
// The code is matched case-insensitively and the hyphen is optional; the bot mention, when
// present, must name this bot.
const PAIR_COMMAND = /^\/pair(?:@([A-Za-z0-9_]+))?\s+([A-Za-z0-9]{4})-?([A-Za-z0-9]{4})\s*$/
const GROUP_CHAT_ID = /^-100[1-9]\d*$/
// Telegram caps chat titles at 128 characters; anything longer is not a Telegram title.
const MAX_TITLE_LENGTH = 255

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const sameKeys = (value, keys) => isObject(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key))
const isIsoTime = (value) => typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value
const rejected = (reason) => ({ ok: false, reason })

const pairingPath = (stateDir) => path.join(stateDir, PAIRING_FILE)
const resultPath = (stateDir) => path.join(stateDir, RESULT_FILE)

// A missing file and a file that is not JSON both read as absent; any other failure is real.
const readJson = (file) => {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const flushDirectory = (directory) => {
  let descriptor
  try {
    descriptor = fs.openSync(directory, 'r')
    fs.fsyncSync(descriptor)
  } catch {
    // Best effort: the rename has already taken effect for every reader.
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor) } catch {}
  }
}

// The temporary name carries the process ID because the server and control.js write the same
// files from separate processes.
const writeJsonAtomic = (file, value) => {
  const temporary = `${file}.${process.pid}.tmp`
  let descriptor = null
  try {
    descriptor = fs.openSync(temporary, 'w', 0o600)
    fs.fchmodSync(descriptor, 0o600)
    fs.writeSync(descriptor, `${JSON.stringify(value)}\n`, null, 'utf8')
    fs.fsyncSync(descriptor)
    const handle = descriptor
    descriptor = null
    fs.closeSync(handle)
    fs.renameSync(temporary, file)
  } catch (error) {
    if (descriptor !== null) try { fs.closeSync(descriptor) } catch {}
    try { fs.rmSync(temporary, { force: true }) } catch {}
    throw error
  }
  flushDirectory(path.dirname(file))
}

const readPairing = (stateDir) => {
  const stored = readJson(pairingPath(stateDir))
  if (
    !sameKeys(stored, PAIRING_KEYS) ||
    stored.version !== VERSION ||
    typeof stored.code !== 'string' ||
    !STORED_CODE.test(stored.code) ||
    !isIsoTime(stored.createdAt) ||
    typeof stored.used !== 'boolean'
  ) return null
  return stored
}

const readResult = (stateDir) => {
  const result = readJson(resultPath(stateDir))
  if (
    !sameKeys(result, RESULT_KEYS) ||
    result.version !== VERSION ||
    !Number.isSafeInteger(result.chatId) ||
    !GROUP_CHAT_ID.test(String(result.chatId)) ||
    typeof result.chatTitle !== 'string' ||
    result.chatTitle.length > MAX_TITLE_LENGTH ||
    !Number.isSafeInteger(result.adminUserId) ||
    result.adminUserId <= 0 ||
    !isIsoTime(result.pairedAt)
  ) return null
  return result
}

const readClock = (clock) => {
  const now = clock()
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid pairing clock')
  return now
}

/**
 * Create a new ten-minute pairing code, replacing any earlier code and clearing an earlier
 * pairing result, so the status that follows can only describe this code.
 *
 * @param {string} stateDir
 * @param {{ clock?: () => number, random?: (max: number) => number }} [options]
 * @returns {{ code: string, expiresAt: string }}
 */
const createPairing = (stateDir, { clock = Date.now, random = (max) => crypto.randomInt(max) } = {}) => {
  const now = readClock(clock)
  let characters = ''
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    const draw = random(ALPHABET.length)
    if (!Number.isSafeInteger(draw) || draw < 0 || draw >= ALPHABET.length) {
      throw new Error('Invalid pairing random source')
    }
    characters += ALPHABET[draw]
  }
  const code = `${characters.slice(0, 4)}-${characters.slice(4)}`

  // The old result goes first: a failure after it leaves no result, never a stale one beside a
  // new code.
  fs.rmSync(resultPath(stateDir), { force: true })
  writeJsonAtomic(pairingPath(stateDir), { version: VERSION, code, createdAt: new Date(now).toISOString(), used: false })
  return { code, expiresAt: new Date(now + PAIRING_TTL_MS).toISOString() }
}

/**
 * `paired` when a valid result exists; otherwise `pending` for an unused code inside its ten
 * minutes, `expired` for an unused code past them, and `none` for anything else.
 *
 * @param {string} stateDir
 * @param {() => number} [clock]
 * @returns {{ status: 'none'|'pending'|'expired' } | { status: 'paired', chatId: number, chatTitle: string, adminUserId: number, pairedAt: string }}
 */
const readPairingStatus = (stateDir, clock = Date.now) => {
  const result = readResult(stateDir)
  if (result) {
    const { chatId, chatTitle, adminUserId, pairedAt } = result
    return { status: 'paired', chatId, chatTitle, adminUserId, pairedAt }
  }
  const stored = readPairing(stateDir)
  if (!stored || stored.used) return { status: 'none' }
  const now = readClock(clock)
  const createdAt = Date.parse(stored.createdAt)
  // The same window consumePairingCode enforces.
  return now >= createdAt && now < createdAt + PAIRING_TTL_MS ? { status: 'pending' } : { status: 'expired' }
}

// The normalized code of a `/pair` message addressed to this bot, or null for any other text.
const pairingCode = (text, botUsername) => {
  if (typeof text !== 'string') return null
  const match = PAIR_COMMAND.exec(text)
  if (!match) return null
  const [, mention, first, second] = match
  if (mention !== undefined && (
    typeof botUsername !== 'string' ||
    mention.toLowerCase() !== botUsername.toLowerCase()
  )) return null
  return `${first}-${second}`.toUpperCase()
}

const chatTitle = (chat) => typeof chat.title === 'string' ? chat.title.slice(0, MAX_TITLE_LENGTH) : ''

/**
 * Handle one Telegram `message` update while the relay is unpaired.
 *
 * Returns null when the message is not a `/pair` command for this bot; nothing is read or written
 * then. Otherwise the stored code is read afresh and checked by `consumePairingCode`. A rejection
 * writes nothing. A success writes `pairing-result.json`, then marks the code used.
 *
 * @param {{ stateDir: string, update: Object, botUsername: string, getChatMember: Function, clock?: () => number }} input
 * @returns {Promise<null | { ok: true, chatId: number, adminUserId: number } | { ok: false, reason: string }>}
 */
const handlePairingUpdate = async ({ stateDir, update, botUsername, getChatMember, clock = Date.now } = {}) => {
  const message = isObject(update) && isObject(update.message) ? update.message : null
  const code = message ? pairingCode(message.text, botUsername) : null
  if (!code) return null

  const now = clock()
  const stored = readPairing(stateDir)
  if (!stored) return rejected('code')
  const state = { code: stored.code, createdAt: stored.createdAt, used: stored.used, getChatMember }
  // Only the message's own chat and sender are passed, so no other update field can stand in for
  // them.
  const result = await consumePairingCode(state, { code, message: { chat: message.chat, from: message.from } }, now)
  if (!result.ok) return result

  // control.js may have replaced or used the code while membership was being checked.
  const current = readPairing(stateDir)
  if (!current || current.code !== stored.code || current.createdAt !== stored.createdAt) return rejected('code')
  if (current.used) return rejected('used')

  writeJsonAtomic(resultPath(stateDir), {
    version: VERSION,
    chatId: result.chatId,
    chatTitle: chatTitle(message.chat),
    adminUserId: result.adminUserId,
    pairedAt: new Date(now).toISOString(),
  })
  writeJsonAtomic(pairingPath(stateDir), { ...current, used: true })
  return result
}

module.exports = {
  createPairing,
  handlePairingUpdate,
  readPairingStatus,
}
