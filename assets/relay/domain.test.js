'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeEvent, incidentReference, webhookEvents, webhookProject } = require('./domain')

// The body GlitchTip's generic webhook recipient POSTs: send_issue_as_webhook() in
// apps/alerts/webhooks.py (gitlab.com/glitchtip/glitchtip-backend, master at 854d2fa0, file last
// changed in 5c60274e). It carries the project NAME, no top-level environment, and no event ID.
const glitchtipWebhook = () => structuredClone(require('./fixtures/glitchtip-webhook.json'))
// Companion's own synthetic events: the same attachment fields plus a state and a producer ID.
const companionEvent = () => structuredClone(require('./fixtures/companion-event.json'))
// GlitchTip's enrichment responses as its API serializes them (apps/issue_events/schema.py):
// GET /api/0/issues/<id>/ is IssueDetailSchema, with `level` as the label, `count` as a string,
// `userCount` as a number and `project.slug`; GET /api/0/issues/<id>/events/latest/ is
// IssueEventDetailSchema, a CamelSchema with `eventID` and no `level`.
const enrichedIssue = (overrides = {}) => ({ ...structuredClone(require('./fixtures/glitchtip-issue.json')), ...overrides })
const latestEvent = (overrides = {}) => ({ ...structuredClone(require('./fixtures/glitchtip-latest-event.json')), ...overrides })
const LATEST_ID = '4b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e'

const application = { id: 'billing-api', name: 'Billing API', projectSlug: 'billing-api' }
const CANARY = 'id-canary-3b9e'
const TEN_MINUTES = 10 * 60 * 1000
// 10:00 UTC starts a 10-minute bucket.
const BUCKET_START = Date.UTC(2026, 8, 23, 10)
const BUCKET = BUCKET_START / TEN_MINUTES

for (const [input, expected] of [
  [{ issue: { level: 'fatal' } }, 'error'],
  [{ issue: { level: 'warning' } }, 'warning'],
  [{ issue: { level: 'info' } }, 'info'],
  [{ event: { level: 'fatal' } }, 'error'],
  [{ event: { level: 'warning' } }, 'warning'],
  [{ payload: { action: 'resolved' } }, 'resolved'],
  [{ event: { level: 'info' } }, 'info'],
  [{ payload: { companion_state: 'setup_complete' } }, 'setup_complete'],
  [{ payload: { companion_state: 'test' } }, 'test'],
]) {
  test(`normalizes ${expected}`, () => {
    assert.equal(normalizeEvent({ ...input, application }).state, expected)
  })
}

test('incident references identify but do not authorize', () => {
  const value = normalizeEvent({
    payload: { url: 'https://errors.example.test/issues/1842/' },
    application,
  })
  assert.equal(incidentReference(value), 'gt:billing-api:1842')
})

test('normalizes the public event shape from webhook and API data', () => {
  const value = normalizeEvent({
    payload: {
      threshold: '12',
      window_minutes: '15',
      attachments: [{
        title: 'Webhook fallback',
        title_link: 'https://errors.example.test/issues/1842/?notification=private#fragment',
      }],
    },
    issue: enrichedIssue({ level: 'warning' }),
    event: latestEvent({ title: 'Payment authorization slow' }),
    application,
  })

  assert.deepEqual(value, {
    id: `${LATEST_ID}:warning`,
    applicationId: 'billing-api',
    applicationName: 'Billing API',
    projectSlug: 'billing-api',
    environment: 'production',
    state: 'warning',
    title: 'Payment authorization slow',
    issueId: '1842',
    issueUrl: 'https://errors.example.test/billing-api/issues/1842',
    release: 'a81c2f7',
    eventCount: 47,
    affectedUsers: 18,
    windowMinutes: 15,
    threshold: 12,
    firstSeen: '2026-09-23T09:32:00Z',
    lastSeen: '2026-09-23T09:44:00Z',
    incidentMinutes: null,
    quietMinutes: null,
  })
})

test('the real latest-event response carries no level, so the issue level decides the state', () => {
  assert.equal(Object.hasOwn(latestEvent(), 'level'), false)
  const payload = glitchtipWebhook()
  // GlitchTip sends no color for warnings loaded from its database.
  delete payload.attachments[0].color

  const value = normalizeEvent({ payload, issue: enrichedIssue({ level: 'warning' }), event: latestEvent(), application })

  assert.equal(value.state, 'warning')
  assert.equal(value.id, `${LATEST_ID}:warning`)
})

