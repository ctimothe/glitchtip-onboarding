'use strict'

const TOPIC_COLORS = new Set([
  7322096,
  16766590,
  13338331,
  9367192,
  16749490,
  16478047,
])
const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member']
const LONG_POLL_TIMEOUT_SECONDS = 25
const TELEGRAM_TOKEN_PATTERN = '[0-9]+:[A-Za-z0-9_-]+'
const TELEGRAM_TOKEN = new RegExp(`^${TELEGRAM_TOKEN_PATTERN}$`)
const TOKEN_IN_DESCRIPTION = new RegExp(TELEGRAM_TOKEN_PATTERN, 'g')

const failure = (code, description, retryAfterSeconds = null) => ({
  code,
  retryAfterSeconds,
  description: redactDescription(description),
})

const redactDescription = (description) => String(description)
  .replace(/https?:\/\/[^\s]+/gi, '[redacted]')
  .replace(TOKEN_IN_DESCRIPTION, '[redacted]')
  .slice(0, 200)

const invalidInput = (description) => failure('invalid-input', description)

const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0
const isNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0
const isGroupChatId = (value) => Number.isSafeInteger(value) && /^-100\d+$/.test(String(value))
const isText = (value) => typeof value === 'string' && value.trim().length > 0
const isTelegramToken = (value) => typeof value === 'string' && TELEGRAM_TOKEN.test(value)
const readOptions = (value) => value && typeof value === 'object' ? value : {}

const requireGroupChatId = (chatId) => {
  if (!isGroupChatId(chatId)) throw invalidInput('Invalid chatId')
}

const requireTopicId = (topicId) => {
  if (!isPositiveInteger(topicId)) throw invalidInput('Invalid topicId')
}

const requireSignal = (signal) => {
  if (signal !== undefined && (
    signal === null ||
    typeof signal !== 'object' ||
    typeof signal.aborted !== 'boolean' ||
    typeof signal.addEventListener !== 'function'
  )) {
    throw invalidInput('Invalid signal')
  }
}

const validRetryAfter = (value) => isNonNegativeInteger(value) ? value : null

const httpCode = (response) => (
  Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
    ? response.status
    : 'http-error'
)

const responseFailure = (body, response) => {
  const code = Number.isInteger(body.error_code) ? body.error_code : httpCode(response)
  const retryAfterSeconds = body.parameters && typeof body.parameters === 'object'
    ? validRetryAfter(body.parameters.retry_after)
    : null
  const description = typeof body.description === 'string'
    ? body.description
    : 'Telegram request failed'
  return failure(code, description, retryAfterSeconds)
}

const invalidResponse = () => failure('invalid-response', 'Invalid Telegram response')

const isBotResponse = (response) => response && typeof response === 'object' && typeof response.ok === 'boolean'

