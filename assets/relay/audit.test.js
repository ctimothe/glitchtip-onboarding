'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { isDeepStrictEqual } = require('node:util')

const { openAudit } = require('./audit')

const ROTATION_BYTES = 10 * 1024 * 1024
// Registers cleanup with the test context so scratch directories never leak into $TMPDIR. Pass the
// test's `t` whenever one is available; callers that already clean up in a `finally` may omit it.
const temporaryDirectory = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-audit-'))
  if (t) t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
const safeRecord = {
  eventId: 'evt-1',
  applicationId: 'billing-api',
  state: 'error',
  status: 'retrying',
  at: '2026-09-22T10:00:00.000Z',
  retryCount: 1,
  nextRetryAt: '2026-09-22T10:00:05.000Z',
  failureCode: 'telegram-429',
  relayVersion: '1.0.0',
  configRevision: 'rev-7',
}
const rotationMarker = (auditPath, phase, existed = [true, false, false, false]) => ({
  version: 2,
  phase,
  slots: existed.map((present, index) => ({
    index,
    file: index === 0 ? auditPath : `${auditPath}.${index}`,
    existed: present,
    backup: present ? `${auditPath}.rotation.${index}` : null,
  })),
})
// The writer emits the public string fields first, then the numeric ones.
const { retryCount: safeRetryCount, ...safeStrings } = safeRecord
const auditLine = `${JSON.stringify({ ...safeStrings, retryCount: safeRetryCount })}\n`
const readDirectory = (directory) => Object.fromEntries(
  fs.readdirSync(directory).sort().map((name) => [name, fs.readFileSync(path.join(directory, name), 'utf8')]),
)

// Filesystem calls that can change what is on disk. The crash sweep injects a fault at each one.
const FAULT_POINTS = new Set(['chmodSync', 'fchmodSync', 'unlinkSync', 'openSync', 'writeSync', 'fsyncSync', 'closeSync', 'renameSync', 'copyFileSync'])
const TEARABLE = new Set(['writeSync', 'copyFileSync'])

// Wraps node:fs for one audit path. The active file reports the 10 MiB threshold, so every write
// runs a real rotation on small, distinguishable fixtures. The log records every mutation in
// order, and `fault.point` names the one to fail. With `torn`, half of a write or copy lands first.
// With `stop`, every later mutation fails too, which leaves the disk exactly as a process crash
// at that point would.
const faultInjectingFs = (auditPath, fault = null) => {
  const log = []
  const openPaths = new Map()
  let stopped = false
  const tear = (name, args) => {
    if (name === 'writeSync') {
      const [descriptor, text] = args
      fs.writeSync(descriptor, text.slice(0, Math.floor(text.length / 2)), null, 'utf8')
      return
    }
    const [source, destination] = args
    const bytes = fs.readFileSync(source)
    fs.writeFileSync(destination, bytes.subarray(0, Math.floor(bytes.length / 2)))
  }
  const proxy = new Proxy(fs, {
    get(target, name) {
      if (name === 'statSync') {
        return (file, ...rest) => {
          const stats = target.statSync(file, ...rest)
          return file === auditPath ? { ...stats, size: ROTATION_BYTES } : stats
        }
      }
      if (!FAULT_POINTS.has(name)) return target[name]
      return (...args) => {
        const point = log.length
        log.push({ name, file: typeof args[0] === 'string' ? args[0] : openPaths.get(args[0]) ?? null, flags: args[1] })
        // A dead process still releases its descriptors; closing one changes no file contents.
        const release = () => {
          if (name !== 'closeSync') return
          try { target.closeSync(...args) } catch {}
        }
        if (stopped) {
          release()
          throw new Error('process stopped')
        }
        if (fault === null || point !== fault.point) {
          // Flushing only matters after power loss, which this sweep does not model, and it costs
          // several milliseconds per call on macOS. The call stays a fault point.
          if (name === 'fsyncSync') return undefined
          const result = target[name](...args)
          if (name === 'openSync') openPaths.set(result, args[0])
          return result
        }
        if (fault.torn) tear(name, args)
        release()
        stopped = fault.stop
        throw Object.assign(new Error('injected fault'), { code: 'ENOSPC' })
      }
    },
  })
  return { fs: proxy, log }
}

// A fault in the directory flush that follows a rename or unlink (its open, fsync or close) comes
// after that step took effect, so the write counts as committed and may succeed.
const absorbedFlush = (log, point, directory) => {
  if (log[point].file !== directory) return false
  let index = point
  while (index >= 0 && log[index].file === directory) index -= 1
  return index >= 0 && ['renameSync', 'unlinkSync'].includes(log[index].name)
}

// Callers of writeLayout already remove every directory it creates (the fault sweep below, in a
// `finally` so it runs even when an assertion throws), so this does not register with `t.after`.
const writeLayout = (layout) => {
  const directory = temporaryDirectory()
  for (const [suffix, contents] of Object.entries(layout)) {
    fs.writeFileSync(path.join(directory, `audit.jsonl${suffix}`), contents, { mode: 0o600 })
  }
  return directory
}
const rotatedLayout = (layout) => {
  const next = {}
  for (const [suffix, previous] of [['.1', ''], ['.2', '.1'], ['.3', '.2']]) {
    if (layout[previous] !== undefined) next[suffix] = layout[previous]
  }
  return next
}
const readLayout = (directory) => Object.fromEntries(
  fs.readdirSync(directory).map((name) => [name.slice('audit.jsonl'.length), fs.readFileSync(path.join(directory, name), 'utf8')]),
)