test('reads the level from the issue, then the event, then the color, then the exception entry', () => {
  const payload = glitchtipWebhook()
  const noColor = glitchtipWebhook()
  delete noColor.attachments[0].color
  const state = (input) => normalizeEvent({ application, ...input }).state

  assert.equal(state({ payload, issue: enrichedIssue({ level: 'warning' }), event: { level: 'fatal' } }), 'warning')
  assert.equal(state({ payload, issue: enrichedIssue({ level: 'info' }), event: latestEvent() }), 'info')
  assert.equal(state({ payload: noColor, issue: { id: '1842' }, event: { level: 'warning' } }), 'warning')
  assert.equal(state({ payload, issue: { id: '1842' }, event: latestEvent() }), 'error')
  assert.equal(state({ payload: noColor, issue: { id: '1842' }, event: latestEvent() }), 'error')
  assert.equal(state({ payload: noColor, issue: { id: '1842' }, event: latestEvent({ entries: [] }) }), 'info')
})

test('reads the enriched event ID whether GlitchTip spells it eventID or eventId', () => {
  const { eventID, ...withoutId } = latestEvent()
  assert.equal(normalizeEvent({ payload: glitchtipWebhook(), issue: enrichedIssue(), event: latestEvent(), application }).id, `${eventID}:error`)
  assert.equal(normalizeEvent({ payload: glitchtipWebhook(), issue: enrichedIssue(), event: { ...withoutId, eventId: 'camel-id' }, application }).id, 'camel-id:error')
})

test('state precedence and exception fallback are deterministic', () => {
  assert.equal(normalizeEvent({
    payload: { companion_state: 'test', action: 'resolved' },
    event: { level: 'fatal' },
    application,
  }).state, 'test')
  assert.equal(normalizeEvent({
    payload: { action: 'resolved' },
    event: { level: 'fatal' },
    application,
  }).state, 'resolved')
  assert.equal(normalizeEvent({
    event: { entries: [{ type: 'exception' }] },
    application,
  }).state, 'error')
  assert.equal(normalizeEvent({ application }).state, 'info')
})

test('uses stable identifier fallbacks and never returns undefined fields', () => {
  const issueValue = normalizeEvent({
    payload: { action: 'resolved', url: 'https://errors.example.test/issues/1842/' },
    application,
  })
  const hashValue = normalizeEvent({
    payload: { title: 'No identifiers' },
    application,
  })

  assert.equal(issueValue.id, 'issue-1842:resolved')
  assert.match(hashValue.id, /^[a-f0-9]{32}:info$/)
  assert.deepEqual(hashValue, normalizeEvent({
    payload: { title: 'No identifiers' },
    application,
  }))
  assert.equal(Object.values(hashValue).includes(undefined), false)
})

test('rejects unsafe issue links without exposing query data', () => {
  const value = normalizeEvent({
    payload: { url: 'javascript:alert(document.cookie)' },
    application,
  })

  assert.equal(value.issueUrl, '')
  assert.equal(value.issueId, '')
  assert.equal(incidentReference(value), 'gt:billing-api:unknown')
})

test('optional API responses may be null', () => {
  const value = normalizeEvent({
    payload: null,
    issue: null,
    event: null,
    application,
  })

  assert.equal(value.state, 'info')
  assert.equal(value.applicationId, 'billing-api')
  assert.equal(Object.values(value).includes(undefined), false)
})

test('uses the first safe issue deep link instead of an unsafe preferred candidate', () => {
  const value = normalizeEvent({
    payload: { url: 'https://errors.example.test/issues/1842/?secret=value' },
    issue: { permalink: 'javascript:alert(1)' },
    application,
  })

  assert.equal(value.issueUrl, 'https://errors.example.test/issues/1842/')
})

test('rejects credential-bearing issue links and continues to a safe candidate', () => {
  const fallback = normalizeEvent({
    payload: { url: 'https://errors.example.test/issues/1842/?secret=value' },
    issue: { permalink: 'https://token:password@errors.example.test/issues/1842/' },
    application,
  })
  const rejected = normalizeEvent({
    payload: { url: 'https://token:password@errors.example.test/issues/1842/' },
    application,
  })

  assert.equal(fallback.issueUrl, 'https://errors.example.test/issues/1842/')
  assert.equal(rejected.issueUrl, '')
})

