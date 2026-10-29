#!/usr/bin/env bash
# Deploys the relay the way the Mac app does: the app's own Rust deploy code (remote.rs) over real
# SSH, with host key checking on, to a stand-in server that runs its own Docker daemon. Needs Docker
# only. It never reads ~/.ssh: the key and known_hosts it uses are generated here and deleted
# afterwards.
#
# The relay, its image, volume and network live inside the stand-in, so cleanup removes one
# container (with its anonymous volume), one image, both carrying one generated name, and one
# mktemp directory. Nothing else on this Docker daemon is touched. The stand-in runs privileged
# because it hosts a Docker daemon, and that daemon pulls the relay's pinned Node base image.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if ! docker info >/dev/null 2>&1; then
  echo 'companion-ssh-e2e: docker daemon unavailable' >&2
  exit 1
fi

NAME="companion-ssh-e2e-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
WORKDIR="$(mktemp -d)"

cleanup() {
  docker rm -f -v "$NAME" >/dev/null 2>&1 || true
  docker rmi "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT INT TERM

fail() {
  echo "companion-ssh-e2e: $1" >&2
  docker logs "$NAME" >&2 2>&1
  docker exec "$NAME" tail -20 /var/log/dockerd.log >&2 2>&1
  exit 1
}

ssh-keygen -q -t ed25519 -N '' -C "$NAME" -f "$WORKDIR/id_ed25519" || exit 1
docker build -q -t "$NAME" "$ROOT/test/companion-ssh-e2e" >/dev/null || exit 1
# A private cgroup namespace, whatever the daemon's default, so entrypoint.sh can only rearrange
# the container's own cgroups.
docker run -d --name "$NAME" --privileged --cgroupns=private -p 127.0.0.1::22 -v /var/lib/docker \
  -e AUTHORIZED_KEY="$(cat "$WORKDIR/id_ed25519.pub")" "$NAME" >/dev/null || exit 1

PORT="$(docker port "$NAME" 22/tcp | head -1 | sed 's/.*://')"
printf '[127.0.0.1]:%s %s\n' "$PORT" "$(docker exec "$NAME" cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)" > "$WORKDIR/known_hosts"

ready=
for _ in $(seq 1 30); do
  if ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$WORKDIR/known_hosts" \
    -o GlobalKnownHostsFile=/dev/null -o IdentitiesOnly=yes -i "$WORKDIR/id_ed25519" -p "$PORT" root@127.0.0.1 \
    docker info >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ -n "$ready" ] || fail 'the stand-in server never accepted SSH with its Docker daemon up'
# The network the relay joins beside GlitchTip, on the stand-in's daemon, with a GlitchTip
# stand-in on it that sends webhooks to private addresses, as pre-flight requires. It is the
# relay's own pinned base image under a GlitchTip name, so nothing extra is downloaded.
docker exec "$NAME" docker network create glitchtip >/dev/null || fail 'could not create the glitchtip network'
BASE_IMAGE="$(sed -n 's/^FROM //p' "$ROOT/assets/relay/deploy/Dockerfile" | head -1)"
docker exec "$NAME" sh -c "docker pull -q '$BASE_IMAGE' >/dev/null && docker tag '$BASE_IMAGE' glitchtip/glitchtip:e2e" ||
  fail 'could not pull the base image for the GlitchTip stand-in'
docker exec "$NAME" docker run -d --name glitchtip-web --network glitchtip -e GLITCHTIP_ALLOW_PRIVATE_IPS=true \
  glitchtip/glitchtip:e2e sleep 3600 >/dev/null || fail 'could not start the GlitchTip stand-in'

COMPANION_SSH_E2E_PORT="$PORT" \
COMPANION_SSH_E2E_KEY="$WORKDIR/id_ed25519" \
COMPANION_SSH_E2E_KNOWN_HOSTS="$WORKDIR/known_hosts" \
COMPANION_SSH_E2E_NETWORK=glitchtip \
  cargo test --manifest-path "$ROOT/apps/desktop/src-tauri/Cargo.toml" ssh_e2e -- --ignored --nocapture
status=$?

if [ "$status" -ne 0 ]; then
  echo "companion-ssh-e2e: failed (exit $status)" >&2
fi
exit "$status"
