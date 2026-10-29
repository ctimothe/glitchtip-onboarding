'use strict'

const nodeFs = require('node:fs')
const path = require('node:path')
const { isFailureCode, normalizeFailureCode } = require('./failure-code')

const SECOND = 1000
const CLAIM_LEASE_MILLISECONDS = 15 * 60 * SECOND
const RETRY_DELAYS = [5, 15, 45, 135, 405].map((seconds) => seconds * SECOND)
const MAX_RETRY_DELAY = 15 * 60 * SECOND
const EVENT_FIELDS = [
  'id', 'applicationId', 'applicationName', 'projectSlug', 'environment', 'state',
  'title', 'issueId', 'issueUrl', 'release', 'eventCount', 'affectedUsers',
  'windowMinutes', 'threshold', 'firstSeen', 'lastSeen', 'incidentMinutes', 'quietMinutes',
]
const NUMBER_EVENT_FIELDS = new Set(['eventCount', 'affectedUsers', 'windowMinutes', 'threshold', 'incidentMinutes', 'quietMinutes'])
const RECORD_FIELDS = [...EVENT_FIELDS, 'receivedAt', 'status', 'retryCount', 'nextRetryAt', 'telegramMessageId', 'deliveredAt', 'claimedAt', 'claimExpiresAt', 'failureCode']
const TOMBSTONE_FIELDS = ['id', 'expiresAt']
const DURABILITY_WARNING = 'directory-fsync-failed'

const copy = (value) => JSON.parse(JSON.stringify(value))
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isTimestamp = (value) => Number.isSafeInteger(value) && value >= 0
const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0
const sameKeys = (value, fields) => isObject(value) && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field))
const safeAdd = (left, right) => left <= Number.MAX_SAFE_INTEGER - right ? left + right : Number.MAX_SAFE_INTEGER
const jitterMilliseconds = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_RETRY_DELAY ? value : 0
const retryAfter = (failure, now) => {
  if (!isObject(failure) || !Number.isSafeInteger(failure.retryAfterSeconds) || failure.retryAfterSeconds < 0) return null
  const milliseconds = failure.retryAfterSeconds * SECOND
  return Number.isSafeInteger(milliseconds) && now <= Number.MAX_SAFE_INTEGER - milliseconds ? milliseconds : null
}
const clockTime = (clock) => {
  const value = clock()
  if (!isTimestamp(value)) throw new Error('Invalid queue clock')
  return value
}

const normalizedEvent = (event) => {
  if (!isObject(event) || !EVENT_FIELDS.every((field) => Object.hasOwn(event, field))) throw new Error('Invalid normalized delivery event')
  const normalized = {}
  for (const field of EVENT_FIELDS) {
    const value = event[field]
    if (NUMBER_EVENT_FIELDS.has(field)) {
      if (value !== null && !(typeof value === 'number' && Number.isFinite(value))) throw new Error('Invalid normalized delivery event')
    } else if (typeof value !== 'string') {
      throw new Error('Invalid normalized delivery event')
    }
    normalized[field] = value
  }
  if (!normalized.id || !normalized.applicationId) throw new Error('Invalid normalized delivery event')
  return normalized
}

const validRecord = (record) => {
  if (!sameKeys(record, RECORD_FIELDS)) return false
  try { normalizedEvent(record) } catch { return false }
  if (!isTimestamp(record.receivedAt) || !isTimestamp(record.nextRetryAt) || !Number.isSafeInteger(record.retryCount) || record.retryCount < 0) return false
  if (record.failureCode !== null && !isFailureCode(record.failureCode)) return false
  if (record.status === 'pending') return record.telegramMessageId === null && record.deliveredAt === null && record.claimedAt === null && record.claimExpiresAt === null
  if (record.status === 'claimed') return record.telegramMessageId === null && record.deliveredAt === null && isTimestamp(record.claimedAt) && isTimestamp(record.claimExpiresAt) && record.claimExpiresAt > record.claimedAt
  if (record.status === 'delivered') return isPositiveInteger(record.telegramMessageId) && isTimestamp(record.deliveredAt) && record.deliveredAt >= record.receivedAt && record.claimedAt === null && record.claimExpiresAt === null && record.failureCode === null
  return false
}
const validTombstone = (tombstone) => sameKeys(tombstone, TOMBSTONE_FIELDS) && typeof tombstone.id === 'string' && tombstone.id.length > 0 && isTimestamp(tombstone.expiresAt)

