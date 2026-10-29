#!/usr/bin/env bash
# Install the glitchtip-onboarding skill into a project (or for every project at once).
#
#   ./install.sh ~/code/projects/myapp     # project-scoped: <project>/.claude/skills/
#   ./install.sh --user                    # every project: ~/.claude/skills/
#   ./install.sh ~/code/projects/myapp --link   # symlink instead of copy (edits stay live)
#
# Project-scoped is the default because the skill is checked in with the project, so a
# teammate or a fresh clone gets it without doing anything. Use --user for a machine-wide
# copy that no repo carries.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="glitchtip-onboarding"
MODE="copy"
TARGET=""

for arg in "$@"; do
  case "$arg" in
    --user) TARGET="$HOME/.claude/skills" ;;
    --link) MODE="link" ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) TARGET="${arg%/}/.claude/skills" ;;
  esac
done

if [ -z "$TARGET" ]; then
  echo "usage: ./install.sh <project-dir> | --user  [--link]" >&2
  exit 2
fi

# Refuse a target whose parent does not exist — that is a typo'd path, not a new install,
# and creating it silently leaves a skill somewhere nobody will look for it.
parent="$(dirname "$(dirname "$TARGET")")"
[ -d "$parent" ] || { echo "refusing: $parent does not exist (typo in the project path?)" >&2; exit 1; }

mkdir -p "$TARGET"
DEST="$TARGET/$NAME"

if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  echo "replacing existing $DEST"
  rm -rf "$DEST"
fi

if [ "$MODE" = "link" ]; then
  ln -s "$SRC" "$DEST"
  echo "linked  $DEST -> $SRC"
else
  mkdir -p "$DEST"
  cp -R "$SRC/SKILL.md" "$SRC/references" "$SRC/assets" "$DEST/"
  mkdir -p "$DEST/docs"
  cp -R "$SRC/docs/sdk" "$DEST/docs/"
  echo "copied  $DEST"
fi

chmod +x "$DEST/assets/glitchtip_onboard.py" "$DEST/assets/verify.py" 2>/dev/null || true

cat <<EOF

Installed. In that project, ask an agent:

    Set up GlitchTip for this project

or invoke it directly:

    /$NAME

The skill will read the project, find what already exists, and work through provision →
scrub → wire → alert → verify. It stops and asks only where guessing would be expensive
(which instance, what must never leave the box, which Telegram group).
EOF