test('reads a real GlitchTip webhook without API enrichment', () => {
  const payload = glitchtipWebhook()
  const value = normalizeEvent({ payload })

  assert.equal(value.environment, 'production')
  assert.equal(value.release, 'a81c2f7')
  assert.equal(value.title, 'OperationalError: database unavailable')
  assert.equal(value.issueId, '1842')
  assert.equal(value.issueUrl, 'https://errors.example.test/acme/issues/1842')
  assert.equal(value.state, 'error')
  assert.equal(value.id, 'issue-1842:error')
  assert.equal(webhookProject(payload), 'Billing API')
  assert.equal(normalizeEvent({ payload, application }).applicationId, 'billing-api')
  assert.equal(normalizeEvent({ payload, application }).environment, 'production')
})

test('matches webhook field titles case-insensitively and reads only text values', () => {
  const payload = glitchtipWebhook()
  payload.attachments[0].fields = [
    { title: 'PROJECT', value: 'Billing API', short: true },
    { title: 'environment', value: 'staging', short: true },
    { title: 'rElEaSe', value: 'b92d3e8', short: false },
  ]
  const value = normalizeEvent({ payload, application })
  assert.equal(value.environment, 'staging')
  assert.equal(value.release, 'b92d3e8')
  assert.equal(webhookProject(payload), 'Billing API')

  payload.attachments[0].fields = [
    { title: 'Project', value: { name: 'Billing API' } },
    { title: 'Environment', value: ['production'] },
    { title: 'Release', value: 7 },
  ]
  const odd = normalizeEvent({ payload, application })
  assert.equal(odd.environment, '')
  assert.equal(odd.release, '')
  assert.equal(webhookProject(payload), '')
  assert.equal(webhookProject(null), '')
  assert.equal(webhookProject({ attachments: 'none' }), '')
})

test('the project field is exposed exactly as GlitchTip sent it', () => {
  const payload = glitchtipWebhook()
  payload.attachments[0].fields[0].value = ' Billing API '
  assert.equal(webhookProject(payload), ' Billing API ')
})

test('event tags and API fields take precedence over webhook attachment fields', () => {
  const value = normalizeEvent({
    payload: glitchtipWebhook(),
    event: { tags: [{ key: 'environment', value: 'canary' }, { key: 'release', value: 'c03f4a9' }] },
    application,
  })

  assert.equal(value.environment, 'canary')
  assert.equal(value.release, 'c03f4a9')
})

test('a synthetic Companion event keeps its producer ID and state', () => {
  const payload = companionEvent()
  const value = normalizeEvent({ payload })

  assert.equal(value.id, 'test-5f0c2a9e41d7b388:test')
  assert.equal(value.state, 'test')
  assert.equal(value.environment, 'production')
  assert.equal(value.projectSlug, 'billing-api')
  assert.equal(webhookProject(payload), 'billing-api')
})

test('delivery IDs combine the first valid identity with the semantic state', () => {
  const latest = latestEvent()
  const issue = enrichedIssue()

  assert.equal(normalizeEvent({ payload: { event_id: 'producer-1' }, event: latest, issue, application }).id, 'producer-1:error')
  assert.equal(normalizeEvent({ payload: { eventID: 'producer.2' }, event: latest, issue, application }).id, 'producer.2:error')
  assert.equal(normalizeEvent({ payload: { eventId: 'producer_3' }, event: latest, issue, application }).id, 'producer_3:error')
  assert.equal(normalizeEvent({ payload: glitchtipWebhook(), event: latest, issue, application }).id, `${latest.eventID}:error`)
  assert.equal(normalizeEvent({ payload: glitchtipWebhook(), issue: { id: '1842' }, application }).id, 'issue-1842:error')
})

test('the same latest event yields a distinct delivery ID for each state', () => {
  const latest = latestEvent()
  const issue = enrichedIssue()
  const error = normalizeEvent({ payload: glitchtipWebhook(), issue, event: latest, application })
  const resolved = normalizeEvent({ payload: { ...glitchtipWebhook(), action: 'resolved' }, issue, event: latest, application })

  assert.equal(error.id, `${latest.eventID}:error`)
  assert.equal(resolved.id, `${latest.eventID}:resolved`)
})

