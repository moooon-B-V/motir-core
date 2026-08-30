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

## Changesets

The three published workspace packages — `@motir/cli`, `@motir/brand` and
`@motir/design-system` — record their release decisions with
[Changesets](https://github.com/changesets/changesets). A pull request that
changes a published package's behaviour or public surface owes a changeset:

- Run `pnpm changeset` and describe the change, choosing a major / minor / patch
  bump for each affected package. The generated `.changeset/*.md` file is both
  the release note and the version decision, reviewed like code — it is what the
  release lane turns into the next version.
- **A change that does not reach a published package** (a root-app-only,
  docs-only or CI-only change) needs no changeset.
- **A change that touches a package but has no user-visible effect** (an
  internal refactor, a test, a build tweak) takes an empty changeset:
  `pnpm changeset --empty`, which records "no version bump" explicitly instead
  of leaving the release lane to guess.
- **A new package under `packages/*` is an explicit decision, not an accident of
  the workspace glob.** When you add one, decide whether it is published — if it
  is not, list it under `ignore` in `.changeset/config.json`.
