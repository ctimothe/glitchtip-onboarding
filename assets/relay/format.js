'use strict'

const { normalizeEvent } = require('./domain')
const en = require('./locales/en')
const ru = require('./locales/ru')
const uz = require('./locales/uz')

const MAX_MESSAGE_LENGTH = 4096
const LOCALES = { en, ru, uz }
const STATES = new Set(['error', 'warning', 'resolved', 'info', 'setup_complete', 'test'])

// Telegram rejects oversized messages and malformed partial HTML. Only complete
// lines are retained so clipping cannot split a tag or an escaped entity.
const clipMessage = (text) => {
  if (text.length <= MAX_MESSAGE_LENGTH) return text
  const marker = '\n…'
  const budget = MAX_MESSAGE_LENGTH - marker.length
  let result = ''
  for (const line of text.split('\n')) {
    const next = result ? `${result}\n${line}` : line
    if (next.length > budget) break
    result = next
  }
  return result ? result + marker : '…'
}

const clip = (value, length) => {
  const text = String(value == null ? '' : value)
  return text.length > length ? text.slice(0, length - 1) + '…' : text
}

// Control characters and bidi overrides in untrusted event text are dropped before escaping.
const UNSAFE_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g

const escapeHtml = (value) => String(value == null ? '' : value)
  .replace(UNSAFE_CHARACTERS, '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

const interpolate = (template, values) => String(template).replace(
  /\{([a-zA-Z]+)\}/g,
  (_, key) => values[key] == null ? '' : String(values[key]),
)

const safeNumber = (value) => {
  const number = Number(value)
  return value == null || value === '' || !Number.isFinite(number) ? null : number
}

const safeIssueUrl = (value) => {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    if (url.username || url.password) return ''
    if (!/\/issues\/[^/]+\/?$/.test(url.pathname)) return ''
    url.search = ''
    url.hash = ''
    return clip(url.toString(), 500)
  } catch {
    return ''
  }
}

const timeLabel = (value) => {
  const text = clip(value, 80)
  if (!text) return ''
  const isoTime = text.match(/T(\d{2}:\d{2})/)
  return isoTime ? isoTime[1] : text
}

const eventAction = (state, messages) => {
  if (state === 'error' || state === 'warning') {
    return { text: messages.actionBrief, kind: 'brief' }
  }
  if (state === 'resolved') {
    return { text: messages.actionRecovery, kind: 'recovery' }
  }
  return null
}

const stateLabel = (state, messages) => ({
  error: messages.stateError,
  warning: messages.stateWarning,
  resolved: messages.stateResolved,
  info: messages.stateInfo,
  setup_complete: messages.stateSetupComplete,
  test: messages.stateTest,
})[state]

const defaultTitle = (state, messages) => ({
  error: messages.defaultErrorTitle,
  warning: messages.defaultWarningTitle,
  resolved: messages.defaultResolvedTitle,
  info: messages.defaultInfoTitle,
  setup_complete: messages.defaultSetupCompleteTitle,
  test: messages.defaultTestTitle,
})[state]

const impactLine = (event, state, messages) => {
  const users = safeNumber(event.affectedUsers)
  const events = safeNumber(event.eventCount)
  const window = safeNumber(event.windowMinutes)
  const threshold = safeNumber(event.threshold)
  const affectedUsers = users == null ? '' : interpolate(messages.affectedUsers, { users })
  const eventCount = events == null
    ? ''
    : interpolate(window == null ? messages.events : messages.eventsInWindow, { events, window })

  if (state === 'error') return [affectedUsers, eventCount].filter(Boolean).join(' · ')
  if (state === 'warning') {
    const measured = events == null ? '' : interpolate(messages.events, { events })
    const thresholdText = threshold == null
      ? ''
      : interpolate(window == null ? messages.threshold : messages.thresholdInWindow, { threshold, window })
    return [measured, thresholdText, affectedUsers].filter(Boolean).join(' · ')
  }
  if (state === 'resolved') {
    const peak = [affectedUsers, events == null ? '' : interpolate(messages.events, { events })]
      .filter(Boolean)
      .join(' · ')
    return peak ? `${messages.peakImpact} ${peak}` : ''
  }
  if (state === 'info') return [affectedUsers, eventCount].filter(Boolean).join(' · ')
  return ''
}

