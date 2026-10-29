# GlitchTip Companion — Desktop App

A free, MIT-open, direct-downloaded macOS app that connects a GlitchTip
instance to Telegram and to coding agents. It deploys a small relay next to
GlitchTip, pairs a Telegram forum group, gives each application its own topic,
and installs agent files so Codex or Claude Code can read an incident.

Why a desktop app: setup needs a GlitchTip API token and a Telegram bot token
while it talks to self-hosted instances and an SSH server. A Tauri shell keeps
those on the user's Mac, in the Keychain, with no hosted service in between.

## What it does

- **Setup assistant** (first run, six stages): connect GlitchTip → deploy the
  relay over SSH → pair Telegram → add the first application → connect a
  repository's agent → verify the full path. Every change to a server or a
  repository is shown as a preview and confirmed in a sheet before it runs.
- **Sidebar screens** once setup is done: Overview, Applications (add more with
  the same assistant), Telegram, Relay server (health, logs, update,
  rollback), Delivery activity, Credentials, Settings.
- **Move from v1**: a Mac that ran the old local relay daemon is offered a
  preview of what moves to the server, or a fresh setup instead.
- Instance check against `GET {base}/api/0/openapi.json`, falling back to
  `/api/openapi.json` (app.glitchtip.com), title read from `info.title`.
- Native macOS look: system font, light and dark appearance, translucent
  sidebar, sheets for every confirmation, and a translated menu bar: Settings… (⌘,) in the
  app menu, Add Application… (⌘N) under File, and the sidebar's destinations (⌘1–⌘6) under View.
- English, Russian and Uzbek, following the Mac's language on first run.
- Menu bar item with the latest alerts the relay delivered, read from its
  audit on the server once a minute while the app runs; nothing runs on the
  Mac when the app is closed — the relay delivers alerts on its own.

## Companion scope

The Mac app owns configuration and credentials; it does not run the relay.
The relay runs in Docker on the Linux server beside GlitchTip and delivers
alerts to Telegram on its own. The app deploys and configures it over SSH and
runs its control commands there. Operator procedures live in
`docs/operations/` (install, upgrade, rollback, security, agent handoff).
Several of those procedures are marked "not yet verified" until they have been
exercised against a live server.

## Prerequisites

- Node ≥ 20, Rust toolchain (`cargo`), Xcode Command Line Tools
  (`xcode-select -p` must print a path).
- No Apple Developer account is needed for local dev builds (unsigned).
- A paid Apple Developer account (Developer ID + notarization credentials)
  is required for public distribution — a human prerequisite, not
  automatable here.

## Run

```bash
npm install        # repo root — picks up apps/* via workspaces
npm run dev        # workdir apps/desktop — launches the Tauri window
```

Useful scripts (workdir `apps/desktop`):

| Command              | What it does                              |
| -------------------- | ----------------------------------------- |
| `npm run dev`        | Tauri dev window (Vite on `:1420`)        |
| `npm run dev:frontend` | Browser preview with mocked IPC: open `/preview.html?scenario=ready` (`setup`, `server`, `migration`; `&relay=outdated`, `&v1=web` or `&v1=unknown`, `&locale=ru`) |
| `npm run typecheck`  | `tsc --noEmit`                            |
| `npm run lint`       | ESLint (flat config)                      |
| `npm run test`       | Vitest: unit and screen tests (jsdom)     |
| `npm run build`      | Release Tauri build (needs signing setup) |
| `npm run build:debug`| **Unsigned** debug `.app` for local use   |
| `npm run fetch:node` | Puts the bundled Node.js (pinned version and checksum) in `src-tauri/binaries/`; every build needs it |

`bash test/companion-ssh-e2e/run.sh` (repo root, needs Docker, about three minutes) deploys the relay
with the app's own Rust deploy code over real SSH to a throwaway stand-in server with its own Docker
daemon, and checks that the relay starts with the environment the app writes, then that a failed
first install is rolled back.
The relay cannot report ready there, because its Telegram check needs a real bot token. It is not a
`./scripts/check` step; run it after changing `src-tauri/src/remote.rs` or `assets/relay/deploy/`.

## Build (unsigned, local)

```bash
npm run fetch:node    # workdir apps/desktop, once per clone
npm run build:debug
```

The unsigned bundle lands under
`apps/desktop/src-tauri/target/debug/bundle/macos/*.app`.
Unsigned builds open with a right-click → Open (Gatekeeper) prompt on
first launch; that is expected and not a bug. There is no ad-hoc or
debug signing in this repo — do not add any to work around Gatekeeper.

## Distribution checklist (for the human doing the release)

