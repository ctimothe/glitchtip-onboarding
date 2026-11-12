#!/usr/bin/env bash
# The inbox against a real GlitchTip. Starts GlitchTip 6.2.0 in Docker on loopback, sends it the
# corpus of ordinary production errors (corpus.mjs) and runs the app's own poller, client and
# triage against it (apps/desktop/src/lib/inbox.live.test.ts). Needs Docker; about a minute once
# the images are there. Not a ./scripts/check step: run it after changing src/lib/triage.ts,
# src/lib/inbox.ts or the issue calls in src/lib/glitchtip.ts.
#
#   bash test/live-glitchtip/run.sh          start, check, remove
#   bash test/live-glitchtip/run.sh --keep   leave the server running on 127.0.0.1:8377 for
#                                            app.sh and the browser preview (&live=8377)
#   bash test/live-glitchtip/run.sh --down   remove a server that --keep left
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE=(docker compose -p companion-live -f "$ROOT/test/live-glitchtip/compose.yaml")
export LIVE_GLITCHTIP_PORT="${LIVE_GLITCHTIP_PORT:-8377}"
URL="http://127.0.0.1:$LIVE_GLITCHTIP_PORT"
MODE="${1:-}"

if ! docker info >/dev/null 2>&1; then
  echo 'live-glitchtip: docker daemon unavailable' >&2
  exit 1
fi
if [ "$MODE" = "--down" ]; then
  "${COMPOSE[@]}" down --volumes --remove-orphans --timeout 5
  exit $?
fi

cleanup() {
  [ "$MODE" = "--keep" ] || "${COMPOSE[@]}" down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

"${COMPOSE[@]}" up -d || exit 1
# GlitchTip migrates its database and creates its development user and token before it answers.
ready=""
for _ in $(seq 1 90); do
  if curl -fsS -o /dev/null -H "Authorization: Bearer $(printf 'd%.0s' $(seq 1 64))" "$URL/api/0/organizations/"; then
    ready=1
    break
  fi
  sleep 2
done
if [ -z "$ready" ]; then
  echo "live-glitchtip: $URL did not answer in three minutes" >&2
  "${COMPOSE[@]}" logs --tail 40 glitchtip >&2
  exit 1
fi

cd "$ROOT/apps/desktop" || exit 1
LIVE_GLITCHTIP_URL="$URL" npx vitest run src/lib/inbox.live.test.ts
status=$?
if [ "$MODE" = "--keep" ]; then
  echo "live-glitchtip: left running at $URL (organization org); remove it with run.sh --down"
fi
exit "$status"
