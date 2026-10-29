# GlitchTip API — the verified surface

Verified against a live GlitchTip **6.2.0** instance by fetching `/api/0/openapi.json`
(OpenAPI 3.1.0, **101 paths**). Re-verify against your own instance before relying on any row;
GlitchTip moves, and this is a snapshot.

```bash
curl -s https://errors.example.com/api/0/openapi.json | python3 -c \
  'import sys,json; d=json.load(sys.stdin); print(d["info"], len(d["paths"]))'
```

## Auth

```
securitySchemes:
  TokenAuth   { type: http, scheme: bearer }      <- what scripts use
  SessionAuth { type: apiKey, in: cookie, name: sessionid }
```

`POST /api/0/api-tokens/` is declared `security: [{SessionAuth: []}]` — **the first token
cannot be minted through the API.** Create it in the UI: Profile → Auth Tokens. This is the
one irreducibly manual step in the whole install.

## Provisioning

| Verb | Path | Notes |
|---|---|---|
| GET | `/api/0/organizations/` | auth smoke test |
| POST | `/api/0/organizations/` | rarely wanted — an org is an ownership boundary |
| GET, POST | `/api/0/organizations/{org}/teams/` | `TeamIn` requires `slug`, pattern `^[-a-zA-Z0-9_]+$` |
| **GET only** | `/api/0/organizations/{org}/projects/` | ⚠️ **not** a creation endpoint |
| GET, **POST** | `/api/0/teams/{org}/{team}/projects/` | ⚠️ creation lives **here**. `ProjectIn` requires `name` (max 64); optional `slug`, `platform`, `eventThrottleRate` |

## DSN

| Verb | Path | Notes |
|---|---|---|
| GET | `/api/0/projects/{org}/{project}/keys/` | `ProjectKeySchema[]`, each with a `dsn` object |
| POST | `/api/0/projects/{org}/{project}/keys/` | `ProjectKeyIn { name?, rateLimit? }` |

The `dsn` object has exactly three fields — `public`, `secret`, `security`. The server
resolver returns the same value for `public` and `secret`; `secret` is deprecated and retained
only because `@sentry/wizard` requires the field. **Use `dsn.public`.**

## Alerts

| Verb | Path | Notes |
|---|---|---|
| GET, POST | `/api/0/projects/{org}/{project}/alerts/` | `ProjectAlertIn { name?, alertRecipients?, timespanMinutes?, quantity?, uptime=false }` |
| POST | `/api/0/projects/{org}/{project}/alerts/{id}/test/` | fires the rule immediately |

Recipients are discriminated on `recipientType`. `WebhookAlertRecipientIn` requires `url`;
optional `tagsToAdd`. There is **no Telegram recipient type** — hence the relay.

`uptime: true` turns a rule into an uptime alert; GlitchTip ships uptime monitoring at
`/api/0/organizations/{org}/monitors/` and `/monitors/{id}/checks/`, so a separate uptime SaaS
is usually redundant.

## Reading events (what the relay uses)

| Verb | Path |
|---|---|
| GET | `/api/0/issues/{id}/` — counts, project, culprit |
| GET | `/api/0/issues/{id}/events/latest/` — full event: entries, tags, contexts, breadcrumbs |
| GET | `/api/0/projects/{org}/{project}/issues/` — issue list |

## Releases and source maps

| Verb | Path |
|---|---|
| GET, POST | `/api/0/organizations/{org}/releases/` — `ReleaseIn` requires `version`, `projects[]` |
| GET, POST | `/api/0/organizations/{org}/chunk-upload/` — POST is `multipart/form-data`, field `file_gzip` |
| POST | `/api/0/organizations/{org}/artifactbundle/assemble/` — requires `checksum`, `chunks[]` (40-hex), `projects[]` |

This is Sentry's chunked-upload protocol, so `sentry-cli` works against GlitchTip with
`SENTRY_URL` / `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT`. Adopting `sentry-cli` is
a preference, not a requirement — the endpoints are callable directly.

## Ingest (what `verify.py --fire` uses)

A DSN decomposes as `{scheme}://{public_key}@{host}/{project_id}`:

```
POST {scheme}://{host}/api/{project_id}/store/
X-Sentry-Auth: Sentry sentry_version=7, sentry_key={public_key}, sentry_client=name/version
Content-Type: application/json
```

Unauthenticated `GET` of `chunk-upload` returns **401**, confirming enforcement is real rather
than advisory.
