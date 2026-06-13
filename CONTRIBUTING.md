# Contributing to Motir

Thanks for your interest in contributing to Motir! This document covers the
essentials for getting a change merged.

## Contributor License Agreement (CLA)

By opening a pull request, you'll be asked to sign our CLA via
[CLA Assistant](https://cla-assistant.io). This grants us the rights we need to
maintain the project's open-source license and to potentially relicense the
codebase in the future. **You retain copyright of your contribution.** See
[`CLA.md`](./CLA.md) for the full agreement.

You sign once. The bot comments on your PR with a signing link, and a required
status check turns green once you've signed — it then covers all of your future
contributions.

## Development

- See [`README.md`](./README.md) for local setup (Node, pnpm, the dev Postgres at
  `localhost:5433`).
- The architecture contract lives in [`CLAUDE.md`](./CLAUDE.md): every
  DB-touching endpoint flows through the **Route → Service → Repository → Prisma**
  layers. Read it before adding an endpoint, a repository method, or a migration.

## Pull requests

- Branch off `main` and open your PR against `main`.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
  messages (e.g. `feat(workspaces): ...`, `fix(board): ...`, `chore: ...`).
- Keep PRs focused; run lint, typecheck, and the relevant tests locally before
  pushing. CI runs the full suite and a coverage gate.
- Sign the CLA when prompted — a PR can't be merged until the CLA check is green.
