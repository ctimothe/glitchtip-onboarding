'use strict'

const { createHash } = require('node:crypto')

/** @typedef {'error'|'warning'|'resolved'|'info'|'setup_complete'|'test'} SemanticState */
/**
 * @typedef {Object} NormalizedEvent
 * @property {string} id
 * @property {string} applicationId
 * @property {string} applicationName
 * @property {string} projectSlug
 * @property {string} environment
 * @property {SemanticState} state
 * @property {string} title
 * @property {string} issueId
 * @property {string} issueUrl
 * @property {string} release
 * @property {number|null} eventCount
 * @property {number|null} affectedUsers
 * @property {number|null} windowMinutes
 * @property {number|null} threshold
 * @property {string} firstSeen
 * @property {string} lastSeen
 * @property {number|null} incidentMinutes
 * @property {number|null} quietMinutes
 */

const SEMANTIC_STATES = new Set([
  'error',
  'warning',
  'resolved',
  'info',
  'setup_complete',
  'test',
])

// Producer and GlitchTip event IDs become part of the delivery ID, the callback key input, and
// the audit record, so only short, plain identifiers are trusted. Anything else is ignored.
const SAFE_ID = /^[A-Za-z0-9._-]{1,96}$/
const NUMERIC_ISSUE_ID = /^[0-9]{1,19}$/
// Separate alerts for one issue in later 10-minute windows get separate deliveries.
const ISSUE_BUCKET_MS = 10 * 60 * 1000
// GlitchTip sends an issue's level only as the attachment color: Issue.get_hex_color() in
// apps/issue_events/models.py, passed through by apps/alerts/webhooks.py. Error and fatal share
// one color, and levels without a color (debug, sample) send none.
const LEVEL_BY_COLOR = new Map([
  ['#4b60b4', 'info'],
  ['#e9b949', 'warning'],
  ['#e52b50', 'error'],
])

const stringValue = (value) => value == null ? '' : String(value)

