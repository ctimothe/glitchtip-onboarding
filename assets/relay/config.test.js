'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { applicationForEvent, applicationForProject, readConfig, readPort } = require('./config')

const application = {
  id: 'billing-api',
  name: 'Billing API',
  projectSlug: 'billing-api',
  topicId: 44,
  environments: ['production'],
}

const validEnv = (overrides = {}) => ({
  COMPANION_WORKSPACE_ID: 'acme',
  COMPANION_LOCALE: 'uz',
  TELEGRAM_BOT_TOKEN: 'secret',
  TELEGRAM_CHAT_ID: '-100123',
  ALLOWED_MEMBER_IDS: '[42,91]',
  APPLICATIONS_JSON: JSON.stringify([application]),
  QUEUE_PATH: '/var/lib/glitchtip-companion/state.json',
  AUDIT_PATH: '/var/lib/glitchtip-companion/audit.jsonl',
  QUEUE_LIMIT: '500',
  RETENTION_HOURS: '72',
  ...overrides,
})

test('parses a complete workspace configuration', () => {
  assert.deepEqual(readConfig(validEnv()), {
    workspaceId: 'acme',
    locale: 'uz',
    botToken: 'secret',
    paired: true,
    chatId: -100123,
    allowedMemberIds: [42, 91],
    applications: [application],
    queuePath: '/var/lib/glitchtip-companion/state.json',
    auditPath: '/var/lib/glitchtip-companion/audit.jsonl',
    queueLimit: 500,
    retentionHours: 72,
    glitchtipApiBase: 'http://web:8080',
    glitchtipApiToken: '',
    configRevision: 'unversioned',
  })
})

test('defaults locale and bounded storage settings', () => {
  const env = validEnv()
  delete env.COMPANION_LOCALE
  delete env.QUEUE_PATH
  delete env.AUDIT_PATH
  delete env.QUEUE_LIMIT
  delete env.RETENTION_HOURS

  assert.deepEqual(readConfig(env), {
    workspaceId: 'acme',
    locale: 'uz',
    botToken: 'secret',
    paired: true,
    chatId: -100123,
    allowedMemberIds: [42, 91],
    applications: [application],
    queuePath: '/var/lib/glitchtip-companion/state.json',
    auditPath: '/var/lib/glitchtip-companion/audit.jsonl',
    queueLimit: 500,
    retentionHours: 72,
    glitchtipApiBase: 'http://web:8080',
    glitchtipApiToken: '',
    configRevision: 'unversioned',
  })
})

test('blank optional strings preserve the approved defaults', () => {
  assert.deepEqual(readConfig(validEnv({
    COMPANION_LOCALE: '   ',
    QUEUE_PATH: '',
    AUDIT_PATH: '  ',
    QUEUE_LIMIT: '',
    RETENTION_HOURS: '   ',
  })), {
    workspaceId: 'acme',
    locale: 'uz',
    botToken: 'secret',
    paired: true,
    chatId: -100123,
    allowedMemberIds: [42, 91],
    applications: [application],
    queuePath: '/var/lib/glitchtip-companion/state.json',
    auditPath: '/var/lib/glitchtip-companion/audit.jsonl',
    queueLimit: 500,
    retentionHours: 72,
    glitchtipApiBase: 'http://web:8080',
    glitchtipApiToken: '',
    configRevision: 'unversioned',
  })
})

for (const [type, value] of [
  ['number', 72],
  ['object', { private: 'do-not-print-this-value' }],
  ['boolean', true],
]) {
  test(`present ${type} optional env values are invalid instead of defaulted`, () => {
    assert.throws(
      () => readConfig(validEnv({
        COMPANION_LOCALE: value,
        QUEUE_PATH: value,
        AUDIT_PATH: value,
        QUEUE_LIMIT: value,
        RETENTION_HOURS: value,
        GLITCHTIP_API_BASE: value,
        GLITCHTIP_API_TOKEN: value,
        COMPANION_CONFIG_REVISION: value,
      })),
      (error) => {
        for (const name of [
          'COMPANION_LOCALE',
          'QUEUE_PATH',
          'AUDIT_PATH',
          'QUEUE_LIMIT',
          'RETENTION_HOURS',
          'GLITCHTIP_API_BASE',
          'GLITCHTIP_API_TOKEN',
          'COMPANION_CONFIG_REVISION',
        ]) assert.match(error.message, new RegExp(name))
        assert.doesNotMatch(error.message, /do-not-print-this-value|\[object Object\]|true|72/)
        return true
      },
    )
  })
}

