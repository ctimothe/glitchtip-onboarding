'use strict'

const DEFAULT_QUEUE_PATH = '/var/lib/glitchtip-companion/state.json'
const DEFAULT_AUDIT_PATH = '/var/lib/glitchtip-companion/audit.jsonl'
const DEFAULT_QUEUE_LIMIT = 500
const DEFAULT_RETENTION_HOURS = 72
const DEFAULT_GLITCHTIP_API_BASE = 'http://web:8080'
const DEFAULT_CONFIG_REVISION = 'unversioned'
const DEFAULT_PORT = 8090
const LOCALES = new Set(['uz', 'ru', 'en'])
const API_TOKEN = /^[\x21-\x7e]*$/
const CONFIG_REVISION = /^[A-Za-z0-9._-]{1,64}$/

/**
 * `projectName` is the GlitchTip project's display name, which GlitchTip's webhooks send in their
 * `Project` field. It is optional, and the key is absent when it was not configured.
 *
 * @typedef {{ id:string, name:string, projectSlug:string, projectName?:string, topicId:number, environments:string[] }} ApplicationConfig
 */
/**
 * `paired` is false only when TELEGRAM_CHAT_ID, ALLOWED_MEMBER_IDS, and APPLICATIONS_JSON are all
 * blank: the relay is deployed before Telegram pairing and then has no chat, members, or
 * applications. A paired relay may have no applications yet, while its topics are being created.
 *
 * @typedef {{ workspaceId:string, locale:'uz'|'ru'|'en', botToken:string, paired:boolean, chatId:number|null, allowedMemberIds:number[], applications:ApplicationConfig[], queuePath:string, auditPath:string, queueLimit:number, retentionHours:number, glitchtipApiBase:string, glitchtipApiToken:string, configRevision:string }} RelayConfig
 */

const text = (value) => typeof value === 'string' ? value.trim() : ''
const isBlank = (value) => value == null || (typeof value === 'string' && value.trim() === '')

