import type { ProjectRepoRole, ProjectRepoState } from '@prisma/client';

// The repo-SET vocabulary (Story MOTIR-1775 · MOTIR-1780) — the small set of
// constants `docs/decisions/project-repository-set.md` fixes, in one module so no
// consumer re-derives them and no second copy can drift.
//
// Deliberately NOT here: the DERIVATION of a set's contents (which roles a plan
// implies, ADR §0.1) and the NAME derivation (§1.4). Both belong to MOTIR-1881,
// which writes `proposed` rows THROUGH this card's service. This module carries
// only what the schema + service need to be correct today.

/**
 * Every role the ADR §1.1 vocabulary admits, in the ADR's own order. Exported as
 * a value (not just the Prisma type) so a caller can enumerate / validate without
 * importing the generated enum object, and so a totality test can assert this
 * list and the Prisma enum stay in lockstep.
 *
 * Keep in lockstep with motir-ai's proposal-schema role enum (MOTIR-1885) — the
 * same cross-repo constant discipline `AI_DRAFT_EXPLANATION_SOURCE` follows.
 */
export const PROJECT_REPO_ROLES = [
  'web',
  'api',
  'mobile',
  'shared',
  'infra',
  'other',
] as const satisfies readonly ProjectRepoRole[];

/** Every per-row establish state (ADR §4.1), in lifecycle order. */
export const PROJECT_REPO_STATES = [
  'proposed',
  'creating',
  'created',
  'connected',
  'skipped',
  'failed',
] as const satisfies readonly ProjectRepoState[];

/**
 * The states in which a row HAS a repository — the ADR's word "established"
 * (§5.3). This is the filter every repo-resolution read applies: a `proposed`,
 * `creating`, `skipped` or `failed` row names no checkout that exists, so a work
 * item must never be pinned to one (§5.3's "matches no established row →
 * `targetRepo` stays null" is exactly this set being empty for a role).
 */
export const ESTABLISHED_PROJECT_REPO_STATES = [
  'created',
  'connected',
] as const satisfies readonly ProjectRepoState[];

/** Whether a row is ESTABLISHED — i.e. it names a repository that exists. */
export function isEstablishedState(state: ProjectRepoState): boolean {
  return (ESTABLISHED_PROJECT_REPO_STATES as readonly ProjectRepoState[]).includes(state);
}

/**
 * The ONE default platform starter (ADR §2) — a full-stack Next.js + Prisma +
 * Vercel web app which imports `@motir/design-system`. Its `-with-design` sibling
 * is retired and archived, so there is exactly one, and only a `web` row can be
 * seeded from it.
 */
export const SEED_SOURCE_PLATFORM_STARTER = 'nextjs-prisma-vercel-starter';

/**
 * The honest fallback for a role the single starter does not fit (ADR §2): an
 * INITIALISED repo — a README naming the project and the row's role, a licence, a
 * `.gitignore`, a CI stub. A non-web repo starts near-empty and the flow says so
 * rather than implying a scaffold that does not exist; the first card dispatched
 * into that repo builds its skeleton, which is what a scaffold would have guessed
 * at, done by an agent that has read the plan.
 */
export const SEED_SOURCE_INITIALISED = 'initialised';

/**
 * ADR §2's seeding table, encoded once: the default seed source for a role.
 *
 * When the multi-stack starter registry lands (MOTIR-709 / 9.3.5) a row's
 * `seedSource` becomes a registry key and this function becomes its DEFAULT map —
 * no migration and no second code path, which is why the column is a string
 * rather than a boolean or a two-value enum.
 */
export function defaultSeedSourceForRole(role: ProjectRepoRole): string {
  return role === 'web' ? SEED_SOURCE_PLATFORM_STARTER : SEED_SOURCE_INITIALISED;
}
