'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { openQueue } = require('./queue')

const SECOND = 1000
const HOUR = 60 * 60 * SECOND

// Registers cleanup with the test context so scratch directories never leak into $TMPDIR.
const temporaryDirectory = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-queue-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
const event = (id, applicationId = 'billing-api') => ({
  id,
  applicationId,
  applicationName: applicationId,
  projectSlug: applicationId,
  environment: 'production',
  state: 'error',
  title: 'Database unavailable',
  issueId: 'issue-1',
  issueUrl: 'https://glitchtip.example/issues/issue-1/',
  release: '2026.09.22',
  eventCount: 1,
  affectedUsers: 0,
  windowMinutes: 5,
  threshold: 1,
  firstSeen: '2026-09-22T10:00:00.000Z',
  lastSeen: '2026-09-22T10:00:00.000Z',
  incidentMinutes: 0,
  quietMinutes: null,
})

const queueAt = (directory, now, options = {}) => openQueue({
  path: path.join(directory, 'state.json'),
  limit: 10,
  retentionHours: 72,
  clock: () => now.value,
  jitter: () => 0,
  ...options,
})

test('enqueues one stable event ID once and keeps delivered IDs deduplicated through retention', (t) => {
  const directory = temporaryDirectory(t)
  const now = { value: Date.UTC(2026, 8, 22, 10) }
  const queue = queueAt(directory, now)

  assert.deepEqual(queue.enqueue(event('evt-1')), { accepted: true, duplicate: false })
  assert.deepEqual(queue.enqueue(event('evt-1')), { accepted: false, duplicate: true })
  assert.equal(queue.claimReady(1)[0].id, 'evt-1')
  queue.markDelivered('evt-1', 801)
  assert.deepEqual(queue.enqueue(event('evt-1')), { accepted: false, duplicate: true })

  now.value += 72 * HOUR + 1
  assert.deepEqual(queue.enqueue(event('evt-1')), { accepted: true, duplicate: false })
})

test('keeps the hard queue bound, evicts the oldest terminal record, and rejects when only pending work remains', (t) => {
  const directory = temporaryDirectory(t)
  const now = { value: Date.UTC(2026, 8, 22, 10) }
  const queue = queueAt(directory, now, { limit: 2 })

  queue.enqueue(event('delivered'))
  queue.claimReady(1)
  queue.markDelivered('delivered', 1)
  now.value += SECOND
  queue.enqueue(event('pending'))
  assert.deepEqual(queue.enqueue(event('new', 'catalog')), { accepted: true, duplicate: false })
  assert.equal(queue.size(), 2)
  assert.deepEqual(queue.enqueue(event('overflow')), { accepted: false, duplicate: false })
  assert.equal(queue.size(), 2)
  assert.deepEqual(queue.claimReady(10).map((item) => item.id), ['pending', 'new'])
})

test('evicts by terminal timestamp rather than enqueue order', (t) => {
  const directory = temporaryDirectory(t)
  const now = { value: Date.UTC(2026, 8, 22, 10) }
  const queue = queueAt(directory, now, { limit: 2 })
  queue.enqueue(event('first', 'first-app'))
  queue.enqueue(event('second', 'second-app'))
  queue.claimReady(2)
  queue.markDelivered('second', 2)
  now.value += SECOND
  queue.markDelivered('first', 1)

  assert.deepEqual(queue.enqueue(event('incoming', 'third-app')), { accepted: true, duplicate: false })
  assert.equal(queue.inspect('second'), null)
  assert.ok(queue.inspect('first'))
})

test('retains evicted delivered IDs as bounded tombstones until retention expires', (t) => {
  const directory = temporaryDirectory(t)
  const now = { value: Date.UTC(2026, 8, 22, 10) }
  const queue = queueAt(directory, now, { limit: 1 })
  queue.enqueue(event('delivered'))
  queue.claimReady(1)
  queue.markDelivered('delivered', 1)

  assert.deepEqual(queue.enqueue(event('replacement', 'catalog')), { accepted: true, duplicate: false })
  assert.deepEqual(queue.enqueue(event('delivered')), { accepted: false, duplicate: true })
  assert.equal(queue.size(), 1)

  now.value += 72 * HOUR + 1
  assert.deepEqual(queue.enqueue(event('delivered')), { accepted: false, duplicate: false })
})

