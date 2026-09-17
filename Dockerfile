# syntax=docker/dockerfile:1

FROM node:22-alpine3.20 AS portal

# Update this commit when promoting changes from the portal's contrib branch.
ARG PORTAL_COMMIT=8156dacf0e167acf5f9a0df0b3781da33df1bed1
WORKDIR /portal
ADD https://codeload.github.com/SuccubusBot/discord-tickets-portal/tar.gz/${PORTAL_COMMIT} /tmp/portal.tar.gz
RUN tar -xzf /tmp/portal.tar.gz --strip-components=1 \
	&& npm install --global pnpm@9.15.9 \
	&& pnpm install --frozen-lockfile \
	&& pnpm test \
	&& pnpm build

FROM oven/bun:1.4.2 AS builder

WORKDIR /build

COPY --link scripts scripts
RUN chmod +x ./scripts/start.sh

COPY package.json bun.lock ./

RUN CI=true bun install --production --frozen-lockfile

RUN rm -rf node_modules/@discord-tickets/settings
COPY --from=portal /portal/package.json node_modules/@discord-tickets/settings/package.json
COPY --from=portal /portal/build node_modules/@discord-tickets/settings/build

COPY --link . .

FROM node:22-alpine3.20 AS runner
LABEL org.opencontainers.image.source=https://github.com/discord-tickets/bot \
	org.opencontainers.image.description="The most popular open-source ticket bot for Discord." \
	org.opencontainers.image.licenses="GPL-3.0-or-later"

RUN apk --no-cache add curl

RUN adduser --disabled-password --home /home/container container
RUN mkdir /app \
	&& chown container:container /app \
	&& chmod -R 777 /app

RUN mkdir -p /home/container/user /home/container/logs \
    && chown -R container:container /home/container

USER container
ENV USER=container \
	HOME=/home/container \
	NODE_ENV=production \
	HTTP_HOST=0.0.0.0 \
	DOCKER=true

WORKDIR /home/container

COPY --from=builder --chown=container:container --chmod=777 /build /app

RUN node /app/scripts/check-stats.js && node /app/scripts/check-archive.js && node /app/scripts/check-portal.mjs

ENTRYPOINT [ "/app/scripts/start.sh" ]
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s \
	CMD curl -f http://localhost:${HTTP_PORT}/status || exit 1
