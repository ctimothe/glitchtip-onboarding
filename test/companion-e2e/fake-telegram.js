'use strict'
/**
 * Deterministic fake of the Telegram Bot API surface Companion uses. Synthetic data only.
 *
 * `fetchFn` is for the real relay's Telegram client: it rewrites https://api.telegram.org to the
 * fake's listener, so the relay's real request code runs. Every call is captured and readable at
 * GET /__captured, which exists on the test network only.
 */
const http = require('node:http')

const BOT_URL = /^\/bot([0-9]+:[A-Za-z0-9_-]+)\/([A-Za-z]+)$/

const createFakeTelegram = ({ token, chatId, botId = 900001, members = [] } = {}) => {
  const captured = []
  const memberIds = new Set(members)
  const updates = []
  const rateLimits = []
  let nextTopicId = 100
  let nextMessageId = 500
  let server = null

  const ok = (result) => ({ status: 200, body: { ok: true, result } })
  const handlers = {
    getMe: () => ok({ id: botId, is_bot: true, username: 'companion_e2e_bot' }),
    getUpdates: async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
      return ok(updates.splice(0))
    },
    getChat: () => ok({ id: chatId, type: 'supergroup', is_forum: true, title: 'Companion E2E' }),
    getChatMember: (body) => memberIds.has(body.user_id)
      ? ok({ status: 'member', user: { id: body.user_id } })
      : ok({ status: 'left', user: { id: body.user_id } }),
    createForumTopic: () => {
      nextTopicId += 1
      return ok({ message_thread_id: nextTopicId })
    },
    sendMessage: () => {
      const limit = rateLimits.shift()
      if (limit !== undefined) {
        return {
          status: 429,
          body: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: limit } },
        }
      }
      nextMessageId += 1
      return ok({ message_id: nextMessageId })
    },
    answerCallbackQuery: () => ok(true),
  }

  const handle = (method, body) => {
    captured.push({ method, body })
    const handler = handlers[method]
    return handler ? handler(body) : { status: 404, body: { ok: false, error_code: 404, description: 'Not Found' } }
  }

  const listener = (request, response) => {
    if (request.method === 'GET' && request.url === '/__captured') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      return response.end(JSON.stringify(captured))
    }
    const match = BOT_URL.exec(request.url)
    if (request.method !== 'POST' || !match || match[1] !== token) {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      return response.end('{"ok":false,"error_code":404,"description":"Not Found"}')
    }
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', async () => {
      const result = await handle(match[2], JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      response.writeHead(result.status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(result.body))
    })
  }

  const fake = {
    captured,
    url: null,
    sent: () => captured.filter((call) => call.method === 'sendMessage').map((call) => call.body),
    // The next sendMessage calls answer 429 with these retry_after seconds, one per call.
    rateLimitNextSends: (...seconds) => rateLimits.push(...seconds),
    pushUpdate: (update) => updates.push(update),
    async start() {
      server = http.createServer(listener)
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      fake.url = `http://127.0.0.1:${server.address().port}`
      return fake.url
    },
    async close() {
      if (!server) return
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      server = null
    },
    fetchFn: (target, init) => fetch(String(target).replace('https://api.telegram.org', fake.url), init),
  }
  return fake
}

module.exports = { createFakeTelegram }
