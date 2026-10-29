'use strict'
// Companion security regression scan. Zero dependencies; run through scripts/security-scan.
// Runs synthetic canaries through every boundary that exists on this tree and applies static
// checks. A boundary whose source file is absent prints SKIP and is counted, so the same script
// covers it once it lands.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const rel = (...parts) => path.join(ROOT, ...parts)

const parseCanaries = (text) => String(text).split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#') && line.includes('='))
  .map((line) => {
    const index = line.indexOf('=')
    return { name: line.slice(0, index).trim(), value: line.slice(index + 1) }
  })
  .filter((canary) => canary.name && canary.value)

// Pieces of a canary that are individually secret (the bare token after "Bearer ", the value after "=").
const secretNeedles = (canary) => {
  const needles = new Set([canary.value])
  const afterSpace = canary.value.split(' ').pop()
  if (afterSpace && afterSpace !== canary.value && /canary/i.test(afterSpace)) needles.add(afterSpace)
  const afterEquals = canary.value.includes('=') ? canary.value.split('=').pop() : ''
  if (/canary/i.test(afterEquals)) needles.add(afterEquals)
  return [...needles]
}

const findLeaks = (output, canaries) => {
  const text = typeof output === 'string' ? output : JSON.stringify(output)
  const leaks = []
  for (const canary of canaries) {
    if (secretNeedles(canary).some((needle) => text.includes(needle))) leaks.push(canary.name)
  }
  return leaks
}

// Walks a directory for files with the given extensions.
const walk = (directory, extensions, found = []) => {
  if (!fs.existsSync(directory)) return found
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'target' || entry.name === 'dist') continue
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(full, extensions, found)
    else if (extensions.some((extension) => entry.name.endsWith(extension)) && !/\.test\./.test(entry.name)) found.push(full)
  }
  return found
}

const exists = (...parts) => fs.existsSync(rel(...parts))

const inflate = (value, size) => JSON.parse(JSON.stringify(value).replaceAll('OVERSIZE_PLACEHOLDER', 'X'.repeat(size)))

const loadCorpus = () => ({
  canaries: parseCanaries(fs.readFileSync(rel('test/security/secret-canaries.txt'), 'utf8')),
  events: JSON.parse(fs.readFileSync(rel('test/security/hostile-events.json'), 'utf8')),
  updates: JSON.parse(fs.readFileSync(rel('test/security/hostile-updates.json'), 'utf8')),
})

const normalizedHostile = (corpus) => {
  const { normalizeEvent } = require(rel('assets/relay/domain.js'))
  return corpus.events.map((input) => ({
    name: input.name,
    event: normalizeEvent({ payload: input.payload, issue: input.issue, event: input.event, application: input.application, receivedAt: '2026-09-22T10:00:00.000Z' }),
  }))
}

const violation = (boundary, message) => ({ boundary, message })

