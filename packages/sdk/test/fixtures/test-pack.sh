#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
fixture_dir="$(mktemp -d)"
trap 'rm -rf "$fixture_dir"' EXIT

npm pack -w @glitchtip-onboarding/sdk --pack-destination "$fixture_dir" >/dev/null
tarball="$(find "$fixture_dir" -maxdepth 1 -name '*.tgz' -print -quit)"
test -n "$tarball"

cd "$fixture_dir"
npm init -y >/dev/null
npm install --silent "$tarball" react@19 express@5 fastify@5 @nestjs/common@12 @nestjs/core@12 reflect-metadata rxjs
cp "$repo_root/packages/sdk/test/fixtures/import-esm.mjs" .
cp "$repo_root/packages/sdk/test/fixtures/import-cjs.cjs" .
node import-esm.mjs
node import-cjs.cjs
node "$repo_root/packages/sdk/test/fixtures/check-browser.mjs"
