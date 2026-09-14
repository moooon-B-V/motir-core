import type { PrMergeMode, ProjectRepoState } from '@/generated/prisma/client';
import { isMotirHostedOwner } from '@/lib/git/hostOwnership';
import { isSettledState } from '@/lib/projectRepos/transitions';

// THE PROVENANCE DEFAULT for a project's merge mode (Story MOTIR-4880 · MOTIR-5178,
// `docs/decisions/approval-gates.md` §7 and its 2026-09-13 amendment).
//
// Pure, and split into the two questions the amendment asks:
//
//   1. IS THE SET ESTABLISHED? — at least one row, and every row settled. Only then
//      may the default be written; before that there is no provenance to read.
//   2. WHAT DOES IT SEED? — total over the set's REPOSITORIES (a `skipped` row has
//      none): every one Motir-hosted ⇒ `auto`; anything else, MIXED and EMPTY
//      included ⇒ `manual`.
//
// ⚠️ PROVENANCE IS `isMotirHostedOwner` AND NOTHING ELSE. Bug MOTIR-4892 found three
// surfaces spelling that comparison three times and disagreeing about one row; this
// module composes it and never re-spells it. It TAKES `hostOwner`, as that module
// does, so it reads no environment — the service resolves it once.
//
// Why MIXED falls to `manual`: an unnecessary question costs a click, and an unasked
// merge into somebody's own repository costs their trust.

/** The slice of a set row the default reads. */
export interface PrMergeModeSetRow {
  state: ProjectRepoState;
  githubRepo: { owner: string } | null;
}

/** Has this repository set reached ESTABLISHMENT — at least one row, every row
 *  settled (the ADR §4.1 machine's own definition, via `isSettledState`)? */
export function isEstablishedSet(rows: readonly Pick<PrMergeModeSetRow, 'state'>[]): boolean {
  return rows.length > 0 && rows.every((row) => isSettledState(row.state));
}

/**
 * The merge mode a set SEEDS. Total: an empty set, or one whose every row is
 * `skipped`, has no repository to be Motir's and seeds `manual`; `auto` needs at
 * least one realized repository and every realized repository Motir-hosted.
 *
 * `hostOwner: null` classifies nothing as hosted, so a deployment that cannot
 * provision seeds `manual` for every project — the correct answer, not a degraded one.
 */
export function derivePrMergeModeDefault(
  rows: readonly PrMergeModeSetRow[],
  hostOwner: string | null,
): PrMergeMode {
  const owners = rows
    .filter((row) => row.state !== 'skipped')
    .map((row) => row.githubRepo?.owner ?? null);
  if (owners.length === 0) return 'manual';
  return owners.every((owner) => isMotirHostedOwner(owner, hostOwner)) ? 'auto' : 'manual';
}
