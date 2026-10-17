# syntax=docker/dockerfile:1.28@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b

ARG BUN_IMAGE=oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373

# Dependency installation and the dashboard build run on the native builder.
# The final stage has no RUN instruction, so buildx can assemble amd64 and arm64
# images without emulation.
FROM --platform=$BUILDPLATFORM ${BUN_IMAGE} AS source
WORKDIR /app
ENV HUSKY=0
COPY package.json bun.lock turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

FROM source AS build
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
  bun install --frozen-lockfile --ignore-scripts
RUN bun run --filter @sre/dashboard build

FROM source AS production-dependencies
ARG TARGETARCH
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
  case "${TARGETARCH}" in \
    amd64) bun_cpu=x64 ;; \
    arm64) bun_cpu=arm64 ;; \
    *) echo "Unsupported target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
  esac && \
  bun install --frozen-lockfile --production --ignore-scripts --os=linux --cpu="${bun_cpu}"

FROM ${BUN_IMAGE} AS production
WORKDIR /app

ARG SRE_VERSION=dev
ARG SRE_REVISION=unknown
LABEL org.opencontainers.image.title="SRE Platform" \
  org.opencontainers.image.version="${SRE_VERSION}" \
  org.opencontainers.image.revision="${SRE_REVISION}"

ENV NODE_ENV=production \
  ROLE=api \
  SRE_VERSION=${SRE_VERSION} \
  SRE_REVISION=${SRE_REVISION} \
  DASHBOARD_DIST_DIR=/app/apps/dashboard/dist

COPY --from=source --chown=bun:bun /app/package.json /app/package.json
# Sources come from the stage that installed, not from `source`. Bun keeps package
# contents in the root store at node_modules/.bun and gives each workspace its own
# node_modules of symlinks into it. Copying apps and packages from `source` left
# those per-workspace directories out, so every import of a third-party package
# from inside a workspace failed to resolve at runtime even though the store was
# present. production-dependencies is `FROM source` plus the install, so it carries
# the same sources and the symlinks that make them resolvable.
COPY --from=production-dependencies --chown=bun:bun /app/apps /app/apps
COPY --from=production-dependencies --chown=bun:bun /app/packages /app/packages
COPY --from=production-dependencies --chown=bun:bun /app/node_modules /app/node_modules
COPY --from=build --chown=bun:bun /app/apps/dashboard/dist /app/apps/dashboard/dist
COPY --chown=bun:bun --chmod=0755 scripts/docker-entrypoint.sh /usr/local/bin/sre-platform

USER 1000:1000
EXPOSE 3000 8080
ENTRYPOINT ["/usr/local/bin/sre-platform"]