function createTelegramClient(options) {
  const { token, fetchFn } = readOptions(options)
  if (!isTelegramToken(token)) throw invalidInput('Invalid token')
  if (typeof fetchFn !== 'function') throw invalidInput('Invalid fetchFn')

  const botUrl = `https://api.telegram.org/bot${token}`

  const request = async (method, body, signal) => {
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
    if (signal !== undefined) init.signal = signal

    let response
    try {
      response = await fetchFn(`${botUrl}/${method}`, init)
    } catch {
      throw failure('network-error', 'Telegram network request failed')
    }

    if (!isBotResponse(response) || typeof response.json !== 'function') throw invalidResponse()

    let payload
    try {
      payload = await response.json()
    } catch {
      throw invalidResponse()
    }

    if (!payload || typeof payload !== 'object' || typeof payload.ok !== 'boolean') {
      throw invalidResponse()
    }
    if (payload.ok === false) throw responseFailure(payload, response)
    if (response.ok !== true) throw failure(httpCode(response), 'Telegram HTTP request failed')
    return payload.result
  }

  return {
    async sendEvent(options) {
      const { chatId, topicId, message, callbackKey, actionText } = readOptions(options)
      requireGroupChatId(chatId)
      requireTopicId(topicId)
      if (!isText(message)) throw invalidInput('Invalid message')
      if (callbackKey !== undefined && (
        !isText(callbackKey) || Buffer.byteLength(callbackKey, 'utf8') > 64
      )) {
        throw invalidInput('Invalid callbackKey')
      }
      // The button label is localized by the caller, so it travels with the key and never alone.
      if (callbackKey === undefined ? actionText !== undefined : !isText(actionText)) {
        throw invalidInput('Invalid actionText')
      }

      const body = {
        chat_id: chatId,
        message_thread_id: topicId,
        text: message,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }
      if (callbackKey !== undefined) {
        body.reply_markup = {
          inline_keyboard: [[{
            text: actionText,
            callback_data: callbackKey,
          }]],
        }
      }

      const result = await request('sendMessage', body)
      if (!result || typeof result !== 'object' || !isPositiveInteger(result.message_id)) {
        throw invalidResponse()
      }
      return result.message_id
    },

    async getMe() {
      const result = await request('getMe', {})
      if (
        !result ||
        typeof result !== 'object' ||
        !isPositiveInteger(result.id) ||
        !isText(result.username)
      ) {
        throw invalidResponse()
      }
      return { id: result.id, username: result.username }
    },

    async createTopic(options) {
      const { chatId, name, iconColor } = readOptions(options)
      requireGroupChatId(chatId)
      if (!isText(name)) throw invalidInput('Invalid name')
      if (!TOPIC_COLORS.has(iconColor)) throw invalidInput('Invalid iconColor')

      const result = await request('createForumTopic', {
        chat_id: chatId,
        name,
        icon_color: iconColor,
      })
      if (!result || typeof result !== 'object' || !isPositiveInteger(result.message_thread_id)) {
        throw invalidResponse()
      }
      return result.message_thread_id
    },

    async pollUpdates(options) {
      const { offset, timeoutSeconds = LONG_POLL_TIMEOUT_SECONDS, signal } = readOptions(options)
      if (!isNonNegativeInteger(offset)) throw invalidInput('Invalid offset')
      if (timeoutSeconds !== LONG_POLL_TIMEOUT_SECONDS) throw invalidInput('Invalid timeoutSeconds')
      requireSignal(signal)

      const updates = await request('getUpdates', {
        offset,
        timeout: LONG_POLL_TIMEOUT_SECONDS,
        allowed_updates: ALLOWED_UPDATES,
      }, signal)
      if (!Array.isArray(updates) || !updates.every((update) => (
        update && typeof update === 'object' && isPositiveInteger(update.update_id)
      ))) {
        throw invalidResponse()
      }

      const greatestUpdateId = updates.reduce(
        (greatest, update) => Math.max(greatest, update.update_id),
        offset - 1,
      )
      if (greatestUpdateId === Number.MAX_SAFE_INTEGER) throw invalidResponse()
      return {
        updates,
        nextOffset: Math.max(offset, greatestUpdateId + 1),
      }
    },

    // Pairing checks the sender's live membership. Only the status and the user ID leave here.
    async getChatMember(chatId, userId) {
      requireGroupChatId(chatId)
      if (!isPositiveInteger(userId)) throw invalidInput('Invalid userId')

      const result = await request('getChatMember', { chat_id: chatId, user_id: userId })
      if (
        !result ||
        typeof result !== 'object' ||
        !isText(result.status) ||
        !result.user ||
        typeof result.user !== 'object' ||
        !isPositiveInteger(result.user.id)
      ) {
        throw invalidResponse()
      }
      return { status: result.status, user: { id: result.user.id } }
    },

    async answerCallbackQuery(id, text) {
      if (!isText(id)) throw invalidInput('Invalid id')
      if (text !== undefined && !isText(text)) throw invalidInput('Invalid text')
      const body = { callback_query_id: id }
      if (text !== undefined) body.text = text
      const result = await request('answerCallbackQuery', body)
      if (result !== true) throw invalidResponse()
    },

    // Replaces the keyboard of the brief message in place, so the provider choice needs no new message.
    async showProviderKeyboard(options) {
      const { chatId, messageId, replyMarkup } = readOptions(options)
      requireGroupChatId(chatId)
      if (!isPositiveInteger(messageId)) throw invalidInput('Invalid messageId')
      if (!replyMarkup || typeof replyMarkup !== 'object') throw invalidInput('Invalid replyMarkup')
      await request('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup,
      })
    },

    // The agent prompt is plain text: no parse mode, so nothing in it is interpreted, and no preview.
    async sendPrompt(options) {
      const { chatId, topicId, text } = readOptions(options)
      requireGroupChatId(chatId)
      requireTopicId(topicId)
      if (!isText(text)) throw invalidInput('Invalid text')
      const result = await request('sendMessage', {
        chat_id: chatId,
        message_thread_id: topicId,
        text,
        link_preview_options: { is_disabled: true },
      })
      if (!result || typeof result !== 'object' || !isPositiveInteger(result.message_id)) {
        throw invalidResponse()
      }
      return result.message_id
    },
  }
}

/** Whether `value` is one of Telegram's native forum topic icon colors. */
const isTopicColor = (value) => TOPIC_COLORS.has(value)

module.exports = { createTelegramClient, isTopicColor }
