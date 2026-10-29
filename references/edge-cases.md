# Edge cases

Every entry here was found by an install that looked finished and was not. Each is written as
**symptom → cause → check**, because the symptom is what you will actually meet.

---

## Silent non-delivery

### The dashboard is configured and no error ever appears

**Cause:** the DSN is set in a file nothing reads at runtime. A `DEPLOYED_VERSION.txt`, a
`.env` the service unit does not load, a `VITE_*` key added after the build was made.
**Check:** read the environment of the *running process*, not the file.
`tr '\0' '\n' < /proc/$(pidof -s myapp)/environ | grep -c GLITCHTIP_DSN`

### `VITE_*` set in production changes nothing

**Cause:** Vite bakes `VITE_*` at **build** time. Setting it in the deployed `.env` and
restarting is a no-op — the string is already absent from the bundle.
**Check:** `grep -c 'glitchtip\|sentry' dist/assets/*.js`, and confirm the build step actually
passes the variable. A key declared in `.env.example` and never passed by CI is the common
shape.

### Errors from real users never arrive, but yours do

**Cause:** ad blockers and privacy extensions block requests to error-reporting hosts. You do
not see it because you do not run one.
**Fix:** a same-origin tunnel. The endpoint **must** verify the envelope's DSN key is yours,
or you have built an open relay anyone can use to fill your instance.

### The one that makes the whole install pointless: streaming endpoints

**Symptom:** the API reports errors, but the product's main path — the chat stream, the SSE
feed, the long export — never reports anything, even when it visibly fails.
**Cause:** the response headers were already sent, so an exception inside the generator never
propagates to the framework's error handler. Most apps then catch it locally, log it, and emit
a generic error frame to the client. Nothing reaches the tracker, and nothing pages anyone.
**Check:** grep for the streaming response class, then read every `except` inside those
handlers. Each needs an explicit capture.

### GlitchTip retries a webhook forever

**Cause:** the relay returned non-2xx because a formatting bug threw. One broken alert becomes
a retry storm.
**Fix:** the relay always answers 200, after the handler, with the handler wrapped.

---

## Silent over-collection

### `send_default_pii=False` and user data still ships

**Cause:** it gates cookies, request body and the user block. It does **not** gate
`include_local_variables`, which defaults to **True**. Every function argument in the traceback
is serialized.
**Check:** search a stored event for `"vars"`. If it is there, frame locals are on.

### The scrubber is wired and data still ships

**Cause:** it was wired as `before_send` only. Breadcrumbs do not pass through `before_send`.
A logging integration turns `logger.exception("... user_id=%s ...")` into a breadcrumb and it
travels untouched.
**Fix:** `before_breadcrumb` as well, always both.

### The scrubber passes its own tests and fails in production

**Cause:** it was tested against the string `"secret"`. Real leaks are shaped like your domain
— a decision excerpt, a prompt, a customer record — and match no generic pattern.
**Fix:** take a real function signature from the codebase and assert its argument's content
cannot appear in a serialized event.

### A scrubber that throws loses the error entirely

**Fix:** never raise, and fail **closed** — return `None` (drop the event) rather than pass an
unscrubbed one through. Losing one error beats exporting user data.

---

## Provisioning

### `POST /api/0/organizations/{org}/projects/` → 405, and you conclude the token is wrong

**Cause:** that endpoint is **GET-only**. Creation lives on the team endpoint,
`POST /api/0/teams/{org}/{team}/projects/`. A project must belong to a team.

### Every API call 401s while you try to script token creation

**Cause:** `POST /api/0/api-tokens/` accepts **session auth only**. The first token cannot be
minted through the API. Mint it in the UI (Profile → Auth Tokens) and say so rather than
looping.

### Every API call 403s with a correct token, behind Cloudflare

**Symptom:**

```
HTTP 403 {"error_code":1010,"error_name":"browser_signature_banned",
          "detail":"The site owner has blocked access based on your browser's signature."}
```

**Cause:** urllib's default `User-Agent: Python-urllib/3.x` is on Cloudflare's banned-signature
list. It reads exactly like an auth failure, so the natural response is to go and re-mint a
token that was never wrong. `curl` from the same machine works, which makes it more confusing,
not less — curl sends its own UA.
**Fix:** set a real `User-Agent` on every request. Both scripts in `assets/` do.
**Found by:** running the provisioner against a live Cloudflare-fronted instance. It is not in
any GlitchTip documentation.

### A re-run creates a second project / duplicate alert rules

**Fix:** list before every create, match on a stable key (project **slug**, alert **name**).
Converging is the correct semantics; a partial install is the normal starting state.

---

## Alert quality

### Alerts arrive labelled with the wrong project

**Cause:** a relay serving several projects with one hardcoded label. This is the specific
defect that motivates the multi-project relay in `assets/relay/`.
**Check:** trigger an error in the *second* project onboarded and read the label.

### The team stops reading the alert channel

**Cause:** unfiltered browser noise — `ResizeObserver loop`, bare `Script error.`,
`AbortError`, extension URLs, and chunk-load failures from users on a stale bundle after a
deploy. The failure mode of alerting is **too many** alerts, not too few.

### Alerts are useless because nobody can reproduce them

**Cause:** no breadcrumbs, or breadcrumbs recorded as CSS selectors.
**Fix:** record the accessible label of the clicked control.

### A degraded system produces no alerts at all

**Cause:** nothing threw. A queue backing up, a health check failing, a deploy that silently
did not happen — none of these raise an exception, so the error tracker has nothing to send.
**Fix:** keep a second, app-side alert channel for conditions the app *detects*. The two are
not redundant.

---

## Features that silently discard traffic

GlitchTip is Sentry-**ingest**-compatible, not Sentry-**feature**-compatible.

| Feature | What happens |
|---|---|
| Session Replay | no ingest, no UI — envelopes discarded |
| `autoSessionTracking` / Release Health | GlitchTip's own docs say sessions are unsupported; set it `false` |
| Profiling | discarded |
| Performance tracing | transactions ingest, but nobody reads them; keep `tracesSampleRate: 0` |

Sending these costs bandwidth and quota and returns nothing.

---

## A measurement that did not survive being re-measured

An earlier version of this skill stated that `import * as Sentry` costs **+30.1 kB gzip** while
named imports with an explicit `integrations` array cost **~0.5 kB**, and told you not to
"tidy" the named form away.

Re-measured on a real build (@sentry/react 10.70.0, Vite, React 18) by swapping all 11 symbols
to a namespace import: the output chunk was **byte-identical, same content hash**, 90.17 kB /
30.54 kB gzip. Rollup tree-shakes both forms the same way. The claim is **refuted** — do not
repeat it.

What IS measurable: the SDK is ~30 kB gzip however it is written, and a **dynamic** import
keeps all of it out of the chunk that gates first paint (entry 108.07 → 108.09 kB gzip).

Keep the named imports and the explicit integrations array regardless, for what they do at
runtime rather than what they weigh. The general lesson is the one this file exists for: a
number you inherited is a hypothesis until you have run the build yourself.

## The meta-trap

**An install that delivers but does not scrub is worse than no install.** It is a continuous
export of user data wearing the appearance of a correct setup, and it will not be re-examined
because alerts are visibly arriving. This is why `verify.py` treats a scrub failure as an
overall FAIL even when every delivery check passes.