const numberOrNull = (value) => {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const tagMap = (event) => Object.fromEntries(
  (Array.isArray(event && event.tags) ? event.tags : [])
    .filter((tag) => tag && tag.key != null)
    .map((tag) => [String(tag.key), tag.value]),
)

const attachmentOf = (payload) =>
  (Array.isArray(payload && payload.attachments) && payload.attachments[0]) || {}

const webhookField = (payload, names) => {
  const fields = Array.isArray(attachmentOf(payload).fields) ? attachmentOf(payload).fields : []
  const wanted = names.map((name) => String(name).toLowerCase())
  const field = fields.find((item) => wanted.includes(String(item && item.title || '').toLowerCase()))
  return field && field.value != null ? field.value : ''
}

// GlitchTip sends every attachment field value as text; anything else is not trusted as text.
const webhookText = (payload, names) => {
  const value = webhookField(payload, names)
  return typeof value === 'string' ? value : ''
}

/**
 * The webhook's `Project` field exactly as sent, or `''` unless it is text. GlitchTip's own
 * webhooks put the project's display name there, not its slug, so routing matches it against both.
 *
 * @param {Object} payload
 * @returns {string}
 */
const webhookProject = (payload) => webhookText(payload || {}, ['project'])

// GlitchTip's API spells it `eventID` (CamelSchema); the other spellings come from producers.
const ID_KEYS = ['event_id', 'eventID', 'eventId']

const safeIdOf = (source) => {
  if (!source || typeof source !== 'object') return ''
  return ID_KEYS.map((key) => source[key])
    .find((value) => typeof value === 'string' && SAFE_ID.test(value)) || ''
}

const attachmentCount = (payload) =>
  Array.isArray(payload && payload.attachments) ? payload.attachments.length : 0

const normalizeLevel = (value) => {
  const level = stringValue(value).trim().toLowerCase()
  if (level === 'fatal' || level === 'error') return 'error'
  if (level === 'warn' || level === 'warning') return 'warning'
  if (level === 'info') return 'info'
  return ''
}

const colorLevel = (payload) => {
  const { color } = attachmentOf(payload)
  return typeof color === 'string' ? LEVEL_BY_COLOR.get(color) || '' : ''
}

// GlitchTip's issue detail carries the level (IssueSchema.level, the label such as "warning"); its
// latest-event detail has none, so `event.level` only comes from other producers.
const stateOf = (payload, issue, event) => {
  const explicit = stringValue(payload && payload.companion_state).trim().toLowerCase()
  if (SEMANTIC_STATES.has(explicit)) return explicit
  if (stringValue(payload && payload.action).trim().toLowerCase() === 'resolved') return 'resolved'
  const issueLevel = stringValue(issue && issue.level).trim()
  const eventLevel = stringValue(event && event.level).trim()
  const level = normalizeLevel(issueLevel) || normalizeLevel(eventLevel)
  if (level) return level
  // The webhook color stands in for the level only when enrichment supplied none.
  const colored = issueLevel === '' && eventLevel === '' ? colorLevel(payload) : ''
  if (colored) return colored
  const entries = Array.isArray(event && event.entries) ? event.entries : []
  if (entries.some((entry) => entry && entry.type === 'exception')) return 'error'
  return 'info'
}

const issueLink = (payload, issue, event) => {
  const attachment = attachmentOf(payload)
  const candidates = [
    (issue && (issue.permalink || issue.web_url || issue.webUrl)) ||
      '',
    (event && (event.web_url || event.webUrl)) || '',
    attachment.title_link || '',
    (payload && payload.url) || '',
  ]
  for (const candidate of candidates) {
    try {
      const url = new URL(stringValue(candidate))
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
      if (url.username || url.password) continue
      if (!/\/issues\/[^/]+\/?$/.test(url.pathname)) continue
      url.search = ''
      url.hash = ''
      return url.toString()
    } catch {
      continue
    }
  }
  return ''
}

const issueIdOf = (payload, issueUrl, issue) => {
  const explicit = stringValue(issue && (issue.id || issue.issueId || issue.issue_id))
  if (explicit) return explicit
  const linked = stringValue(issueUrl || (payload && payload.url) || attachmentOf(payload).title_link)
  const match = linked.match(/\/issues\/([^/?#]+)/)
  return match ? match[1] : ''
}

const titleOf = (payload, issue, event) => {
  const metadata = (event && event.metadata) || {}
  const metadataTitle = metadata.type
    ? `${stringValue(metadata.type)}${metadata.value ? `: ${stringValue(metadata.value)}` : ''}`
    : ''
  return stringValue(
    (event && event.title) ||
    (issue && issue.title) ||
    attachmentOf(payload).title ||
    (payload && payload.title) ||
    metadataTitle,
  )
}

const stableId = (event) => createHash('sha256')
  .update(JSON.stringify([
    event.applicationId,
    event.projectSlug,
    event.environment,
    event.state,
    event.title,
    event.issueId,
    event.release,
    event.firstSeen,
    event.lastSeen,
  ]))
  .digest('hex')
  .slice(0, 32)

/**
 * Split a webhook into one payload per attachment, since GlitchTip sends one attachment per issue
 * in a multi-issue alert. Each payload keeps the top-level fields and carries a single attachment.
 * A top-level producer ID names one event, so it is dropped when there are several attachments.
 * A payload without attachments is returned whole. At most `limit` attachments are used.
 *
 * @param {Object} payload
 * @param {number} limit
 * @returns {Object[]}
 */
const webhookEvents = (payload, limit) => {
  const attachments = payload && Array.isArray(payload.attachments) ? payload.attachments : []
  if (attachments.length === 0) return [payload]
  const shared = { ...payload }
  if (attachments.length > 1) for (const key of ID_KEYS) delete shared[key]
  return attachments.slice(0, limit).map((attachment) => ({ ...shared, attachments: [attachment] }))
}

const bucketOf = (receivedAt) => Number.isSafeInteger(receivedAt) && receivedAt >= 0
  ? Math.floor(receivedAt / ISSUE_BUCKET_MS)
  : null

/**
 * Convert supported GlitchTip webhook and API shapes into one safe public model.
 *
 * The delivery ID is `<base>:<state>`, so one GlitchTip event still yields separate error and
 * resolved deliveries. `<base>` is the first of: the payload's producer ID
 * (`event_id`/`eventID`/`eventId`, honoured only when the payload has at most one attachment), the
 * enriched latest-event ID (`eventID`, or `eventId`/`event_id`), `issue-<issueId>-<bucket>` for a
 * numeric issue ID, or a digest of the stable fields. IDs outside `^[A-Za-z0-9._-]{1,96}$` are
 * skipped. `<bucket>` is `floor(receivedAt / 600000)`, the receive time's 10-minute window; without
 * a valid `receivedAt` (milliseconds since the epoch) the base is `issue-<issueId>`.
 *
 * @param {{payload?: Object, issue?: Object, event?: Object, application?: Object, receivedAt?: number}} input
 * @returns {NormalizedEvent}
 */
const normalizeEvent = ({ payload = {}, issue = {}, event = {}, application = {}, receivedAt } = {}) => {
  payload = payload || {}
  issue = issue || {}
  event = event || {}
  application = application || {}
  const tags = tagMap(event)
  const state = stateOf(payload, issue, event)
  const issueUrl = issueLink(payload, issue, event)
  const issueId = issueIdOf(payload, issueUrl, issue)
  const projectSlug = stringValue(
    application.projectSlug ||
    (issue.project && (issue.project.slug || issue.project.name)) ||
    webhookProject(payload) ||
    application.id,
  )
  const applicationId = stringValue(application.id || projectSlug)
  const normalized = {
    id: '',
    applicationId,
    applicationName: stringValue(application.name || projectSlug || applicationId),
    projectSlug,
    environment: stringValue(tags.environment || event.environment || payload.environment) ||
      webhookText(payload, ['environment']),
    state,
    title: titleOf(payload, issue, event),
    issueId,
    issueUrl,
    release: stringValue(tags.release || event.release || payload.release) ||
      webhookText(payload, ['release']),
    eventCount: numberOrNull(issue.count ?? payload.eventCount ?? payload.event_count ?? webhookField(payload, ['events', 'event count'])),
    affectedUsers: numberOrNull(issue.userCount ?? issue.user_count ?? payload.affectedUsers ?? payload.affected_users ?? webhookField(payload, ['affected users', 'users'])),
    windowMinutes: numberOrNull(payload.windowMinutes ?? payload.window_minutes ?? webhookField(payload, ['window', 'window minutes'])),
    threshold: numberOrNull(payload.threshold ?? webhookField(payload, ['threshold'])),
    firstSeen: stringValue(issue.firstSeen || issue.first_seen || event.firstSeen || event.first_seen || payload.firstSeen || payload.first_seen),
    lastSeen: stringValue(issue.lastSeen || issue.last_seen || event.lastSeen || event.last_seen || payload.lastSeen || payload.last_seen),
    incidentMinutes: numberOrNull(payload.incidentMinutes ?? payload.incident_minutes),
    quietMinutes: numberOrNull(payload.quietMinutes ?? payload.quiet_minutes),
  }

  const bucket = bucketOf(receivedAt)
  const issueBase = bucket === null ? `issue-${issueId}` : `issue-${issueId}-${bucket}`
  const producerId = attachmentCount(payload) <= 1 ? safeIdOf(payload) : ''
  const base = producerId ||
    safeIdOf(event) ||
    (NUMERIC_ISSUE_ID.test(issueId) ? issueBase : stableId(normalized))
  normalized.id = `${base}:${state}`
  return normalized
}

const incidentReference = (event) =>
  `gt:${stringValue(event && (event.projectSlug || event.applicationId)) || 'unknown'}:${stringValue(event && event.issueId) || 'unknown'}`

module.exports = {
  incidentReference,
  normalizeEvent,
  webhookEvents,
  webhookProject,
}
