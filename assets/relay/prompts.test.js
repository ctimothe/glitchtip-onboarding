'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  PROMPTS,
  PROMPT_STATES,
  assertPromptSafe,
  buildPrompt,
  providerKeyboard,
} = require('./prompts')

const incident = {
  applicationName: 'Billing API',
  incidentRef: 'gt:billing-api:1842',
  state: 'error',
  environment: 'production',
  release: 'a81c2f7',
  impact: '18 users, 47 events in 12 minutes',
  classification: 'regression after release',
  title: 'payment authorization failure',
}

const EXACT_CODEX_ERROR = `Investigate GlitchTip issue GT-1842 for Billing API in this repository.

Use $glitchtip-investigate. Fetch the latest private issue context using incident reference \`gt:billing-api:1842\`.

Goal: reproduce and diagnose the payment authorization failure. Do not modify code, dependencies, infrastructure, or production data unless I explicitly ask after reviewing your diagnosis.

Known signal:
- Environment: production
- Release: a81c2f7
- Impact: 18 users, 47 events in 12 minutes
- Classification: regression after release

Report:
1. Reproduction result and evidence
2. Most likely root cause, with relevant code paths
3. What changed near the first failing release
4. Confidence, unknowns, and missing evidence
5. Smallest safe fix options and verification plan

Redact secrets and personal data. If private context cannot be fetched, stop and report the exact failed step. Do not guess.`

const build = (overrides = {}, provider = 'codex', locale = 'en') =>
  buildPrompt({ provider, locale, incident: { ...incident, ...overrides } })

test('renders the exact English Codex Error prompt', () => {
  assert.equal(build(), EXACT_CODEX_ERROR)
})

test('providers differ only by invocation line', () => {
  const codex = build()
  const claude = build({}, 'claude')
  const other = build({}, 'other')
  assert.ok(claude.includes('Use /glitchtip-investigate.'))
  assert.equal(claude.replace('Use /glitchtip-investigate.', 'Use $glitchtip-investigate.'), codex)
  assert.ok(other.includes(
    'Run glitchtip-companion context --ref gt:billing-api:1842 --format json, then follow the repository investigation policy.',
  ))
  assert.equal(other.split('\n\n').slice(2).join('\n\n'), codex.split('\n\n').slice(2).join('\n\n'))
})

test('each state has its own goal', () => {
  const goal = (state) => build({ state }).split('\n\n')[2]
  assert.match(goal('error'), /reproduce and diagnose/)
  assert.match(goal('warning'), /trend, risk, and action threshold/)
  assert.match(goal('resolved'), /recovery and recurrence risk.*Do not assume a fix\./)
  assert.match(goal('test'), /verify delivery only.*Do not inspect application code\./)
  assert.match(goal('setup_failure'), /Companion, GlitchTip, relay, or Telegram.*Do not classify it as an application failure\./)
})

test('omits signal lines that are empty', () => {
  const prompt = build({ environment: '', release: '  ', impact: '', classification: '' })
  assert.ok(!prompt.includes('Known signal:'))
})

test('normalizes whitespace and clips the title to 160 characters', () => {
  const prompt = build({ title: `  a\n\tb   ${'x'.repeat(400)}` })
  const goal = prompt.split('\n\n')[2]
  const title = goal.slice('Goal: reproduce and diagnose the '.length, goal.indexOf('. Do not'))
  assert.equal(title.length, 160)
  assert.ok(title.startsWith('a b xxx'))
})

test('rejects raw context or payload properties and bad inputs', () => {
  for (const key of ['context', 'payload']) {
    assert.throws(() => build({ [key]: 'x' }), { code: 'unsafe-prompt' })
  }
  assert.throws(() => build({ incidentRef: 'gt:x`; rm -rf' }), { code: 'unsafe-prompt' })
  assert.throws(() => build({ state: 'info' }), { code: 'unsafe-prompt' })
  assert.throws(() => build({}, 'gemini'), { code: 'unsafe-prompt' })
  assert.throws(() => build({}, 'codex', 'de'), { code: 'unsafe-prompt' })
})

test('ignores fields outside the allowlist', () => {
  assert.equal(build({ stack: 'boom at x.js:1:2', extra: 'sk-secretsecretsecret1' }), EXACT_CODEX_ERROR)
})