// Each boundary: { name, files (existence gate), run(corpus) -> violations[] }.
const boundaries = [
  {
    name: 'domain',
    files: ['assets/relay/domain.js'],
    run: (corpus) => normalizedHostile(corpus)
      .flatMap(({ name, event }) => findLeaks(event, corpus.canaries).map((leak) => violation('domain', `${name}: canary ${leak} survived normalizeEvent`))),
  },
  {
    name: 'formatter',
    files: ['assets/relay/format.js'],
    run: (corpus) => {
      const { formatMessage } = require(rel('assets/relay/format.js'))
      const out = []
      for (const { name, event } of normalizedHostile(corpus)) {
        for (const locale of ['en', 'ru', 'uz']) {
          const message = formatMessage(event, locale).text
          for (const leak of findLeaks(message, corpus.canaries)) out.push(violation('formatter', `${name}/${locale}: canary ${leak} in message`))
          if (message.length > 4096) out.push(violation('formatter', `${name}/${locale}: message ${message.length} > 4096`))
          if (/<(?!\/?(b|i|code|a)\b)[^>]*>/i.test(message)) out.push(violation('formatter', `${name}/${locale}: unescaped HTML`))
          if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f‪-‮]/.test(message)) out.push(violation('formatter', `${name}/${locale}: control character in message`))
        }
      }
      // Oversized payload through the formatter.
      const big = normalizedHostile({ ...corpus, events: corpus.events.map((e) => inflate(e, 200000)) })
      for (const { name, event } of big) {
        const message = require(rel('assets/relay/format.js')).formatMessage(event, 'en').text
        if (message.length > 4096) out.push(violation('formatter', `${name}: oversized payload produced ${message.length} chars`))
      }
      return out
    },
  },
  {
    name: 'queue',
    files: ['assets/relay/queue.js'],
    run: (corpus) => {
      const { openQueue } = require(rel('assets/relay/queue.js'))
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'security-scan-queue-'))
      try {
        const statePath = path.join(directory, 'state.json')
        const queue = openQueue({ path: statePath, limit: 50, retentionHours: 72, clock: () => Date.UTC(2026, 8, 22, 10), jitter: () => 0 })
        for (const { event } of normalizedHostile(corpus)) queue.enqueue(event)
        const stored = fs.readFileSync(statePath, 'utf8')
        const out = findLeaks(stored, corpus.canaries).map((leak) => violation('queue', `canary ${leak} persisted in queue state`))
        const mode = fs.statSync(statePath).mode & 0o777
        if (mode & 0o077) out.push(violation('queue', `state file mode ${mode.toString(8)} is group/world accessible`))
        return out
      } finally {
        fs.rmSync(directory, { recursive: true, force: true })
      }
    },
  },
  {
    name: 'audit',
    files: ['assets/relay/audit.js'],
    run: (corpus) => {
      const { openAudit } = require(rel('assets/relay/audit.js'))
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'security-scan-audit-'))
      try {
        const auditPath = path.join(directory, 'audit.log')
        const audit = openAudit({ path: auditPath })
        const out = []
        for (const { event } of normalizedHostile(corpus)) {
          // Canary-laden extra fields and a hostile event must never reach the file.
          const record = {
            eventId: 'evt-security', applicationId: 'shop', state: 'error', status: 'retrying', at: '2026-09-22T10:00:00.000Z',
            retryCount: 1, relayVersion: '1.0.0', configRevision: 'rev-1',
          }
          for (const canary of corpus.canaries) record[`x_${canary.name.replace(/-/g, '_')}`] = canary.value
          record.event = event
          try { audit.writeAudit(record) } catch { /* rejecting a hostile record is acceptable */ }
          try { audit.writeAudit({ ...record, failureCode: corpus.canaries[0].value }) } catch { /* rejected */ }
        }
        const stored = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : ''
        for (const leak of findLeaks(stored, corpus.canaries)) out.push(violation('audit', `canary ${leak} written to audit log`))
        if (fs.existsSync(auditPath)) {
          const mode = fs.statSync(auditPath).mode & 0o777
          if (mode & 0o077) out.push(violation('audit', `audit file mode ${mode.toString(8)} is group/world accessible`))
        }
        return out
      } finally {
        fs.rmSync(directory, { recursive: true, force: true })
      }
    },
  },
  {
    name: 'telegram',
    files: ['assets/relay/telegram.js'],
    run: async (corpus) => {
      const { createTelegramClient } = require(rel('assets/relay/telegram.js'))
      const token = corpus.canaries.find((canary) => canary.name === 'bot-token').value
      const out = []
      for (const update of corpus.updates) {
        const fetchFn = async () => ({
          ok: false,
          status: update.error_code,
          headers: { get: () => null },
          json: async () => ({ ok: false, error_code: update.error_code, description: update.description }),
        })
        const client = createTelegramClient({ token, fetchFn })
        try {
          await client.sendEvent({ chatId: -100123, topicId: 44, message: 'x' })
          out.push(violation('telegram', `${update.name}: error response did not fail`))
        } catch (error) {
          for (const leak of findLeaks({ ...error, message: error && error.message }, corpus.canaries)) {
            out.push(violation('telegram', `${update.name}: canary ${leak} in failure`))
          }
        }
      }
      return out
    },
  },
  ...[
    ['prompts', 'assets/relay/prompts.js', 'prompts'],
  ].map(([name, file]) => ({
    name,
    files: [file],
    run: (corpus) => {
      const mod = require(rel(file))
      const out = []
      for (const { name: caseName, event } of normalizedHostile(corpus)) {
        let prompt
        try { prompt = typeof mod.buildPrompt === 'function' ? mod.buildPrompt(event) : null } catch { continue /* refusing is safe */ }
        if (prompt == null) continue
        const text = typeof prompt === 'string' ? prompt : JSON.stringify(prompt)
        for (const leak of findLeaks(text, corpus.canaries)) out.push(violation(name, `${caseName}: canary ${leak} in prompt`))
        if (typeof mod.assertPromptSafe === 'function') {
          try { mod.assertPromptSafe(`${text}\n${corpus.canaries.map((c) => c.value).join('\n')}`); out.push(violation(name, 'assertPromptSafe accepted canary-laden text')) } catch { /* expected */ }
        }
      }
      return out
    },
  })),
  // Boundaries owned by other work: source must exist to be scanned; here each is checked for
  // embedded canaries (fixtures/previews) and, for JS modules, exercised through sanitizer exports.
  ...[
    ['helper-sanitizer', () => walk(rel('tools/companion-helper'), ['.js', '.mjs', '.ts', '.rs', '.sh', '.json'])],
    ['deployment-preview', () => (exists('apps/desktop/src-tauri/src/remote.rs') ? [rel('apps/desktop/src-tauri/src/remote.rs')] : [])],
    ['generated-project-files', () => (exists('apps/desktop/src-tauri/src/agent_install.rs') ? [rel('apps/desktop/src-tauri/src/agent_install.rs')] : [])],
    ['diagnostics-export', () => walk(rel('apps/desktop'), ['.rs', '.ts', '.tsx']).filter((file) => /diagnostics/i.test(path.basename(file)))],
  ].map(([name, find]) => ({
    name,
    files: null,
    present: () => find().length > 0,
    run: (corpus) => find().flatMap((file) => {
      const source = fs.readFileSync(file, 'utf8')
      return findLeaks(source, corpus.canaries).map((leak) => violation(name, `${path.relative(ROOT, file)} embeds canary ${leak}`))
    }),
  })),
]

