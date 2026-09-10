import { describe, expect, it } from 'vitest';
import {
  TERMINAL_REFRESH_REASONS,
  deriveRefreshFailing,
  refreshIsStuck,
  type CodeRefreshReason,
} from '@/lib/codeGraph/refreshReason';

// WHY A GRAPH IS BEHIND, AND WHETHER ANYTHING IS COMING (Story MOTIR-1754 ·
// MOTIR-2105).
//
// ⚠️ THE PROPERTY UNDER TEST IS NOT "THE REASON IS RIGHT". It is that a refresh
// which will NEVER complete is distinguishable from one merely queued. Both
// render `stale`, both keep answering every code tool, and only one of them is
// ever going to get better — so a surface that cannot tell them apart tells
// somebody to wait for an event nobody scheduled.
//
// The incident this card was split out of MOTIR-2057 for is the argument: 35
// dead-letters accumulated over 48 hours, nobody noticed, and three days later
// the rate was unchanged. The DLQ tab is technically a surface; at that volume it
// reads as background noise.

describe('deriveRefreshFailing — the POINTER is the only attribution there is', () => {
  it('is TRUE when the run that claimed the repository is terminal', () => {
    expect(
      deriveRefreshFailing({ indexingRunId: 'run_1', terminalRunIds: new Set(['run_1']) }),
    ).toBe(true);
  });

  it('is FALSE when nothing ever claimed it', () => {
    // A repository with no pointer has no failed run to speak of. It may still be
    // `never` or `stale`; what it is not is BROKEN.
    expect(deriveRefreshFailing({ indexingRunId: null, terminalRunIds: new Set(['run_1']) })).toBe(
      false,
    );
  });

  it('is FALSE when the run it names is not terminal', () => {
    // Running is `indexing` — the one state that is actually moving — and a
    // succeeded run has already cleared. Neither is a failure.
    expect(
      deriveRefreshFailing({ indexingRunId: 'run_live', terminalRunIds: new Set(['run_dead']) }),
    ).toBe(false);
  });

  it('⚠️ is FALSE for an empty terminal set — never inferred from drift', () => {
    // The mistake this guards: concluding from "far behind" that something must
    // have broken. An active repository is behind between every push, and a
    // perfectly healthy pipeline that has simply not run yet looks identical.
    expect(deriveRefreshFailing({ indexingRunId: 'run_1', terminalRunIds: new Set() })).toBe(false);
  });
});

describe('refreshIsStuck — which reasons mean WAITING IS THE WRONG ADVICE', () => {
  it('⚠️ the three that will not resolve themselves', () => {
    // `design/code-context` §10.1: a refresh can be paused, failing, or
    // impossible for the provider entirely, and a stale repository may sit stale
    // FOR EVER. None of these may be given wait-and-return language.
    for (const reason of ['refresh_failing', 'paused', 'provider_unsupported'] as const) {
      expect(refreshIsStuck(reason), reason).toBe(true);
    }
  });

  it('the two that ARE moving', () => {
    // Panel G's language is licensed by these and by nothing else: a refresh
    // this session enqueued, and one already running.
    for (const reason of ['refresh_enqueued', 'refresh_pending'] as const) {
      expect(refreshIsStuck(reason), reason).toBe(false);
    }
  });

  it('⚠️ `never_indexed` is NOT stuck — the first index is a different path', () => {
    // A graph that has never been built is not a refresh that failed. The connect
    // path owns it, and calling it stuck would point somebody at a repair for a
    // thing that was never broken.
    expect(refreshIsStuck('never_indexed')).toBe(false);
  });

  it('absent is not stuck — nothing to explain means nothing is wrong', () => {
    expect(refreshIsStuck(undefined)).toBe(false);
  });

  it('the stuck set and the moving set PARTITION the vocabulary', () => {
    // Every member of the union is dispositioned, so a seventh reason added later
    // cannot be silently neither — which would render as "no explanation" and
    // read exactly like a healthy graph.
    const all: CodeRefreshReason[] = [
      'refresh_enqueued',
      'refresh_pending',
      'never_indexed',
      'provider_unsupported',
      'refresh_failing',
      'paused',
    ];
    const stuck = all.filter(refreshIsStuck);
    expect(stuck.sort()).toEqual([...TERMINAL_REFRESH_REASONS].sort());
    expect(all.length).toBeGreaterThan(stuck.length);
  });
});
