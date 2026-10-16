import { describe, expect, it } from 'vitest';
import {
  decideMigrateIndexExit,
  deriveMigrateIndexRepoState,
  type MigrateIndexRepoFacts,
} from '@/lib/codeGraph/migrateIndexRepoState';
import { deriveRefreshFailing } from '@/lib/codeGraph/refreshReason';

// The migrate wizard's per-repo index state and its index-step exit
// (Story MOTIR-8246 · MOTIR-8768) — pure, so no database.

const none: MigrateIndexRepoFacts = {
  hasSucceededIndex: false,
  hasRunningIndex: false,
  refreshFailing: false,
  refusedForSize: false,
};

describe('deriveMigrateIndexRepoState', () => {
  it('names each of the four states', () => {
    expect(deriveMigrateIndexRepoState(none)).toBe('queued');
    expect(deriveMigrateIndexRepoState({ ...none, hasRunningIndex: true })).toBe('indexing');
    expect(deriveMigrateIndexRepoState({ ...none, hasSucceededIndex: true })).toBe('indexed');
    expect(deriveMigrateIndexRepoState({ ...none, refreshFailing: true })).toBe('failed');
    expect(deriveMigrateIndexRepoState({ ...none, refusedForSize: true })).toBe('failed');
  });

  it('a built graph wins over a later failed refresh or a size refusal', () => {
    expect(
      deriveMigrateIndexRepoState({
        hasSucceededIndex: true,
        hasRunningIndex: false,
        refreshFailing: true,
        refusedForSize: true,
      }),
    ).toBe('indexed');
  });

  it('a pointer left by a crashed run reads failed, never indexing', () => {
    // The run that claimed the repository died; the reaper marked it abandoned.
    // The pointer still names it, the running set no longer holds it.
    const crashedRunId = 'run-crashed';
    const runningRunIds = new Set<string>();
    const terminalRunIds = new Set([crashedRunId]);
    expect(
      deriveMigrateIndexRepoState({
        hasSucceededIndex: false,
        hasRunningIndex: runningRunIds.has(crashedRunId),
        refreshFailing: deriveRefreshFailing({ indexingRunId: crashedRunId, terminalRunIds }),
        refusedForSize: false,
      }),
    ).toBe('failed');
  });
});

describe('decideMigrateIndexExit', () => {
  const connected = new Set(['acme/widgets']);

  it('is ready, graph not built, while the connected repo has no succeeded index', () => {
    expect(
      decideMigrateIndexExit({
        codeGraphReady: false,
        connectedRepoRef: 'acme/widgets',
        connectedRefs: connected,
        succeededRefs: new Set(),
      }),
    ).toEqual({ ready: true, graphBuilt: false });
  });

  it('is ready with the graph built once a succeeded index carries the ref', () => {
    expect(
      decideMigrateIndexExit({
        codeGraphReady: false,
        connectedRepoRef: 'acme/widgets',
        connectedRefs: connected,
        succeededRefs: new Set(['acme/widgets']),
      }),
    ).toEqual({ ready: true, graphBuilt: true });
  });

  it('is not ready with no ref, or a ref outside the connected set', () => {
    for (const connectedRepoRef of [null, 'acme/other']) {
      expect(
        decideMigrateIndexExit({
          codeGraphReady: false,
          connectedRepoRef,
          connectedRefs: connected,
          succeededRefs: new Set(['acme/other']),
        }),
      ).toEqual({ ready: false });
    }
  });

  it('an already-observed codeGraphReady stays ready and built', () => {
    expect(
      decideMigrateIndexExit({
        codeGraphReady: true,
        connectedRepoRef: null,
        connectedRefs: new Set(),
        succeededRefs: new Set(),
      }),
    ).toEqual({ ready: true, graphBuilt: true });
  });
});