test('uses bounded retry delays and injected deterministic jitter', (t) => {
  const directory = temporaryDirectory(t)
  const now = { value: Date.UTC(2026, 8, 22, 10) }
  const seen = []
  const queue = queueAt(directory, now, {
    jitter: ({ delayMilliseconds, retryCount, id }) => {
      seen.push({ delayMilliseconds, retryCount, id })
      return SECOND
    },
  })
  queue.enqueue(event('evt-1'))

  for (const expectedBase of [5, 15, 45, 135, 405, 900]) {
    assert.equal(queue.claimReady(1)[0].id, 'evt-1')
    queue.markRetry('evt-1', { code: 'network-error' })
    const item = queue.inspect('evt-1')
    assert.equal(item.nextRetryAt, now.value + Math.min(expectedBase * SECOND + SECOND, 900 * SECOND))
    now.value = item.nextRetryAt
  }
  assert.deepEqual(seen, [
    { delayMilliseconds: 5 * SECOND, retryCount: 1, id: 'evt-1' },
    { delayMilliseconds: 15 * SECOND, retryCount: 2, id: 'evt-1' },
    { delayMilliseconds: 45 * SECOND, retryCount: 3, id: 'evt-1' },
    { delayMilliseconds: 135 * SECOND, retryCount: 4, id: 'evt-1' },
    { delayMilliseconds: 405 * SECOND, retryCount: 5, id: 'evt-1' },
    { delayMilliseconds: 900 * SECOND, retryCount: 6, id: 'evt-1' },
  ])
})

test('honors Telegram retry_after exactly instead of adding local jitter', (t) => {
  const directory = temporaryDirectory(t)
  const now = { value: Date.UTC(2026, 8, 22, 10) }
  const queue = queueAt(directory, now, { jitter: () => { throw new Error('must not jitter retry_after') } })
  queue.enqueue(event('evt-1'))
  queue.claimReady(1)
  queue.markRetry('evt-1', { code: 429, retryAfterSeconds: 17 })

  assert.equal(queue.inspect('evt-1').nextRetryAt, now.value + 17 * SECOND)
})

test('preserves FIFO within an application while ready work from another application proceeds', (t) => {
  const directory = temporaryDirectory(t)
  const now = { value: Date.UTC(2026, 8, 22, 10) }
  const queue = queueAt(directory, now)
  queue.enqueue(event('billing-1', 'billing'))
  queue.enqueue(event('billing-2', 'billing'))
  queue.enqueue(event('catalog-1', 'catalog'))
  assert.deepEqual(queue.claimReady(1).map((item) => item.id), ['billing-1'])
  queue.markRetry('billing-1', { code: 'network-error' })

  assert.deepEqual(queue.claimReady(10).map((item) => item.id), ['catalog-1'])
})

test('persists each mutation via a temp file, fsync, close, and rename', (t) => {
  const directory = temporaryDirectory(t)
  const now = { value: Date.UTC(2026, 8, 22, 10) }
  const operations = []
  const recordingFs = new Proxy(fs, {
    get(target, property) {
      const value = target[property]
      if (!['openSync', 'writeSync', 'fsyncSync', 'closeSync', 'renameSync'].includes(property)) return value
      return (...args) => {
        operations.push([property, ...args])
        return value(...args)
      }
    },
  })
  const queue = queueAt(directory, now, { fs: recordingFs })
  queue.enqueue(event('evt-1'))

  const statePath = path.join(directory, 'state.json')
  const temporaryPath = `${statePath}.tmp`
  assert.ok(operations.some(([name, file]) => name === 'openSync' && file === temporaryPath))
  assert.ok(operations.some(([name]) => name === 'fsyncSync'))
  assert.ok(operations.some(([name]) => name === 'closeSync'))
  assert.ok(operations.some(([name, from, to]) => name === 'renameSync' && from === temporaryPath && to === statePath))
})

test('recovers valid state and fails closed on corrupt state without overwriting it', (t) => {
  const directory = temporaryDirectory(t)
  const now = { value: Date.UTC(2026, 8, 22, 10) }
  const queue = queueAt(directory, now)
  queue.enqueue(event('evt-1'))
  assert.deepEqual(queueAt(directory, now).claimReady(1).map((item) => item.id), ['evt-1'])

  const statePath = path.join(directory, 'state.json')
  fs.writeFileSync(statePath, '{not-json', { mode: 0o600 })
  assert.throws(() => queueAt(directory, now), /Invalid queue state/)
  assert.equal(fs.readFileSync(statePath, 'utf8'), '{not-json')
})

