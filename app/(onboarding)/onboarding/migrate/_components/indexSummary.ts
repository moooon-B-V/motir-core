import type { MigrateIndexRepoStatusDto, MigrateIndexStatusDto } from '@/lib/dto/migrateOnboarding';

/** The indicator's one state, in precedence order (MOTIR-8771, design
 *  `design/onboarding-migrate/` § Non-blocking index states). */
export type IndexSummaryState = 'failed' | 'indexing' | 'queued' | 'done';

export interface IndexSummary {
  state: IndexSummaryState;
  /** The repository the state is about: the first one in the worst state. */
  repoRef: string;
  /** How many other repositories there are ("+N"). */
  others: number;
  total: number;
  indexedCount: number;
  failedCount: number;
}

/** Worst first. A value this list does not know ranks after every known one. */
const PRECEDENCE: readonly MigrateIndexRepoStatusDto[] = [
  'failed',
  'indexing',
  'queued',
  'indexed',
];

const STATE_OF: Record<MigrateIndexRepoStatusDto, IndexSummaryState> = {
  failed: 'failed',
  indexing: 'indexing',
  queued: 'queued',
  indexed: 'done',
};

/**
 * One function for the chip, its narrow dot and the detail: `failed` beats
 * `indexing` beats `queued` beats `done`. Null when there is nothing to show
 * (no read yet, or no repository).
 */
export function summariseIndex(status: MigrateIndexStatusDto | null): IndexSummary | null {
  if (!status || status.repos.length === 0) return null;
  const rank = (s: string) => {
    const i = PRECEDENCE.indexOf(s as MigrateIndexRepoStatusDto);
    return i === -1 ? PRECEDENCE.length : i;
  };
  const worst = status.repos.reduce((a, b) => (rank(b.status) < rank(a.status) ? b : a));
  return {
    state: STATE_OF[worst.status] ?? 'queued',
    repoRef: worst.repoRef,
    others: status.repos.length - 1,
    total: status.total,
    indexedCount: status.indexedCount,
    failedCount: status.failedCount,
  };
}

/** The repository's own name, without its owner. */
export function repoName(repoRef: string): string {
  const slash = repoRef.indexOf('/');
  return slash === -1 ? repoRef : repoRef.slice(slash + 1);
}
