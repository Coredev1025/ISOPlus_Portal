# syntax=docker/dockerfile:1

# Local-development image for the ISO+ Portal Next.js app.
# Debian-slim so npm resolves the glibc @next/swc-linux-x64-gnu binary that the
# committed package-lock.json pins (the musl variant is not in the lockfile).
FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN chown node:node /app
USER node

FROM base AS deps
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci

FROM base AS dev
ENV NODE_ENV=development
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .
# Pre-create .next so the named volume mounted there inherits node ownership
# instead of root, otherwise `next dev` cannot write its build cache.
RUN mkdir -p /app/.next
EXPOSE 3000
CMD ["npm", "run", "dev"]