function openQueue(options) {
  if (!isObject(options) || typeof options.path !== 'string' || !options.path || !isPositiveInteger(options.limit) || !Number.isSafeInteger(options.retentionHours) || options.retentionHours <= 0 || typeof options.clock !== 'function') throw new Error('Invalid queue options')
  const fs = options.fs || nodeFs
  const statePath = options.path
  const directory = path.dirname(statePath)
  const retentionMilliseconds = options.retentionHours * 60 * 60 * SECOND
  if (!Number.isSafeInteger(retentionMilliseconds)) throw new Error('Invalid queue options')
  const jitter = options.jitter || (() => 0)
  if (typeof jitter !== 'function') throw new Error('Invalid queue options')
  if (options.onDurabilityWarning !== undefined && typeof options.onDurabilityWarning !== 'function') throw new Error('Invalid queue options')
  const { onDurabilityWarning } = options
  let state = { records: [], tombstones: [] }

  if (fs.existsSync(statePath)) {
    let saved
    try { saved = JSON.parse(fs.readFileSync(statePath, 'utf8')) } catch { throw new Error('Invalid queue state') }
    const allIds = isObject(saved) && Array.isArray(saved.records) && Array.isArray(saved.tombstones) ? [...saved.records.map((record) => record && record.id), ...saved.tombstones.map((tombstone) => tombstone && tombstone.id)] : []
    if (!isObject(saved) || saved.version !== 2 || !sameKeys(saved, ['version', 'records', 'tombstones']) || !Array.isArray(saved.records) || !Array.isArray(saved.tombstones) || saved.records.length > options.limit || saved.tombstones.length > options.limit || saved.records.some((record) => !validRecord(record)) || saved.tombstones.some((tombstone) => !validTombstone(tombstone)) || new Set(allIds).size !== allIds.length) throw new Error('Invalid queue state')
    state = { records: copy(saved.records), tombstones: copy(saved.tombstones) }
  }

  // A rename is only durable once its directory entry is itself flushed. By then the rename has
  // replaced the state file, so the write is committed: the state held in memory is what a restart
  // reads. A failed flush (including platforms that cannot fsync a directory) only leaves a window
  // in which a power loss could lose the write, so it is swallowed rather than reported as a failed
  // write, which would roll the in-memory state back behind the file. The first such failure is
  // reported through `onDurabilityWarning`, once for this queue and with a fixed code only; a
  // callback that throws cannot fail the committed write.
  let durabilityWarned = false
  const flushCommitted = () => {
    try {
      const descriptor = fs.openSync(directory, 'r')
      try {
        fs.fsyncSync(descriptor)
      } finally {
        fs.closeSync(descriptor)
      }
    } catch {
      if (durabilityWarned || !onDurabilityWarning) return
      durabilityWarned = true
      try { onDurabilityWarning(DURABILITY_WARNING) } catch {}
    }
  }
  const persist = () => {
    const temporaryPath = `${statePath}.tmp`
    let descriptor
    try {
      descriptor = fs.openSync(temporaryPath, 'w', 0o600)
      fs.writeSync(descriptor, JSON.stringify({ version: 2, ...state }), null, 'utf8')
      fs.fsyncSync(descriptor)
      // Nulled before the close call itself, so a close that throws is never retried below.
      const handle = descriptor
      descriptor = null
      fs.closeSync(handle)
      fs.renameSync(temporaryPath, statePath)
      flushCommitted()
    } catch {
      if (descriptor !== undefined && descriptor !== null) {
        try { fs.closeSync(descriptor) } catch {}
      }
      throw new Error('Unable to persist queue state')
    }
  }
  const pruneExpired = (now) => {
    state.records = state.records.filter((record) => record.status !== 'delivered' || now - record.deliveredAt <= retentionMilliseconds)
    state.tombstones = state.tombstones.filter((tombstone) => now <= tombstone.expiresAt)
  }
  const releaseExpiredClaims = (now) => {
    for (const record of state.records) {
      if (record.status === 'claimed' && record.claimExpiresAt <= now) {
        record.status = 'pending'
        record.claimedAt = null
        record.claimExpiresAt = null
      }
    }
  }
  const mutate = (operation) => {
    const before = copy(state)
    try {
      const now = clockTime(options.clock)
      pruneExpired(now)
      releaseExpiredClaims(now)
      const result = operation(now)
      if (JSON.stringify(state) !== JSON.stringify(before)) persist()
      return result
    } catch (error) {
      state = before
      throw error
    }
  }

  return {
    enqueue(event) {
      const normalized = normalizedEvent(event)
      return mutate((now) => {
        if (state.records.some((record) => record.id === normalized.id) || state.tombstones.some((tombstone) => tombstone.id === normalized.id)) return { accepted: false, duplicate: true }
        if (state.records.length >= options.limit) {
          let terminalIndex = -1
          for (let index = 0; index < state.records.length; index += 1) {
            if (state.records[index].status !== 'delivered') continue
            if (terminalIndex === -1 || state.records[index].deliveredAt < state.records[terminalIndex].deliveredAt) terminalIndex = index
          }
          if (terminalIndex === -1 || state.tombstones.length >= options.limit) return { accepted: false, duplicate: false }
          const [evicted] = state.records.splice(terminalIndex, 1)
          state.tombstones.push({ id: evicted.id, expiresAt: safeAdd(evicted.deliveredAt, retentionMilliseconds) })
        }
        state.records.push({ ...normalized, receivedAt: now, status: 'pending', retryCount: 0, nextRetryAt: now, telegramMessageId: null, deliveredAt: null, claimedAt: null, claimExpiresAt: null, failureCode: null })
        return { accepted: true, duplicate: false }
      })
    },
    claimReady(limit) {
      if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid claim limit')
      return mutate((now) => {
        const claimed = []
        for (let index = 0; index < state.records.length && claimed.length < limit; index += 1) {
          const record = state.records[index]
          if (record.status !== 'pending' || record.nextRetryAt > now) continue
          if (state.records.slice(0, index).some((earlier) => earlier.applicationId === record.applicationId && earlier.status !== 'delivered')) continue
          record.status = 'claimed'
          record.claimedAt = now
          record.claimExpiresAt = safeAdd(now, CLAIM_LEASE_MILLISECONDS)
          if (record.claimExpiresAt <= now) throw new Error('Queue timestamp overflow')
          claimed.push(copy(record))
        }
        return claimed
      })
    },
    markDelivered(id, telegramMessageId) {
      if (typeof id !== 'string' || !isPositiveInteger(telegramMessageId)) throw new Error('Invalid delivery transition')
      mutate((now) => {
        const record = state.records.find((item) => item.id === id)
        if (!record || record.status !== 'claimed') throw new Error('Invalid delivery transition')
        record.status = 'delivered'
        record.telegramMessageId = telegramMessageId
        record.deliveredAt = now
        record.claimedAt = null
        record.claimExpiresAt = null
        record.failureCode = null
      })
    },
    markRetry(id, failure) {
      if (typeof id !== 'string') throw new Error('Invalid retry transition')
      mutate((now) => {
        const record = state.records.find((item) => item.id === id)
        if (!record || record.status !== 'claimed') throw new Error('Invalid retry transition')
        record.retryCount += 1
        const override = retryAfter(failure, now)
        let delay = override
        if (delay === null) {
          const baseDelay = RETRY_DELAYS[record.retryCount - 1] || MAX_RETRY_DELAY
          const adjustment = jitterMilliseconds(jitter({ delayMilliseconds: baseDelay, retryCount: record.retryCount, id: record.id }))
          delay = Math.min(MAX_RETRY_DELAY, baseDelay + adjustment)
        }
        record.status = 'pending'
        record.nextRetryAt = safeAdd(now, delay)
        record.claimedAt = null
        record.claimExpiresAt = null
        record.failureCode = normalizeFailureCode(isObject(failure) ? failure.code : null)
      })
    },
    // Puts back a claimed record that was never attempted, such as one claimed just before
    // shutdown. It is not a failure: the retry count and failure code are left as they were, and
    // the record is ready again at once instead of after the claim lease. Anything else is a no-op.
    release(id) {
      mutate(() => {
        const record = state.records.find((item) => item.id === id)
        if (!record || record.status !== 'claimed') return
        record.status = 'pending'
        record.claimedAt = null
        record.claimExpiresAt = null
      })
    },
    inspect(id) {
      const record = state.records.find((item) => item.id === id)
      return record ? copy(record) : null
    },
    size() {
      return mutate(() => state.records.length)
    },
  }
}

module.exports = { openQueue }