test('producer and enriched IDs outside the safe pattern are skipped and never echoed', () => {
  const latest = latestEvent()
  for (const unsafe of [
    `${CANARY} with spaces`,
    `${CANARY}/../../etc`,
    `${CANARY}<b>`,
    `${CANARY}:error`,
    `${CANARY}${'x'.repeat(97 - CANARY.length)}`,
    '',
  ]) {
    const value = normalizeEvent({ payload: { ...glitchtipWebhook(), event_id: unsafe }, event: latest, application })
    assert.equal(value.id, `${latest.eventID}:error`, JSON.stringify(unsafe))
  }
  for (const unsafe of [12345, ['producer-1'], { id: 'producer-1' }, true]) {
    const value = normalizeEvent({ payload: { ...glitchtipWebhook(), event_id: unsafe }, event: latest, application })
    assert.equal(value.id, `${latest.eventID}:error`, JSON.stringify(unsafe))
  }

  const unsafeEvent = normalizeEvent({
    payload: { ...glitchtipWebhook(), eventId: `${CANARY}\n` },
    issue: enrichedIssue({ level: 'warning' }),
    event: latestEvent({ eventID: `${CANARY} evt` }),
    application,
  })
  assert.equal(unsafeEvent.id, 'issue-1842:warning')
  assert.doesNotMatch(JSON.stringify(unsafeEvent), new RegExp(CANARY))
})

test('the ID pattern admits exactly 96 safe characters', () => {
  const longest = 'a'.repeat(96)
  assert.equal(normalizeEvent({ payload: { event_id: longest }, application }).id, `${longest}:info`)
  assert.match(normalizeEvent({ payload: { event_id: `${longest}a` }, application }).id, /^[a-f0-9]{32}:info$/)
})

test('non-numeric issue IDs fall back to a digest of the stable fields', () => {
  const payload = glitchtipWebhook()
  payload.attachments[0].title_link = 'https://errors.example.test/acme/issues/GT-1842'
  const value = normalizeEvent({ payload, application })

  assert.equal(value.issueId, 'GT-1842')
  assert.match(value.id, /^[a-f0-9]{32}:error$/)
  assert.equal(value.id, normalizeEvent({ payload: structuredClone(payload), application }).id)
  payload.attachments[0].title = 'A different failure'
  assert.notEqual(normalizeEvent({ payload, application }).id, value.id)
})

// Issue.get_hex_color() in GlitchTip's apps/issue_events/models.py, which apps/alerts/webhooks.py
// sends as the attachment color: info #4b60b4, warning #e9b949, error and fatal #e52b50.
for (const [color, expected] of [
  ['#e52b50', 'error'],
  ['#e9b949', 'warning'],
  ['#4b60b4', 'info'],
  ['#E52B50', 'info'],
  ['#ffffff', 'info'],
  ['', 'info'],
  [null, 'info'],
  [0xe52b50, 'info'],
]) {
  test(`maps the webhook color ${JSON.stringify(color)} to ${expected} without enrichment`, () => {
    const payload = glitchtipWebhook()
    if (color === null) delete payload.attachments[0].color
    else payload.attachments[0].color = color
    assert.equal(normalizeEvent({ payload, application }).state, expected)
  })
}

test('the webhook color is used only when neither the enriched issue nor the event has a level', () => {
  const payload = glitchtipWebhook()
  assert.equal(normalizeEvent({ payload, issue: { level: 'warning' }, application }).state, 'warning')
  assert.equal(normalizeEvent({ payload, event: { level: 'warning' }, application }).state, 'warning')
  assert.equal(normalizeEvent({ payload, event: { level: 'info' }, application }).state, 'info')
  // A level GlitchTip sent but that has no semantic state is still the level.
  assert.equal(normalizeEvent({ payload, issue: { level: 'debug' }, application }).state, 'info')
  assert.equal(normalizeEvent({ payload, event: { level: 'debug' }, application }).state, 'info')
  assert.equal(normalizeEvent({ payload, event: { eventID: 'e1' }, application }).state, 'error')
  assert.equal(normalizeEvent({ payload: { ...payload, action: 'resolved' }, application }).state, 'resolved')
  assert.equal(normalizeEvent({ payload: { ...payload, companion_state: 'test' }, application }).state, 'test')
})

