'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const en = require('./locales/en')
const ru = require('./locales/ru')
const uz = require('./locales/uz')
const {
  escapeHtml,
  formatEnriched,
  formatMessage,
  formatSummary,
} = require('./format')

const baseEvent = {
  id: 'evt-1',
  applicationId: 'billing-api',
  applicationName: 'Billing API',
  projectSlug: 'billing-api',
  environment: 'production',
  state: 'error',
  title: 'Payment authorization failed',
  issueId: '1842',
  issueUrl: 'https://errors.example.test/issues/1842/',
  release: 'a81c2f7',
  eventCount: 47,
  affectedUsers: 18,
  windowMinutes: 12,
  threshold: null,
  firstSeen: '14:32',
  lastSeen: '',
  incidentMinutes: null,
  quietMinutes: null,
}

const fixture = (overrides) => ({ ...baseEvent, ...overrides })

test('renders the exact English Error message', () => {
  assert.deepEqual(formatMessage(baseEvent, 'en'), {
    text: '<b>ERROR · Billing API · production</b>\n<b>Payment authorization failed</b>\n18 affected users · 47 events in 12 min\nFirst seen 14:32 · release <code>a81c2f7</code>\n<a href="https://errors.example.test/issues/1842/">Open issue GT-1842 in GlitchTip</a>',
    action: { text: 'Prepare agent brief', kind: 'brief' },
  })
})

test('renders the exact English Warning message', () => {
  assert.deepEqual(formatMessage(fixture({
    state: 'warning',
    title: 'Payment errors rising',
    eventCount: 9,
    affectedUsers: 4,
    windowMinutes: 15,
    threshold: 6,
    firstSeen: '',
  }), 'en'), {
    text: '<b>WARNING · Billing API · production</b>\n<b>Payment errors rising</b>\n9 events · threshold 6 in 15 min · 4 affected users\nrelease <code>a81c2f7</code>\n<a href="https://errors.example.test/issues/1842/">Open issue GT-1842 in GlitchTip</a>',
    action: { text: 'Prepare agent brief', kind: 'brief' },
  })
})

test('renders the exact English Resolved message', () => {
  assert.deepEqual(formatMessage(fixture({
    state: 'resolved',
    title: 'Payment authorization recovered',
    release: '',
    windowMinutes: null,
    quietMinutes: 20,
    incidentMinutes: 38,
  }), 'en'), {
    text: '<b>RESOLVED · Billing API · production</b>\n<b>Payment authorization recovered</b>\nQuiet for 20 min · incident lasted 38 min\nPeak impact 18 affected users · 47 events\n<a href="https://errors.example.test/issues/1842/">Open issue GT-1842 in GlitchTip</a>',
    action: { text: 'Prepare recovery review', kind: 'recovery' },
  })
})

test('renders the exact English Info message without an action', () => {
  assert.deepEqual(formatMessage(fixture({
    state: 'info',
    title: 'First event observed from this release',
    issueId: '',
    issueUrl: '',
    eventCount: null,
    affectedUsers: null,
    windowMinutes: null,
    firstSeen: '',
  }), 'en'), {
    text: '<b>INFO · Billing API · production</b>\n<b>First event observed from this release</b>\nrelease <code>a81c2f7</code>',
    action: null,
  })
})

test('renders the exact one-time English Setup Complete message', () => {
  const message = formatMessage(fixture({
    state: 'setup_complete',
    title: 'Monitoring setup verified',
    issueId: '',
    issueUrl: '',
    release: '',
    eventCount: null,
    affectedUsers: null,
    windowMinutes: null,
    firstSeen: '',
  }), 'en')

  assert.deepEqual(message, {
    text: '<b>SETUP COMPLETE · Billing API · production</b>\n<b>Monitoring setup verified</b>\nVerified GlitchTip connection · relay · Telegram topic · agent skill',
    action: null,
  })
  assert.doesNotMatch(message.text, /recurring|healthy|success/i)
})

