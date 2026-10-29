# Roll back or remove

Not yet verified against a live server. Rollback keeps queued event identifiers and never prints secret values.

## Roll back to the previous relay revision

Prerequisites: SSH access and a retained previous configuration and image digest (the app keeps one).

Preview: the app shows the revision it will restore and the configuration it will replace.

Action: choose the recovery action on the Relay server screen. The app restores the retained configuration and image, restarts `companion-relay`, and re-runs the health check.

Expected evidence: `docker compose ps` shows the relay healthy on the previous digest; `send-test` for one application delivers to its topic; `audit-tail` shows the restore.

Failure owner: the Relay server screen.

Rollback of the rollback: run the upgrade again from the app.

Cleanup: none; the failed candidate image may be removed with `docker image prune` once the relay is healthy.

## Remove one application

Preview: the app shows the topic and mapping changes and disables the application's webhook first.

Expected evidence: the application no longer appears in the app; a test event for it is not delivered.

Failure owner: the Applications screen. Rollback: add the application again. Cleanup: close the Telegram topic by hand if the app left it.

## Remove the relay

Removing the Mac app does not remove the relay. Removing the relay is a separate operation with a deletion preview.

Action: on the server run `docker compose down` in the deployment directory; add `--volumes` only when the queue and audit state are to be discarded. Then delete `$HOME/.local/share/glitchtip-companion/shared/relay.env`.

Expected evidence: `docker compose ps` lists no `companion-relay`; the file is gone.

Failure owner: the Relay server screen. Rollback: install again (`install.md`); the queue is gone if `--volumes` was used.

Cleanup: revoke the bot token in BotFather, revoke the GlitchTip API token in GlitchTip, and delete the matching Keychain items (service `dev.ctimothe.glitchtip-companion`) in Keychain Access.
