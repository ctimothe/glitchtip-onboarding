#!/usr/bin/env bash
# Builds a development copy of the Companion and points it at the local GlitchTip that
# compose.yaml starts, so the real window, menu bar item and notifications can be tried against
# live data. The copy has its own name, bundle identifier, data folder and Keychain service
# (src-tauri/src/keychain.rs `service_for`): it cannot read or change the app you really use.
#
#   bash test/live-glitchtip/app.sh           build, connect on first run, print how to open it
#   bash test/live-glitchtip/app.sh --reset   forget the copy's workspace and history first
#
# The copy starts connected: on first run it finds a workspace file and the local server's
# development token (a constant from GlitchTip's source, see compose.yaml) in its data folder and
# moves the token into its own Keychain service.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ID="dev.ctimothe.glitchtip-onboarding.live"
NAME="GlitchTip Companion Live"
PORT="${LIVE_GLITCHTIP_PORT:-8377}"
DATA="$HOME/Library/Application Support/$ID"
APP="$ROOT/apps/desktop/src-tauri/target/debug/bundle/macos/$NAME.app"

if [ "${1:-}" = "--reset" ]; then
  rm -f "$DATA/workspace.json" "$DATA/inbox.json" "$DATA/preferences.json" "$DATA/secrets.json"
fi

cd "$ROOT/apps/desktop"
[ -f src-tauri/binaries/node-aarch64-apple-darwin ] || npm run fetch:node
npx tauri build --debug --bundles app --config "{\"identifier\":\"$ID\",\"productName\":\"$NAME\"}"

# An unsigned build cannot read a Keychain item an earlier build of it made without macOS asking,
# and the inbox waits on that question. So the copy's one item goes after every build, and the app
# makes it again from secrets.json when it starts.
security delete-generic-password -s "dev.ctimothe.glitchtip-companion.$ID" -a "default/glitchtip-token" >/dev/null 2>&1 || true

mkdir -p "$DATA"
if [ ! -f "$DATA/workspace.json" ]; then
  NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cat > "$DATA/workspace.json" <<JSON
{"workspace":{"schemaVersion":1,"id":"default","name":"Live","locale":"en","glitchtip":{"baseUrl":"http://localhost:$PORT","organizationSlug":"org","verifiedAt":"$NOW"},"sources":[],"relay":null,"telegram":null,"applications":[],"onboarding":{"completedAt":"$NOW","currentStage":6}}}
JSON
fi
printf '{"glitchtip-token":"%s"}\n' "$(printf 'd%.0s' $(seq 1 64))" > "$DATA/secrets.json"
chmod 600 "$DATA/secrets.json"

echo
echo "Built: $APP"
echo "Open it with:  open \"$APP\""
