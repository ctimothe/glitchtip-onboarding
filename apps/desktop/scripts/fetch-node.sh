#!/usr/bin/env bash
# Puts the official Node.js build the app bundles (tauri.conf.json `externalBin`) at
# src-tauri/binaries/node-aarch64-apple-darwin, checked against pinned checksums.
# Apple silicon only, like the release build.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=24.21.0
NAME="node-v$VERSION-darwin-arm64"
# From https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
ARCHIVE_SHA256=bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057
# bin/node inside that archive
BINARY_SHA256=e4b5a3af0e05c75de2eae013904145f40fe7fc2a6e6f17510128bf45cca4e79b
TARGET=src-tauri/binaries/node-aarch64-apple-darwin

sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }

if [[ -f "$TARGET" && "$(sha256 "$TARGET")" == "$BINARY_SHA256" ]]; then
  echo "Node.js v$VERSION is already at $TARGET"
  exit 0
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL --proto '=https' --tlsv1.2 -o "$work/node.tar.gz" "https://nodejs.org/dist/v$VERSION/$NAME.tar.gz"
if [[ "$(sha256 "$work/node.tar.gz")" != "$ARCHIVE_SHA256" ]]; then
  echo "The download of $NAME.tar.gz does not match its pinned checksum." >&2
  exit 1
fi
tar -xzf "$work/node.tar.gz" -C "$work" "$NAME/bin/node"
if [[ "$(sha256 "$work/$NAME/bin/node")" != "$BINARY_SHA256" ]]; then
  echo "bin/node in $NAME.tar.gz does not match its pinned checksum." >&2
  exit 1
fi
mkdir -p src-tauri/binaries
install -m 755 "$work/$NAME/bin/node" "$TARGET"
echo "Node.js v$VERSION -> $TARGET"
