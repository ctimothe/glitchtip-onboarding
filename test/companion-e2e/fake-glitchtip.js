'use strict'
/**
 * Deterministic fake of the GlitchTip surface Companion uses: project, issue and latest-event reads,
 * alert recipient registration and switch, synthetic issue creation, and the webhook POST to the
 * relay. Synthetic names under example.test only.
 */
const http = require('node:http')

const issueFixture = require('../../assets/relay/fixtures/glitchtip-issue.json')
const latestEventFixture = require('../../assets/relay/fixtures/glitchtip-latest-event.json')
const webhookFixture = require('../../assets/relay/fixtures/glitchtip-webhook.json')

const createFakeGlitchTip = ({ apiToken, relayEventsUrl } = {}) => {
  const requests = []
  const recipients = []
  const syntheticIssues = []
  let server = null

  const send = (response, status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(body))
  }

  const route = (method, pathname, body) => {
    let match
    if (method === 'GET' && (match = /^\/api\/0\/projects\/([^/]+)\/([^/]+)\/$/.exec(pathname))) {
      return [200, { id: 1, slug: match[2], name: match[2], organization: { slug: match[1] } }]
    }
    if (method === 'GET' && (match = /^\/api\/0\/issues\/(\d+)\/events\/latest\/$/.exec(pathname))) {
      return [200, structuredClone(latestEventFixture)]
    }
    if (method === 'GET' && (match = /^\/api\/0\/issues\/(\d+)\/$/.exec(pathname))) {
      return [200, { ...structuredClone(issueFixture), id: match[1] }]
    }
    if (method === 'POST' && /^\/api\/0\/projects\/[^/]+\/[^/]+\/alerts\/$/.test(pathname)) {
      const recipient = { id: String(recipients.length + 1), url: body.url, enabled: true }
      recipients.push(recipient)
      return [201, recipient]
    }
    if (method === 'PUT' && (match = /^\/api\/0\/projects\/[^/]+\/[^/]+\/alerts\/(\d+)\/$/.exec(pathname))) {
      const recipient = recipients.find((candidate) => candidate.id === match[1])
      if (!recipient) return [404, { detail: 'Not found' }]
      Object.assign(recipient, { url: body.url ?? recipient.url, enabled: body.enabled ?? recipient.enabled })
      return [200, recipient]
    }
    if (method === 'POST' && /^\/api\/0\/projects\/[^/]+\/[^/]+\/issues\/synthetic\/$/.test(pathname)) {
      const issue = { id: String(9000 + syntheticIssues.length), title: body.title ?? 'Synthetic issue' }
      syntheticIssues.push(issue)
      return [201, issue]
    }
    return [404, { detail: 'Not found' }]
  }

  const fake = {
    requests,
    recipients,
    syntheticIssues,
    url: null,
    async start() {
      server = http.createServer((request, response) => {
        const chunks = []
        request.on('data', (chunk) => chunks.push(chunk))
        request.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization })
          if (apiToken && request.headers.authorization !== `Bearer ${apiToken}`) {
            return send(response, 401, { detail: 'Unauthorized' })
          }
          const [status, body] = route(request.method, new URL(request.url, 'http://x').pathname, raw ? JSON.parse(raw) : {})
          send(response, status, body)
        })
      })
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
    // The generic webhook GlitchTip POSTs when an alert fires; `payload` defaults to the real fixture.
    async postWebhook(payload = webhookFixture) {
      const response = await fetch(relayEventsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      return { status: response.status, body: await response.json() }
    },
  }
  return fake
}

module.exports = { createFakeGlitchTip }