const parseJson = (raw) => {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const parseInteger = (raw) => {
  const value = typeof raw === 'number' ? String(raw) : text(raw)
  if (!/^-?\d+$/.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

const optionalString = (raw, fallback) => {
  if (raw == null) return { valid: true, value: fallback }
  if (typeof raw !== 'string') return { valid: false, value: fallback }
  return { valid: true, value: raw.trim() || fallback }
}

const optionalInteger = (raw, fallback) => {
  const input = optionalString(raw, '')
  if (!input.valid) return { valid: false, value: fallback }
  if (input.value === '') return { valid: true, value: fallback }
  const value = parseInteger(input.value)
  return { valid: value != null, value }
}

const isNonEmptyExactString = (value) =>
  typeof value === 'string' && value.length > 0 && value === value.trim()

const isPositiveId = (value) => Number.isSafeInteger(value) && value > 0

const normalizeApplications = (value) => {
  if (!Array.isArray(value)) return null
  const ids = new Set()
  const projectSlugs = new Set()
  const projectNames = new Set()
  const topicIds = new Set()
  const applications = []

  for (const application of value) {
    if (!application || typeof application !== 'object' || Array.isArray(application)) return null
    const { id, name, projectSlug, topicId, environments } = application
    const hasProjectName = Object.hasOwn(application, 'projectName')
    const { projectName } = application
    if (
      !isNonEmptyExactString(id) ||
      !isNonEmptyExactString(name) ||
      !isNonEmptyExactString(projectSlug) ||
      (hasProjectName && (!isNonEmptyExactString(projectName) || projectNames.has(projectName))) ||
      !isPositiveId(topicId) ||
      !Array.isArray(environments) ||
      environments.length === 0 ||
      environments.some((environment) => !isNonEmptyExactString(environment)) ||
      new Set(environments).size !== environments.length ||
      ids.has(id) ||
      projectSlugs.has(projectSlug) ||
      topicIds.has(topicId)
    ) return null

    ids.add(id)
    projectSlugs.add(projectSlug)
    topicIds.add(topicId)
    if (hasProjectName) {
      projectNames.add(projectName)
      applications.push({ id, name, projectSlug, projectName, topicId, environments: [...environments] })
    } else {
      applications.push({ id, name, projectSlug, topicId, environments: [...environments] })
    }
  }

  return applications
}

// Request paths are appended to the base, so it must be a bare origin or path without credentials,
// query, or fragment. The returned form has no trailing slash.
const apiBase = (value) => {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[?#]/.test(value)) return null
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname || url.username || url.password) return null
  return url.href.replace(/\/+$/, '')
}

const isAbsoluteDataPath = (value) =>
  typeof value === 'string' && value.startsWith('/') && value.length > 1 && !value.includes('\0')

/**
 * Parse the relay environment without guessing around malformed input.
 * Error messages contain field names only so secrets and private workspace data cannot leak.
 *
 * @param {Record<string, unknown>} env
 * @returns {RelayConfig}
 */
const readConfig = (env = {}) => {
  const invalid = []
  const workspaceId = text(env.COMPANION_WORKSPACE_ID)
  const localeInput = optionalString(env.COMPANION_LOCALE, 'uz')
  const locale = localeInput.value
  const botToken = text(env.TELEGRAM_BOT_TOKEN)
  const paired = !['TELEGRAM_CHAT_ID', 'ALLOWED_MEMBER_IDS', 'APPLICATIONS_JSON'].every((name) => isBlank(env[name]))
  const chatId = paired ? parseInteger(env.TELEGRAM_CHAT_ID) : null
  const memberValue = paired ? parseJson(env.ALLOWED_MEMBER_IDS) : []
  const applicationValue = paired ? parseJson(env.APPLICATIONS_JSON) : []
  const queuePathInput = optionalString(env.QUEUE_PATH, DEFAULT_QUEUE_PATH)
  const queuePath = queuePathInput.value
  const auditPathInput = optionalString(env.AUDIT_PATH, DEFAULT_AUDIT_PATH)
  const auditPath = auditPathInput.value
  const queueLimitInput = optionalInteger(env.QUEUE_LIMIT, DEFAULT_QUEUE_LIMIT)
  const queueLimit = queueLimitInput.value
  const retentionInput = optionalInteger(env.RETENTION_HOURS, DEFAULT_RETENTION_HOURS)
  const retentionHours = retentionInput.value
  const apiBaseInput = optionalString(env.GLITCHTIP_API_BASE, DEFAULT_GLITCHTIP_API_BASE)
  const glitchtipApiBase = apiBase(apiBaseInput.value)
  const apiTokenInput = optionalString(env.GLITCHTIP_API_TOKEN, '')
  const glitchtipApiToken = apiTokenInput.value
  const revisionInput = optionalString(env.COMPANION_CONFIG_REVISION, DEFAULT_CONFIG_REVISION)
  const configRevision = revisionInput.value

  if (!workspaceId) invalid.push('COMPANION_WORKSPACE_ID')
  if (!localeInput.valid || !LOCALES.has(locale)) invalid.push('COMPANION_LOCALE')
  if (!botToken) invalid.push('TELEGRAM_BOT_TOKEN')
  // Once any pairing field is set, all three must be: a supergroup chat, a non-empty member
  // allowlist, and an application list (empty until the topics exist).
  if (paired && (chatId == null || !/^-100[1-9]\d*$/.test(String(chatId)))) invalid.push('TELEGRAM_CHAT_ID')

  const allowedMemberIds = !paired
    ? []
    : Array.isArray(memberValue) &&
      memberValue.length > 0 &&
      memberValue.every(isPositiveId) &&
      new Set(memberValue).size === memberValue.length
      ? [...memberValue]
      : null
  if (!allowedMemberIds) invalid.push('ALLOWED_MEMBER_IDS')

  const applications = normalizeApplications(applicationValue)
  if (!applications) invalid.push('APPLICATIONS_JSON')
  if (!queuePathInput.valid || !isAbsoluteDataPath(queuePath)) invalid.push('QUEUE_PATH')
  if (!auditPathInput.valid || !isAbsoluteDataPath(auditPath)) invalid.push('AUDIT_PATH')
  if (!queueLimitInput.valid || queueLimit < 10 || queueLimit > 5_000) {
    invalid.push('QUEUE_LIMIT')
  }
  if (!retentionInput.valid || retentionHours < 1 || retentionHours > 168) {
    invalid.push('RETENTION_HOURS')
  }
  if (!apiBaseInput.valid || !glitchtipApiBase) invalid.push('GLITCHTIP_API_BASE')
  if (!apiTokenInput.valid || !API_TOKEN.test(glitchtipApiToken)) invalid.push('GLITCHTIP_API_TOKEN')
  if (!revisionInput.valid || !CONFIG_REVISION.test(configRevision)) {
    invalid.push('COMPANION_CONFIG_REVISION')
  }

  if (invalid.length > 0) {
    throw new Error(`Invalid relay configuration: ${invalid.join(', ')}`)
  }

  return {
    workspaceId,
    locale,
    botToken,
    paired,
    chatId,
    allowedMemberIds,
    applications,
    queuePath,
    auditPath,
    queueLimit,
    retentionHours,
    glitchtipApiBase,
    glitchtipApiToken,
    configRevision,
  }
}

/**
 * The port the relay listens on, from `PORT`. The control commands post to the same port.
 *
 * @param {unknown} value
 * @returns {number|null} The port, 8090 when blank, or null when invalid.
 */
const readPort = (value) => {
  if (value === undefined || String(value).trim() === '') return DEFAULT_PORT
  const digits = String(value).trim()
  if (!/^\d{1,5}$/.test(digits)) return null
  const port = Number(digits)
  return port <= 65535 ? port : null
}

/**
 * @param {RelayConfig} config
 * @param {string} projectSlug
 * @returns {ApplicationConfig|null}
 */
const applicationForProject = (config, projectSlug) => {
  if (!config || !Array.isArray(config.applications) || typeof projectSlug !== 'string') return null
  return config.applications.find((application) => application.projectSlug === projectSlug) || null
}

const applicationForProjectName = (config, projectName) =>
  config.applications.find((application) => application.projectName === projectName) || null

/**
 * Route an event to one application, or `null` when none watches it.
 *
 * The enriched issue's project slug decides whenever GlitchTip returned one: the slug is the only
 * identifier unique to a project, so a same-named project that no application watches is refused
 * rather than matched by name. Without it, the webhook's `Project` field is matched exactly
 * against each application's slug and then its optional `projectName`.
 *
 * @param {RelayConfig} config
 * @param {{ issueProjectSlug?: unknown, payloadProject?: unknown }} [sources]
 * @returns {ApplicationConfig|null}
 */
const applicationForEvent = (config, { issueProjectSlug, payloadProject } = {}) => {
  if (!config || !Array.isArray(config.applications)) return null
  if (typeof issueProjectSlug === 'string' && issueProjectSlug !== '') {
    return applicationForProject(config, issueProjectSlug)
  }
  if (typeof payloadProject !== 'string' || payloadProject === '') return null
  return applicationForProject(config, payloadProject) || applicationForProjectName(config, payloadProject)
}

module.exports = {
  DEFAULT_PORT,
  applicationForEvent,
  applicationForProject,
  readConfig,
  readPort,
}
