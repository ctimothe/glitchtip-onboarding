'use strict'

const nodeFs = require('node:fs')
const path = require('node:path')
const { normalizeFailureCode } = require('./failure-code')

const MAX_BYTES = 10 * 1024 * 1024
const MAX_STRING_BYTES = 4096
const ARCHIVES = 3
const STRING_FIELDS = ['eventId', 'applicationId', 'state', 'status', 'at', 'nextRetryAt', 'failureCode', 'relayVersion', 'configRevision']
const NUMBER_FIELDS = ['telegramMessageId', 'retryCount']
const MARKER_VERSION = 2
const MARKER_PHASES = ['snapshotting', 'rotating', 'completed']
const SLOT_KEYS = ['index', 'file', 'existed', 'backup']
// A directory fsync is unsupported on some platforms/filesystems; that specific failure is not a
// sign anything is wrong, so it is ignored there and there alone.
const IGNORABLE_DIRECTORY_FSYNC_CODES = new Set(['EISDIR', 'EINVAL', 'EPERM'])
const DURABILITY_WARNING = 'directory-fsync-failed'

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const sameKeys = (value, keys) => isObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const publicRecord = (record) => {
  if (!isObject(record)) throw new Error('Invalid audit record')
  const output = {}
  for (const field of STRING_FIELDS) {
    if (record[field] === undefined || record[field] === null) continue
    if (field === 'failureCode' && Number.isSafeInteger(record[field])) {
      output[field] = normalizeFailureCode(record[field])
      continue
    }
    if (typeof record[field] !== 'string' || Buffer.byteLength(record[field], 'utf8') > MAX_STRING_BYTES) throw new Error('Invalid audit record')
    output[field] = field === 'failureCode' ? normalizeFailureCode(record[field]) : record[field]
  }
  for (const field of NUMBER_FIELDS) {
    if (record[field] === undefined || record[field] === null) continue
    if (!Number.isSafeInteger(record[field]) || record[field] < 0 || (field === 'telegramMessageId' && record[field] === 0)) throw new Error('Invalid audit record')
    output[field] = record[field]
  }
  return output
}

