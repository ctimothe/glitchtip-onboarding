# Install the Companion relay

The Companion has two parts: the Mac app, which owns configuration and credentials, and the relay, which runs on the Linux server beside GlitchTip and delivers alerts to Telegram. Do not run the relay on macOS. Do not paste a Telegram or GlitchTip token into an agent, a chat, or a command line; the app takes secrets through masked inputs only.

Status of verification: the relay source, its control commands and the deployment files below are covered by the relay unit tests. The end-to-end install through the Mac app against a live server has not yet been verified; each step says what evidence to expect, and any step that has not been exercised live is marked "not yet verified".

## Prerequisites

- A Linux server running Docker and Docker Compose, with GlitchTip on an existing Docker network named `glitchtip` (the network is declared `external` in `assets/relay/deploy/compose.yaml`).
- `GLITCHTIP_ALLOW_PRIVATE_IPS=true` on GlitchTip's web and worker containers. GlitchTip reaches the relay at `http://companion-relay:8090`, a private address on that network, and since GlitchTip 6.1.7 it refuses to create or send a webhook to a private address unless this variable is on. Pre-flight reads only this variable of GlitchTip's environment, and prints only whether it is on.
- SSH access from the Mac with an existing SSH identity and a trusted host key.
- A GlitchTip API token with access to the organization, and a BotFather token for the workspace bot.
- A private Telegram group with forum topics enabled, and a Telegram administrator to submit the pairing code.

## 1. Preview

Action: in the Mac app, open the server step and enter the server, then the bot token in the masked field. Telegram checks the token before anything reaches the server. The step shows the proposed files, the service name `companion-relay`, the secret locations and the rollback point before anything is written.

Expected evidence: the preview lists `compose.yaml`, `relay.env` (names only, no values), no published port, and the previous revision if one exists.

## 2. Apply

Action: confirm the preview in the app. The app builds the relay environment from the workspace and its two Keychain tokens, copies the deployment files to the server over SSH and writes the secret file at `$HOME/.local/share/glitchtip-companion/shared/relay.env` with mode 0600. The first deploy is unpaired: the relay has the tokens but no chat or applications yet. The relay container joins the `glitchtip` network, keeps its queue and audit state in the `companion-relay-state` volume, and publishes no port.

Expected evidence:

- `ls -l $HOME/.local/share/glitchtip-companion/shared/relay.env` on the server shows `-rw-------`.
- `docker compose ps` shows `companion-relay` as healthy. The health check calls `/health/ready` on port 8090 inside the container.
- `docker compose port companion-relay 8090` prints nothing, because no port is published.

Not yet verified: the app-driven apply against a live server.

## 3. Pair Telegram

Action: in the app, ask for a pairing code. It runs `node control.js pairing-create` on the server, which returns a code that expires after 10 minutes and works once. A Telegram administrator posts the code in the forum group.

Once paired, the app redeploys the same release with the chat and its administrator in `relay.env`. A redeploy that fails restores the previous `relay.env`.

Expected evidence: `pairing-status` returns `paired`, bound to that chat and administrator. Direct messages and unknown groups receive nothing.

## 4. Add an application and verify

Action: choose the GlitchTip project and environments in the app. It creates one Telegram topic (`topic-create`), redeploys the relay with the application in `relay.env`, then creates the GlitchTip alert rule with the relay's internal service address as its webhook. A rule of the same name that already sends elsewhere, such as v1's, is left as it is for now. Verification runs `send-test` and reads `audit-tail` until the relay records that Telegram took that event, checks the agent, and only then points an existing rule at the relay, keeping its other recipients, before it runs `send-setup-complete`.

Expected evidence: a test message in the application's topic, a Setup Complete message, the alert rule's webhook set to `http://companion-relay:8090/v1/glitchtip/events`, and `audit-tail` showing the delivery states without payloads or tokens.

## Failure owner

Each failure is shown on exactly one app screen: relay not healthy is the Relay server screen; a revoked bot token is the Telegram screen; GlitchTip unreachable is the Applications screen. Install stops at the first failing step.

## Rollback

If apply fails, the app restores the previous revision when one exists. On a first install there is nothing to restore; follow the cleanup below. See `rollback.md`.

## Cleanup

Remove nothing on success. After a failed first install, on the server run `docker compose down` in the deployment directory and delete `relay.env` if it was written. Revoke a bot token that was ever exposed through BotFather.
