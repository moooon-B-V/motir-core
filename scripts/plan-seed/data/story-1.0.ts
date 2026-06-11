import type { PlanStory } from '../types';

/**
 * Story 1.0 — Project bootstrap.
 * Faithful transcription of prodect_plan/story-1.0-project-bootstrap.html (frozen archive).
 */
export const story_1_0: PlanStory = {
  id: '1.0',
  title: 'Project bootstrap',
  status: 'done',
  descriptionMd:
    'Stand up the empty Next.js + TypeScript + Postgres + Prisma + Tailwind scaffold that every ' +
    'subsequent Story builds on. Without this, the very first `motir next` call would ' +
    'hand an agent an empty directory with no tooling, no config, and no clue what stack to use. ' +
    'This Story exists so that all later prompts can assume "the project is set up the standard way."\n\n' +
    '**Prerequisite for everything else.** Story 1.0 must complete before Story 1.0.5 ' +
    '(design system) and Story 1.1 (auth). The artifacts it produces — repo structure, README, env ' +
    "files, CI config — become shared context that Epic 4's prompt-generation agent will reference " +
    'in every Subtask prompt.\n\n' +
    '**This version is the Next.js variant.** The Subtasks below assume the user picked ' +
    "Next.js + Postgres + Prisma + Tailwind in Epic 2's *stack discovery* Story (2.1.5). When " +
    "Motir's real planner generates this Story for an arbitrary user project, it must produce a " +
    '*stack-appropriate* variant: Spring Boot for a Java user, FastAPI for a Python user, ' +
    'Rails for a Ruby user, etc. The shape of the Story (bootstrap, dev runner, CI, deploy) stays ' +
    'the same; the specific Subtasks change per stack.',
  verificationRecipeMd:
    '- Verify the two repos exist on GitHub:\n' +
    '  - https://github.com/moooon-B-V/motir-core (PUBLIC, GPL-3.0)\n' +
    '  - https://github.com/moooon-B-V/motir-ai   (PRIVATE, proprietary)\n' +
    '- Open motir-core in a terminal and run:\n' +
    '  `git checkout story/PROD-1.0-bootstrap`, `./scripts/db-up.sh`, `pnpm install`, `pnpm dev`.\n' +
    '  Open http://localhost:3000 in your browser. You should see a placeholder\n' +
    '  "Motir" page rendered in the dark theme — not the default Next.js welcome page.\n' +
    '- Open motir-ai in a second terminal and run:\n' +
    '  `pnpm install`, `pnpm dev`.\n' +
    '  Open http://localhost:8001/health in your browser (or curl it). You should see `{"status": "ok"}`.\n' +
    "- In motir-core's repo on GitHub, confirm:\n" +
    '  - LICENSE file at the root is the canonical GPL-3.0 text.\n' +
    '  - README.md mentions "GPL-3.0" and links to motir-ai as the closed-source companion.\n' +
    "- In motir-ai's repo on GitHub, confirm:\n" +
    '  - LICENSE file says "Copyright © Motir Inc. All rights reserved." (proprietary, NOT GPL).\n' +
    '  - README.md is short and points back at motir-core.\n' +
    '- Visit the motir-core Vercel deployment URL (provided in the PR description). Same placeholder page should render there too.\n' +
    '- Confirm CI is green on the Story PR for motir-core (all 3 jobs: lint, typecheck, build).\n' +
    '- If all seven checks pass, approve and merge the PR. If anything fails, add a comment explaining what ' +
    "didn't work and Motir will produce a follow-up Subtask to fix it.",
  items: [
    {
      id: '1.0.0',
      title: 'Scaffold `motir-ai` repo (the closed-source AI service stub)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 6,
      descriptionMd:
        "Create the second repo of Motir's open-core architecture: `motir-ai`, " +
        'closed-source, commercial, and **headless** — a backend service with no ' +
        'UI. It will eventually hold the planning agent, prompt-generation agent, async expansion ' +
        "loop, and shared-context retrieval. For now it's a minimal stub — just enough to have a " +
        'deployable HTTP service that `motir-core` can call into server-to-server ' +
        'via the API contract defined in Epic 7 Story 7.1 (Core ↔ AI API contract).\n\n' +
        '**Why headless (no UI):** all user-facing UI lives in ' +
        '`motir-core`. The browser never talks to `motir-ai` directly; ' +
        "only `motir-core`'s server-side handlers do. This is what keeps the user " +
        'experience unified (one app, one domain, one cookie) while preserving the GPL boundary ' +
        '(clean network service interface, not a derivative work).\n\n' +
        '**Why a separate repo from day one (not "split later"):** see ' +
        'feasibility.html ADR-008. Splitting a mature codebase ' +
        'retroactively is expensive and rarely happens cleanly. Two repos from the start enforce ' +
        'the GPL boundary and give each codebase its own CI, deploy, and version pipeline.\n\n' +
        "**What you'll do:** Create the `motir-ai` repo on GitHub " +
        '**as private** (not public — this code is closed-source). Add a minimal ' +
        '**backend-only** service: Hono or Express with a single `GET /health` ' +
        'endpoint returning `{ "status": "ok" }`. **No React, no Next.js, no ' +
        'UI dependencies** — this is server code only. Add `package.json` ' +
        'with start script, `.env.example` documenting `ANTHROPIC_API_KEY` ' +
        '(used later), `.gitignore`, and a **proprietary LICENSE notice** ' +
        'at the repo root saying "Copyright © Motir Inc. All rights reserved. This software ' +
        'is proprietary and confidential." Add a README naming the repo\'s purpose ("headless AI ' +
        'backend, no UI, called server-to-server from `motir-core`") and explicitly ' +
        'pointing at `motir-core` for the open-source PM substrate and all UI.\n\n' +
        '## Acceptance criteria\n\n' +
        '- GitHub repo `moooon-B-V/motir-ai` exists, **private** (visibility = private).\n' +
        '- A LICENSE file is at the repo root with a proprietary notice: *"Copyright © Motir Inc. All rights reserved. This software is proprietary and confidential."* — explicitly NOT GPL or any open-source license.\n' +
        '- A README.md exists, naming the repo\'s purpose ("closed-source AI service for Motir\'s planning intelligence"), pointing at `motir-core` as the companion open-source repo, and saying clearly: "this repo is intentionally not open-source — see `motir-core` for the GPL-3.0 PM substrate."\n' +
        "- Minimal Node service exists: `pnpm dev` starts a server on `localhost:8001` (different port from `motir-core`'s 3000) and `GET /health` returns `200 OK` with a JSON body.\n" +
        '- TypeScript strict mode configured.\n' +
        '- `.env.example` has `ANTHROPIC_API_KEY` and `PORT=8001`.\n' +
        '- `.gitignore` excludes `node_modules`, `.env`, and build output.\n' +
        '- No web framework choice baked in deeply yet — Hono or Express is fine; the choice can be revisited when real AI code starts arriving in Epic 4.\n\n' +
        '## Context refs\n\n' +
        '- feasibility.html ADR-008 — the open-core architecture rationale\n' +
        '- vision.html principle #19 — the open-core decision\n' +
        '- Hono v4 docs OR Express docs (URL, fetched at prompt-gen time)',
    },
    {
      id: '1.0.1',
      title: '`create-next-app` + Tailwind + TypeScript strict + folder layout (in `motir-core`)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 5,
      descriptionMd:
        'Initialize **`motir-core`** — the **open-source ' +
        '(GPL-3.0)** repository that holds the PM substrate — with Next.js 15+ (App Router), ' +
        'TypeScript strict mode, and Tailwind CSS. This is the literal entry point for every ' +
        "other Subtask that ships in core; until this runs, the repo doesn't exist as a runnable " +
        'project. The output is a freshly-bootstrapped codebase that runs `pnpm dev` ' +
        'and shows a placeholder home page.\n\n' +
        '**Why `create-next-app` and not a custom scaffold:** ' +
        '`create-next-app` gives us a maintained, well-known starting point with ' +
        'sensible defaults (App Router, Server Components, RSC streaming). Custom scaffolding ' +
        'would solve the same problem with more bugs. Configure strict mode and the folder layout ' +
        '*after* the scaffold runs.\n\n' +
        '**Why GPL-3.0 (not MIT/Apache/AGPL):** see ' +
        'feasibility.html ADR-008. Short version: GPL-3.0 gives ' +
        'enterprise buyers full source-code transparency for audit while preventing competitors ' +
        'from closed-sourcing forks. AGPL was rejected because enterprises blacklist it.\n\n' +
        "**What you'll do:** Create the GitHub repo at `moooon-B-V/motir-core` " +
        '**as public** (this is the open-source side). Run ' +
        '`pnpm create next-app@latest .` with flags for App Router + Tailwind + ' +
        'TypeScript. Add `"strict": true` (with all sub-flags) to ' +
        '`tsconfig.json`. Create the folder layout: `/app` (routes), ' +
        '`/lib` (server logic), `/components` (React), `/prisma` ' +
        '(added in 1.0.2), `/tests` (Playwright + Vitest), `/docs` (project ' +
        'docs). Add a placeholder `app/page.tsx` showing "Motir" with the dark ' +
        'theme. **Add the GPL-3.0 LICENSE file at the repo root** ' +
        '(verbatim from gnu.org/licenses/gpl-3.0.txt), ' +
        'plus a COPYRIGHT header at the top of each source file: ' +
        '`// Copyright (C) 2026 Motir contributors. Licensed under GPL-3.0-only.`\n\n' +
        '## Acceptance criteria\n\n' +
        '- GitHub repo `moooon-B-V/motir-core` exists, **public** (visibility = public).\n' +
        '- **GPL-3.0 LICENSE file exists at repo root**, verbatim copy of the canonical GPL-3.0 text from gnu.org. `package.json` has `"license": "GPL-3.0-only"`.\n' +
        '- README.md exists at repo root with: title, one-line pitch, a clear "Open source under GPL-3.0" line in the first paragraph, and a pointer to the companion closed-source `motir-ai` repo (saying "the planning intelligence ships separately; see vision.html principle #19").\n' +
        '- Source files have a one-line copyright header (a lint rule can be added later to enforce; not required in this Subtask).\n' +
        '- Repo exists with `package.json`, `tsconfig.json`, `next.config.mjs`, `tailwind.config.ts`, `postcss.config.js`.\n' +
        '- Next.js version is ≥15 and App Router is enabled.\n' +
        '- TypeScript `strict: true` with `noUncheckedIndexedAccess` and `noImplicitAny`.\n' +
        '- Folder layout exists: `/app`, `/lib`, `/components`, `/tests`, `/docs`.\n' +
        '- `pnpm dev` starts the app on `localhost:3000` showing a placeholder "Motir" page.\n' +
        '- `pnpm build` succeeds with zero errors and zero warnings.\n' +
        '- `pnpm typecheck` exists as a script and exits 0.\n' +
        '- First commit is small and clean: scaffold output + strict-mode tweaks + folder placeholders + LICENSE + README.\n\n' +
        '## Context refs\n\n' +
        '- Next.js 15 App Router docs (URL, fetched at prompt-gen time)\n' +
        '- Tailwind v3 docs for the config + globals.css setup\n' +
        '- TypeScript strict-mode docs for the recommended flag set\n' +
        '- The existing color palette from `vision.html` CSS variables (becomes the placeholder dark theme)',
    },
    {
      id: '1.0.2',
      title: 'Prisma + Postgres setup (local Docker), placeholder schema, first migration',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 10,
      dependsOn: ['1.0.1'],
      descriptionMd:
        'Wire up Prisma as the ORM and a local-Docker Postgres as the dev database. Create ' +
        'the initial `schema.prisma` with no user tables yet — just enough to prove ' +
        'the connection works and migrations apply. Real schema (user, workspace, work_item) ' +
        'arrives in subsequent stories (1.1.3, 1.2.1, 1.4.2).\n\n' +
        '**Why local Postgres in Docker (not SQLite or a hosted dev DB):** ' +
        'production uses Postgres, so dev should match. SQLite has too many subtle differences ' +
        '(no native JSON ops, weaker type system, no RLS for 1.2.1). A hosted dev DB adds a network ' +
        'hop and a credential dance for every contributor. Docker is the smallest, most-portable ' +
        'way to give every developer the right database locally.\n\n' +
        "**What you'll do:** Add `prisma` and `@prisma/client` " +
        'deps. Create `/prisma/schema.prisma` with a Postgres datasource pointing at ' +
        '`env("DATABASE_URL")`. Add a `docker-compose.yml` with a single ' +
        'Postgres 16 service. Write a `scripts/db-up.sh` that brings the DB up and ' +
        'applies migrations. Add a placeholder migration (no app tables yet — just so the ' +
        'migration system is exercised). Add `/lib/db.ts` exporting a singleton ' +
        '`PrismaClient` following the Next.js dev-mode pattern (avoid hot-reload ' +
        'connection leaks).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `prisma` and `@prisma/client` installed.\n' +
        '- `/prisma/schema.prisma` exists with a Postgres datasource pointing at `env("DATABASE_URL")`.\n' +
        '- `docker-compose.yml` defines a single Postgres 16 service with a named volume for persistence.\n' +
        '- `scripts/db-up.sh` brings up the DB and runs `prisma migrate deploy`; exits 0 on success.\n' +
        '- A placeholder migration exists under `/prisma/migrations/` (it can be empty or create a no-op marker table).\n' +
        '- `/lib/db.ts` exports a singleton `PrismaClient` with the Next.js dev-mode hot-reload guard.\n' +
        '- `.env.example` updated with `DATABASE_URL="postgresql://prodect:prodect@localhost:5432/prodect"` and a comment explaining the dev pattern.\n' +
        '- `pnpm prisma migrate dev` succeeds against the Docker DB.\n\n' +
        '## Context refs\n\n' +
        '- Prisma docs for Postgres + Next.js (singleton pattern)\n' +
        '- `README.md` (after 1.0.4) — to extend with the DB section\n' +
        '- `.env.example` (from 1.0.1) — to add `DATABASE_URL`\n' +
        '- Postgres 16 Docker image docs',
    },
    {
      id: '1.0.3',
      title: 'ESLint + Prettier + Husky pre-commit hook + lint-staged',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 8,
      dependsOn: ['1.0.1'],
      descriptionMd:
        'Set up the code-quality toolchain so every commit is automatically linted and formatted. ' +
        'The goal: a developer who runs `git commit` can never accidentally commit a ' +
        'file that fails lint or has inconsistent formatting. This matters more for AI-generated ' +
        'code than for hand-written code — coding agents are happy to produce code that *works* ' +
        'but has slightly off style; the commit hook is the cheapest enforcement layer.\n\n' +
        '**Why this stack:** ESLint with `@next/eslint-config-next` is ' +
        'the Next.js community standard. Prettier handles formatting (less debate, more consistency). ' +
        'Husky manages git hooks declaratively. lint-staged runs the tools only on changed files ' +
        '(fast). Together: full lint + format pass on every commit in <2s for typical changes.\n\n' +
        "**What you'll do:** Install `eslint`, `@next/eslint-config-next`, " +
        '`prettier`, `eslint-config-prettier` (turns off lint rules Prettier ' +
        'handles), `husky`, and `lint-staged`. Create `.eslintrc.cjs` ' +
        'extending Next + adding strict rules (no unused vars except `_prefixed`, no ' +
        'implicit any, no console.log in prod files). Create `.prettierrc` with the ' +
        "project's style (single quotes, no semicolons or with — pick one; 100-char lines; trailing " +
        'commas). Run `pnpm husky init`; add a `pre-commit` hook that runs ' +
        '`npx lint-staged`; configure `lint-staged` in `package.json` ' +
        'to run ESLint and Prettier on staged `.ts/.tsx` files.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm lint` runs ESLint across `/app`, `/lib`, `/components` and exits 0 on a clean repo.\n' +
        '- `pnpm format` runs Prettier across the whole repo and fixes formatting in place.\n' +
        '- `pnpm format:check` runs Prettier in check mode (used by CI) and exits 0 on a clean repo.\n' +
        '- Husky installed; `.husky/pre-commit` exists and runs `npx lint-staged`.\n' +
        '- `lint-staged` config in `package.json` runs ESLint (`--fix`) and Prettier on staged `*.{ts,tsx,js,jsx,json,css,md}`.\n' +
        '- Test: introduce a deliberately mis-formatted file, stage and commit; the hook fixes it (or rejects).\n' +
        '- Test: introduce an unused variable; `pnpm lint` fails with a clear error.\n' +
        '- Documented in `README.md` (after 1.0.4): "We use ESLint + Prettier; commits are auto-formatted."\n\n' +
        '## Context refs\n\n' +
        '- Next.js ESLint config docs\n' +
        '- Prettier 3.x docs (config format)\n' +
        '- Husky v9+ docs (newer setup pattern is different from v7)\n' +
        '- lint-staged docs (the `package.json` config pattern)',
    },
    {
      id: '1.0.4',
      title: 'GitHub Actions CI (lint + typecheck + build) + README documenting the stack',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 15,
      dependsOn: ['1.0.2', '1.0.3'],
      descriptionMd:
        'Set up GitHub Actions CI **in both repos** (`motir-core` ' +
        'and `motir-ai`) so every pull request gets a green check (or fails fast). ' +
        'For `motir-core`: three jobs (lint, typecheck, build). For ' +
        '`motir-ai`: a smaller two-job setup (lint, build) since the service is ' +
        'minimal until Epic 4. Plus write the canonical READMEs.\n\n' +
        "**Why a real README matters more than usual:** Motir's planner agent " +
        '(Epic 4) will *inject README.md as context* into every subtask prompt. A vague ' +
        'README ("a web app") produces vague output. A specific README ("Next.js 15 App Router + ' +
        'Prisma + Postgres + Tailwind + tRPC v11 + NextAuth v5") gives the coding agent everything ' +
        'it needs to make stack-appropriate choices.\n\n' +
        "**The open-source pitch goes in `motir-core`'s README:** " +
        '"Motir is the open-source PM substrate for AI-native project management. GPL-3.0 ' +
        'licensed. Companion to the closed-source `motir-ai` planning service." ' +
        'This is the first thing a security-cautious enterprise will read; it should be specific ' +
        "about what's open and what isn't, and link to vision.html principle #19 for the rationale.\n\n" +
        "**What you'll do:** In `motir-core`, create " +
        '`.github/workflows/ci.yml` with three jobs running in parallel ' +
        '(`lint`, `typecheck`, `build`); all need Node 20+, ' +
        'pnpm, and the pnpm cache action; build also needs a Postgres service container. Write ' +
        '`motir-core/README.md` with the structure below (acceptance criteria). ' +
        'In `motir-ai`, create a smaller CI workflow with two jobs (lint, build) — ' +
        "no DB needed yet. Write `motir-ai/README.md` declaring it's closed-source, " +
        'companion to `motir-core`.\n\n' +
        '## Acceptance criteria\n\n' +
        '- **motir-core**: `.github/workflows/ci.yml` exists; runs on every PR + push to `main`; three jobs (`lint`, `typecheck`, `build`) in parallel; Node 20 LTS + pnpm cache; `build` job has a Postgres service container.\n' +
        '- **motir-ai**: `.github/workflows/ci.yml` exists with two jobs (`lint`, `build`); no DB service needed yet.\n' +
        '- Both repos: CI completes in <3 min on a fresh clone.\n' +
        '- **motir-core README.md** has these sections in order:\n' +
        '  - Title + 1-line pitch.\n' +
        '  - **Open source** — explicit "GPL-3.0; this is the PM substrate. The closed-source planning intelligence ships separately as `motir-ai`" — with a link to vision.html principle #19.\n' +
        '  - Stack (bulleted: framework, runtime, DB, ORM, auth, styling, tests, deploy).\n' +
        '  - Local setup (3 commands: `pnpm install`, `./scripts/db-up.sh`, `pnpm dev`).\n' +
        '  - Project layout.\n' +
        '  - Testing.\n' +
        '  - Docs (links to `/docs` and the discovery tier docs in this very planning corpus).\n' +
        '  - License — name GPL-3.0, link to LICENSE file.\n' +
        '- **motir-ai README.md** is short: title, "closed-source AI service — see `motir-core` for the open-source companion", proprietary license notice, dev-setup commands.\n' +
        "- README's Stack section is the authoritative reference for every later prompt. Keep it short, specific, link-rich.\n" +
        '- Open a placeholder PR in each repo; verify CI passes.\n\n' +
        '## Context refs\n\n' +
        '- GitHub Actions docs (Node + pnpm setup pattern)\n' +
        '- `package.json` — the lint/typecheck/build scripts exist by now\n' +
        '- `docker-compose.yml` (from 1.0.2) — for the Postgres service config\n' +
        '- Project pitch from `vision.html` hero — to seed the README intro',
    },
    {
      id: '1.0.5',
      title: 'Vercel project link + preview deploys on PR + production env from `main`',
      status: 'done',
      type: 'deploy',
      executor: 'coding_agent',
      estimateMinutes: 15,
      dependsOn: ['1.0.4'],
      descriptionMd:
        'Hook the repo up to Vercel so every PR gets a preview deploy and `main` ' +
        'deploys to production. Plus a managed Postgres for the deployed app (Neon or Vercel ' +
        'Postgres). This is the last Subtask in Story 1.0 — once it ships, the repo is fully ' +
        'deployable and the next Story can start adding features.\n\n' +
        '**Why this comes last in the story:** deploys need CI to be green ' +
        '(Subtask 1.0.4), they need a working database (1.0.2), and they need the lint/build ' +
        'scripts (1.0.3). Running deploy setup before those exist would produce broken first ' +
        "deploys that look like the platform's fault.\n\n" +
        "**What you'll do:** Create the Vercel project via dashboard or " +
        '`vercel` CLI. Link the GitHub repo so preview deploys fire on every PR. Add ' +
        'a Neon (or Vercel Postgres) database; configure `DATABASE_URL` in Vercel as ' +
        "both preview and production env vars (Neon's branch databases work nicely for previews). " +
        'Add `vercel.json` if needed for build commands. Trigger a deploy of `main`; ' +
        'verify the placeholder page renders at the production URL.\n\n' +
        '**Note on this being a deploy-type Subtask:** some steps require Vercel ' +
        "dashboard clicks (creating the project, adding env vars) and aren't fully automatable by " +
        "a coding agent in v1. The Subtask's prompt should explicitly tell the user what manual " +
        'steps to take, then let the coding agent finish the in-repo work (`vercel.json`, ' +
        'README updates).\n\n' +
        '## Acceptance criteria\n\n' +
        '- Vercel project linked to the GitHub repo.\n' +
        "- Preview deploy fires automatically on every PR; preview URL is posted to the PR by Vercel's GitHub integration.\n" +
        '- Production deploy fires on every push to `main`; production URL is reserved (subdomain or apex; final domain decision lives in Epic 5).\n' +
        '- Managed Postgres provisioned (Neon or Vercel Postgres); `DATABASE_URL` set as preview + production env vars; Prisma migrations run on deploy.\n' +
        "- Preview deploys use a separate database branch / schema (Neon's branch feature, or a dedicated preview DB).\n" +
        '- Placeholder page renders at the production URL.\n' +
        '- `README.md` updated with a "Deploys" section: which platform, preview URL pattern, how to roll back.\n' +
        '- Story 1.0 marked complete only when the placeholder page is live at the production URL.\n\n' +
        '## Context refs\n\n' +
        '- Vercel docs (Next.js deployment, env vars, preview deploys)\n' +
        '- Neon docs (branch databases, Prisma integration)\n' +
        '- `.github/workflows/ci.yml` (from 1.0.4) — to coordinate CI gate with deploy\n' +
        '- `README.md` (from 1.0.4) — to extend with the deploy section',
    },
    {
      id: '1.0.6',
      title: 'Create `moooon-B-V/nextjs-prisma-vercel-starter` (MIT, GitHub Template)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 15,
      dependsOn: ['1.0.5'],
      descriptionMd:
        'Snapshot `motir-core` at the end of Story 1.0 into a brand-new public ' +
        'GitHub Template repo at `moooon-B-V/nextjs-prisma-vercel-starter`. Strip ' +
        'Motir-specific wording (wordmark, README references to `motir-ai` and ' +
        'Motir-the-product, planning-doc links) and re-license under **MIT** ' +
        '(not GPL-3.0 — see "License" below). Mark the new repo as a GitHub Template via ' +
        '`is_template: true` so downstream users see the "Use this template" button.\n\n' +
        '**Why now (last Subtask of Story 1.0):** at this commit, ' +
        '`motir-core` contains exactly the generic Next.js + Prisma + Tailwind + ' +
        'ESLint/Prettier + Vercel + Neon scaffolding — and *nothing* Motir-specific (no ' +
        'User model yet, no workspace tables, no work-item schema). Forking now means minimal ' +
        "stripping. If we waited until Stories 1.1 / 1.2 / 1.4 land, we'd have to surgically " +
        'remove Motir-specific code from the starter, which is harder and easier to get wrong. ' +
        'This is a semantic-ordering constraint: **1.0.6 must close before Subtask 1.1.3 ' +
        "(User schema) merges to `motir-core`'s main.**\n\n" +
        '**Mechanism: manual copy + new repo + mark as Template** (NOT a GitHub ' +
        'fork). GitHub Templates create a new repo with a clean single-commit history when ' +
        'downstream users click "Use this template" — no inherited Motir git history, no ' +
        '"forked from" badge. This is what create-t3-app, shadcn/ui, and Vercel\'s own templates ' +
        'do. A raw fork would carry our Story 1.0 planning commits forever and make the ' +
        'template look like "a fork of Motir" to anyone browsing the repo.\n\n' +
        "**License: MIT**, not GPL-3.0. Templates ship under MIT because GPL's " +
        "copyleft requirement repels would-be forkers (they'd have to GPL their derivative " +
        'work). MIT maximizes adoption. `motir-core` stays GPL-3.0; the starter is ' +
        'independent and MIT-licensed.\n\n' +
        "**Value proposition (for the README pitch):** the starter's " +
        "differentiator isn't novel scaffolding — it's *discovered gotchas baked in*. " +
        "Specifically: (a) Vercel build-cache stales out Prisma's generated client → fixed via " +
        "`postinstall: prisma generate`; (b) Neon-Vercel integration's pooled " +
        '`DATABASE_URL` breaks Prisma migrations → fixed via ' +
        "`DATABASE_URL_UNPOOLED` in `prisma.config.ts`; (c) Prisma 7's " +
        'config loads on every CLI command including `generate` → fixed via ' +
        'conditional `datasource` block; (d) pnpm 11 requires Node ≥22.13. The README ' +
        'should sell these as the value prop, not novel features.\n\n' +
        "**What you'll do:**\n" +
        '- Create the empty public repo: `gh repo create moooon-B-V/nextjs-prisma-vercel-starter --public`\n' +
        '- Locally: copy the entire `motir-core` tree (sans `.git`, `node_modules`, `.next`) into a new sibling directory.\n' +
        '- `git init`, set the remote to the new repo, single initial commit.\n' +
        '- Apply the strip/genericize edits (see Acceptance criteria for the full list).\n' +
        '- Push to main as the initial commit. Verify all four quality gates pass.\n' +
        '- Mark as template: `gh repo edit moooon-B-V/nextjs-prisma-vercel-starter --template`\n' +
        '- Smoke-test: click "Use this template" on the GitHub repo page, create a throwaway test repo, clone it, run `pnpm install && ./scripts/db-up.sh && pnpm dev`, confirm it works end-to-end, then delete the throwaway repo.\n\n' +
        '## Acceptance criteria\n\n' +
        '**Repo + GitHub setup:**\n' +
        '- GitHub repo `moooon-B-V/nextjs-prisma-vercel-starter` exists, **public**, **MIT**-licensed.\n' +
        '- Repo is marked as a GitHub Template (`is_template: true`) — the "Use this template" button is visible on the repo page.\n' +
        '- Single initial commit; no inherited Motir git history.\n\n' +
        '**License + branding strip:**\n' +
        '- `LICENSE` is the canonical MIT text (e.g., opensource.org/license/mit), copyright "© 2026 moooon B.V." or similar.\n' +
        '- `package.json`\'s `"license": "MIT"`, `"name": "nextjs-prisma-vercel-starter"`, generic `"description"` (no Motir mention).\n' +
        '- `app/page.tsx` is a generic placeholder (e.g., "Next.js + Prisma starter"); NO "Motir" wordmark.\n' +
        '- `app/layout.tsx` metadata uses generic title and description (no Motir mention).\n' +
        '- README does NOT reference Motir, `motir-ai`, `motir-core`, `vision.html`, `feasibility.html`, `notes.html`, or any planning docs.\n' +
        "- README's value proposition leads with the discovered gotchas (postinstall fix, DATABASE_URL_UNPOOLED, conditional Prisma config, Node 22+) — that's what makes this template differentiated from `create-next-app` defaults.\n\n" +
        '**DB naming convention:**\n' +
        '- DB user/password/name in `docker-compose.yml`, `.env.example`, `scripts/db-up.sh`, and `.github/workflows/ci.yml` all use `nextjs_prisma_vercel_starter` (snake_case for Postgres identifier rules).\n' +
        '- Docker container name is `nextjs-prisma-vercel-starter-postgres` (hyphens fine for Docker).\n' +
        '- Volume name is `nextjs-prisma-vercel-starter-pg-data`.\n\n' +
        '**Schema:**\n' +
        '- `prisma/schema.prisma`: drop the "Motir — motir-core schema" comment; keep the placeholder model but rename `MigrationMarker` → `Marker` (or remove entirely if you prefer; flag the trade-off in PR description). Update the migration file accordingly.\n\n' +
        '**Quality gates:**\n' +
        '- All four quality gates pass on the starter repo: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build`.\n' +
        '- GitHub Actions CI runs on the initial commit and goes green (3 jobs: lint, typecheck, build with Postgres service container).\n\n' +
        '**End-to-end smoke test (the load-bearing AC):**\n' +
        '- Click "Use this template" in the GitHub UI; create a throwaway test repo (e.g., `moooon-B-V/_starter-smoke-test`); clone it; run `pnpm install && ./scripts/db-up.sh && pnpm dev`; confirm `localhost:3000` renders the generic placeholder; confirm `pnpm prisma migrate dev --name init` works; delete the throwaway repo.\n\n' +
        '**Reference to planning docs:**\n' +
        '- Captures the lesson from notes.html mistake #20: future Motir-planned projects on this stack default to "Use this template" rather than re-deriving the bootstrap from scratch.\n\n' +
        '## Context refs\n\n' +
        '- notes.html mistake #20 — the lesson driving this Subtask\n' +
        "- `motir-core`'s current tree at the end of Story 1.0 — the source to fork from\n" +
        '- GitHub\'s "Creating a template repository" docs\n' +
        '- create-t3-app — reference starter for comparison (README shape, scope of what goes in)',
    },
  ],
};