test('renders the exact English Test message with elapsed time', () => {
  assert.deepEqual(formatMessage(fixture({
    state: 'test',
    title: 'Delivery test',
    issueId: '',
    issueUrl: '',
    release: '',
    eventCount: null,
    affectedUsers: null,
    windowMinutes: 2,
    firstSeen: '',
  }), 'en'), {
    text: '<b>TEST · Billing API · production</b>\n<b>Delivery test</b>\nGlitchTip → relay → Telegram · 2 min elapsed',
    action: null,
  })
})

test('escapes hostile dynamic fields and rejects unsafe links', () => {
  const hostile = `<>&"'`
  const message = formatMessage(fixture({
    applicationName: hostile,
    environment: hostile,
    title: hostile,
    issueId: hostile,
    issueUrl: 'javascript:alert(1)',
    release: hostile,
  }), 'en')

  assert.equal(escapeHtml(hostile), '&lt;&gt;&amp;&quot;&#39;')
  assert.match(message.text, /&lt;&gt;&amp;&quot;&#39;/)
  assert.doesNotMatch(message.text, /javascript:|<>&"'/)
})

test('rejects credential-bearing issue links at the rendering boundary', () => {
  const message = formatMessage(fixture({
    issueUrl: 'https://token:password@errors.example.test/issues/1842/',
  }), 'en')

  assert.doesNotMatch(message.text, /token|password|href=/)
})

const visibleText = (text) => text
  .replace(/<a href="[^"]*">([^<]*)<\/a>/g, '$1')
  .replace(/<\/?(?:b|code)>/g, '')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&')

const assertBalancedSupportedTags = (text) => {
  const tags = [...text.matchAll(/<\/?([a-z]+)(?: [^>]*)?>/g)].map((match) => match[0])
  const stack = []
  for (const tag of tags) {
    const match = tag.match(/^<\/?([a-z]+)/)
    const name = match && match[1]
    assert.ok(['a', 'b', 'code'].includes(name), `unsupported tag ${tag}`)
    if (tag.startsWith('</')) assert.equal(stack.pop(), name, `unbalanced tag ${tag}`)
    else stack.push(name)
  }
  assert.deepEqual(stack, [])
}

test('all messages fit Telegram and contain only balanced supported tags', () => {
  const huge = `<>&"'`.repeat(3_000)
  for (const state of ['error', 'warning', 'resolved', 'info', 'setup_complete', 'test']) {
    const { text } = formatMessage(fixture({
      state,
      applicationName: huge,
      environment: huge,
      title: huge,
      issueId: huge,
      issueUrl: 'https://errors.example.test/issues/1842/',
      release: huge,
      threshold: 3,
      quietMinutes: 15,
      incidentMinutes: 20,
    }), 'en')
    assert.ok(text.length <= 4_096, `${state} raw message was ${text.length} characters`)
    assert.ok(visibleText(text).length <= 4_096, `${state} visible message exceeded Telegram limit`)
    assertBalancedSupportedTags(text)
  }
})

test('semantic templates contain none of the old icon set', () => {
  const oldIcons = ['🚨', '⚠️', 'ℹ️', '🔔']
  for (const state of ['error', 'warning', 'resolved', 'info', 'setup_complete', 'test']) {
    const { text } = formatMessage(fixture({ state }), 'en')
    for (const icon of oldIcons) assert.doesNotMatch(text, new RegExp(icon, 'u'))
  }
})

test('locale modules have identical keys and interpolation placeholders', () => {
  const locales = { en, ru, uz }
  const keys = Object.keys(en).sort()
  const placeholders = (value) => [...String(value).matchAll(/\{([a-zA-Z]+)\}/g)]
    .map((match) => match[1])
    .sort()

  for (const [locale, messages] of Object.entries(locales)) {
    assert.deepEqual(Object.keys(messages).sort(), keys, `${locale} keyset differs`)
    for (const key of keys) {
      assert.deepEqual(placeholders(messages[key]), placeholders(en[key]), `${locale}.${key} placeholders differ`)
    }
  }
})

test('every semantic state renders in every locale without English fallback', () => {
  const labels = {
    en: ['ERROR', 'WARNING', 'RESOLVED', 'INFO', 'SETUP COMPLETE', 'TEST'],
    ru: ['ОШИБКА', 'ПРЕДУПРЕЖДЕНИЕ', 'ВОССТАНОВЛЕНО', 'ИНФОРМАЦИЯ', 'НАСТРОЙКА ЗАВЕРШЕНА', 'ТЕСТ'],
    uz: ['XATO', 'OGOHLANTIRISH', 'TIKLANDI', 'MAʼLUMOT', 'SOZLASH YAKUNLANDI', 'SINOV'],
  }
  const states = ['error', 'warning', 'resolved', 'info', 'setup_complete', 'test']

  for (const [locale, expectedLabels] of Object.entries(labels)) {
    states.forEach((state, index) => {
      const { text } = formatMessage(fixture({ state }), locale)
      assert.match(text, new RegExp(`^<b>${expectedLabels[index]} ·`))
    })
  }
})

test('omitted locale renders Uzbek and unsupported locales are rejected', () => {
  const message = formatMessage(fixture({ state: 'error' }))

  assert.match(message.text, /^<b>XATO ·/)
  assert.deepEqual(message.action, {
    text: 'Agent uchun maʼlumot tayyorlash',
    kind: 'brief',
  })
  assert.throws(
    () => formatMessage(fixture({ state: 'error' }), 'de'),
    { name: 'RangeError', message: 'Unsupported locale: de' },
  )
})

test('missing latest event preserves webhook summary fallback', () => {
  const payload = {
    attachments: [{
      title: 'Webhook warning remains available',
      title_link: 'https://errors.example.test/issues/7?private=1',
      fields: [{ title: 'Level', value: 'warning' }],
    }],
  }
  const enriched = formatEnriched(
    'billing-api',
    { id: '7' },
    null,
    'https://errors.example.test/issues/7?private=1',
    null,
  )
  const fallback = enriched || formatSummary('billing-api', payload)

  assert.equal(enriched, null)
  assert.match(fallback, /^<b>WARNING · billing-api<\/b>/)
  assert.match(fallback, /Webhook warning remains available/)
})

test('legacy summary accepts a null payload', () => {
  assert.doesNotThrow(() => formatSummary('billing-api', null))
  assert.equal(
    formatSummary('billing-api', null),
    '<b>INFO · billing-api</b>\n<b>New information event</b>',
  )
})

test('legacy enriched and summary callers use the English semantic formatter', () => {
  const enriched = formatEnriched(
    'billing-api',
    { id: '1842', count: '3', userCount: 2 },
    {
      title: 'Payment <retry> & wait',
      level: 'warning',
      tags: [
        { key: 'environment', value: 'production' },
        { key: 'release', value: 'abc123' },
      ],
      entries: [],
    },
    'https://errors.example.test/issues/1842/?private=1',
    { user: { name: 'Must not appear' } },
  )
  const summary = formatSummary('billing-api', {
    attachments: [{
      title: '<b>not markup</b>',
      title_link: 'https://errors.example.test/issues/7?private=1',
      fields: [{ title: 'Level', value: 'warning' }],
    }],
  })

  assert.match(enriched, /^<b>WARNING · billing-api · production<\/b>/)
  assert.match(enriched, /Payment &lt;retry&gt; &amp; wait/)
  assert.match(enriched, /https:\/\/errors\.example\.test\/issues\/1842\//)
  assert.doesNotMatch(enriched, /private|Must not appear/)
  assert.match(summary, /^<b>WARNING · billing-api<\/b>/)
  assert.match(summary, /&lt;b&gt;not markup&lt;\/b&gt;/)
  assert.doesNotMatch(summary, /private/)
})