test('provider keyboard carries the callback key and provider codes', () => {
  assert.deepEqual(providerKeyboard('k1'), {
    inline_keyboard: [[
      { text: 'Codex', callback_data: 'provider:k1:c' },
      { text: 'Claude Code', callback_data: 'provider:k1:h' },
      { text: 'Other', callback_data: 'provider:k1:o' },
    ]],
  })
  assert.throws(() => providerKeyboard('a:b'), { code: 'unsafe-prompt' })
  assert.throws(() => providerKeyboard('x'.repeat(60)), { code: 'unsafe-prompt' })
})

test('locale dictionaries have identical keys and placeholders', () => {
  const placeholders = (text) => (String(text).match(/\{[a-zA-Z]+\}/g) || []).sort()
  const keys = Object.keys(PROMPTS.en).sort()
  for (const locale of ['ru', 'uz']) {
    assert.deepEqual(Object.keys(PROMPTS[locale]).sort(), keys, locale)
    for (const key of keys) {
      assert.deepEqual(placeholders(PROMPTS[locale][key]), placeholders(PROMPTS.en[key]), `${locale}.${key}`)
    }
  }
})

test('every state renders in every locale without fallback text', () => {
  assert.deepEqual(PROMPT_STATES, ['error', 'warning', 'resolved', 'test', 'setup_failure'])
  const seen = new Set()
  for (const locale of ['uz', 'ru', 'en']) {
    for (const state of PROMPT_STATES) {
      for (const provider of ['codex', 'claude', 'other']) {
        const prompt = build({ state }, provider, locale)
        assert.ok(!/\{[a-zA-Z]+\}|undefined/.test(prompt), `${locale}/${state}/${provider}`)
        assertPromptSafe(prompt, [])
        if (provider === 'codex') {
          assert.ok(!seen.has(prompt), 'prompts are distinct')
          seen.add(prompt)
        }
      }
    }
  }
  assert.equal(seen.size, 15)
})

test('assertPromptSafe accepts the clean prompt', () => {
  assert.doesNotThrow(() => assertPromptSafe(EXACT_CODEX_ERROR, ['canary-secret']))
})

test('canaries in every incident string field are rejected', () => {
  const canary = 'CANARY-7f3a9b'
  for (const field of ['applicationName', 'environment', 'release', 'impact', 'classification', 'title']) {
    const prompt = build({ [field]: `${canary} value` })
    assert.throws(() => assertPromptSafe(prompt, [canary]), { code: 'unsafe-prompt', message: 'unsafe-prompt' }, field)
  }
})

test('assertPromptSafe rejects secret-shaped and code-shaped content', () => {
  const cases = {
    openai: 'sk-abcdefghijklmnopqrstuvwx',
    github: 'ghp_abcdefghijklmnopqrstuvwx',
    slack: 'xoxb-1234567890-abcdefgh',
    aws: 'AKIAABCDEFGHIJKLMNOP',
    jwt: 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0',
    telegram: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
    bearer: 'Bearer abcdef123456',
    longToken: 'a'.repeat(64),
    email: 'person@example.com',
    phone: '+998 90 123 45 67',
    authorization: 'Authorization: Basic abc',
    cookie: 'Cookie: sid=abc',
    stack: 'Error: boom\n    at handler (/app/src/pay.js:10:5)',
    python: 'Traceback (most recent call last)',
    source: '```js\nconst a = 1\n```',
  }
  for (const [name, value] of Object.entries(cases)) {
    assert.throws(() => assertPromptSafe(build({ impact: value }), []), { code: 'unsafe-prompt' }, name)
    assert.throws(() => assertPromptSafe(`${EXACT_CODEX_ERROR}\n${value}`, []), { code: 'unsafe-prompt' }, name)
  }
})

test('assertPromptSafe rejects oversized prompts and lines', () => {
  assert.throws(() => assertPromptSafe(`${EXACT_CODEX_ERROR}\n${'word '.repeat(100)}`, []), { code: 'unsafe-prompt' })
  assert.throws(() => assertPromptSafe(`${EXACT_CODEX_ERROR}\n${'ab '.repeat(1100)}`, []), { code: 'unsafe-prompt' })
  assert.throws(() => assertPromptSafe('', []), { code: 'unsafe-prompt' })
})
