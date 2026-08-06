# syntax=docker/dockerfile:1

# Local-development image for the ISO+ Portal API.
# Debian-slim (not alpine) because the committed package-lock.json resolves
# glibc/linux-x64 binaries, matching CI and the Elastic Beanstalk runtime.
FROM node:22-bookworm-slim AS base
WORKDIR /app
# libcurl4 is required by the mongod binary that mongodb-memory-server downloads
# for the test suite. Without it every test file fails at startup with
# "a library is missing or cannot be opened: libcurl.so.4" — 35 of 35 locally,
# while CI passes because ubuntu-latest ships libcurl. Debian-slim does not.
# test/setup.js prefers a system mongod when MONGOMS_SYSTEM_BINARY or
# /usr/bin/mongod exists; this covers the downloaded-binary path instead, which
# is what runs by default.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libcurl4 \
    && rm -rf /var/lib/apt/lists/*
RUN chown node:node /app
USER node

FROM base AS deps
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci

FROM base AS dev
ENV NODE_ENV=development
# nodemon needs a writable cwd; logs/ and uploads/ are created at runtime by
# the app (utils/logger.js does mkdir on boot).
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .
EXPOSE 3001
CMD ["npm", "run", "dev"]
