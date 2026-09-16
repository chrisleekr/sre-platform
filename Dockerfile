# syntax=docker/dockerfile:1.27@sha256:bde3983e9c939224420ddaf6b784cc30e09b035a4dea01f581230c50809f372e

ARG BUN_IMAGE=oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f

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
