# The relay

One process serves every project on the instance. It receives GlitchTip's alert webhook,
fetches the full event from the API, resolves who hit it from the owning app, formats a
paste-into-an-AI-ready message, and posts to Telegram.

Zero dependencies — Node built-ins only, so `node:22-alpine` with a read-only bind mount is the
entire deployment.

## Severity templates

The formatter selects severity from the full event level, then the SDK's `event_kind` tag,
then webhook fields. Exception data is the final error fallback. Unknown payloads use a neutral
template and are still delivered.

| Event | Telegram marker | Default policy |
|---|---|---|
| Error | `🚨` urgent red | deliver immediately |
| Warning | `⚠️` amber | deliver when the project alert rule includes warnings |
| Info | `ℹ️` blue | store in GlitchTip; deliver only through an explicit info rule |
| Unknown | `🔔` neutral | deliver as a generic notification |

Telegram messages use HTML for readable headings, source locations, request IDs, and issue
links. Every payload-derived value is escaped, and only `http:` or `https:` issue links become
clickable. Missing fields are omitted cleanly.

## Deploy

Alongside the GlitchTip compose stack, as `docker-compose.override.yml`:

```yaml
# GlitchTip → Telegram relay sidecar. Auto-merged with docker-compose.yml.
# Internal-only (no published ports): GlitchTip's worker reaches it at http://relay:8090,
# and the relay reaches GlitchTip's API at http://web:8080.
services:
  relay:
    image: node:22-alpine
    command: ["node", "/app/server.js"]
    volumes:
      - ./relay:/app:ro
    environment:
      PORT: "8090"
      TELEGRAM_ALERT_BOT_TOKEN: "${TELEGRAM_ALERT_BOT_TOKEN}"
      TELEGRAM_ALERT_CHAT_ID: "${TELEGRAM_ALERT_CHAT_ID}"
      GLITCHTIP_API_BASE: "http://web:8080"
      GLITCHTIP_API_TOKEN: "${GLITCHTIP_API_TOKEN}"
      OBSERVABILITY_LOOKUP_TOKEN: "${OBSERVABILITY_LOOKUP_TOKEN}"
      PROJECT_APP_BASES: >-
        {"myapp":{"production":"https://myapp.com","staging":"https://staging.myapp.com"},
         "otherapp":{"production":"https://other.com"}}
    restart: unless-stopped
```

**No published ports.** The relay is reachable only from inside the compose network, which is
also why the alert rule's webhook URL is `http://relay:8090/` and why a health check from
outside will fail — that is correct, not a fault. Check it from inside:

```bash
docker compose exec worker wget -qO- http://relay:8090/    # -> glitchtip-telegram relay ok
```

## Adding a project

1. Add an entry to `PROJECT_APP_BASES`, or don't — a project absent from the map still gets a
   correctly-labelled alert, it only skips the WHO/activity enrichment.
2. Point that project's alert rule at `http://relay:8090/` (the onboarding script does this).
3. `docker compose up -d relay` to pick up changed env.

There is **no** per-project relay. One relay, routed by GlitchTip project slug.

## How the project is resolved

`GET /api/0/issues/{id}/` returns a `project` object; its `slug` is used. If the API is
unreachable, the webhook's own Slack-style attachment carries a `Project` field, which is used
instead. Failing both, the label reads `unknown` — the alert still goes out.

**Never hardcode a project name in the message format.** A relay serving several projects and
labelling them all with the first one's name is the specific defect this file exists to
prevent, and it is invisible until the second project onboards.

## Backwards compatibility

`APP_BASE_PRODUCTION` / `APP_BASE_STAGING` from the original single-project relay are still
read and adopted as the entry for `DEFAULT_PROJECT` (default `kelajakmerosi`) when
`PROJECT_APP_BASES` has no entry for it. Dropping the new file over the old one changes nothing
for the deployment it came from.

## Contract

- **Always answers 200**, after the handler, with the handler wrapped. GlitchTip retries on
  non-2xx, so a formatting bug would otherwise multiply one broken alert into a retry storm.
- **A malformed `PROJECT_APP_BASES` is logged and ignored**, never fatal. An alert without
  enrichment beats no alert.
- **Body capped at 1 MB**, connection destroyed past it.
- **Never logs the Telegram token or the API token.** `LOG_PAYLOAD=0` silences the message dump
  entirely if the channel content is itself sensitive.

## Extending the message

`format.js` owns pure formatting and `format.test.js` covers severity and escaping. Add sections
to `formatEnriched`, then extend those tests. Three constraints:

1. **Anything human-identifying comes from `userCtx`** — resolved live from the app — never
   from the event. The moment identity is read off the event, it is because it was stored in
   GlitchTip, which is the thing this design avoids.
2. **Telegram caps a message at 4096 characters** and the send clips to it. A new section
   competes with the stack trace and the trail for that budget; add sections that change what
   someone *does*, not sections that look thorough.
3. **Escape dynamic values with `escapeHtml`.** Never concatenate payload text into markup or
   turn non-HTTP payload links into Telegram anchors.
