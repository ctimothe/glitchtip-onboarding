#!/bin/sh
# The public key arrives in the environment, so no file from the Mac needs sshd's ownership rules.
set -eu
printf '%s\n' "$AUTHORIZED_KEY" > /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys

# On cgroup v2, move this container's processes into a child group so the inner daemon can
# delegate controllers to its own containers, as the official docker:dind entrypoint does.
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  mkdir -p /sys/fs/cgroup/init
  xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs || :
  sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control
fi

dockerd > /var/log/dockerd.log 2>&1 &
exec /usr/sbin/sshd -D -e
