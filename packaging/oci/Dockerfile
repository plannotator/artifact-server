# syntax=docker/dockerfile:1.18@sha256:dabfc0969b935b2080555ace70ee69a5261af8a8f1b4df97b9e7fbcf6722eddf

ARG NODE_IMAGE=node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99

FROM ${NODE_IMAGE} AS build

ENV PNPM_HOME=/opt/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
WORKDIR /build

RUN corepack enable \
    && corepack prepare pnpm@10.34.3 --activate

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=artifact-server-pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts/local-package-metadata.mjs ./scripts/local-package-metadata.mjs

RUN pnpm build \
    && pnpm prune --prod --ignore-scripts \
    && find dist \( -name '*.d.ts' -o -name '*.d.ts.map' \) -delete \
    && node scripts/local-package-metadata.mjs prepare package.json package.release.json

FROM ${NODE_IMAGE} AS runtime

ARG IMAGE_CREATED=""
ARG IMAGE_REVISION="unknown"
ARG IMAGE_SOURCE=""
ARG IMAGE_SOURCE_TREE_CLEAN="false"
ARG IMAGE_VERSION="0.0.0"

LABEL org.opencontainers.image.created=${IMAGE_CREATED} \
      org.opencontainers.image.description="Self-hosted server for publishing and versioning finished client-side artifacts" \
      org.opencontainers.image.revision=${IMAGE_REVISION} \
      org.opencontainers.image.source=${IMAGE_SOURCE} \
      org.opencontainers.image.title="Artifact Server" \
      org.opencontainers.image.version=${IMAGE_VERSION} \
      org.artifactserver.image.source-tree-clean=${IMAGE_SOURCE_TREE_CLEAN}

ENV ARTIFACT_SERVER_IMAGE_REVISION=${IMAGE_REVISION} \
    HOME=/tmp \
    NODE_ENV=production \
    TMPDIR=/tmp

WORKDIR /opt/artifact-server

RUN install -d -m 0755 /usr/local/share/ca-certificates

ADD --checksum=sha256:e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3 \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    /usr/local/share/ca-certificates/aws-rds-global-bundle.pem

RUN chmod 0444 /usr/local/share/ca-certificates/aws-rds-global-bundle.pem \
    && mkdir -p /var/lib/artifact-server \
    && chown node:node /var/lib/artifact-server

COPY --from=build --chown=node:node /build/dist ./dist
COPY --from=build --chown=node:node /build/node_modules ./node_modules
COPY --from=build --chown=node:node /build/package.release.json ./package.json

USER node:node

EXPOSE 8787

ENTRYPOINT ["node", "dist/cli/main.js"]
CMD ["--help"]
