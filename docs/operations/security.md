# Security

## Where secrets live

| Secret | Location | Protection |
| --- | --- | --- |
| GlitchTip API token, bot token, other app secrets | macOS login Keychain, service `dev.ctimothe.glitchtip-companion`, account `<workspace-id>/<key>` | Keychain access control; the Rust side owns every call and errors carry a code, never a value |
| Relay environment (bot token, GlitchTip token, chat ID, allowed member IDs) | server file `$HOME/.local/share/glitchtip-companion/shared/relay.env` | owner-only, mode 0600 |
| Relay queue and audit | Docker volume `companion-relay-state`, mounted at `/var/lib/glitchtip-companion` | identifiers, timestamps, states and redacted errors only |

The legacy JSON file vault (`secrets.json` in the app config directory) is migrated into the Keychain on start and is deleted only by a separate command that first verifies every key.

Project files, generated prompts, command previews and app logs contain identifiers and instructions only. Never paste a Telegram or GlitchTip token into an agent, a chat message, an issue or a command line; if an agent asks for one, stop and use the app.

## Network

The relay publishes no port. It joins the Docker network that GlitchTip uses and accepts GlitchTip webhooks only there. Telegram buttons arrive by outbound long polling, so nothing is exposed to the internet. Health endpoints reveal no configuration or event data.

## Telegram

Pairing needs a one-time code that expires after 10 minutes and a Telegram administrator inside a forum-enabled private group. Chat, topic, member, application and incident are checked on every action. Bot privacy mode stays on. Direct messages, unknown groups and inline mode return nothing.

## Rotating a secret

Preview: the app names the secret and where it is stored. Action: enter the new value in the masked field; the app updates the Keychain item and the server `relay.env`, then restarts the relay. Evidence: `send-test` delivers. Failure owner: the Telegram screen for a bot token, the Applications screen for a GlitchTip token. Rollback: re-enter the previous value if it is still valid. Cleanup: revoke the old value at its source. Not yet verified against a live server.
