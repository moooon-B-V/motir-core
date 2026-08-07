# syntax=docker/dockerfile:1
#
# motir-core on Fly.io — the production image (MOTIR-2387).
#
# ── Why this shape ──────────────────────────────────────────────────────────
# `next build` with `output: 'standalone'` traces the whole app ONCE and emits a
# self-contained server with a minimal node_modules. Every route shares that one
# process, so a heavy dependency is resident once rather than copied per route —
# which is the entire reason the Vercel build exhausted its packaging disk
# (MOTIR-2371: Prisma's 4.9 MB WASM compiler x 490 bundles). The decision and its
# measurements are `docs/decisions/application-hosting.md` Q1; the spike that
# produced them is MOTIR-2383.
#
#   standalone server   375 MB  (of which 222 MB is design/ — see the note below)
#   static assets         7 MB
#   against Vercel    4,240 MB  traced across 490 function bundles
#
# ── Multi-stage, and why the builder is fat ─────────────────────────────────
# The builder needs the FULL dependency set: `postinstall` runs `prisma generate`
# and builds @motir/design-system, and `next build` needs devDependencies. The
# runner takes only the standalone output plus the migration toolchain below, so
# none of the builder's tree reaches the shipped image.

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
# ⚠️ `next build`, NOT `pnpm build`. The `build` script is
# `prisma generate && node scripts/migrate-deploy.mjs && next build` — it applies
# MIGRATIONS, because on Vercel the build was the only deploy hook there was.
# Here it is not: Fly's release_command owns migrations (fly.toml), and running
# them during an image build would fail the build outright (no DATABASE_URL is
# set at build time, by design) or, worse, migrate whatever database the builder
# could reach. `prisma generate` is already done, one step up.
#
# The build needs OAuth/auth values only to satisfy module-load `requiredEnv`
# checks during page-data collection; next.config.ts seeds placeholders for
# non-prod. DATABASE_URL is read at RUNTIME.
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm exec next build

# ── the migration toolchain ─────────────────────────────────────────────────
# `fly.toml`'s release_command runs `prisma migrate deploy` inside THIS image,
# and the pnpm tree above cannot come with it. Two reasons, both verified rather
# than assumed (MOTIR-2387):
#
#   1. `node_modules/prisma` under pnpm is a SYMLINK into `.pnpm/<hash>/`, and
#      the CLI's dependencies are that directory's SIBLINGS, not the package's
#      children. Copying `node_modules/prisma` into the runner therefore yields
#      `Cannot find module '@prisma/engines'` on the first invocation — a deploy
#      that dies in the release step, before any machine takes traffic.
#   2. `node_modules/.bin/prisma` is a pnpm shim carrying ABSOLUTE build-host
#      paths in its NODE_PATH export, so it does not survive relocation either.
#
# So the toolchain is a FLAT, relocatable npm tree, pinned to the exact versions
# pnpm resolved (read from the installed packages, so it cannot drift from the
# lockfile behind a `^` range), installed HERE so any platform-specific artifact
# matches the runner's architecture. `dotenv` is in the set because
# `prisma.config.ts` imports it. It is not small (~225 MB, nearly all of it
# @prisma/studio-core, which the CLI bundle requires eagerly — pruning it breaks
# `migrate deploy` with `Cannot find module '@prisma/studio-core/data/bff'`), and
# it is the price of a migration lane that runs from the app's own image.
RUN PRISMA_VERSION="$(node -p "require('prisma/package.json').version")" \
 && DOTENV_VERSION="$(node -p "require('dotenv/package.json').version")" \
 && npm install --prefix /migrate --no-audit --no-fund --save-exact \
      "prisma@${PRISMA_VERSION}" "dotenv@${DOTENV_VERSION}"

# ── runner ──────────────────────────────────────────────────────────────────
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# ⚠️ HOSTNAME MUST be 0.0.0.0, and omitting it FAILS SILENTLY. Next's standalone
# server binds the CONTAINER HOSTNAME by default: the process logs "✓ Ready",
# every health signal looks correct, and nothing outside the container can reach
# it — on a first deploy it presents as a networking problem and is debugged as
# one. Verified the hard way during the spike (MOTIR-2383).
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

# ── /app/migrate — the release lane, in ONE self-contained directory ────────
# It gets its own directory rather than merging into the standalone server's
# node_modules for two independent reasons:
#
#   * The two trees share `@prisma`, `react` and `react-dom`, and a merge would
#     let the CLI's copies shadow the ones the running server was traced against.
#   * `prisma.config.ts` is a MODULE, not a data file: it imports `dotenv` and
#     `prisma/config`, which Node resolves from the config file's OWN directory.
#     Left at /app it resolves against the standalone server's minimal
#     node_modules, which has neither, and the release command dies with
#     `Cannot find module 'dotenv'` — verified (MOTIR-2387). Beside the toolchain
#     it simply works.
#
# Next's tracer happens to sweep the repo root into the standalone output today,
# so `prisma/` and `scripts/` also land at /app whether or not anything asks. The
# release lane must not inherit them from that: it is a tracing side effect a
# Next upgrade could withdraw without a word. Everything it reads is copied here
# explicitly.
COPY --from=builder --chown=nextjs:nodejs /migrate/node_modules ./migrate/node_modules
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./migrate/prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./migrate/prisma.config.ts
COPY --from=builder --chown=nextjs:nodejs /app/scripts/migrate-deploy.mjs ./migrate/migrate-deploy.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/release-migrate.mjs ./migrate/release-migrate.mjs

USER nextjs
EXPOSE 8080
CMD ["node", "server.js"]
