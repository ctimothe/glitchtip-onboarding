# Evidence policy

Rules for what the investigation may use and how the report states it.

## Allowed evidence

- Output of `glitchtip-companion context --ref <reference> --format json` (already sanitized by the helper).
- Repository files, tests, and read-only history at the checkout.
- Output of existing test commands run one-shot.

## Not allowed

- Raw event payloads, tokens, cookies, authorization headers, or DSNs from any other source.
- Asking the user to supply a credential.
- Copying the helper's failure into a workaround. A failed step ends the investigation at that step.

## Redaction

Redact secrets and personal data in the report, command lines, and quoted output: replace values with `[redacted]`. This covers tokens, keys, emails, phone numbers, IP addresses, user identifiers, and request bodies. Keep file paths, function names, release identifiers, and counts.

## Stating confidence

- High: reproduced, and the cause is confirmed by a code path and a release change.
- Medium: not reproduced, but frames map to code and a plausible change exists near the first failing release.
- Low: partial mapping, no reproduction, or conflicting signals.

Always list unknowns and missing evidence. Never round a guess up to a finding.

## Fix options

List the smallest safe fix options, each with its risk and how to verify it. The investigation does not choose for the owner and does not apply any option.