function openAudit(options) {
  if (!isObject(options) || typeof options.path !== 'string' || !options.path) throw new Error('Invalid audit options')
  if (options.onDurabilityWarning !== undefined && typeof options.onDurabilityWarning !== 'function') throw new Error('Invalid audit options')
  const { onDurabilityWarning } = options
  const fs = options.fs || nodeFs
  const auditPath = options.path
  const directory = path.dirname(auditPath)
  const markerPath = `${auditPath}.rotation.json`
  const markerTemporaryPath = `${markerPath}.tmp`
  const paths = () => Array.from({ length: ARCHIVES + 1 }, (_, index) => index === 0 ? auditPath : `${auditPath}.${index}`)
  const backupPath = (index) => `${auditPath}.rotation.${index}`
  const backupPaths = () => paths().map((_, index) => backupPath(index))
  const harden = () => {
    for (const file of paths()) if (fs.existsSync(file)) fs.chmodSync(file, 0o600)
  }
  const remove = (file) => {
    if (fs.existsSync(file)) fs.unlinkSync(file)
  }
  // A rename or unlink is only durable once its directory entry is itself flushed. This covers
  // every mutation point the crash sweep already exercises, using the same injectable `fs`.
  const fsyncDirectory = () => {
    const descriptor = fs.openSync(directory, 'r')
    try {
      fs.fsyncSync(descriptor)
    } catch (error) {
      if (!error || !IGNORABLE_DIRECTORY_FSYNC_CODES.has(error.code)) throw error
    } finally {
      fs.closeSync(descriptor)
    }
  }
  // Flushes the directory after a rename or unlink that has already taken effect. That change is
  // committed: every later read sees it, and undoing it would be the destructive step. A failed
  // flush only leaves a window in which a power loss could lose the change, so it is swallowed
  // rather than turned into a reported failure and a rollback. Flushes that must land before a
  // commit point (the backups before the "rotating" marker, a restore before the "completed"
  // marker) call fsyncDirectory directly and still throw.
  // The first swallowed failure is reported through `onDurabilityWarning`, once for this audit log
  // and with a fixed code only; a callback that throws cannot fail the committed step.
  let durabilityWarned = false
  const flushCommitted = () => {
    try {
      fsyncDirectory()
    } catch {
      if (durabilityWarned || !onDurabilityWarning) return
      durabilityWarned = true
      try { onDurabilityWarning(DURABILITY_WARNING) } catch {}
    }
  }
  // Any step before the rename can fail; `file` is then untouched and the temporary file is
  // removed. The rename commits the new contents, and nothing after it can fail the write.
  const writeDurable = (file, text) => {
    const temporary = `${file}.tmp`
    let descriptor
    try {
      descriptor = fs.openSync(temporary, 'w', 0o600)
      fs.fchmodSync(descriptor, 0o600)
      fs.writeSync(descriptor, text, null, 'utf8')
      fs.fsyncSync(descriptor)
      // Nulled before the close call itself, so a close that throws is never retried on the same
      // descriptor by the catch block below.
      const handle = descriptor
      descriptor = null
      fs.closeSync(handle)
      fs.renameSync(temporary, file)
      flushCommitted()
    } catch (error) {
      if (descriptor !== undefined && descriptor !== null) {
        try { fs.closeSync(descriptor) } catch {}
      }
      try { remove(temporary) } catch {}
      throw error
    }
  }
  // One existence check per file, so a racing change cannot record a slot as both present and absent.
  const slots = () => paths().map((file, index) => {
    const existed = fs.existsSync(file)
    return { index, file, existed, backup: existed ? backupPath(index) : null }
  })
  const validSlot = (slot, index, expectedPaths) => {
    if (!sameKeys(slot, SLOT_KEYS)) return false
    const inPlace = slot.index === index && slot.file === expectedPaths[index]
    const backupMatches = slot.existed === true
      ? slot.backup === backupPath(index)
      : slot.existed === false && slot.backup === null
    return inPlace && backupMatches
  }
  const validManifest = (marker) => {
    if (!isObject(marker) || marker.version !== MARKER_VERSION) return false
    if (!MARKER_PHASES.includes(marker.phase)) return false
    if (!Array.isArray(marker.slots) || marker.slots.length !== ARCHIVES + 1) return false
    const expectedPaths = paths()
    return marker.slots.every((slot, index) => validSlot(slot, index, expectedPaths))
  }
  const parseMarker = () => {
    const text = fs.readFileSync(markerPath, 'utf8')
    let marker
    try {
      marker = JSON.parse(text)
    } catch {
      throw new Error('Invalid rotation marker')
    }
    if (!validManifest(marker)) throw new Error('Invalid rotation marker')
    return marker
  }
  // Backups and the temporary marker go first. An interrupted cleanup therefore still leaves the
  // marker, and the next recovery finishes the job.
  const cleanup = (manifest) => {
    for (const slot of manifest.slots) {
      if (slot.existed) remove(slot.backup)
    }
    remove(markerTemporaryPath)
    remove(markerPath)
    flushCommitted()
  }
  const sameBytes = (left, right) => fs.readFileSync(left).equals(fs.readFileSync(right))
  // A slot that was empty before the rotation can only have been filled by renaming the slot
  // before it, so its live file must hold exactly that slot's backed-up bytes.
  const producedByRotation = (manifest, slot) => {
    const previous = manifest.slots[slot.index - 1]
    return previous !== undefined
      && previous.existed
      && fs.existsSync(previous.backup)
      && sameBytes(slot.file, previous.backup)
  }
  const restorable = (manifest, slot) => {
    if (slot.existed) return fs.existsSync(slot.backup)
    return !fs.existsSync(slot.file) || producedByRotation(manifest, slot)
  }
  const restore = (manifest) => {
    // Every slot is checked before anything changes, so a refusal leaves the disk as it was.
    if (!manifest.slots.every((slot) => restorable(manifest, slot))) throw new Error('Unable to recover audit rotation')
    for (const slot of manifest.slots) {
      if (slot.existed) {
        remove(slot.file)
        fs.copyFileSync(slot.backup, slot.file)
        fs.chmodSync(slot.file, 0o600)
      } else {
        remove(slot.file)
      }
    }
    fsyncDirectory()
  }
  const recover = () => {
    if (!fs.existsSync(markerPath)) {
      if (backupPaths().some((file) => fs.existsSync(file))) throw new Error('Unable to recover audit rotation')
      // Without a published marker, the temporary file only holds a manifest that never took effect.
      remove(markerTemporaryPath)
      return
    }
    const manifest = parseMarker()
    if (manifest.phase === 'snapshotting' || manifest.phase === 'completed') {
      cleanup(manifest)
      return
    }
    restore(manifest)
    writeDurable(markerPath, JSON.stringify({ ...manifest, phase: 'completed' }))
    cleanup(manifest)
  }
  const snapshot = (manifest) => {
    try {
      writeDurable(markerPath, JSON.stringify({ ...manifest, phase: 'snapshotting' }))
      for (const slot of manifest.slots) {
        if (!slot.existed) continue
        fs.copyFileSync(slot.file, slot.backup)
        fs.chmodSync(slot.backup, 0o600)
        const descriptor = fs.openSync(slot.backup, 'r')
        try {
          fs.fsyncSync(descriptor)
        } finally {
          fs.closeSync(descriptor)
        }
      }
      fsyncDirectory()
      writeDurable(markerPath, JSON.stringify({ ...manifest, phase: 'rotating' }))
    } catch {
      // Recovery refuses to start while any backup exists without a marker, so every backup path
      // here, including a partly copied one, belongs to this snapshot. The marker still says
      // "snapshotting" or is absent: a "rotating" write can only fail before its rename, since
      // nothing after that rename fails the write.
      try { cleanup(manifest) } catch {}
      throw new Error('Unable to snapshot audit log')
    }
  }
  const rotate = (lineBytes) => {
    if (!fs.existsSync(auditPath) || fs.statSync(auditPath).size + lineBytes <= MAX_BYTES) return
    harden()
    const manifest = { version: MARKER_VERSION, phase: 'snapshotting', slots: slots() }
    snapshot(manifest)
    try {
      // The "rotating" marker must be durable before any live archive moves. Its own write only
      // flushes on a best-effort basis (flushCommitted), so this is the barrier, and it throws:
      // nothing has moved yet, and recovery restores from the snapshot.
      fsyncDirectory()
      remove(`${auditPath}.${ARCHIVES}`)
      for (let index = ARCHIVES - 1; index >= 1; index -= 1) {
        const source = `${auditPath}.${index}`
        if (fs.existsSync(source)) fs.renameSync(source, `${auditPath}.${index + 1}`)
      }
      fs.renameSync(auditPath, `${auditPath}.1`)
      flushCommitted()
      harden()
      writeDurable(markerPath, JSON.stringify({ ...manifest, phase: 'completed' }))
      cleanup(manifest)
    } catch {
      try { recover() } catch {}
      throw new Error('Unable to rotate audit log')
    }
  }

  recover()
  return {
    writeAudit(record) {
      const line = `${JSON.stringify(publicRecord(record))}\n`
      const lineBytes = Buffer.byteLength(line, 'utf8')
      if (lineBytes > MAX_BYTES) throw new Error('Audit record exceeds maximum size')
      let descriptor
      try {
        recover()
        rotate(lineBytes)
        harden()
        // After a rotation, or on the very first write, there is no active file: this append
        // creates it.
        const created = !fs.existsSync(auditPath)
        descriptor = fs.openSync(auditPath, 'a', 0o600)
        fs.fchmodSync(descriptor, 0o600)
        fs.writeSync(descriptor, line, null, 'utf8')
        fs.fsyncSync(descriptor)
        // Nulled before the close call itself, so a close that throws is never retried below.
        const handle = descriptor
        descriptor = null
        fs.closeSync(handle)
        // A new file survives a power loss only once its directory entry is flushed, so the write
        // is not reported done before that. The record itself is already written and synced, so a
        // failed flush counts as committed, as for any other committed step.
        if (created) flushCommitted()
      } catch {
        if (descriptor !== undefined && descriptor !== null) {
          try { fs.closeSync(descriptor) } catch {}
        }
        throw new Error('Unable to write audit record')
      }
    },
  }
}

module.exports = { openAudit }