test('parses GlitchTip enrichment and configuration revision settings', () => {
  const config = readConfig(validEnv({
    GLITCHTIP_API_BASE: ' https://errors.example.test/glitchtip/// ',
    GLITCHTIP_API_TOKEN: ' gt_0123456789abcdef ',
    COMPANION_CONFIG_REVISION: 'rev-2026.09.23_1',
  }))

  assert.equal(config.glitchtipApiBase, 'https://errors.example.test/glitchtip')
  assert.equal(config.glitchtipApiToken, 'gt_0123456789abcdef')
  assert.equal(config.configRevision, 'rev-2026.09.23_1')
  assert.equal(readConfig(validEnv({ GLITCHTIP_API_BASE: 'http://web:8080/' })).glitchtipApiBase, 'http://web:8080')
})

test('blank enrichment and revision settings keep their defaults', () => {
  const config = readConfig(validEnv({
    GLITCHTIP_API_BASE: '  ',
    GLITCHTIP_API_TOKEN: '',
    COMPANION_CONFIG_REVISION: ' ',
  }))

  assert.equal(config.glitchtipApiBase, 'http://web:8080')
  assert.equal(config.glitchtipApiToken, '')
  assert.equal(config.configRevision, 'unversioned')
})

for (const apiBase of [
  'web:8080',
  '/api',
  'http:web',
  'ftp://errors.example.test',
  'javascript:alert(1)',
  'https://user:do-not-print-this-value@errors.example.test',
  'https://errors.example.test/?token=do-not-print-this-value',
  'https://errors.example.test/#fragment',
  'not a url',
]) {
  test(`rejects GlitchTip API base ${JSON.stringify(apiBase)}`, () => {
    assert.throws(
      () => readConfig(validEnv({ GLITCHTIP_API_BASE: apiBase })),
      (error) => {
        assert.match(error.message, /GLITCHTIP_API_BASE/)
        assert.doesNotMatch(error.message, /do-not-print-this-value/)
        return true
      },
    )
  })
}

for (const apiToken of ['do-not-print this-value', 'do-not-print\nthis-value', 'do-not-print-thïs-value']) {
  test(`rejects GlitchTip API token ${JSON.stringify(apiToken)} without echoing it`, () => {
    assert.throws(
      () => readConfig(validEnv({ GLITCHTIP_API_TOKEN: apiToken })),
      (error) => {
        assert.match(error.message, /GLITCHTIP_API_TOKEN/)
        assert.doesNotMatch(error.message, /do-not-print/)
        return true
      },
    )
  })
}

for (const revision of ['rev 1', 'rev/1', 'rév', 'r'.repeat(65)]) {
  test(`rejects configuration revision ${JSON.stringify(revision)}`, () => {
    assert.throws(
      () => readConfig(validEnv({ COMPANION_CONFIG_REVISION: revision })),
      /COMPANION_CONFIG_REVISION/,
    )
  })
}

test('lists every invalid field in one redacted error', () => {
  const token = 'do-not-print-this-token'
  const env = validEnv({
    COMPANION_WORKSPACE_ID: '',
    COMPANION_LOCALE: 'de',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHAT_ID: 'public-chat',
    ALLOWED_MEMBER_IDS: '{malformed',
    APPLICATIONS_JSON: token,
    QUEUE_PATH: 'relative.json',
    AUDIT_PATH: 'relative.json',
    QUEUE_LIMIT: '9',
    RETENTION_HOURS: '169',
  })

  assert.throws(
    () => readConfig(env),
    (error) => {
      for (const name of [
        'COMPANION_WORKSPACE_ID',
        'COMPANION_LOCALE',
        'TELEGRAM_BOT_TOKEN',
        'TELEGRAM_CHAT_ID',
        'ALLOWED_MEMBER_IDS',
        'APPLICATIONS_JSON',
        'QUEUE_PATH',
        'AUDIT_PATH',
        'QUEUE_LIMIT',
        'RETENTION_HOURS',
      ]) assert.match(error.message, new RegExp(name))
      assert.doesNotMatch(error.message, new RegExp(token))
      assert.equal(error.message.split('\n').length, 1)
      return true
    },
  )
})

for (const chatId of ['42', '-42', '-100', '-100.5', '']) {
  test(`rejects non-supergroup chat id ${JSON.stringify(chatId)}`, () => {
    assert.throws(() => readConfig(validEnv({ TELEGRAM_CHAT_ID: chatId })), /TELEGRAM_CHAT_ID/)
  })
}

test('rejects duplicate application identifiers and topic identifiers', () => {
  const applications = [
    application,
    { ...application, name: 'Duplicate ID', projectSlug: 'other-api', topicId: 45 },
    { ...application, id: 'other-api', name: 'Duplicate topic', projectSlug: 'third-api' },
  ]

  assert.throws(
    () => readConfig(validEnv({ APPLICATIONS_JSON: JSON.stringify(applications) })),
    /APPLICATIONS_JSON/,
  )
})

