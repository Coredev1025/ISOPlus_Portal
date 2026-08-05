# syntax=docker/dockerfile:1

# Local-development image for the ISO+ Portal API.
# Debian-slim (not alpine) because the committed package-lock.json resolves
# glibc/linux-x64 binaries, matching CI and the Elastic Beanstalk runtime.
FROM node:22-bookworm-slim AS base
WORKDIR /app
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
