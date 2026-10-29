# GlitchTip Companion relay. Build context: assets/relay (see deploy/compose.yaml).
# Node 22.23.2 LTS on Alpine 3.24, pinned to the multi-arch index digest resolved on 2026-09-23
# with `docker buildx imagetools inspect node:22.23.2-alpine`.
FROM node:22.23.2-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85

ENV NODE_ENV=production
WORKDIR /app

# Runtime modules only. ../.dockerignore keeps tests, deploy files, and relay.env out of the
# build context, and the code stays root-owned so the relay cannot rewrite itself.
COPY *.js ./
COPY locales/ ./locales/

# The named volume copies this directory's ownership on first mount.
RUN mkdir -p /var/lib/glitchtip-companion \
  && chown node:node /var/lib/glitchtip-companion \
  && chmod 0700 /var/lib/glitchtip-companion

USER node
CMD ["node", "server.js"]
