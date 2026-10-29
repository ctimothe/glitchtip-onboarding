---
name: glitchtip-investigate
description: Investigate a GlitchTip incident from a Companion-copied prompt (incident reference gt:<application-id>:<issue-id>). Fetches private issue context through the glitchtip-companion helper, reproduces the failure with the smallest existing test surface, and returns a diagnosis report. Read-only; never edits the repository.
---

# GlitchTip investigation

Diagnose one GlitchTip incident and produce a report. This skill never changes anything: Do not modify code, dependencies, infrastructure, or production data. If the owner wants a fix, they ask after reading your diagnosis.

Invoked as `$glitchtip-investigate` (Codex) or `/glitchtip-investigate` (Claude Code), or by a prompt that tells you to run the helper and follow this policy. Evidence rules live in `references/evidence-policy.md`; read it before writing the report.

## Hard rules

- Read-only. No edits, no commits, no dependency or infrastructure changes, no writes to production data or to any remote.
- Never ask the user for a token, password, DSN, or any credential. The helper holds the credential; you never see it.
- Redact secrets and personal data in everything you write: tokens, keys, DSNs, emails, phone numbers, IP addresses, cookies, authorization headers, user identifiers.
- If any step fails, stop and report the exact failed step with the helper exit code or command output. Do not guess, do not work around it, do not substitute another data source.

## Workflow

Run these steps in order.

1. **Validate the incident reference and repository config.** The reference must match `gt:<application-id>:<issue-id>` (for example `gt:billing-api:1842`). Check that the repository has its Companion config. A malformed reference or missing config is a configuration failure: stop and report the exact failed step.

2. **Run the helper and preserve its exact failure code.** The helper lives at the fixed per-user path `$HOME/Library/Application Support/dev.ctimothe.glitchtip-onboarding/bin/glitchtip-companion`. Run:

   `glitchtip-companion context --ref gt:<application-id>:<issue-id> --format json`

   using that full path. Exit codes:

   - 0 success: parse the JSON and continue.
   - 2 configuration: stop and report the exact failed step.
   - 3 credential: stop and report the exact failed step. Never ask for a token.
   - 4 network or API: stop and report the exact failed step.
   - 5 sanitization: the helper refused to emit unsafe context. Stop and report the exact failed step.

   If the binary does not exist at that path, the failure is `helper-not-installed`: stop and report it. Do not search for the binary elsewhere or install it.

3. **Read repository instructions before code.** Read `AGENTS.md`, `CLAUDE.md`, and `CONTEXT.md` when present, plus any nested instruction file for the directories you will touch. Follow the project's commands and invariants, read-only.

4. **Map safe frames and release to relevant code.** Use only the sanitized frames, module names, release, and environment the helper returned. Find the matching files and the code at that release. Note where frames do not map to the checkout.

5. **Reproduce with the smallest existing test surface.** Prefer an existing failing or nearby test, a single-file run, or a documented script. Run tests one-shot, never in watch mode. Do not write new files into the repository; if a reproduction needs new code, describe it in the report instead. Record the exact command and result. If you cannot reproduce, say so and what you tried.

6. **Compare the failing release or nearby change when available.** Use read-only history (`git log`, `git diff`, `git blame`) around the first failing release. Name the changes that touch the mapped code paths. Say when no release information is available.

7. **Report evidence, cause, confidence, unknowns, options, and verification.** Use the report shape below.

8. **Stop without edits.** Do not apply any option. Hand the report back and wait for the owner.

## Report shape

1. Reproduction result and evidence (command, outcome, or why not reproduced).
2. Most likely root cause, with relevant code paths (`path:line`).
3. What changed near the first failing release.
4. Confidence (low, medium, high), unknowns, and missing evidence.
5. Smallest safe fix options and a verification plan for each. Describe them; do not implement them.

Redact secrets and personal data before sending the report.

## State-specific behavior

The copied prompt or the helper JSON names the incident state. Follow the matching section; the workflow above still applies unless the section says otherwise.

### Error

Goal: reproduce and diagnose the root cause. Produce the full report shape.

### Warning

Goal: measure trend, risk, and action threshold. Use event counts, affected users, and release data from the helper to say whether the signal is rising, flat, or falling, how bad it could get, and at what threshold someone should act. Reproduction is optional; confidence and unknowns still apply.

### Resolved

Goal: confirm recovery and recurrence risk. Check whether events stopped after the resolving change or release, and whether the cause could return. Do not assume a fix: a Resolved status in GlitchTip is a label, not proof. Report what the data shows and what it cannot show.

### Test

Goal: verify delivery only. The incident is a Companion test event. Confirm the reference resolved and the helper returned context, then report that delivery works. Do not inspect application code, do not reproduce, do not compare releases.

### Setup Failure

Goal: diagnose Companion, GlitchTip, relay, or Telegram setup. Examine helper exit codes, configuration, and connectivity steps only. Do not classify it as an application failure and do not look for a root cause in application code.
