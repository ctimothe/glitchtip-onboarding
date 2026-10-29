# Stand-in for the server beside GlitchTip: OpenSSH, bash, and its own Docker daemon with Compose v2,
# so the deploy never touches the Docker daemon that runs this container. Root logs in only with the
# key run.sh generates for one run.
FROM node:22-alpine

RUN apk add --no-cache bash openssh-server docker docker-cli-compose docker-cli-buildx \
  && ssh-keygen -A \
  && sed -i 's/^root:!/root:*/' /etc/shadow \
  && printf 'PermitRootLogin prohibit-password\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n' >> /etc/ssh/sshd_config \
  && mkdir -m 700 /root/.ssh

COPY entrypoint.sh /entrypoint.sh
CMD ["/entrypoint.sh"]
