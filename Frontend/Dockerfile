# syntax=docker/dockerfile:1

# Local-development image for the ISO+ Portal Next.js app.
# Debian-slim so npm resolves the glibc @next/swc-linux-x64-gnu binary that the
# committed package-lock.json pins (the musl variant is not in the lockfile).
FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN chown node:node /app
USER node

FROM base AS deps
# .npmrc must come too. It carries legacy-peer-deps=true, which every other way
# of installing this app picks up automatically — a developer running npm in
# Frontend/, and CI, which checks out the whole repo. Only this build saw a
# different npm config, so only this build failed, with an ERESOLVE that looked
# like a dependency problem rather than a missing config file.
COPY --chown=node:node package.json package-lock.json .npmrc ./
RUN npm ci

FROM base AS dev
ENV NODE_ENV=development
ENV NEXT_TELEMETRY_DISABLED=1

# Shared libraries Chromium needs for the Playwright suite (npm run e2e).
# Without them the browser exits 127 with "libglib-2.0.so.0: cannot open shared
# object file" and every e2e test fails at launch — which is why that suite had
# never actually run. Dev stage only, so production images stay lean; the
# browser binary itself is not baked in, `npm run e2e:install` fetches it into
# the container's cache on first use.
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libglib2.0-0 libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
        libcups2 libdrm2 libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 \
        libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    && rm -rf /var/lib/apt/lists/*
USER node

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .
# Pre-create .next so the named volume mounted there inherits node ownership
# instead of root, otherwise `next dev` cannot write its build cache.
RUN mkdir -p /app/.next
EXPOSE 3000
CMD ["npm", "run", "dev"]