test('rejects persisted records with invalid status invariants or non-normalized fields before overwriting state', (t) => {
  const directory = temporaryDirectory(t)
  const now = { value: Date.UTC(2026, 8, 22, 10) }
  const queue = queueAt(directory, now)
  queue.enqueue(event('evt-1'))
  const statePath = path.join(directory, 'state.json')
  const valid = JSON.parse(fs.readFileSync(statePath, 'utf8'))

  for (const mutate of [
    (state) => { state.records[0].deliveredAt = now.value },
    (state) => { state.records[0].retryCount = -1 },
    (state) => { state.records[0].title = { raw: 'private' } },
    (state) => { state.records[0].payload = { token: 'secret' } },
  ]) {
    const corrupt = structuredClone(valid)
    mutate(corrupt)
    const raw = JSON.stringify(corrupt)
    fs.writeFileSync(statePath, raw, { mode: 0o600 })
    assert.throws(() => queueAt(directory, now), /Invalid queue state/)
    assert.equal(fs.readFileSync(statePath, 'utf8'), raw)
  }
})

test('refresh prunes terminal records and releases expired claims in one state transition', (t) => {
  const directory = temporaryDirectory(t)
  const now = { value: Date.UTC(2026, 8, 22, 10) }
  const queue = queueAt(directory, now, { retentionHours: 1 })
  queue.enqueue(event('delivered', 'delivered-app'))
  queue.enqueue(event('claimed', 'claimed-app'))
  queue.claimReady(2)
  queue.markDelivered('delivered', 1)
  now.value += 60 * 60 * SECOND + 1

  assert.equal(queue.size(), 1)
  assert.equal(queue.inspect('claimed').status, 'pending')
})

test('a persisted claim blocks concurrent or restarted workers until its lease expires', (t) => {
  const directory = temporaryDirectory(t)
  const now = { value: Date.UTC(2026, 8, 22, 10) }
  const queue = queueAt(directory, now)
  queue.enqueue(event('evt-1'))
  assert.deepEqual(queue.claimReady(1).map((item) => item.id), ['evt-1'])
  assert.deepEqual(queue.claimReady(1), [])
  assert.deepEqual(queueAt(directory, now).claimReady(1), [])

  now.value += 15 * 60 * SECOND
  assert.deepEqual(queueAt(directory, now).claimReady(1).map((item) => item.id), ['evt-1'])
})

test('persists only normalized delivery fields', (t) => {
  const directory = temporaryDirectory(t)
  const now = { value: Date.UTC(2026, 8, 22, 10) }
  const queue = queueAt(directory, now)
  queue.enqueue({ ...event('evt-1'), payload: { token: 'secret' }, agentContext: 'private', update: { message: 'raw' } })

  const state = fs.readFileSync(path.join(directory, 'state.json'), 'utf8')
  assert.doesNotMatch(state, /secret|private|raw|payload|agentContext|update/)
})

test('normalizes secret failure codes and restores live state when persistence fails', (t) => {
  const directory = temporaryDirectory(t)
  const now = { value: Date.UTC(2026, 8, 22, 10) }
  let failRename = false
  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property !== 'renameSync') return target[property]
      return (...args) => {
        if (failRename) throw new Error('disk full')
        return target.renameSync(...args)
      }
    },
  })
  const queue = queueAt(directory, now, { fs: failingFs })
  queue.enqueue(event('evt-1'))
  queue.claimReady(1)
  failRename = true

  assert.throws(() => queue.markRetry('evt-1', { code: 'Bearer top-secret-token' }), /Unable to persist queue state/)
  assert.equal(queue.inspect('evt-1').status, 'claimed')
  assert.equal(queue.inspect('evt-1').failureCode, null)

  failRename = false
  queue.markRetry('evt-1', { code: 'Bearer top-secret-token' })
  const persisted = fs.readFileSync(path.join(directory, 'state.json'), 'utf8')
  assert.equal(queue.inspect('evt-1').failureCode, 'delivery-failed')
  assert.doesNotMatch(persisted, /top-secret-token|Bearer/)
})