test('rejects applications without at least one environment', () => {
  assert.throws(
    () => readConfig(validEnv({
      APPLICATIONS_JSON: JSON.stringify([{ ...application, environments: [] }]),
    })),
    /APPLICATIONS_JSON/,
  )
})

for (const queueLimit of ['9', '5001', '10.5', 'not-a-number']) {
  test(`rejects queue limit ${queueLimit}`, () => {
    assert.throws(() => readConfig(validEnv({ QUEUE_LIMIT: queueLimit })), /QUEUE_LIMIT/)
  })
}

for (const retentionHours of ['0', '169', '1.5', 'not-a-number']) {
  test(`rejects retention hours ${retentionHours}`, () => {
    assert.throws(() => readConfig(validEnv({ RETENTION_HOURS: retentionHours })), /RETENTION_HOURS/)
  })
}

test('allows only uz, ru, and en locales', () => {
  for (const locale of ['uz', 'ru', 'en']) {
    assert.equal(readConfig(validEnv({ COMPANION_LOCALE: locale })).locale, locale)
  }
  assert.throws(() => readConfig(validEnv({ COMPANION_LOCALE: 'UZ' })), /COMPANION_LOCALE/)
})

test('looks up applications by exact project slug', () => {
  const config = readConfig(validEnv())

  assert.equal(applicationForProject(config, 'billing-api'), config.applications[0])
  assert.equal(applicationForProject(config, 'Billing-API'), null)
  assert.equal(applicationForProject(config, 'unknown'), null)
})

const named = { ...application, projectName: 'Billing API' }
const storefront = { id: 'storefront', name: 'Storefront', projectSlug: 'storefront', topicId: 45, environments: ['production'] }

test('parses an optional GlitchTip project name and omits it when absent', () => {
  const config = readConfig(validEnv({ APPLICATIONS_JSON: JSON.stringify([named, storefront]) }))

  assert.deepEqual(config.applications, [named, storefront])
  assert.equal(Object.hasOwn(config.applications[1], 'projectName'), false)
  assert.equal(Object.hasOwn(readConfig(validEnv()).applications[0], 'projectName'), false)
})

for (const projectName of ['', '   ', ' Billing API', 'Billing API ', null, 42, ['Billing API'], { name: 'Billing API' }]) {
  test(`rejects the project name ${JSON.stringify(projectName)}`, () => {
    assert.throws(
      () => readConfig(validEnv({ APPLICATIONS_JSON: JSON.stringify([{ ...application, projectName }]) })),
      /APPLICATIONS_JSON/,
    )
  })
}

test('rejects a project name shared by two applications', () => {
  assert.throws(
    () => readConfig(validEnv({
      APPLICATIONS_JSON: JSON.stringify([named, { ...storefront, projectName: 'Billing API' }]),
    })),
    /APPLICATIONS_JSON/,
  )
})

test('routes by the enriched issue slug, then the webhook project as a slug, then as a name', () => {
  const web = { id: 'web', name: 'Web', projectSlug: 'web', topicId: 46, environments: ['production'] }
  const api = { id: 'api', name: 'API', projectSlug: 'api', projectName: 'web', topicId: 47, environments: ['production'] }
  const config = readConfig(validEnv({ APPLICATIONS_JSON: JSON.stringify([named, storefront, web, api]) }))
  const [billing, store, webApp, apiApp] = config.applications

  // (a) The enriched slug decides, whatever the webhook's Project field says.
  assert.equal(applicationForEvent(config, { issueProjectSlug: 'storefront', payloadProject: 'Billing API' }), store)
  // (b) The Project field matched exactly against a slug.
  assert.equal(applicationForEvent(config, { payloadProject: 'storefront' }), store)
  assert.equal(applicationForEvent(config, { issueProjectSlug: '', payloadProject: 'billing-api' }), billing)
  // (c) Then against a configured project name, which is what GlitchTip actually sends.
  assert.equal(applicationForEvent(config, { payloadProject: 'Billing API' }), billing)
  // A slug match comes before a name match.
  assert.equal(applicationForEvent(config, { payloadProject: 'web' }), webApp)
  assert.notEqual(applicationForEvent(config, { payloadProject: 'web' }), apiApp)
})

test('routing matches exactly and refuses what it cannot place', () => {
  const config = readConfig(validEnv({ APPLICATIONS_JSON: JSON.stringify([named, storefront]) }))

  for (const payloadProject of ['billing api', 'BILLING API', ' Billing API', 'Billing-API', 'Storefront', '', undefined, 42]) {
    assert.equal(applicationForEvent(config, { payloadProject }), null, JSON.stringify(payloadProject))
  }
  // An enriched slug that no application watches is not rescued by a same-named webhook project.
  assert.equal(applicationForEvent(config, { issueProjectSlug: 'billing-api-v2', payloadProject: 'Billing API' }), null)
  assert.equal(applicationForEvent(config, { issueProjectSlug: 42, payloadProject: 'Billing API' }), config.applications[0])
  assert.equal(applicationForEvent(config), null)
  assert.equal(applicationForEvent(null, { payloadProject: 'Billing API' }), null)
})