test('an issue-based ID carries the 10-minute bucket of the receive time', () => {
  const idAt = (receivedAt) => normalizeEvent({ payload: glitchtipWebhook(), application, receivedAt }).id

  assert.equal(idAt(BUCKET_START - 1), `issue-1842-${BUCKET - 1}:error`)
  assert.equal(idAt(BUCKET_START), `issue-1842-${BUCKET}:error`)
  assert.equal(idAt(BUCKET_START + TEN_MINUTES - 1), `issue-1842-${BUCKET}:error`)
  assert.equal(idAt(BUCKET_START + TEN_MINUTES), `issue-1842-${BUCKET + 1}:error`)
  assert.equal(idAt(0), 'issue-1842-0:error')
})

test('the bucket applies only to issue-based IDs with a valid receive time', () => {
  const latest = latestEvent()
  const receivedAt = BUCKET_START

  assert.equal(normalizeEvent({ payload: { ...glitchtipWebhook(), event_id: 'producer-1' }, application, receivedAt }).id, 'producer-1:error')
  assert.equal(normalizeEvent({ payload: glitchtipWebhook(), event: latest, application, receivedAt }).id, `${latest.eventID}:error`)
  const unnumbered = glitchtipWebhook()
  unnumbered.attachments[0].title_link = 'https://errors.example.test/acme/issues/GT-1842'
  assert.match(normalizeEvent({ payload: unnumbered, application, receivedAt }).id, /^[a-f0-9]{32}:error$/)
  for (const invalid of [undefined, null, -1, 1.5, Number.NaN, '1790000000000']) {
    assert.equal(normalizeEvent({ payload: glitchtipWebhook(), application, receivedAt: invalid }).id, 'issue-1842:error', String(invalid))
  }
})

test('splits a multi-issue webhook into one payload per attachment', () => {
  const payload = glitchtipWebhook()
  payload.text = 'GlitchTip Alert (3 issues)'
  const second = structuredClone(payload.attachments[0])
  second.title_link = 'https://errors.example.test/acme/issues/1843'
  payload.attachments.push(second, null)

  const events = webhookEvents(payload, 50)

  assert.equal(events.length, 3)
  for (const [index, event] of events.entries()) {
    assert.equal(event.text, 'GlitchTip Alert (3 issues)')
    assert.deepEqual(event.attachments, [payload.attachments[index]])
  }
  assert.deepEqual(events.map((event) => normalizeEvent({ payload: event }).issueId), ['1842', '1843', ''])
  assert.equal(payload.attachments.length, 3)
})

test('keeps a payload without attachments whole and caps the attachments it splits', () => {
  const synthetic = { companion_state: 'test', event_id: 'test-1' }
  assert.deepEqual(webhookEvents(synthetic, 50), [synthetic])
  assert.deepEqual(webhookEvents({ ...synthetic, attachments: [] }, 50), [{ ...synthetic, attachments: [] }])
  assert.deepEqual(webhookEvents({ ...synthetic, attachments: 'none' }, 50), [{ ...synthetic, attachments: 'none' }])

  const many = { attachments: Array.from({ length: 60 }, (_, index) => ({ title: `issue ${index}` })) }
  const events = webhookEvents(many, 50)
  assert.equal(events.length, 50)
  assert.equal(events[49].attachments[0].title, 'issue 49')
})

test('a top-level producer ID is honoured only when the payload has at most one attachment', () => {
  const single = { ...glitchtipWebhook(), event_id: 'producer-1' }
  assert.equal(normalizeEvent({ payload: single, application }).id, 'producer-1:error')
  assert.equal(normalizeEvent({ payload: { event_id: 'producer-1' }, application }).id, 'producer-1:info')

  const multi = { ...glitchtipWebhook(), event_id: 'producer-1', eventID: 'producer-2', eventId: 'producer-3' }
  const second = structuredClone(multi.attachments[0])
  second.title_link = 'https://errors.example.test/acme/issues/1843'
  multi.attachments.push(second)

  assert.equal(normalizeEvent({ payload: multi, application }).id, 'issue-1842:error')
  const split = webhookEvents(multi, 50)
  assert.deepEqual(split.map((event) => normalizeEvent({ payload: event, application }).id), ['issue-1842:error', 'issue-1843:error'])
  for (const event of split) {
    for (const key of ['event_id', 'eventID', 'eventId']) assert.equal(Object.hasOwn(event, key), false, key)
  }
  assert.equal(webhookEvents(single, 50)[0].event_id, 'producer-1')
})