1. **Signing secrets** — `.github/workflows/desktop-release.yml` signs with a
   Developer ID Application certificate and notarizes; its header lists the
   repository secrets it needs (the certificate, and either an App Store
   Connect API key or an Apple ID with an app-specific password). It fails
   rather than build unsigned. Signing turns on the hardened runtime;
   `src-tauri/Entitlements.plist` allows the JIT the bundled Node.js needs
   under it (without it `node` aborts with "Failed to reserve virtual memory
   for CodeRange").
2. **Release** — run the workflow by hand first: it signs, notarizes, staples
   and checks the app and DMG with Gatekeeper, and keeps the DMG as a
   workflow artifact. Then push a `desktop-v<version>` tag matching
   `tauri.conf.json`; the DMG lands on a draft release to publish by hand.
   Apple silicon only.
3. **Turn the updater on** — v1 ships with the updater wired off. To
   enable it: add an `updater` block under `plugins` in
   `src-tauri/tauri.conf.json` pointing `endpoints` at the releases feed
   (e.g. `https://github.com/ctimothe/glitchtip-onboarding/releases/latest/download/`
   artifacts), embed the updater public key (`pubkey`), set
   `"active": true`, publish a first release so the feed exists, and
   test an update round-trip before announcing.
4. Re-run the full verify (`typecheck`, `lint`, `test`, `build:debug`
   plus the launch smoke below) after any of the above changes.

## Secret storage

Secrets live in the macOS login Keychain as generic passwords under the
service `dev.ctimothe.glitchtip-companion`, one item per
`<workspace ID>/<key>` account. Rust owns every Keychain call
(`src-tauri/src/keychain.rs`: `secret_set`, `secret_get`, `secret_remove`,
`secret_presence`, `secret_migrate_file_vault`, `secret_remove_file_vault`);
the renderer only calls them through `src/lib/keychain.ts` and the
`get / set / remove` wrapper in `src/lib/secrets.ts`, which now takes a
workspace ID. The default workspace, and the v1 items the migration reads,
use `LEGACY_WORKSPACE_ID` (`"default"`).
Failures come back as a code only (`keychain-denied`, `keychain-locked`,
`secret-not-found`, `keychain-write-failed`, …), never with a value.

Coding agents read incident context through the app too: the launcher at
`~/Library/Application Support/dev.ctimothe.glitchtip-onboarding/bin/glitchtip-companion`
starts this executable in helper mode (`src-tauri/src/helper.rs`), which reads
only the `glitchtip-token` item and prints sanitized context
(`docs/operations/agent-handoff.md`). It is the same signed program, so it
needs no Keychain permission of its own.

The relay's environment is built from the workspace and its
`glitchtip-token` and `telegram-bot-token` items
(`src/lib/relay-config.ts`) and stored as the `relay.env` item before
every deploy; `deploy_relay` reads it from there. The relay is redeployed
whenever that environment changes: after pairing, after each new
application, and on Update in the Relay server screen. A failed deploy puts
the stored item back, as the server's installer does, so it always matches
what the relay runs; the Relay server screen compares it with the environment
the workspace calls for and asks for an Update when they differ (a new
language, a rotated token).

The old JSON file vault (`secrets.json` in the app config dir) is no
longer read or written by the renderer, and the fs-plugin scopes for it
are gone. On every start, `bootstrap()` (`src/app/bootstrap.ts`) runs
`secret_migrate_file_vault` for the legacy workspace before the first
render. It writes each key the Keychain lacks and reads it back, reports
keys already present as `verified` (same value) or `conflicts` (different
value, which is kept), and never deletes the file. Deleting it is a
separate command, `secret_remove_file_vault`, which re-reads every key and
unlinks the file only when all of them match; otherwise it returns
`vault-not-verified` or `vault-remove-failed` and keeps the file.

A Mac with a v1 install opens on the move screen (`src/app/migration.ts`).
Continue copies the two tokens to the names setup reads and opens the setup
assistant with the GlitchTip address and organization filled in; the v1
launchd relay keeps running meanwhile, and setup offers v1's project for the
first application. Setup points the existing GlitchTip alert rule at the new
relay only after verification proves Telegram delivery. Once an application
for v1's project has passed verification and is saved, the app turns the v1
relay off, removes the verified file vault, then the v1 Keychain items; until
then Overview shows the relay on this Mac. A v1 install that never saved its
project stays on until the user turns it off from Overview. "Set up fresh"
leaves v1 untouched.

## Troubleshooting

- **Self-signed / localhost instances fail TLS.** GlitchTip and Telegram
  calls run over the webview's `fetch` with normal TLS verification; there is
  no insecure-skip. Use a properly certified `https://` instance URL.
- **Only `https:` hosts are reachable from the window.** The CSP is
  `connect-src 'self' https: ipc: http://ipc.localhost`. Both GlitchTip and
  `https://api.telegram.org` answer cross-origin requests from the app
  (`Access-Control-Allow-Origin: *`, checked 2026-10-28). SSH and relay
  commands run in Rust, not in the window.
- **Pairing code is not accepted.** Codes expire after 10 minutes and work
  once; create a new one from the Telegram step and post it in the forum
  group as an administrator.
- **Copy does nothing.** Clipboard access needs a focused window — click the
  window and retry.
