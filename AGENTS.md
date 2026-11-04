# glitchtip-onboarding

Agent instructions for this repository, read by every coding agent (Codex, Claude Code, OpenCode).
Human-facing overview: `README.md`.

## Purpose and stack

GlitchTip observability end to end, in four parts:

- **GlitchTip Companion** (`apps/desktop`): a macOS app in Tauri 2 (Rust) with a React 19 + Vite
  window. Its inbox polls every connected GlitchTip server once a minute, notifies on new and
  returning errors, and resolves or ignores them. Telegram alerts are optional: the app can deploy
  the relay over SSH and pair a Telegram forum group. Secrets live in the macOS Keychain, owned by
  Rust (`apps/desktop/src-tauri/src/keychain.rs`).
- **Relay** (`assets/relay`): a zero-dependency Node.js service that runs in Docker beside
  GlitchTip and delivers alerts to Telegram topics.
- **SDK** (`packages/sdk`): `@glitchtip-onboarding/sdk`, Node.js and browser runtimes plus React,
  Next.js, Express, NestJS and Fastify adapters, built on the Sentry JavaScript SDKs.
- **Agent skill** (`SKILL.md`, `assets/agent-skill`): an agent-executable onboarding procedure.

`website/` is a separate Next.js landing page with its own `package-lock.json`, outside the npm
workspaces and outside `./scripts/check`.

## Commands

```bash
npm install                                    # repo root; installs packages/* and apps/*
./scripts/check                                # the gate: every step, every failure
./scripts/check desktop-test relay             # only the named steps
npm run dev -w glitchtip-onboarding-desktop    # Tauri dev window
npm run dev:frontend -w glitchtip-onboarding-desktop   # browser preview, mocked IPC: /preview.html?scenario=ready
npm run build:debug -w glitchtip-onboarding-desktop    # unsigned local .app
npm run fetch:node -w glitchtip-onboarding-desktop     # bundled Node.js for the relay; every build needs it
bash test/companion-ssh-e2e/run.sh             # relay deploy over real SSH to a stand-in server (Docker, ~3 min)
```

## Definition of done

`./scripts/check` has run and passed, and its output was shown. Steps are listed in `STEPS` at the
top of `scripts/check`; logs land in `.check-logs/<step>.log`. `companion-e2e` needs a running
Docker daemon and `desktop-cargo` needs the Rust toolchain. A skipped step is reported as skipped,
never as passed.

## Publishing (overrides the global workflow)

`github.com/ctimothe/glitchtip-onboarding` is public. Its `main` is a line of squashed snapshot
commits, each authored as `ctimothe <119429310+ctimothe@users.noreply.github.com>` with no
co-author or tool trailers. Work branches from `origin/main` and reaches `main` through a pull
request merged with **rebase**, so the commit keeps that identity. Before every push, scan the tree
with gitleaks and look for personal emails, private hostnames and internal plan documents; dated
plans and research stay out of the public tree.

There is no `staging` branch and no CI on pull requests: the gate is `./scripts/check`, run locally
before the pull request. `.github/workflows/desktop-release.yml` runs only on a `desktop-v*` tag or
by hand, and needs Apple signing secrets that are not set yet. The in-app updater stays off until a
signed release exists (`apps/desktop/README.md`, "Release").

## Safety

- Never commit `.env*`, `assets/relay/deploy/relay.env` or any token. GlitchTip and Telegram
  tokens belong in the Keychain; the renderer reaches them only through `src/lib/keychain.ts` and
  `src/lib/secrets.ts`.
- A live check against a real GlitchTip server uses a throwaway project and test chat, or every
  error is reported twice. Delete any token file the check created.
- The relay deploys to a real server over SSH. Deploy, update or roll back only with the owner's
  go-ahead.
- Known weakness: each server's token sits in the Keychain apart from its address, so whoever edits
  the workspace file could point a token at another address.

## Invariants

- Every GlitchTip API call lives in `apps/desktop/src/lib/glitchtip.ts`. Reading stays GET-only;
  the only writes are resolve and ignore (`setIssueStatus`) and project setup
  (`provisionInventory`).
- The inbox notifies only for errors never seen before and errors back after being resolved; the
  first read of a server is the baseline and notifies nothing (`src/lib/inbox.ts`).
- Agent context is sanitized before it leaves the app (`src-tauri/src/helper.rs`); redaction rules
  have regression tests, and `scripts/security-scan` runs a canary corpus through every boundary.
- Styles come from the semantic tokens at the top of `apps/desktop/src/styles.css` and the
  primitives in `apps/desktop/src/components/ui`. Screens hold no colour, radius, shadow or font
  values and no raw `<button>`, `<input>`, `<select>` or `<textarea>`.
- Every user-facing string is in `apps/desktop/src/i18n/en.ts`, `ru.ts` and `uz.ts`. The app
  follows the Mac's language on first run.
- One failure surface per event: a server the inbox cannot read shows as one inline alert in the
  inbox, never also as a toast.

## Map

| Path | Read first |
|---|---|
| `apps/desktop/` | `apps/desktop/README.md`: features, scripts, release steps, Keychain layout, troubleshooting |
| `apps/desktop/src/lib/` | the module's own `*.test.ts` |
| `apps/desktop/src-tauri/` | `keychain.rs` before any secret work, `remote.rs` before SSH or deploy work |
| `assets/relay/` | `docs/operations/install.md` and `docs/operations/security.md` |
| `packages/sdk/` | `docs/sdk/getting-started.md` |
| `docs/operations/` | operator procedures; some are marked "not yet verified" until run on a live server |
| `test/` | `companion-e2e` (Docker), `companion-ssh-e2e` (Docker, SSH), `security` (canary corpus) |
