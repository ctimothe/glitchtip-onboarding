# Agent handoff

Handoff is explicit and starts from Telegram. An authorized member selects `Prepare agent brief` on an incident; the relay checks bot identity, paired chat, application topic, allowlisted user and incident, then posts a copyable prompt in the same topic.

## What the prompt contains

The application and incident reference, environment and release when known, a few non-sensitive impact facts already in Telegram, the instruction to use the `glitchtip-investigate` skill, the state-specific goal, a prohibition on unrequested changes, the expected evidence report, and redaction and stop-on-failure rules. It never contains a credential or a private event payload.

## What the agent does

Prerequisites: the repository has the project-local `glitchtip-investigate` skill installed by the Mac app, and the Companion helper is available on the developer machine, which reads credentials from the Keychain.

The helper is the Mac app itself. Installing the agent files also writes a small launcher at `$HOME/Library/Application Support/dev.ctimothe.glitchtip-onboarding/bin/glitchtip-companion` that starts the app's executable in helper mode; no window opens. It answers `glitchtip-companion context --ref gt:<application>:<issue> --format json` with sanitized context: issue title, culprit, counts and times, the latest event's release and environment, and exception types, messages and frame locations, with email addresses, phone numbers, IP addresses, credentials and query strings in URLs, labelled credentials (`password=…`, `api_key: …`, `Authorization: …`) and token-like values replaced by `[redacted]`. A name written into an exception message as plain words cannot be recognized and stays; the prompt's redaction rule covers what the agent reports. It never returns variables, source context, request data, user data, breadcrumbs or other tags. The repository's `.glitchtip-companion.json` only names the workspace and application, and the helper answers only in the checkout where the app installed that application's agent files. The GlitchTip address and project come from the app's own settings, found through the user database rather than `HOME`, and curl runs with an empty environment and no config file, so neither a repository nor whoever starts the helper can send the token elsewhere or read another project's issues. A checkout that moved needs its agent files installed again. Exit codes: 2 configuration, 3 credential, 4 network or API, 5 sanitization. Moving the app after installing the agent files breaks the launcher; install the agent files again from the app. Run from a quarantined copy (opened straight from Downloads), the app refuses to write the launcher and asks to be moved to Applications first.

Action: paste the prompt into Codex, Claude Code or another agent opened in that repository.

Expected evidence: the agent fetches private issue context through the helper, redacts it, tries a safe reproduction, inspects code and release changes, and reports evidence, confidence, unknowns and the smallest safe fix options. It changes no code, dependency, infrastructure or production data until the user asks after reviewing the diagnosis.

Failure owner: Credentials. If retrieval fails, the agent stops and names the failed step. Do not paste a token to get past it; fix the credential in the app.

Rollback: nothing is modified, so there is nothing to roll back. Cleanup: close the agent session; no secret was placed in the prompt or the repository.

Not yet verified: the helper and skill install against a live repository and a live GlitchTip. Verified locally: the built app answers through the launcher with the exit codes above, and its request reaches GlitchTip over HTTPS with the token on stdin (a rejected token gives exit 3).
