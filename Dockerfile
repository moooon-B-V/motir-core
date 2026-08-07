# syntax=docker/dockerfile:1
#
# motir-core on Fly.io — SPIKE (MOTIR-2383).
#
# ⚠️ NOT a production Dockerfile yet. It exists to answer one question: what
# does motir-core look like as a SINGLE long-running process instead of ~490
# serverless functions? See the spike's PR body for the measurement.
#
# ── Why this shape ──────────────────────────────────────────────────────────
# `next build` with `output: 'standalone'` traces the whole app ONCE and emits a
# self-contained server with a minimal node_modules. Every route shares that one
# process, so a heavy dependency is resident once rather than copied per route —
# which is the entire reason the Vercel build exhausts its packaging disk
# (MOTIR-2371: Prisma's 4.9 MB WASM compiler x 490 bundles).
#
# Measured on this branch: 374 MB standalone + 7 MB static, against 4,240 MB
# traced across 490 function bundles on Vercel. One copy of the WASM compiler,
# not 490.
#
# ── Multi-stage, and why the builder is fat ─────────────────────────────────
# The builder needs the FULL dependency set: `postinstall` runs `prisma generate`
# and builds @motir/design-system, and `next build` needs devDependencies. The
# runner takes only `.next/standalone`, `.next/static` and `public`, so none of
# that reaches the shipped image.

# ── deps ────────────────────────────────────────────────────────────────────
FROM node:22-slim AS deps
WORKDIR /app
RUN corepack enable
# openssl: Prisma's client probes for it at generate time even on the WASM path.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/design-system/package.json packages/design-system/
COPY packages/cli/package.json packages/cli/
COPY prisma ./prisma
# --ignore-scripts here: postinstall needs the full source tree (it builds the
# design-system package), which is not copied yet. It runs in the builder below.
RUN pnpm install --frozen-lockfile --ignore-scripts

# ── build ───────────────────────────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app
RUN corepack enable
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/design-system/node_modules ./packages/design-system/node_modules
COPY . .
# `prisma generate` + the design-system build, the two things postinstall does.
RUN pnpm prisma generate \
 && pnpm --filter @motir/design-system build
# The build only needs these to satisfy module-load `requiredEnv` checks during
# page-data collection; next.config.ts already seeds placeholders for non-prod.
# DATABASE_URL is read at RUNTIME, never at build time.
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ── runner ──────────────────────────────────────────────────────────────────
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Fly's proxy talks to the port in fly.toml; Next's standalone server binds
# HOSTNAME, which MUST be 0.0.0.0 — the default binds the container hostname and
# nothing outside can reach it (verified in the spike: localhost got no answer
# until HOSTNAME was set).
ENV HOSTNAME=0.0.0.0
ENV PORT=8080
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

# The standalone bundle carries its own minimal node_modules; static and public
# are NOT included by Next and must be copied alongside it.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# Migrations are applied by fly.toml's release_command, which runs the Prisma
# CLI — so the schema and its migrations have to be in the image.
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.bin/prisma ./node_modules/.bin/prisma

USER nextjs
EXPOSE 8080
CMD ["node", "server.js"]
