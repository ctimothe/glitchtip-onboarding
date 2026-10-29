'use strict'

/** @typedef {{ id:string, name:string, projectSlug:string, topicId:number, environments:string[] }} ApplicationConfig */
/** @typedef {{ ok:true, application:ApplicationConfig } | { ok:false, reason:'chat'|'member'|'topic'|'application'|'incident' }} AuthorizationResult */
/** @typedef {{ ok:true, chatId:number, adminUserId:number } | { ok:false, reason:'expired'|'used'|'chat-type'|'not-admin'|'code' }} PairingResult */

const rejected = (reason) => ({ ok: false, reason })
const firstDefined = (...values) => values.find((value) => value !== undefined && value !== null)

const callbackFields = (update) => {
  const source = update && typeof update === 'object' ? update : {}
  const callback = source.callback_query && typeof source.callback_query === 'object'
    ? source.callback_query
    : {}
  const message = callback.message && typeof callback.message === 'object' ? callback.message : {}
  const chat = message.chat && typeof message.chat === 'object' ? message.chat : {}
  const from = callback.from && typeof callback.from === 'object' ? callback.from : {}

  return {
    chatId: firstDefined(source.chatId, chat.id),
    memberId: firstDefined(source.memberId, source.userId, from.id),
    topicId: firstDefined(source.topicId, message.message_thread_id),
    applicationId: firstDefined(source.applicationId, callback.applicationId),
    issueId: firstDefined(source.issueId, callback.issueId),
  }
}

/**
 * Check every callback boundary. Rejections contain a category only; callers must ignore
 * unknown input rather than replying to it.
 *
 * @param {Object} config
 * @param {Object} update
 * @param {Object} incident
 * @returns {AuthorizationResult}
 */
const authorizeUpdate = (config, update, incident) => {
  const fields = callbackFields(update)
  if (!config || fields.chatId !== config.chatId) return rejected('chat')
  if (!Array.isArray(config.allowedMemberIds) || !config.allowedMemberIds.includes(fields.memberId)) {
    return rejected('member')
  }

  const applications = Array.isArray(config.applications) ? config.applications : []
  const application = applications.find((candidate) => candidate.id === fields.applicationId)
  const topicApplication = applications.find((candidate) => candidate.topicId === fields.topicId)
  if (!topicApplication || (application && topicApplication !== application)) return rejected('topic')
  if (!application) return rejected('application')

  if (
    !incident ||
    typeof incident !== 'object' ||
    incident.applicationId !== application.id ||
    typeof fields.issueId !== 'string' ||
    fields.issueId.length === 0 ||
    fields.issueId !== incident.issueId
  ) return rejected('incident')

  return { ok: true, application }
}

const instant = (value) => {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  if (typeof value === 'string' && value !== '') return Date.parse(value)
  return NaN
}

const pairingFields = (update) => {
  const source = update && typeof update === 'object' ? update : {}
  const message = source.message && typeof source.message === 'object' ? source.message : {}
  const chat = message.chat && typeof message.chat === 'object'
    ? message.chat
    : (source.chat && typeof source.chat === 'object' ? source.chat : {})
  const from = message.from && typeof message.from === 'object'
    ? message.from
    : (source.from && typeof source.from === 'object' ? source.from : {})

  return {
    code: firstDefined(source.code, message.text),
    chat,
    chatId: firstDefined(source.chatId, chat.id),
    userId: firstDefined(source.adminUserId, source.userId, from.id),
  }
}

const isAdminMembership = (membership, userId) => {
  if (!membership || typeof membership !== 'object') return false
  if (membership.status !== 'creator' && membership.status !== 'administrator') return false
  return Boolean(membership.user) && membership.user.id === userId
}

const finishPairing = (state, fields, membership) => {
  if (!isAdminMembership(membership, fields.userId)) return rejected('not-admin')
  state.used = true
  return { ok: true, chatId: fields.chatId, adminUserId: fields.userId }
}

/**
 * Consume an exact, ten-minute pairing code after revalidating Telegram membership.
 * `getChatMember` may return a value or a promise; no thrown API detail crosses this boundary.
 *
 * @param {Object} state
 * @param {Object} update
 * @param {number|Date|string} now
 * @returns {Promise<PairingResult>}
 */
const consumePairingCode = async (state, update, now) => {
  if (!state || typeof state !== 'object') return rejected('code')
  if (state.used || state.consuming) return rejected('used')

  const nowMs = instant(now)
  const createdAt = instant(state.createdAt)
  const expiresAt = createdAt + 10 * 60 * 1_000
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    nowMs < createdAt ||
    nowMs >= expiresAt
  ) {
    return rejected('expired')
  }

  const fields = pairingFields(update)
  if (typeof state.code !== 'string' || state.code.length === 0 || fields.code !== state.code) {
    return rejected('code')
  }
  if (
    fields.chat.type !== 'supergroup' ||
    fields.chat.is_forum !== true ||
    (typeof fields.chat.username === 'string' && fields.chat.username.length > 0) ||
    !Number.isSafeInteger(fields.chatId) ||
    !/^-100[1-9]\d*$/.test(String(fields.chatId)) ||
    !Number.isSafeInteger(fields.userId)
  ) return rejected('chat-type')

  const memberSource = typeof state.getChatMember === 'function'
    ? state
    : (update && typeof update.getChatMember === 'function' ? update : null)
  if (!memberSource) return rejected('not-admin')

  state.consuming = true
  try {
    const membership = await memberSource.getChatMember(fields.chatId, fields.userId)
    return finishPairing(state, fields, membership)
  } catch {
    return rejected('not-admin')
  } finally {
    delete state.consuming
  }
}

module.exports = {
  authorizeUpdate,
  consumePairingCode,
}