test('accepts only explicit internal failure codes and safe Telegram mappings', (t) => {
  const directory = temporaryDirectory(t)
  const now = { value: Date.UTC(2026, 8, 22, 10) }
  const queue = queueAt(directory, now)
  queue.enqueue(event('evt-1'))
  queue.claimReady(1)
  queue.markRetry('evt-1', { code: 'my-secret-token' })
  assert.equal(queue.inspect('evt-1').failureCode, 'delivery-failed')

  now.value = queue.inspect('evt-1').nextRetryAt
  queue.claimReady(1)
  queue.markRetry('evt-1', { code: 429 })
  assert.equal(queue.inspect('evt-1').failureCode, 'telegram-429')
})

test('clamps lease overflow and normalizes huge retry_after without persisting unsafe timestamps', (t) => {
  const directory = temporaryDirectory(t)
  const now = { value: Number.MAX_SAFE_INTEGER - 100 }
  const queue = queueAt(directory, now)
  queue.enqueue(event('boundary'))
  assert.deepEqual(queue.claimReady(1).map((item) => item.id), ['boundary'])
  assert.equal(queue.inspect('boundary').claimExpiresAt, Number.MAX_SAFE_INTEGER)
  assert.equal(queueAt(directory, now).inspect('boundary').claimExpiresAt, Number.MAX_SAFE_INTEGER)

  now.value = Date.UTC(2026, 8, 22, 10)
  const retryDirectory = temporaryDirectory(t)
  const retryQueue = queueAt(retryDirectory, now)
  retryQueue.enqueue(event('retry'))
  retryQueue.claimReady(1)
  retryQueue.markRetry('retry', { code: 429, retryAfterSeconds: Number.MAX_SAFE_INTEGER })
  assert.equal(retryQueue.inspect('retry').nextRetryAt, now.value + 5 * SECOND)
  assert.equal(queueAt(retryDirectory, now).inspect('retry').nextRetryAt, now.value + 5 * SECOND)
})

test('normalizes fractional, negative, non-finite, and unsafe jitter before persistence', (t) => {
  const now = { value: Date.UTC(2026, 8, 22, 10) }
  for (const [index, jitter, expectedDelay] of [[0, 0.5, 5 * SECOND], [1, -1, 5 * SECOND], [2, Number.NaN, 5 * SECOND], [3, Number.MAX_SAFE_INTEGER, 5 * SECOND]]) {
    const directory = temporaryDirectory(t)
    const queue = queueAt(directory, now, { jitter: () => jitter })
    queue.enqueue(event(`jitter-${index}`, `app-${index}`))
    queue.claimReady(1)
    queue.markRetry(`jitter-${index}`, { code: 'network-error' })
    assert.equal(queue.inspect(`jitter-${index}`).nextRetryAt, now.value + expectedDelay)
    assert.equal(queueAt(directory, now).inspect(`jitter-${index}`).nextRetryAt, now.value + expectedDelay)
  }
})

test('accepts jitter up to exactly the 15-minute cap and treats anything larger as zero', (t) => {
  const now = { value: Date.UTC(2026, 8, 22, 10) }
  const MAX_RETRY_DELAY = 15 * 60 * SECOND
  for (const [index, jitter, expectedDelay] of [[0, MAX_RETRY_DELAY, MAX_RETRY_DELAY], [1, MAX_RETRY_DELAY + 1, 5 * SECOND]]) {
    const directory = temporaryDirectory(t)
    const queue = queueAt(directory, now, { jitter: () => jitter })
    queue.enqueue(event(`boundary-${index}`))
    queue.claimReady(1)
    queue.markRetry(`boundary-${index}`, { code: 'network-error' })
    assert.equal(queue.inspect(`boundary-${index}`).nextRetryAt, now.value + expectedDelay)
    assert.equal(queueAt(directory, now).inspect(`boundary-${index}`).nextRetryAt, now.value + expectedDelay)
  }
})