const stateFacts = (event, state, messages) => {
  if (state === 'setup_complete') return [messages.setupVerification]
  if (state === 'test') {
    const elapsed = safeNumber(event.windowMinutes)
    return [[
      messages.testPath,
      elapsed == null ? '' : interpolate(messages.testElapsed, { minutes: elapsed }),
    ].filter(Boolean).join(' · ')]
  }
  if (state === 'resolved') {
    const quiet = safeNumber(event.quietMinutes)
    const incident = safeNumber(event.incidentMinutes)
    const recovery = [
      quiet == null ? '' : interpolate(messages.quietWindow, { minutes: quiet }),
      incident == null ? '' : interpolate(messages.incidentDuration, { minutes: incident }),
    ].filter(Boolean).join(' · ')
    return [recovery, impactLine(event, state, messages)]
  }
  return [impactLine(event, state, messages)]
}

const timingLine = (event, state, messages) => {
  if (state === 'setup_complete' || state === 'test' || state === 'resolved') return ''
  const firstSeen = timeLabel(event.firstSeen)
  const release = clip(event.release, 160)
  return [
    firstSeen ? interpolate(messages.firstSeen, { time: escapeHtml(firstSeen) }) : '',
    release ? interpolate(messages.release, { release: `<code>${escapeHtml(release)}</code>` }) : '',
  ].filter(Boolean).join(' · ')
}

const linkLine = (event, messages) => {
  const url = safeIssueUrl(event.issueUrl)
  const id = clip(event.issueId, 120)
  if (!url || !id) return ''
  const label = interpolate(messages.linkIssue, { id: escapeHtml(id) })
  return `<a href="${escapeHtml(url)}">${label}</a>`
}

const formatMessage = (event = {}, locale = 'uz') => {
  if (!Object.hasOwn(LOCALES, locale)) throw new RangeError(`Unsupported locale: ${locale}`)
  const messages = LOCALES[locale]
  const state = STATES.has(event.state) ? event.state : 'info'
  const application = clip(event.applicationName || event.projectSlug || event.applicationId, 120)
  const environment = clip(event.environment, 120)
  const header = [stateLabel(state, messages), application, environment]
    .filter(Boolean)
    .map(escapeHtml)
    .join(' · ')
  const title = clip(event.title || defaultTitle(state, messages), 600)
  const lines = [
    `<b>${header}</b>`,
    `<b>${escapeHtml(title)}</b>`,
    ...stateFacts(event, state, messages),
    timingLine(event, state, messages),
    linkLine(event, messages),
  ].filter((line) => line !== '')

  return {
    text: clipMessage(lines.join('\n')),
    action: eventAction(state, messages),
  }
}

const webhookField = (payload, pattern) => {
  const attachment = (Array.isArray(payload && payload.attachments) && payload.attachments[0]) || {}
  const fields = Array.isArray(attachment.fields) ? attachment.fields : []
  const field = fields.find((item) => pattern.test(String(item && item.title || '')))
  return field && field.value != null ? String(field.value) : ''
}

const normalizeLegacyEnriched = (projectSlug, issue, event, link) => event
  ? normalizeEvent({
      payload: { url: link },
      issue,
      event,
      application: { id: projectSlug, name: projectSlug, projectSlug },
    })
  : null

const normalizeLegacySummary = (projectSlug, payload = {}) => {
  payload = payload || {}
  return normalizeEvent({
    payload,
    event: { level: payload.level || webhookField(payload, /level/i) },
    application: { id: projectSlug, name: projectSlug, projectSlug },
  })
}

const formatLegacyEnriched = (...legacyArgs) => {
  const event = normalizeLegacyEnriched(...legacyArgs)
  return event ? formatMessage(event, 'en').text : null
}

module.exports = {
  escapeHtml,
  formatMessage,
  formatEnriched: formatLegacyEnriched,
  formatSummary: (...legacyArgs) => formatMessage(normalizeLegacySummary(...legacyArgs), 'en').text,
}
