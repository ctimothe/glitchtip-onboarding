# glitchtip-onboarding

End-to-end GlitchTip observability: a JavaScript/TypeScript SDK, the Companion desktop app, a Telegram alert relay, and an agent skill that wires it all up.

> The goal is not "the SDK is installed". The goal is: **a real error, in production, reaches a human in Telegram, with enough context to fix it, and without carrying user data out of the box.** An install that stops short of that has produced a dashboard, and nobody looks at a dashboard at 2am.

## Repo layout

| Path | What it is |
|---|---|
| `packages/sdk` | Publishable TypeScript package (`@glitchtip-onboarding/sdk`): Node.js and browser runtimes plus React, Next.js, Express, NestJS, and Fastify adapters |
| `apps/desktop` | Companion, the Tauri desktop app that walks through GlitchTip onboarding and pairs the Telegram relay |
| `assets/relay` | Companion relay: zero-dependency multi-project Telegram alert relay, with deploy files in `assets/relay/deploy` |
| `assets/agent-skill` | Agent skill content and its tests |
| `assets/` (other) | Provisioning and verification scripts (`glitchtip_onboard.py`, `verify.py`) and scrubbing templates |
| `website` | Next.js website |
| `docs/sdk` | Framework setup guides: getting started, React, Next.js, Express, NestJS, Fastify |
| `docs/operations` | Operator docs: install, upgrade, rollback, security, agent handoff |
| `SKILL.md` | Agent-executable onboarding procedure: provision the project, wire the SDK, connect the relay, and prove a real event arrived |

## Quickstart

**App users** - run Companion; start at [`apps/desktop/README.md`](apps/desktop/README.md).

**SDK users** - setup guides live in [`docs/sdk/`](docs/sdk/getting-started.md). The SDK is not yet on npm. Build a tarball and install it in your application:

```bash
npm install
npm run build -w @glitchtip-onboarding/sdk
npm pack -w @glitchtip-onboarding/sdk
```

Then install the generated `.tgz` file in the target application.

**GlitchTip operators** - deploy the Telegram relay; start at [`docs/operations/install.md`](docs/operations/install.md).

## Links

- Repository: <https://github.com/ctimothe/glitchtip-onboarding>
- GlitchTip upstream: <https://glitchtip.com>
- Transport base: the SDK builds on the Sentry JavaScript SDKs (<https://github.com/getsentry/sentry-javascript>)

## License

MIT - see [LICENSE](LICENSE).

## Release

Human-run release steps (maintainers only; do not automate publication):

```bash
npm run build -w @glitchtip-onboarding/sdk
npm pack -w @glitchtip-onboarding/sdk --dry-run   # inspect contents first
npm publish -w @glitchtip-onboarding/sdk --access public   # requires npm login with publish rights
```