test('a close that throws during persistence is attempted once and never retried on the same descriptor', (t) => {
  const directory = temporaryDirectory(t)
  const now = { value: Date.UTC(2026, 8, 22, 10) }
  const closed = []
  const throwingFs = new Proxy(fs, {
    get(target, property) {
      if (property !== 'closeSync') return target[property]
      return (descriptor) => {
        closed.push(descriptor)
        // The descriptor is really released first, as a failing close(2) may already have done;
        // a second close could then hit an unrelated file that reused the number.
        target.closeSync(descriptor)
        throw Object.assign(new Error('close failed'), { code: 'EIO' })
      }
    },
  })
  const queue = queueAt(directory, now, { fs: throwingFs })

  assert.throws(() => queue.enqueue(event('evt-1')), /Unable to persist queue state/)
  assert.equal(closed.length, 1)
  assert.equal(queue.inspect('evt-1'), null)
})

test('release returns a claimed record to pending without counting a retry or recording a failure', (t) => {
  const directory = temporaryDirectory(t)
  const now = { value: Date.UTC(2026, 8, 22, 10) }
  const queue = queueAt(directory, now)
  queue.enqueue(event('evt-1'))
  const [claimed] = queue.claimReady(1)
  assert.equal(claimed.status, 'claimed')

  now.value += SECOND
  queue.release('evt-1')

  const released = queue.inspect('evt-1')
  assert.equal(released.status, 'pending')
  assert.equal(released.claimedAt, null)
  assert.equal(released.claimExpiresAt, null)
  assert.equal(released.retryCount, 0)
  assert.equal(released.failureCode, null)
  assert.equal(released.nextRetryAt, claimed.nextRetryAt)
  // Persisted, and immediately claimable again rather than after the 15-minute lease.
  const reopened = queueAt(directory, now)
  assert.deepEqual(reopened.inspect('evt-1'), released)
  assert.deepEqual(reopened.claimReady(1).map((item) => item.id), ['evt-1'])
})

test('release keeps the failure code and retry count of an earlier attempt', (t) => {
  const directory = temporaryDirectory(t)
  const now = { value: Date.UTC(2026, 8, 22, 10) }
  const queue = queueAt(directory, now)
  queue.enqueue(event('evt-1'))
  queue.claimReady(1)
  queue.markRetry('evt-1', { code: 429, retryAfterSeconds: 5 })
  now.value += 5 * SECOND
  queue.claimReady(1)

  queue.release('evt-1')

  const released = queue.inspect('evt-1')
  assert.equal(released.status, 'pending')
  assert.equal(released.retryCount, 1)
  assert.equal(released.failureCode, 'telegram-429')
})

test('release ignores unknown, pending, and delivered records', (t) => {
  const directory = temporaryDirectory(t)
  const now = { value: Date.UTC(2026, 8, 22, 10) }
  let writes = 0
  const countingFs = new Proxy(fs, {
    get(target, property) {
      if (property !== 'renameSync') return target[property]
      return (...args) => {
        writes += 1
        return target.renameSync(...args)
      }
    },
  })
  const queue = queueAt(directory, now, { fs: countingFs })
  queue.enqueue(event('pending', 'pending-app'))
  queue.enqueue(event('delivered', 'delivered-app'))
  queue.claimReady(2)
  queue.markDelivered('delivered', 7)
  queue.release('pending')
  const before = { pending: queue.inspect('pending'), delivered: queue.inspect('delivered'), writes }

  for (const id of ['unknown', 'delivered', undefined, 42]) queue.release(id)

  assert.deepEqual(queue.inspect('delivered'), before.delivered)
  assert.deepEqual(queue.inspect('pending'), before.pending)
  queue.release('pending')
  assert.deepEqual(queue.inspect('pending'), before.pending)
  assert.equal(writes, before.writes)
})

// Records every state-changing call with the file it touched, resolving descriptors to the path
// they were opened on. With `failDirectoryFsyncAfterRename`, the directory fsync that follows each
// rename fails the way a real I/O error would.
const directoryTrackingFs = (directory, { failDirectoryFsyncAfterRename = false } = {}) => {
  const log = []
  const openPaths = new Map()
  let renamed = false
  const proxy = new Proxy(fs, {
    get(target, property) {
      if (!['openSync', 'writeSync', 'fsyncSync', 'closeSync', 'renameSync'].includes(property)) return target[property]
      return (...args) => {
        const file = typeof args[0] === 'string' ? args[0] : openPaths.get(args[0])
        log.push({ name: property, file })
        if (property === 'renameSync') renamed = true
        if (property === 'fsyncSync' && file === directory && renamed && failDirectoryFsyncAfterRename) {
          renamed = false
          throw Object.assign(new Error('directory fsync failed'), { code: 'EIO' })
        }
        const result = target[property](...args)
        if (property === 'openSync') openPaths.set(result, args[0])
        return result
      }
    },
  })
  return { fs: proxy, log }
}