// The relay is deployed before Telegram pairing, so the three pairing fields may be blank together.
const PAIRING_FIELDS = ['TELEGRAM_CHAT_ID', 'ALLOWED_MEMBER_IDS', 'APPLICATIONS_JSON']

for (const blank of [undefined, '', '   ']) {
  test(`the pairing fields blank together (${JSON.stringify(blank)}) yield an unpaired relay`, () => {
    const env = validEnv()
    for (const name of PAIRING_FIELDS) {
      if (blank === undefined) delete env[name]
      else env[name] = blank
    }

    assert.deepEqual(readConfig(env), {
      workspaceId: 'acme',
      locale: 'uz',
      botToken: 'secret',
      paired: false,
      chatId: null,
      allowedMemberIds: [],
      applications: [],
      queuePath: '/var/lib/glitchtip-companion/state.json',
      auditPath: '/var/lib/glitchtip-companion/audit.jsonl',
      queueLimit: 500,
      retentionHours: 72,
      glitchtipApiBase: 'http://web:8080',
      glitchtipApiToken: '',
      configRevision: 'unversioned',
    })
  })
}

test('an unpaired relay still requires every other field', () => {
  assert.throws(
    () => readConfig(validEnv({
      TELEGRAM_CHAT_ID: '',
      ALLOWED_MEMBER_IDS: '',
      APPLICATIONS_JSON: '',
      COMPANION_WORKSPACE_ID: '',
      TELEGRAM_BOT_TOKEN: '',
    })),
    (error) => {
      assert.match(error.message, /COMPANION_WORKSPACE_ID/)
      assert.match(error.message, /TELEGRAM_BOT_TOKEN/)
      for (const name of PAIRING_FIELDS) assert.doesNotMatch(error.message, new RegExp(name))
      return true
    },
  )
})

test('a paired relay may have no applications yet', () => {
  const config = readConfig(validEnv({ APPLICATIONS_JSON: '[]' }))

  assert.equal(config.paired, true)
  assert.equal(config.chatId, -100123)
  assert.deepEqual(config.allowedMemberIds, [42, 91])
  assert.deepEqual(config.applications, [])
})

test('a paired relay still requires a non-empty member allowlist', () => {
  for (const members of ['[]', '', '  ']) {
    assert.throws(
      () => readConfig(validEnv({ ALLOWED_MEMBER_IDS: members, APPLICATIONS_JSON: '[]' })),
      (error) => {
        assert.match(error.message, /ALLOWED_MEMBER_IDS/)
        assert.doesNotMatch(error.message, /TELEGRAM_CHAT_ID|APPLICATIONS_JSON/)
        return true
      },
    )
  }
})

// Every combination with at least one pairing field set and at least one blank is refused, and the
// error names exactly the blank ones.
for (let mask = 1; mask < 7; mask += 1) {
  const present = PAIRING_FIELDS.filter((_, index) => mask & (1 << index))
  const blank = PAIRING_FIELDS.filter((name) => !present.includes(name))
  test(`rejects the partial pairing configuration with only ${present.join(' and ')}`, () => {
    const overrides = Object.fromEntries(blank.map((name) => [name, '']))
    assert.throws(
      () => readConfig(validEnv(overrides)),
      (error) => {
        for (const name of blank) assert.match(error.message, new RegExp(name))
        for (const name of present) assert.doesNotMatch(error.message, new RegExp(name))
        return true
      },
    )
  })
}

test('an empty application list without a chat is a partial configuration', () => {
  assert.throws(
    () => readConfig(validEnv({ TELEGRAM_CHAT_ID: '', ALLOWED_MEMBER_IDS: '', APPLICATIONS_JSON: '[]' })),
    (error) => {
      assert.match(error.message, /TELEGRAM_CHAT_ID/)
      assert.match(error.message, /ALLOWED_MEMBER_IDS/)
      assert.doesNotMatch(error.message, /APPLICATIONS_JSON/)
      return true
    },
  )
})

test('reads the relay port shared by the server and the control commands', () => {
  assert.equal(readPort(undefined), 8090)
  assert.equal(readPort('  '), 8090)
  assert.equal(readPort('9000'), 9000)
  assert.equal(readPort(' 0 '), 0)
  for (const value of ['-1', '65536', '80.5', 'http', '1e3']) assert.equal(readPort(value), null, value)
})
