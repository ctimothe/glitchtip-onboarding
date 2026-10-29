# Upgrade the relay

Not yet verified: the transactional upgrade described in the design has not been exercised against a live server. This page states the intended procedure and the evidence to require; treat any step that does not produce the stated evidence as failed.

## Prerequisites

- A healthy current relay (`docker compose ps` shows `companion-relay` healthy).
- SSH access from the Mac and the new relay version in the app.
- No unpaired state: `pairing-status` reports `paired`.

## Preview

Action: the app records the current Compose configuration, image digest, application mappings and secret references, then shows what the candidate changes. Secret values are never shown.

Expected evidence: the preview names the previous digest that will be kept as the rollback point.

## Command

Action: confirm in the app. It builds the candidate, validates Compose and relay configuration without switching traffic, starts the candidate, and switches the webhook only after health, a synthetic delivery, a callback authorization check and a deduplication check pass.

Expected evidence: `docker compose ps` shows the candidate healthy, `send-test` for one application produces a message in its topic, and `audit-tail` records the transition.

## Failure owner

The Relay server screen owns every upgrade failure. The previous version stays active until the candidate passes.

## Rollback

If any check fails, traffic stays on the previous revision. If a problem appears after the switch, use `rollback.md`. Queued event identifiers are preserved.

## Cleanup

After a successful upgrade the app keeps exactly one previous known-good configuration and image digest. Remove older images with `docker image prune` on the server only after confirming the relay is healthy.
