#!/usr/bin/env bash
# Companion end-to-end proof. Needs Docker only. Everything it creates carries one generated
# project name, and cleanup targets that name and one mktemp directory, nothing else.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# compose.yaml needs it for every command, cleanup's `down` included, or Compose rejects the file.
export COMPANION_E2E_ROOT="$ROOT"

if ! docker info >/dev/null 2>&1; then
  echo 'companion-e2e: docker daemon unavailable' >&2
  exit 1
fi

WORKDIR="$(mktemp -d)"
PROJECT="companion-e2e-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"

cleanup() {
  docker compose -p "$PROJECT" -f "$ROOT/test/companion-e2e/compose.yaml" down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT INT TERM

docker compose -p "$PROJECT" -f "$ROOT/test/companion-e2e/compose.yaml" \
  up --exit-code-from e2e --abort-on-container-exit 2>&1 | tee "$WORKDIR/e2e.log"
status="${PIPESTATUS[0]}"

if [ "$status" -ne 0 ]; then
  echo "companion-e2e: failed (exit $status)" >&2
fi
exit "$status"