test('flushes the state directory after every rename, before the next write begins', (t) => {
  const directory = temporaryDirectory(t)
  const now = { value: Date.UTC(2026, 8, 22, 10) }
  const { fs: trackingFs, log } = directoryTrackingFs(directory)
  const queue = queueAt(directory, now, { fs: trackingFs })
  queue.enqueue(event('evt-1'))
  queue.claimReady(1)
  queue.markDelivered('evt-1', 7)

  const renames = log.flatMap((entry, index) => entry.name === 'renameSync' ? [index] : [])
  assert.equal(renames.length, 3)
  for (const index of renames) {
    const next = log.findIndex((entry, later) => later > index && (entry.name === 'renameSync' || entry.name === 'writeSync'))
    const flush = log.findIndex((entry, later) => later > index && entry.name === 'fsyncSync' && entry.file === directory)
    assert.ok(flush > index, `no directory fsync after rename ${index}`)
    assert.ok(next === -1 || flush < next, `rename ${index} is not flushed before the next write`)
  }
})

test('a directory fsync that fails after the rename still counts as committed', (t) => {
  const directory = temporaryDirectory(t)
  const now = { value: Date.UTC(2026, 8, 22, 10) }
  const { fs: failingFs, log } = directoryTrackingFs(directory, { failDirectoryFsyncAfterRename: true })
  const queue = queueAt(directory, now, { fs: failingFs })

  assert.deepEqual(queue.enqueue(event('evt-1')), { accepted: true, duplicate: false })
  assert.equal(queue.inspect('evt-1').status, 'pending')
  assert.deepEqual(queue.claimReady(1).map((item) => item.id), ['evt-1'])
  assert.equal(log.filter((entry) => entry.name === 'fsyncSync' && entry.file === directory).length, 2)

  // What the process kept in memory is what a restart reads back.
  const reopened = queueAt(directory, now)
  assert.deepEqual(reopened.inspect('evt-1'), queue.inspect('evt-1'))
  assert.equal(fs.existsSync(path.join(directory, 'state.json.tmp')), false)
})

test('reports a failed post-commit directory flush once, with a fixed code', (t) => {
  const directory = temporaryDirectory(t)
  const now = { value: Date.UTC(2026, 8, 22, 10) }
  const warnings = []
  const { fs: failingFs } = directoryTrackingFs(directory, { failDirectoryFsyncAfterRename: true })
  const queue = queueAt(directory, now, { fs: failingFs, onDurabilityWarning: (...args) => warnings.push(args) })

  queue.enqueue(event('evt-1'))
  queue.claimReady(1)
  queue.markDelivered('evt-1', 7)

  assert.deepEqual(warnings, [['directory-fsync-failed']])
  assert.equal(queueAt(directory, now).inspect('evt-1').status, 'delivered')
})

test('stays silent without failed flushes and ignores a throwing warning callback', (t) => {
  const now = { value: Date.UTC(2026, 8, 22, 10) }
  const quietDirectory = temporaryDirectory(t)
  const warnings = []
  const quiet = queueAt(quietDirectory, now, { onDurabilityWarning: (code) => warnings.push(code) })
  quiet.enqueue(event('evt-1'))
  quiet.claimReady(1)
  assert.deepEqual(warnings, [])

  const directory = temporaryDirectory(t)
  const { fs: failingFs } = directoryTrackingFs(directory, { failDirectoryFsyncAfterRename: true })
  const queue = queueAt(directory, now, { fs: failingFs, onDurabilityWarning: () => { throw new Error('logger down') } })
  assert.deepEqual(queue.enqueue(event('evt-1')), { accepted: true, duplicate: false })
  assert.equal(queueAt(directory, now).inspect('evt-1').status, 'pending')

  for (const onDurabilityWarning of ['log', 42, {}]) {
    assert.throws(() => queueAt(directory, now, { onDurabilityWarning }), /Invalid queue options/)
  }
})