const staticChecks = [
  {
    name: 'compose-no-ports',
    run: () => {
      const file = rel('assets/relay/deploy/compose.yaml')
      if (!fs.existsSync(file)) return []
      return fs.readFileSync(file, 'utf8').split('\n')
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /^\s*ports\s*:/.test(line))
        .map(({ index }) => violation('compose-no-ports', `assets/relay/deploy/compose.yaml:${index + 1} publishes ports`))
    },
  },
  {
    name: 'no-host-key-bypass',
    run: () => walk(rel('apps/desktop/src-tauri/src'), ['.rs'])
      .filter((file) => /StrictHostKeyChecking[=\s]+no/i.test(fs.readFileSync(file, 'utf8')))
      .map((file) => violation('no-host-key-bypass', `${path.relative(ROOT, file)} disables StrictHostKeyChecking`)),
  },
  {
    name: 'no-remote-images',
    run: () => walk(rel('apps/desktop/src'), ['.tsx']).flatMap((file) => fs.readFileSync(file, 'utf8').split('\n')
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /(<img\b[^>]*\bsrc\s*=\s*[{"'`]*\s*["'`]?https?:|\bsrc\s*=\s*["'`{]+\s*["'`]?https?:|url\(\s*["']?https?:)/i.test(line))
      .map(({ index }) => violation('no-remote-images', `${path.relative(ROOT, file)}:${index + 1} references a remote image`))),
  },
  {
    name: 'no-raw-payload-logging',
    run: () => walk(rel('assets/relay'), ['.js']).flatMap((file) => fs.readFileSync(file, 'utf8').split('\n')
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /console\.(log|info|error|warn|debug)\(\s*JSON\.stringify\(/.test(line) || /console\.(log|info|error|warn|debug)\([^)]*\b(req\.body|request\.body|rawBody|payload)\b/.test(line))
      .map(({ index }) => violation('no-raw-payload-logging', `${path.relative(ROOT, file)}:${index + 1} logs a raw payload`))),
  },
  {
    name: 'secret-file-modes',
    run: () => {
      const files = [...walk(rel('assets/relay'), ['.js']), ...walk(rel('apps/desktop/src-tauri/src'), ['.rs'])]
      const out = []
      for (const file of files) {
        const source = fs.readFileSync(file, 'utf8')
        // Any explicit file mode granting group/other bits outside tests is a violation.
        const pattern = /\.mode\(\s*0o([0-7]{3,4})\s*\)|openSync\([^)]*,\s*0o([0-7]{3,4})\s*\)|fchmodSync\([^)]*,\s*0o([0-7]{3,4})\s*\)|chmodSync\([^)]*,\s*0o([0-7]{3,4})\s*\)/g
        let match
        while ((match = pattern.exec(source))) {
          const mode = parseInt(match[1] || match[2] || match[3] || match[4], 8)
          const line = source.slice(0, match.index).split('\n').length
          const context = source.slice(Math.max(0, match.index - 400), match.index)
          if ((mode & 0o077) && !/#\[cfg\(test\)\]|mod tests/.test(context) && !/(^|\n)\s*\/\/.*lax/i.test(context.slice(-200))) {
            const isTestRegion = source.slice(0, match.index).includes('#[cfg(test)]')
            if (!isTestRegion) out.push(violation('secret-file-modes', `${path.relative(ROOT, file)}:${line} creates a file with mode ${mode.toString(8)}`))
          }
        }
      }
      return out
    },
  },
]

const main = async () => {
  const corpus = loadCorpus()
  const lines = []
  const failures = []
  let skipped = 0
  let scanned = 0
  for (const boundary of boundaries) {
    const present = boundary.present ? boundary.present() : boundary.files.every((file) => exists(file))
    if (!present) {
      skipped += 1
      lines.push(`SKIP ${boundary.name} (absent)`)
      continue
    }
    let result
    try {
      result = await boundary.run(corpus)
    } catch (error) {
      result = [violation(boundary.name, `scanner error: ${error && error.message}`)]
    }
    scanned += 1
    failures.push(...result)
    lines.push(`${result.length ? 'FAIL' : 'PASS'} ${boundary.name} (${corpus.canaries.length} canaries, ${corpus.events.length} hostile events${result.length ? `, ${result.length} violations` : ''})`)
  }
  for (const check of staticChecks) {
    const result = check.run()
    scanned += 1
    failures.push(...result)
    lines.push(`${result.length ? 'FAIL' : 'PASS'} ${check.name} (static${result.length ? `, ${result.length} violations` : ''})`)
  }
  for (const failure of failures) console.log(`VIOLATION [${failure.boundary}] ${failure.message}`)
  for (const line of lines) console.log(line)
  console.log(`TOTAL scanned=${scanned} skipped=${skipped} violations=${failures.length}`)
  process.exit(failures.length ? 1 : 0)
}

module.exports = { parseCanaries, findLeaks, secretNeedles }
if (require.main === module) main()
