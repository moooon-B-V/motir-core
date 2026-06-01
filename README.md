# prodect-core

Open-source PM substrate for **Prodect** — an AI-native project management tool
for small startup teams. The user describes what they want to build; Prodect
produces a structured Epic → Story → Subtask tree; coding agents execute the
Subtasks one at a time using prompts Prodect generates.

## Open source

`prodect-core` is **open source under the GPL-3.0 license** (see [LICENSE](LICENSE)).
This repo is the **PM substrate**: Work Items, Stories, dependency graph,
multi-tenant workspaces, projects, the tree-view UI, GitHub integration, the
human-todo queue, the delivery agent. The kind of thing Jira and Linear are,
but open and AI-native.

The **closed-source planning intelligence** — the planner agent, prompt
generation, async-expansion loop, shared-context retrieval — ships separately
as the proprietary [`prodect-ai`](https://github.com/moooon-B-V/prodect-ai) service.
It runs headless and is called server-to-server by `prodect-core`. Browsers
never talk to `prodect-ai` directly, so the user experience stays unified
(one app, one domain, one cookie) and the GPL boundary stays clean (a network
service interface is not a derivative work).

See `vision.html` principle #19 and `feasibility.html` ADR-008 in the planning
docs for the open-core architecture rationale. This split follows the same
playbook as GitLab, Sentry, Plane, and Mattermost.

## Stack

- **Runtime**: [Node.js](https://nodejs.org) ≥22 (pnpm 11 requires it)
- **Framework**: [Next.js 16](https://nextjs.org) (App Router, React Server Components, Turbopack)
- **Language**: [TypeScript](https://www.typescriptlang.org) (strict mode; `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`)
- **Styling**: [Tailwind CSS v4](https://tailwindcss.com)
- **Persistence**: [Postgres 16](https://www.postgresql.org) (local Docker; host port `5433` to coexist with other local Postgres instances) + [Prisma 7](https://www.prisma.io) with [`@prisma/adapter-pg`](https://www.npmjs.com/package/@prisma/adapter-pg). Connection URL lives in [`prisma.config.ts`](prisma.config.ts) (Prisma 7 split it out of `schema.prisma`).
- **Auth**: NextAuth / Better-Auth (lands in Story 1.1 — not yet present)
- **Testing**: [Vitest](https://vitest.dev) unit + [Playwright](https://playwright.dev) e2e (scaffolding lands in later Subtasks)
- **Lint / format**: [ESLint 9](https://eslint.org) (flat config) + [Prettier 3](https://prettier.io). [Husky](https://typicode.github.io/husky) pre-commit hook runs [lint-staged](https://github.com/lint-staged/lint-staged) to auto-fix staged files on every commit.
- **Package manager**: [pnpm](https://pnpm.io) (version pinned via `packageManager` in `package.json`; use `corepack enable`)
- **Deploy**: [Vercel](https://vercel.com) (lands in Subtask 1.0.5)
- **CI**: [GitHub Actions](https://docs.github.com/actions) — three parallel jobs (lint, typecheck, build) on every PR; build uses a Postgres service container

This Stack section is the **authoritative reference** for every later coding-agent
prompt. Prodect's planner (Epic 4) reads it verbatim into Subtask prompts so
generated code matches the project's actual stack.

## Local setup

Prerequisites: [Node 22+](https://nodejs.org), [Docker](https://www.docker.com) or
[OrbStack](https://orbstack.dev), [pnpm](https://pnpm.io) (`corepack enable`
will handle this).

```bash
cp .env.example .env       # creates the dev DATABASE_URL
pnpm install               # installs deps + sets up husky pre-commit hook
./scripts/db-up.sh         # starts Postgres in Docker and applies migrations
pnpm dev                   # http://localhost:3000
```

You should see a placeholder "Prodect" page on a dark theme — not the default
`create-next-app` welcome page.

### Scripts

| Script              | What it does                                 |
| ------------------- | -------------------------------------------- |
| `pnpm dev`          | Start the dev server on `localhost:3000`     |
| `pnpm build`        | Production build (must pass with 0 warnings) |
| `pnpm start`        | Start the production server                  |
| `pnpm lint`         | Run ESLint                                   |
| `pnpm format`       | Run Prettier and write fixes in place        |
| `pnpm format:check` | Run Prettier in check mode (used by CI)      |
| `pnpm typecheck`    | Run `tsc --noEmit`                           |

## Project layout

```
app/          Next.js App Router routes
components/   React UI primitives (filled in Story 1.0.5)
lib/          Server-side logic (DB, auth, agents). `lib/db.ts` exports the
              singleton PrismaClient with the dev-mode hot-reload guard.
prisma/       Prisma schema + migrations. Real models (User, Workspace,
              WorkItem) land in Stories 1.1 / 1.2 / 1.4. Current placeholder
              `MigrationMarker` exists only to prove the migration system works.
tests/        Vitest unit + Playwright e2e (scaffolding lands in later Subtasks)
docs/         Project docs. Design system lands here in Story 1.0.5.
scripts/      Dev-loop scripts. `db-up.sh` brings up Postgres + runs migrations.
public/       Static assets
.github/
  workflows/  CI definitions (see Testing below)
```

## Testing

CI runs on every PR and push to `main` via [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
Three parallel jobs:

- **Lint** — `pnpm lint` + `pnpm format:check`
- **TypeScript** — `pnpm prisma generate` then `pnpm typecheck`
- **Build** — `pnpm prisma migrate deploy` then `pnpm build`, against a
  Postgres 16 service container

The full suite targets <3 min on a fresh clone. The pre-commit hook (Husky +
lint-staged) catches lint/format issues before they reach CI; CI is the
backstop, not the primary gate.

Unit + e2e test scaffolding (Vitest, Playwright) lands in later Subtasks.

### Running the Playwright E2E suite locally

```bash
pnpm exec playwright install chromium   # one-time: download the browser
pnpm test:e2e                           # run the suite
```

On a **no-root dev container** (e.g. the agent sandbox — non-root user, no
`sudo`), Chromium can't launch because its system libraries aren't installed
and `playwright install-deps` needs root. Use the no-root path instead:

```bash
pnpm test:e2e:local                     # installs the libs (user-space) + runs
```

`test:e2e:local` runs [`scripts/e2e-browser-deps.sh`](scripts/e2e-browser-deps.sh),
which downloads Chromium's deps with `apt-get --download-only` and extracts them
into `~/.cache/prodect-e2e-deps` (no root), exposes them via `LD_LIBRARY_PATH`,
then runs `pnpm test:e2e`. It's idempotent and a no-op where the libs already
exist. Args pass through: `pnpm test:e2e:local shell.spec.ts`. CI is unaffected
— its Playwright job installs the deps system-wide with
`playwright install --with-deps chromium`.

## Deploys

Deployed on [Vercel](https://vercel.com) (Hobby tier for v1). Database is
managed [Neon](https://neon.tech) Postgres via the official Vercel-Neon
integration, which auto-provisions an isolated database branch for each
Vercel preview deploy.

- **Production**: every push to `main` triggers a production deploy at
  <https://prodect-core.vercel.app> (Vercel's auto-assigned default; a real
  apex domain lands in Epic 5).
- **Previews**: every PR triggers an isolated preview deploy. Vercel posts
  the preview URL as a PR comment. The preview URL follows the pattern
  `prodect-core-git-<branch>-zhuyue11s-projects.vercel.app` (per-branch
  stable) or `prodect-core-<hash>-zhuyue11s-projects.vercel.app` (per-deploy).
  Each preview gets its own Neon DB branch so PRs can safely run destructive
  migrations without affecting production.
- **Rollback**: Vercel dashboard → Deployments → click any previous deploy
  → "Promote to Production". Or `vercel rollback` from the Vercel CLI.
- **Env vars**: managed in the Vercel dashboard (Settings → Environment
  Variables). The Neon integration sets ~10 env vars; the two we use are
  `DATABASE_URL` (pooled, for runtime queries via PgBouncer — used by
  `lib/db.ts`) and `DATABASE_URL_UNPOOLED` (direct connection — used by
  `prisma migrate deploy`, since PgBouncer in transaction mode breaks
  migrations). The other env vars (`POSTGRES_URL`, `PGHOST`, etc.) are
  unused by Prodect and can be ignored. Never commit secrets to git.
  `.env.example` documents what's needed locally.
- **Build pipeline**: Vercel runs `pnpm install` (which triggers
  `postinstall: prisma generate` to refresh the Prisma client against the
  current schema), then `pnpm build` (which is `next build`). Prisma
  migrations run automatically against the connected Neon branch.

## Docs

- [`docs/design-system.md`](./docs/design-system.md) — canonical reference
  for using the design system: tokens, primitives, patterns, voice & tone,
  don'ts. Read this when building any UI.
- [`docs/DESIGN.md`](./docs/DESIGN.md) — architectural spec of the design
  system: token taxonomy, palette/typography/spacing rules, component
  implementation notes.
- [`/tokens`](./app/tokens/page.tsx) — live specimen route. Visit
  `localhost:3000/tokens` to see every token + primitive rendered with
  interactive theme + display-style toggles.
- **Planning corpus** (sibling to this repo, not inside it): `vision.html` for
  the 19 design principles, `feasibility.html` for ADRs (incl. ADR-008 on
  open-core), `discovery.html` / `validation.html` / `workflow.html` for
  product context, `prodect_plan.html` + `prodect_plan/` for the Epic-Story-
  Subtask build plan, `notes.html` for the running mistakes-log + lessons.

## License

[GPL-3.0-only](LICENSE). The planning intelligence ships separately under a
proprietary license in [`moooon-B-V/prodect-ai`](https://github.com/moooon-B-V/prodect-ai).
See `feasibility.html` ADR-008 in the planning docs for the open-core split
rationale.
