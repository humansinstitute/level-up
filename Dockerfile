ARG BUN_VERSION=1.3.0

FROM oven/bun:${BUN_VERSION}-debian AS build
WORKDIR /app
RUN printf '%s\n' 'level-up-release-2026-09-23-f0c3e0b' > /tmp/level-up-release-marker
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
COPY public ./public
RUN bun run build

FROM oven/bun:${BUN_VERSION}-debian
ARG GOOSE_VERSION=1.43.0
WORKDIR /app
ENV NODE_ENV=production
ENV LEVELUP_GOOSE_BIN=/usr/local/bin/goose
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
RUN apt-get update \
    && apt-get install -y --no-install-recommends bzip2 ca-certificates curl \
    && architecture="$(dpkg --print-architecture)" \
    && case "$architecture" in \
      amd64) goose_arch="x86_64"; goose_sha="b218b08c0a86c9f356623f51bb91fc14c4de6667bc9c15d6d922778beb20f1bf" ;; \
      arm64) goose_arch="aarch64"; goose_sha="5d2e93b7c740409ce09782d98b70db87eac2e1fcff527bdbaf44a98da8b3b597" ;; \
      *) echo "Unsupported architecture: $architecture" >&2; exit 1 ;; \
    esac \
    && curl --fail --location --show-error --silent \
      "https://github.com/aaif-goose/goose/releases/download/v${GOOSE_VERSION}/goose-${goose_arch}-unknown-linux-gnu.tar.bz2" \
      --output /tmp/goose.tar.bz2 \
    && echo "${goose_sha}  /tmp/goose.tar.bz2" | sha256sum --check --strict \
    && tar --extract --bzip2 --file /tmp/goose.tar.bz2 --directory /usr/local/bin ./goose \
    && chmod 0755 /usr/local/bin/goose \
    && rm /tmp/goose.tar.bz2 \
    && goose --version | grep -F "${GOOSE_VERSION}" \
    && rm -rf /var/lib/apt/lists/*
RUN bunx playwright install --with-deps chromium
COPY --from=build /app/dist ./dist
COPY src ./src
COPY public/templates ./public/templates
EXPOSE 3000
CMD ["bun", "run", "start"]