// Tracks every closeSync call by descriptor, and fails it for whichever file `failFile` names.
// Used to prove a failed close is never retried on the same descriptor. A leaked descriptor (this
// close throwing means the real close underneath never ran) can have its number reused by a later,
// unrelated openSync, so each open resets that number's count to start a fresh lifetime.
const closeTrackingFs = (failFile) => {
  const openPaths = new Map()
  const closeCalls = new Map()
  const proxy = new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') {
        return (file, ...rest) => {
          const descriptor = target.openSync(file, ...rest)
          openPaths.set(descriptor, file)
          closeCalls.delete(descriptor)
          return descriptor
        }
      }
      if (property === 'closeSync') {
        return (descriptor, ...rest) => {
          closeCalls.set(descriptor, (closeCalls.get(descriptor) || 0) + 1)
          if (openPaths.get(descriptor) === failFile) throw new Error('close failed')
          return target.closeSync(descriptor, ...rest)
        }
      }
      return target[property]
    },
  })
  return { fs: proxy, closeCalls }
}

test('writes only whitelisted public audit fields', (t) => {
  const directory = temporaryDirectory(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  const audit = openAudit({ path: auditPath })
  audit.writeAudit({
    ...safeRecord,
    token: '123456789:AAExampleBotToken_1234567890',
    authorization: 'Bearer secret',
    cookie: 'session=private',
    requestBody: { email: 'owner@example.test' },
    email: 'owner@example.test',
    botApiUrl: 'https://api.telegram.org/bot123456789:AAExampleBotToken_1234567890/sendMessage',
    nested: { token: 'secret' },
  })

  const output = fs.readFileSync(auditPath, 'utf8')
  assert.deepEqual(JSON.parse(output), safeRecord)
  assert.doesNotMatch(output, /secret|owner@example|api\.telegram\.org|token|authorization|cookie|requestBody|nested/)
})

test('uses owner-only audit files and rotates at 10 MiB while retaining three archives', (t) => {
  const directory = temporaryDirectory(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  fs.writeFileSync(auditPath, 'x'.repeat(10 * 1024 * 1024), { mode: 0o600 })
  fs.chmodSync(auditPath, 0o600)
  fs.writeFileSync(`${auditPath}.1`, 'one', { mode: 0o600 })
  fs.writeFileSync(`${auditPath}.2`, 'two', { mode: 0o600 })
  fs.writeFileSync(`${auditPath}.3`, 'three', { mode: 0o600 })

  openAudit({ path: auditPath }).writeAudit(safeRecord)

  assert.equal(fs.existsSync(`${auditPath}.4`), false)
  assert.equal(fs.readFileSync(`${auditPath}.3`, 'utf8'), 'two')
  assert.equal(fs.readFileSync(`${auditPath}.2`, 'utf8'), 'one')
  assert.equal(fs.statSync(auditPath).mode & 0o777, 0o600)
  assert.equal(fs.statSync(`${auditPath}.1`).mode & 0o777, 0o600)
})

test('does not include sensitive record values in audit write errors', (t) => {
  const secret = '123456789:AAExampleBotToken_1234567890'
  const throwingFs = new Proxy(fs, {
    get(target, property) {
      if (property !== 'openSync') return target[property]
      return () => { throw new Error(`write denied for ${secret}`) }
    },
  })
  const audit = openAudit({ path: path.join(temporaryDirectory(t), 'audit.jsonl'), fs: throwingFs })

  assert.throws(
    () => audit.writeAudit({ ...safeRecord, token: secret }),
    (error) => {
      assert.match(error.message, /Unable to write audit record/)
      assert.doesNotMatch(error.message, /123456789|AAExample|token/)
      return true
    },
  )
})

test('rejects oversize public strings before rotating or writing a JSONL line', (t) => {
  const directory = temporaryDirectory(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  fs.writeFileSync(auditPath, 'unchanged', { mode: 0o600 })

  assert.throws(
    () => openAudit({ path: auditPath }).writeAudit({ ...safeRecord, eventId: 'x'.repeat(10 * 1024 * 1024) }),
    /Invalid audit record|maximum size/,
  )
  assert.equal(fs.readFileSync(auditPath, 'utf8'), 'unchanged')
})

test('normalizes unsafe failure codes and hardens every existing archive', (t) => {
  const directory = temporaryDirectory(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  fs.writeFileSync(auditPath, '', { mode: 0o644 })
  for (const suffix of ['.1', '.2', '.3']) fs.writeFileSync(`${auditPath}${suffix}`, 'old', { mode: 0o644 })

  openAudit({ path: auditPath }).writeAudit({ ...safeRecord, failureCode: 'Bearer private-token' })

  const output = fs.readFileSync(auditPath, 'utf8')
  assert.equal(JSON.parse(output).failureCode, 'delivery-failed')
  assert.doesNotMatch(output, /private-token|Bearer/)
  for (const suffix of ['', '.1', '.2', '.3']) assert.equal(fs.statSync(`${auditPath}${suffix}`).mode & 0o777, 0o600)
})

test('normalizes known numeric audit failure codes without accepting arbitrary values', (t) => {
  const auditPath = path.join(temporaryDirectory(t), 'audit.jsonl')
  openAudit({ path: auditPath }).writeAudit({ ...safeRecord, failureCode: 429 })

  assert.equal(JSON.parse(fs.readFileSync(auditPath, 'utf8')).failureCode, 'telegram-429')
})

test('does not accept caller-invented machine-looking failure codes', (t) => {
  const auditPath = path.join(temporaryDirectory(t), 'audit.jsonl')
  openAudit({ path: auditPath }).writeAudit({ ...safeRecord, failureCode: 'my-secret-token' })

  assert.equal(JSON.parse(fs.readFileSync(auditPath, 'utf8')).failureCode, 'delivery-failed')
})

test('snapshot copy failure leaves every live archive byte-identical', (t) => {
  const directory = temporaryDirectory(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  const original = new Map([
    [auditPath, 'active'.repeat(3 * 1024 * 1024)],
    [`${auditPath}.1`, 'one'],
    [`${auditPath}.2`, 'two'],
    [`${auditPath}.3`, 'three'],
  ])
  for (const [file, contents] of original) fs.writeFileSync(file, contents, { mode: 0o600 })
  let copies = 0
  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property !== 'copyFileSync') return target[property]
      return (...args) => {
        copies += 1
        if (copies === 2) throw new Error('snapshot failed')
        return target.copyFileSync(...args)
      }
    },
  })

  assert.throws(() => openAudit({ path: auditPath, fs: failingFs }).writeAudit(safeRecord), /Unable to write audit record/)
  for (const [file, contents] of original) assert.equal(fs.readFileSync(file, 'utf8'), contents)
  assert.deepEqual(fs.readdirSync(directory).sort(), ['audit.jsonl', 'audit.jsonl.1', 'audit.jsonl.2', 'audit.jsonl.3'])
})

test('recovers an interrupted rotation before appending and removes transaction artifacts', (t) => {
  const directory = temporaryDirectory(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  const backup = `${auditPath}.rotation.0`
  const marker = `${auditPath}.rotation.json`
  fs.writeFileSync(auditPath, 'mutated', { mode: 0o600 })
  fs.writeFileSync(backup, 'original', { mode: 0o600 })
  fs.writeFileSync(marker, JSON.stringify(rotationMarker(auditPath, 'rotating')), { mode: 0o600 })

  openAudit({ path: auditPath }).writeAudit(safeRecord)

  assert.match(fs.readFileSync(auditPath, 'utf8'), /^original\{/)
  assert.equal(fs.existsSync(backup), false)
  assert.equal(fs.existsSync(marker), false)
  assert.deepEqual(fs.readdirSync(directory).sort(), ['audit.jsonl'])
})

test('cleans a crash during snapshot staging without touching live audit bytes', (t) => {
  const directory = temporaryDirectory(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  const backup = `${auditPath}.rotation.0`
  const marker = `${auditPath}.rotation.json`
  fs.writeFileSync(auditPath, 'live', { mode: 0o600 })
  fs.writeFileSync(backup, 'live', { mode: 0o600 })
  fs.writeFileSync(marker, JSON.stringify(rotationMarker(auditPath, 'snapshotting')), { mode: 0o600 })

  openAudit({ path: auditPath }).writeAudit(safeRecord)

  assert.match(fs.readFileSync(auditPath, 'utf8'), /^live\{/)
  assert.deepEqual(fs.readdirSync(directory).sort(), ['audit.jsonl'])
})

test('fails closed for subset, duplicate, or missing rotation snapshot manifests', (t) => {
  const directory = temporaryDirectory(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  fs.writeFileSync(auditPath, 'live', { mode: 0o600 })
  const markerPath = `${auditPath}.rotation.json`
  const complete = rotationMarker(auditPath, 'rotating')

  for (const malformed of [
    { ...complete, slots: complete.slots.slice(0, 1) },
    { ...complete, slots: [...complete.slots.slice(0, 3), { ...complete.slots[2], index: 3 }] },
    { ...complete, slots: complete.slots.map((slot) => slot.index === 0 ? { ...slot, backup: null } : slot) },
  ]) {
    fs.writeFileSync(markerPath, JSON.stringify(malformed), { mode: 0o600 })
    assert.throws(() => openAudit({ path: auditPath }), /Invalid rotation marker/)
    assert.equal(fs.readFileSync(auditPath, 'utf8'), 'live')
    assert.equal(fs.existsSync(markerPath), true)
  }
})

test('fails closed when recovery backups exist without a marker', (t) => {
  const directory = temporaryDirectory(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  fs.writeFileSync(auditPath, 'live', { mode: 0o600 })
  fs.writeFileSync(`${auditPath}.rotation.0`, 'recovery-data', { mode: 0o600 })
  fs.writeFileSync(`${auditPath}.rotation.json.tmp`, 'unpublished', { mode: 0o600 })
  const before = readDirectory(directory)

  assert.throws(() => openAudit({ path: auditPath }), /Unable to recover audit rotation/)
  assert.deepEqual(readDirectory(directory), before)
})

test('fails closed when recovery backups exist beside an invalid marker', (t) => {
  // Each marker is invalid for exactly one reason: unparsable JSON, then a valid v2 shape with
  // only its version field broken (its slot paths otherwise match the real, absolute auditPath).
  for (const invalidMarker of [
    () => '{"version":2,"phase":',
    (auditPath) => JSON.stringify({ ...rotationMarker(auditPath, 'rotating'), version: 1 }),
  ]) {
    const directory = temporaryDirectory(t)
    const auditPath = path.join(directory, 'audit.jsonl')
    fs.writeFileSync(auditPath, 'live', { mode: 0o600 })
    fs.writeFileSync(`${auditPath}.rotation.0`, 'recovery-data', { mode: 0o600 })
    fs.writeFileSync(`${auditPath}.rotation.json`, invalidMarker(auditPath), { mode: 0o600 })
    const before = readDirectory(directory)

    assert.throws(() => openAudit({ path: auditPath }), /Invalid rotation marker/)
    assert.deepEqual(readDirectory(directory), before)
  }
})

test('fails closed when a marker slot path does not match the real audit path', (t) => {
  const directory = temporaryDirectory(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  fs.writeFileSync(auditPath, 'live', { mode: 0o600 })
  fs.writeFileSync(`${auditPath}.rotation.0`, 'recovery-data', { mode: 0o600 })
  // Otherwise a valid v2 marker: only slot 0's `file` is wrong (a relative path instead of the
  // real absolute auditPath), so this fails validation for that single reason.
  const marker = rotationMarker(auditPath, 'rotating')
  marker.slots[0] = { ...marker.slots[0], file: 'audit.jsonl' }
  fs.writeFileSync(`${auditPath}.rotation.json`, JSON.stringify(marker), { mode: 0o600 })
  const before = readDirectory(directory)

  assert.throws(() => openAudit({ path: auditPath }), /Invalid rotation marker/)
  assert.deepEqual(readDirectory(directory), before)
})

test('recovers a crash between writing the rotating marker and renaming it into place', (t) => {
  const directory = temporaryDirectory(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  const markerPath = `${auditPath}.rotation.json`
  fs.writeFileSync(auditPath, 'live', { mode: 0o600 })
  fs.writeFileSync(`${auditPath}.rotation.0`, 'live', { mode: 0o600 })
  fs.writeFileSync(markerPath, JSON.stringify(rotationMarker(auditPath, 'snapshotting')), { mode: 0o600 })
  fs.writeFileSync(`${markerPath}.tmp`, JSON.stringify(rotationMarker(auditPath, 'rotating')), { mode: 0o600 })

  const audit = openAudit({ path: auditPath })
  assert.deepEqual(readDirectory(directory), { 'audit.jsonl': 'live' })
  audit.writeAudit(safeRecord)
  openAudit({ path: auditPath }).writeAudit(safeRecord)

  assert.deepEqual(readDirectory(directory), { 'audit.jsonl': `live${auditLine}${auditLine}` })
})

test('recovers a crash that leaves only the first marker in its temporary file', (t) => {
  for (const leftover of ['', '{"version":2,"pha', JSON.stringify(rotationMarker('audit.jsonl', 'snapshotting'))]) {
    const directory = temporaryDirectory(t)
    const auditPath = path.join(directory, 'audit.jsonl')
    fs.writeFileSync(auditPath, 'live', { mode: 0o600 })
    fs.writeFileSync(`${auditPath}.rotation.json.tmp`, leftover, { mode: 0o600 })

    openAudit({ path: auditPath }).writeAudit(safeRecord)
    openAudit({ path: auditPath }).writeAudit(safeRecord)

    assert.deepEqual(readDirectory(directory), { 'audit.jsonl': `live${auditLine}${auditLine}` })
  }
})

test('a failed rotation marker write leaves no temporary file and the audit writable', (t) => {
  // The first marker write publishes "snapshotting", the second publishes "rotating".
  for (const failingWrite of [1, 2]) {
    const directory = temporaryDirectory(t)
    const auditPath = path.join(directory, 'audit.jsonl')
    const active = 'x'.repeat(ROTATION_BYTES)
    fs.writeFileSync(auditPath, active, { mode: 0o600 })
    let writes = 0
    const fullDiskFs = new Proxy(fs, {
      get(target, property) {
        if (property !== 'writeSync') return target[property]
        return (...args) => {
          writes += 1
          if (writes === failingWrite) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
          return target.writeSync(...args)
        }
      },
    })

    assert.throws(() => openAudit({ path: auditPath, fs: fullDiskFs }).writeAudit(safeRecord), /Unable to write audit record/)
    assert.deepEqual(fs.readdirSync(directory), ['audit.jsonl'])
    assert.equal(fs.readFileSync(auditPath, 'utf8'), active)

    openAudit({ path: auditPath }).writeAudit(safeRecord)
    assert.deepEqual(fs.readdirSync(directory).sort(), ['audit.jsonl', 'audit.jsonl.1'])
    assert.equal(fs.readFileSync(`${auditPath}.1`, 'utf8'), active)
    assert.equal(fs.readFileSync(auditPath, 'utf8'), auditLine)
  }
})

test('a failed recovery marker write removes its temporary file and recovery retries', (t) => {
  const directory = temporaryDirectory(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  const markerPath = `${auditPath}.rotation.json`
  const marker = JSON.stringify(rotationMarker(auditPath, 'rotating'))
  fs.writeFileSync(auditPath, 'mutated', { mode: 0o600 })
  fs.writeFileSync(`${auditPath}.rotation.0`, 'original', { mode: 0o600 })
  fs.writeFileSync(markerPath, marker, { mode: 0o600 })
  const fullDiskFs = new Proxy(fs, {
    get(target, property) {
      if (property !== 'writeSync') return target[property]
      return () => { throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }) }
    },
  })

  assert.throws(() => openAudit({ path: auditPath, fs: fullDiskFs }), /no space left/)
  assert.deepEqual(readDirectory(directory), {
    'audit.jsonl': 'original',
    'audit.jsonl.rotation.0': 'original',
    'audit.jsonl.rotation.json': marker,
  })

  openAudit({ path: auditPath }).writeAudit(safeRecord)
  assert.deepEqual(readDirectory(directory), { 'audit.jsonl': `original${auditLine}` })
})

test('closes each descriptor exactly once even when the close itself throws', (t) => {
  // writeAudit's own append descriptor (audit.js ~216-219).
  {
    const directory = temporaryDirectory(t)
    const auditPath = path.join(directory, 'audit.jsonl')
    const { fs: throwingFs, closeCalls } = closeTrackingFs(auditPath)

    assert.throws(() => openAudit({ path: auditPath, fs: throwingFs }).writeAudit(safeRecord), /Unable to write audit record/)

    assert.ok(closeCalls.size > 0)
    for (const [descriptor, count] of closeCalls) assert.equal(count, 1, `descriptor ${descriptor} closed ${count} times`)
  }
  // writeDurable's marker-tmp descriptor (audit.js ~63-68), reached via recovery's final marker
  // write, which runs unguarded at openAudit construction.
  {
    const directory = temporaryDirectory(t)
    const auditPath = path.join(directory, 'audit.jsonl')
    const markerPath = `${auditPath}.rotation.json`
    fs.writeFileSync(auditPath, 'live', { mode: 0o600 })
    fs.writeFileSync(`${auditPath}.rotation.0`, 'live', { mode: 0o600 })
    fs.writeFileSync(markerPath, JSON.stringify(rotationMarker(auditPath, 'rotating')), { mode: 0o600 })
    const { fs: throwingFs, closeCalls } = closeTrackingFs(`${markerPath}.tmp`)

    assert.throws(() => openAudit({ path: auditPath, fs: throwingFs }), /close failed/)

    assert.ok(closeCalls.size > 0)
    for (const [descriptor, count] of closeCalls) assert.equal(count, 1, `descriptor ${descriptor} closed ${count} times`)
  }
})

test('fails closed without deleting live archives that the rotation never snapshotted', (t) => {
  const layouts = [
    // Archive .1 could come from renaming the active file, but its bytes differ from that snapshot.
    { 'audit.jsonl': 'active', 'audit.jsonl.1': 'one' },
    // Archive .1 does not match the snapshot of the active file, and .2 cannot come from a rename.
    { 'audit.jsonl': 'active', 'audit.jsonl.1': 'one', 'audit.jsonl.2': 'two', 'audit.jsonl.3': 'three' },
    // Archive .1 matches the active snapshot, but .2 still cannot come from a rename.
    { 'audit.jsonl': 'active', 'audit.jsonl.1': 'active', 'audit.jsonl.2': 'two' },
  ]
  for (const live of layouts) {
    const directory = temporaryDirectory(t)
    const auditPath = path.join(directory, 'audit.jsonl')
    for (const [name, contents] of Object.entries(live)) fs.writeFileSync(path.join(directory, name), contents, { mode: 0o600 })
    fs.writeFileSync(`${auditPath}.rotation.0`, 'active', { mode: 0o600 })
    fs.writeFileSync(`${auditPath}.rotation.json`, JSON.stringify(rotationMarker(auditPath, 'rotating', [true, false, false, false])), { mode: 0o600 })
    const before = readDirectory(directory)

    assert.throws(() => openAudit({ path: auditPath }), /Unable to recover audit rotation/)
    assert.deepEqual(readDirectory(directory), before)
  }
})

test('rolls back an archive that only the interrupted rotation could have produced', (t) => {
  const directory = temporaryDirectory(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  fs.writeFileSync(`${auditPath}.1`, 'active', { mode: 0o600 })
  fs.writeFileSync(`${auditPath}.3`, 'three', { mode: 0o600 })
  fs.writeFileSync(`${auditPath}.rotation.0`, 'active', { mode: 0o600 })
  fs.writeFileSync(`${auditPath}.rotation.2`, 'three', { mode: 0o600 })
  fs.writeFileSync(`${auditPath}.rotation.json`, JSON.stringify(rotationMarker(auditPath, 'rotating', [true, false, true, false])), { mode: 0o600 })

  openAudit({ path: auditPath })

  assert.deepEqual(readDirectory(directory), { 'audit.jsonl': 'active', 'audit.jsonl.2': 'three' })
})

test('records each archive in the rotation marker from a single existence check', (t) => {
  const directory = temporaryDirectory(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  const markerPath = `${auditPath}.rotation.json`
  fs.writeFileSync(auditPath, 'x'.repeat(ROTATION_BYTES), { mode: 0o600 })
  for (const suffix of ['.1', '.2', '.3']) fs.writeFileSync(`${auditPath}${suffix}`, suffix, { mode: 0o600 })
  const published = []
  let checks = 0
  const racingFs = new Proxy(fs, {
    get(target, property) {
      // Another process keeps creating and deleting archive .2 between existence checks.
      if (property === 'existsSync') return (file) => file === `${auditPath}.2` ? checks++ % 2 === 0 : target.existsSync(file)
      if (property !== 'renameSync') return target[property]
      return (from, to) => {
        if (to === markerPath) published.push(JSON.parse(target.readFileSync(from, 'utf8')))
        return target.renameSync(from, to)
      }
    },
  })

  try {
    openAudit({ path: auditPath, fs: racingFs }).writeAudit(safeRecord)
  } catch {}

  assert.ok(published.length > 0)
  for (const marker of published) {
    for (const slot of marker.slots) assert.equal(slot.backup !== null, slot.existed, `${marker.phase} slot ${slot.index}`)
  }
})

test('recovers from a fault or crash at every filesystem mutation of a rotation', (t) => {
  const layouts = [
    ['full chain', { '': 'active', '.1': 'one', '.2': 'two', '.3': 'three' }],
    ['active only', { '': 'active' }],
    ['gap in chain', { '': 'active', '.2': 'two' }],
  ]
  const faultModes = [
    { name: 'transient fault', torn: false, stop: false },
    { name: 'crash', torn: false, stop: true },
    { name: 'torn transient fault', torn: true, stop: false },
    { name: 'torn crash', torn: true, stop: true },
  ]
  const failures = []
  let cases = 0
  for (const [layoutName, layout] of layouts) {
    const committed = { ...rotatedLayout(layout), '': auditLine }
    const rolledBack = { ...layout, '': `${layout['']}${auditLine}` }
    const probeDirectory = writeLayout(layout)
    const probe = faultInjectingFs(path.join(probeDirectory, 'audit.jsonl'))
    openAudit({ path: path.join(probeDirectory, 'audit.jsonl'), fs: probe.fs }).writeAudit(safeRecord)
    assert.deepEqual(readLayout(probeDirectory), committed, `${layoutName}: fault-free rotation`)
    fs.rmSync(probeDirectory, { recursive: true, force: true })
    // Every mutation before the record is appended belongs to the rotation.
    const appendStart = probe.log.findIndex(({ name, file, flags }) => name === 'openSync' && path.basename(file) === 'audit.jsonl' && flags === 'a')
    for (const name of ['copyFileSync', 'renameSync', 'unlinkSync', 'writeSync']) {
      assert.ok(probe.log.slice(0, appendStart).some((entry) => entry.name === name), `${layoutName}: rotation never calls ${name}`)
    }

    for (let point = 0; point < appendStart; point += 1) {
      for (const mode of faultModes) {
        if (mode.torn && !TEARABLE.has(probe.log[point].name)) continue
        const label = `${layoutName}, ${mode.name} at mutation ${point} (${probe.log[point].name})`
        const directory = writeLayout(layout)
        const auditPath = path.join(directory, 'audit.jsonl')
        cases += 1
        try {
          const faulty = faultInjectingFs(auditPath, { point, ...mode })
          let failed = false
          try {
            openAudit({ path: auditPath, fs: faulty.fs }).writeAudit(safeRecord)
          } catch (error) {
            assert.match(error.message, /Unable to write audit record/)
            failed = true
          }
          assert.equal(faulty.log[point].name, probe.log[point].name)
          if (failed) {
            openAudit({ path: auditPath }).writeAudit(safeRecord)
          } else {
            // Only a failed flush of a step that already took effect may leave the write successful.
            assert.ok(absorbedFlush(faulty.log, point, directory), 'the write succeeded despite a fault it must report')
            openAudit({ path: auditPath })
          }
          const actual = readLayout(directory)
          const expected = failed ? [committed, rolledBack] : [committed]
          if (!expected.some((layout) => isDeepStrictEqual(actual, layout))) {
            throw new Error(`unexpected files ${JSON.stringify(actual)}`)
          }
          for (const name of fs.readdirSync(directory)) assert.equal(fs.statSync(path.join(directory, name)).mode & 0o777, 0o600, name)
        } catch (error) {
          failures.push(`${label}: ${error.message.split('\n')[0]}`)
        } finally {
          fs.rmSync(directory, { recursive: true, force: true })
        }
      }
    }
  }

  assert.deepEqual(failures, [])
  assert.ok(cases >= 150, `only ${cases} fault cases ran`)
})

test('restores the archive chain when a rotation rename fails', (t) => {
  const directory = temporaryDirectory(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  const original = new Map([
    [auditPath, 'active'],
    [`${auditPath}.1`, 'one'],
    [`${auditPath}.2`, 'two'],
    [`${auditPath}.3`, 'three'],
  ])
  for (const [file, contents] of original) fs.writeFileSync(file, file === auditPath ? contents.repeat(3 * 1024 * 1024) : contents, { mode: 0o600 })
  let renameCount = 0
  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property !== 'renameSync') return target[property]
      return (...args) => {
        renameCount += 1
        if (renameCount === 2) throw new Error('simulated rename failure')
        return target.renameSync(...args)
      }
    },
  })

  assert.throws(() => openAudit({ path: auditPath, fs: failingFs }).writeAudit(safeRecord), /Unable to write audit record/)
  assert.equal(fs.readFileSync(auditPath, 'utf8'), original.get(auditPath).repeat(3 * 1024 * 1024))
  assert.equal(fs.readFileSync(`${auditPath}.1`, 'utf8'), 'one')
  assert.equal(fs.readFileSync(`${auditPath}.2`, 'utf8'), 'two')
  assert.equal(fs.readFileSync(`${auditPath}.3`, 'utf8'), 'three')
})

// Fails the directory fsync that follows each rename, and reports the 10 MiB threshold for the
// active file so every write rotates. The log resolves descriptors to their paths.
const flushTrackingFs = (auditPath, { failFlushAfterRename = false, failEveryFlush = false, rotate = true } = {}) => {
  const directory = path.dirname(auditPath)
  const log = []
  const openPaths = new Map()
  let renamed = false
  const proxy = new Proxy(fs, {
    get(target, property) {
      if (property === 'statSync' && rotate) {
        return (file, ...rest) => {
          const stats = target.statSync(file, ...rest)
          return file === auditPath ? { ...stats, size: ROTATION_BYTES } : stats
        }
      }
      if (!FAULT_POINTS.has(property)) return target[property]
      return (...args) => {
        const file = typeof args[0] === 'string' ? args[0] : openPaths.get(args[0])
        log.push({ name: property, file, flags: args[1] })
        if (property === 'renameSync') renamed = true
        if (property === 'fsyncSync' && file === directory && failEveryFlush) {
          throw Object.assign(new Error('directory fsync failed'), { code: 'EIO' })
        }
        if (property === 'fsyncSync' && file === directory && renamed && failFlushAfterRename) {
          renamed = false
          throw Object.assign(new Error('directory fsync failed'), { code: 'EIO' })
        }
        const result = target[property](...args)
        if (property === 'openSync') openPaths.set(result, args[0])
        return result
      }
    },
  })
  return { fs: proxy, log, directory }
}

test('flushes the audit directory after every rotation rename and unlink, before the next change', (t) => {
  const directory = temporaryDirectory(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  fs.writeFileSync(auditPath, 'active', { mode: 0o600 })
  fs.writeFileSync(`${auditPath}.1`, 'one', { mode: 0o600 })
  const { fs: trackingFs, log } = flushTrackingFs(auditPath)

  openAudit({ path: auditPath, fs: trackingFs }).writeAudit(safeRecord)

  // Consecutive archive renames form one batch, which the rotating marker and its backups cover,
  // and so do the unlinks of one cleanup. Every rename must be flushed before the next unlink,
  // copy, or write, and every unlink before the next copy or write (the first append included).
  const expectations = [
    ['renameSync', new Set(['unlinkSync', 'copyFileSync', 'writeSync'])],
    ['unlinkSync', new Set(['copyFileSync', 'writeSync'])],
  ]
  const counts = {}
  for (const [kind, changes] of expectations) {
    const moves = log.flatMap((entry, index) => entry.name === kind ? [index] : [])
    counts[kind] = moves.length
    for (const index of moves) {
      const next = log.findIndex((entry, later) => later > index && changes.has(entry.name))
      const flush = log.findIndex((entry, later) => later > index && entry.name === 'fsyncSync' && entry.file === directory)
      assert.ok(flush > index, `no directory fsync after ${kind} ${index} (${log[index].file})`)
      assert.ok(next === -1 || flush < next, `${kind} ${index} (${log[index].file}) is not flushed before the next change`)
    }
  }
  // Three marker writes (snapshotting, rotating, completed) plus the two archive renames; the
  // cleanup unlinks both backups and the marker.
  assert.deepEqual(counts, { renameSync: 5, unlinkSync: 3 })
})

test('a directory fsync that fails after each rotation rename leaves the rotation committed', (t) => {
  const directory = temporaryDirectory(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  fs.writeFileSync(auditPath, 'active', { mode: 0o600 })
  fs.writeFileSync(`${auditPath}.1`, 'one', { mode: 0o600 })
  const { fs: failingFs, log } = flushTrackingFs(auditPath, { failFlushAfterRename: true })

  openAudit({ path: auditPath, fs: failingFs }).writeAudit(safeRecord)

  assert.equal(log.filter((entry) => entry.name === 'renameSync').length, 5)
  // Rotated, the record appended, and no marker, backup, or temporary file left behind.
  assert.deepEqual(readDirectory(directory), {
    'audit.jsonl': auditLine,
    'audit.jsonl.1': 'active',
    'audit.jsonl.2': 'one',
  })
  openAudit({ path: auditPath }).writeAudit(safeRecord)
  assert.deepEqual(readDirectory(directory), {
    'audit.jsonl': `${auditLine}${auditLine}`,
    'audit.jsonl.1': 'active',
    'audit.jsonl.2': 'one',
  })
})

test('a directory fsync that fails after the rotating marker rename, followed by a crash, recovers', (t) => {
  const directory = temporaryDirectory(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  const markerPath = `${auditPath}.rotation.json`
  fs.writeFileSync(auditPath, 'active', { mode: 0o600 })
  let published = null
  let crashed = false
  const crashingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'statSync') {
        return (file, ...rest) => {
          const stats = target.statSync(file, ...rest)
          return file === auditPath ? { ...stats, size: ROTATION_BYTES } : stats
        }
      }
      if (!FAULT_POINTS.has(property)) return target[property]
      return (...args) => {
        if (crashed) throw new Error('process stopped')
        if (property === 'renameSync' && args[1] === markerPath) published = JSON.parse(target.readFileSync(args[0], 'utf8')).phase
        // The flush after the "rotating" marker fails, and the process dies right after.
        if (property === 'fsyncSync' && published === 'rotating') {
          crashed = true
          throw Object.assign(new Error('directory fsync failed'), { code: 'EIO' })
        }
        return target[property](...args)
      }
    },
  })

  assert.throws(() => openAudit({ path: auditPath, fs: crashingFs }).writeAudit(safeRecord), /Unable to write audit record/)
  // The committed "rotating" marker and its backup are still there for recovery to use.
  assert.equal(JSON.parse(fs.readFileSync(markerPath, 'utf8')).phase, 'rotating')
  assert.equal(fs.readFileSync(`${auditPath}.rotation.0`, 'utf8'), 'active')

  openAudit({ path: auditPath }).writeAudit(safeRecord)
  assert.deepEqual(readDirectory(directory), { 'audit.jsonl': `active${auditLine}` })
})

// The fsync of the new active file after its first append, then the directory flush that must follow.
const appendFlushes = (log, auditPath, directory) => {
  const append = log.findIndex((entry) => entry.name === 'openSync' && entry.file === auditPath && entry.flags === 'a')
  const fileSync = log.findIndex((entry, index) => index > append && entry.name === 'fsyncSync' && entry.file === auditPath)
  const flush = log.findIndex((entry, index) => index > fileSync && entry.name === 'fsyncSync' && entry.file === directory)
  return { append, fileSync, flush }
}

test('flushes the directory entry of the active file a rotation leaves for the first append', (t) => {
  const directory = temporaryDirectory(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  fs.writeFileSync(auditPath, 'active', { mode: 0o600 })
  const { fs: trackingFs, log } = flushTrackingFs(auditPath)

  openAudit({ path: auditPath, fs: trackingFs }).writeAudit(safeRecord)

  const { append, fileSync, flush } = appendFlushes(log, auditPath, directory)
  assert.ok(append !== -1 && fileSync > append, 'the first append is not synced')
  assert.ok(flush > fileSync, 'the new active file is never flushed into its directory')
  assert.equal(fs.readFileSync(auditPath, 'utf8'), auditLine)
})

test('flushes the directory entry of a first audit file, and not of an existing one', (t) => {
  const directory = temporaryDirectory(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  const first = flushTrackingFs(auditPath, { rotate: false })
  openAudit({ path: auditPath, fs: first.fs }).writeAudit(safeRecord)
  assert.ok(appendFlushes(first.log, auditPath, directory).flush !== -1, 'the new file is never flushed into its directory')

  const again = flushTrackingFs(auditPath, { rotate: false })
  openAudit({ path: auditPath, fs: again.fs }).writeAudit(safeRecord)
  assert.equal(again.log.filter((entry) => entry.name === 'fsyncSync' && entry.file === directory).length, 0)
  assert.equal(fs.readFileSync(auditPath, 'utf8'), `${auditLine}${auditLine}`)
})

test('a failed directory flush after the first append still counts the record as written', (t) => {
  const directory = temporaryDirectory(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  const { fs: failingFs, log } = flushTrackingFs(auditPath, { rotate: false, failEveryFlush: true })

  openAudit({ path: auditPath, fs: failingFs }).writeAudit(safeRecord)

  assert.equal(log.filter((entry) => entry.name === 'fsyncSync' && entry.file === directory).length, 1)
  assert.equal(fs.readFileSync(auditPath, 'utf8'), auditLine)
  openAudit({ path: auditPath }).writeAudit(safeRecord)
  assert.equal(fs.readFileSync(auditPath, 'utf8'), `${auditLine}${auditLine}`)
})

test('a failed flush before the archive renames aborts the rotation with every archive intact', (t) => {
  const directory = temporaryDirectory(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  const markerPath = `${auditPath}.rotation.json`
  const layout = { 'audit.jsonl': 'active', 'audit.jsonl.1': 'one', 'audit.jsonl.2': 'two', 'audit.jsonl.3': 'three' }
  for (const [name, contents] of Object.entries(layout)) fs.writeFileSync(path.join(directory, name), contents, { mode: 0o600 })
  const openPaths = new Map()
  const log = []
  const recoveredPhases = []
  let published = null
  let flushesAfterRotating = 0
  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'statSync') {
        return (file, ...rest) => {
          const stats = target.statSync(file, ...rest)
          return file === auditPath ? { ...stats, size: ROTATION_BYTES } : stats
        }
      }
      if (property === 'readFileSync') {
        return (file, ...rest) => {
          const contents = target.readFileSync(file, ...rest)
          if (file === markerPath) {
            recoveredPhases.push(JSON.parse(contents).phase)
            log.push({ name: 'recovery reads the marker', file })
          }
          return contents
        }
      }
      if (!FAULT_POINTS.has(property)) return target[property]
      return (...args) => {
        const file = typeof args[0] === 'string' ? args[0] : openPaths.get(args[0])
        log.push({ name: property, file, to: args[1] })
        if (property === 'renameSync' && args[1] === markerPath) published = JSON.parse(target.readFileSync(args[0], 'utf8')).phase
        if (property === 'fsyncSync' && file === directory && published === 'rotating') {
          flushesAfterRotating += 1
          // The first flush after the "rotating" marker belongs to that marker's own write and is
          // best-effort; the second is the barrier in front of the archive renames.
          if (flushesAfterRotating === 2) throw Object.assign(new Error('directory fsync failed'), { code: 'EIO' })
        }
        const result = target[property](...args)
        if (property === 'openSync') openPaths.set(result, args[0])
        return result
      }
    },
  })

  assert.throws(() => openAudit({ path: auditPath, fs: failingFs }).writeAudit(safeRecord), /Unable to write audit record/)

  // Recovery found the "rotating" marker before any live file had been moved or removed; its
  // restore then rewrote each archive from the snapshot with the same bytes.
  assert.deepEqual(recoveredPhases, ['rotating'])
  const recovery = log.findIndex((entry) => entry.name === 'recovery reads the marker')
  const archives = new Set(Object.keys(layout).map((name) => path.join(directory, name)))
  assert.deepEqual(log.slice(0, recovery).filter((entry) => (entry.name === 'renameSync' || entry.name === 'unlinkSync') && archives.has(entry.file)), [])
  assert.deepEqual(readDirectory(directory), layout)

  openAudit({ path: auditPath }).writeAudit(safeRecord)
  assert.deepEqual(readDirectory(directory), { ...layout, 'audit.jsonl': `active${auditLine}` })
})

test('reports a failed post-commit directory flush once, with a fixed code', (t) => {
  const directory = temporaryDirectory(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  fs.writeFileSync(auditPath, 'active', { mode: 0o600 })
  const warnings = []
  const { fs: failingFs } = flushTrackingFs(auditPath, { failFlushAfterRename: true })
  const audit = openAudit({ path: auditPath, fs: failingFs, onDurabilityWarning: (...args) => warnings.push(args) })

  // Each rotating write swallows several failed flushes; the warning still comes only once.
  audit.writeAudit(safeRecord)
  audit.writeAudit(safeRecord)

  assert.deepEqual(warnings, [['directory-fsync-failed']])
  assert.equal(fs.readFileSync(auditPath, 'utf8'), auditLine)
})

test('stays silent without failed flushes and ignores a throwing warning callback', (t) => {
  const quietDirectory = temporaryDirectory(t)
  const quietPath = path.join(quietDirectory, 'audit.jsonl')
  fs.writeFileSync(quietPath, 'active', { mode: 0o600 })
  const warnings = []
  openAudit({ path: quietPath, fs: flushTrackingFs(quietPath).fs, onDurabilityWarning: (code) => warnings.push(code) }).writeAudit(safeRecord)
  assert.deepEqual(warnings, [])

  const directory = temporaryDirectory(t)
  const auditPath = path.join(directory, 'audit.jsonl')
  const { fs: failingFs } = flushTrackingFs(auditPath, { rotate: false, failEveryFlush: true })
  const audit = openAudit({ path: auditPath, fs: failingFs, onDurabilityWarning: () => { throw new Error('logger down') } })
  audit.writeAudit(safeRecord)
  assert.equal(fs.readFileSync(auditPath, 'utf8'), auditLine)

  for (const onDurabilityWarning of ['log', 42, {}]) {
    assert.throws(() => openAudit({ path: auditPath, onDurabilityWarning }), /Invalid audit options/)
  }
})
