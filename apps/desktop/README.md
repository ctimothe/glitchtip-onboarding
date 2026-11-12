# GlitchTip Companion — Desktop App

A free, MIT-open, direct-downloaded macOS app for the errors your GlitchTip
servers collect. Its inbox reads every connected server's open errors once a
minute, works out which of them are real problems (an outage, a bug in
production) and which are noise, notifies you of the real ones, and lets you
resolve or ignore them. Telegram alerts are optional: the app can deploy a small relay next to
GlitchTip, pair a Telegram forum group and give each application its own
topic. It also installs agent files so Codex or Claude Code can read an
incident.

Why a desktop app: setup needs a GlitchTip API token and a Telegram bot token
while it talks to self-hosted instances and an SSH server. A Tauri shell keeps
those on the user's Mac, in the Keychain, with no hosted service in between.

## What it does

- **Inbox**: open errors from every GlitchTip server you add (Settings → GlitchTip
  servers), with the latest event's stack trace, Resolve, Ignore and Open in
  GlitchTip. It opens on **Needs attention**, the most serious first; **All** shows
  every open error, most recently seen first. It reads
  `GET /api/0/organizations/{org}/issues/?query=is:unresolved` once a minute, on
  focus and when the network returns, while the app runs; closing the window keeps
  it in the menu bar.
- **Triage** (`src/lib/triage.ts`): GlitchTip's level says how loud the code was,
  not whether anyone is hurt, so every open error is read from its evidence
  instead: the environments its events come from, whether it was a crash or a
  caught error, who or what triggered it, whose code it is in, and how fast it
  arrives. The first rule that fits decides:

  | Kind | What it is | Notifies |
  |---|---|---|
  | Not production | every event names an environment, and each is `development`, `staging`, `preview-…`, `test`, … | no |
  | Outage | a fatal event, a dependency that refuses or cannot be reached, memory, disk or connections used up | yes, as critical |
  | Noise | browser quirks (`ResizeObserver loop`, `Script error.`), an error thrown inside a browser extension, a vulnerability scanner's request to a server, crawlers | no |
  | Expected | a refusal (the app's own 4xx exceptions) or a warning the code caught and reported, cancelled requests | no |
  | Flaky | a browser's own "request never arrived" messages, broken connections and third-party timeouts, a browser still on an old build | only once it spreads (30 events a minute) |
  | Bug | everything else in production | yes; critical when a crash reaches 10 people or it spreads |

  Every quiet verdict is a claim that nobody needs to look, so each is kept
  narrow: a pattern matches a whole message or a code that does not occur in
  prose, a refusal or a warning is quiet only when the code caught it, and a
  verdict that rests on the latest event alone (scanner, crawler, extension)
  gives way once ten people are on the error. An event with no environment, and
  an error GlitchTip has not been asked about yet, count as production: a
  missing answer never hides an error. The evidence comes
  from two GET calls per error (`/issues/{id}/events/latest/` and
  `/issues/{id}/tags/`), at most 24 errors per server per minute, asked again when
  an error's events double or after fifteen minutes of new events. Between polls
  the app keeps ids, counts and yes/no answers only, never event text.
- **Notifications**: by default for outages and bugs alone (Settings →
  Notifications also offers every new error, or none): a new one, one back after
  being resolved, and a known one that got worse (a quiet hiccup that starts
  spreading, a bug that reaches many people). The first read of a server notifies
  nothing. A signed build posts them through the system's notification centre
  (`src-tauri/src/notifications.rs`): one about a single error has Resolve and
  Ignore buttons, a project's notifications stack together, and a click opens
  that error. A button that fails brings the window forward on the error with
  the reason; one on a notification from a server since replaced does nothing.
  An unsigned build is refused by macOS there and falls back to the
  notification plugin, without the buttons.
- **Setup assistant** (first run): connect GlitchTip, then either continue
  without Telegram straight to the inbox, or go on through five more stages:
  deploy the relay over SSH → pair Telegram → add the first application →
  connect a repository's agent → verify the full path. Settings → Telegram
  alerts resumes those stages later. Every change to a server or a
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
- Menu bar item with the five most serious errors that need attention, each
  behind the system's red or amber status dot (a click opens it), and the number
  notified since the window last had focus, which the Dock icon shows too. Quit
  stops the inbox; the relay, when deployed, keeps delivering to Telegram on its
  own.
- The minute's beat comes from the Rust side (`src-tauri/src/heartbeat.rs`), and
  the app opts out of App Nap: macOS slows the timers of a window that is hidden
  or behind others, and with the timer in the page a check due every minute came
  two minutes apart and later.

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

`bash test/live-glitchtip/run.sh` (repo root, needs Docker, about a minute) starts a real GlitchTip
6.2.0 on loopback, sends it a corpus of ordinary production errors (`test/live-glitchtip/corpus.mjs`:
a storefront, its API and a billing worker on a bad day) and runs the app's own poller, client and
triage against it: every scenario must be read the way the corpus says, and a new outage, an error
that returns after Resolve and a hiccup that starts spreading must each alert. Run it after changing
`src/lib/triage.ts`, `src/lib/inbox.ts` or the issue calls in `src/lib/glitchtip.ts`. With `--keep`
the server stays on `127.0.0.1:8377` for the two ways to look at it: the browser preview
(`/preview.html?scenario=ready&live=8377`), and `bash test/live-glitchtip/app.sh`, which builds a
development copy of the app ("GlitchTip Companion Live") already connected to that server. The copy
has its own bundle identifier, data folder and Keychain service, so it cannot read or change the
app you really use.

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
`<workspace ID>/<key>` account. A build under any other bundle identifier
(a development copy) uses its own service, the same name followed by its
identifier (`service_for`), and so never sees the released app's items. Rust owns every Keychain call
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

- **Self-signed instances fail TLS.** GlitchTip and Telegram calls run over
  the webview's `fetch` with normal TLS verification; there is no
  insecure-skip. Use a properly certified `https://` instance URL.
- **Only `https:` hosts are reachable from the window, and this Mac itself.**
  The CSP is `connect-src 'self' https: http://localhost:* http://127.0.0.1:*
  ipc: http://ipc.localhost`, and a server address must be HTTPS unless it is
  `http://localhost` or `http://127.0.0.1` (`acceptsToken` in
  `src/app/workspace.ts`): a GlitchTip in local Docker or behind an SSH tunnel,
  where the token never crosses a network. The agent helper still reads HTTPS
  servers only. Both GlitchTip and
  `https://api.telegram.org` answer cross-origin requests from the app
  (`Access-Control-Allow-Origin: *`, checked 2026-10-28). SSH and relay
  commands run in Rust, not in the window.
- **Pairing code is not accepted.** Codes expire after 10 minutes and work
  once; create a new one from the Telegram step and post it in the forum
  group as an administrator.
- **Copy does nothing.** Clipboard access needs a focused window — click the
  window and retry.
- **No notification appears from a local build.** macOS answers an unsigned
  app's request to notify with "Notifications are not allowed for this
  application" and asks the user nothing (macOS 27.2, 2026-11-12). The inbox,
  the menu bar item and the Dock badge still show the error; the notification
  centre needs the signed release.
- **An error is filed under the wrong kind.** The rules are the tables in
  `src/lib/triage.ts`, each with a test in `triage.test.ts`; add the pattern and
  a scenario to `test/live-glitchtip/corpus.mjs`.
