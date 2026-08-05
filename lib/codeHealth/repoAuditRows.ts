import type { RepoAuditSurfaceDTO } from '@/lib/dto/codeHealth';

// The /code-health audit tab's per-repo LIST model (MOTIR-2207 ·
// design/coding-convention Panel 7 §1/§5/§6).
//
// The tab's selection model is LIST-AND-REPORT: a worst-first list of the
// connected repos, each row carrying that repo's own grade, and the SELECTED
// repo's report beneath it. This module is the pure half of that — it turns the
// per-repo surfaces into rows, orders them, and rolls them up. It is shared by
// the server page (which picks the initially selected repo) and the client
// island (which re-picks after every completed read), so both agree on what
// "the first row" means without either re-deriving the rule.
//
// There is deliberately NO project-level grade here (Panel 7 §2): a mean of
// conformance scores across codebases of different sizes is a claim, not a
// calculation — it would move when a repo is CONNECTED rather than when any code
// changed. The rollup carries only counts that are TRUE by addition.

export type RepoAuditRowState = 'audited' | 'deriving' | 'not_audited' | 'unavailable';

export interface RepoAuditRow {
  repoKey: string;
  state: RepoAuditRowState;
  /** The letter grade, when this repo has an audit that reported one. */
  grade: string | null;
  conformancePct: number | null;
  /** This repo's TOTAL finding count — off the surface's `total`, never the
   *  length of the findings page (the list reads at `findingsLimit=1`). */
  findingCount: number;
  auditedAt: string | null;
}

export interface RepoAuditRollup {
  connected: number;
  audited: number;
  findings: number;
  deriving: number;
  notAudited: number;
  unavailable: number;
}

// Worst-first, then the work in flight, then the code nothing has read yet, then
// the rows that failed to load. Ordering by STATE first is what keeps a row with
// no grade from sorting into the middle of the graded ones; `unavailable` sits
// last because it carries no grade to compare and its only affordance is a
// retry, so defaulting the selection to it would open the tab on an error.
const STATE_RANK: Record<RepoAuditRowState, number> = {
  audited: 0,
  deriving: 1,
  not_audited: 2,
  unavailable: 3,
};

/**
 * Build one row per connected repo, in the order the repos were given (the
 * connected order — `owner asc, name asc`), which `orderRepoAuditRows` then uses
 * as its tiebreak.
 *
 * `derivingRepoKeys` is the set the island knows is IN FLIGHT — the repos
 * `reaudit()` queued whose audit has not changed since. It is not a field on the
 * DTO: inventing one would be a motir-ai change and a two-repo straddle
 * (Panel 7 §5), so the caller passes what the trigger already told it.
 */
export function buildRepoAuditRows(
  audits: readonly RepoAuditSurfaceDTO[],
  derivingRepoKeys: readonly string[] = [],
): RepoAuditRow[] {
  return audits.map(({ repoKey, surface }) => {
    if (surface === null) {
      return {
        repoKey,
        state: 'unavailable' as const,
        grade: null,
        conformancePct: null,
        findingCount: 0,
        auditedAt: null,
      };
    }
    if (surface.audit === null) {
      return {
        repoKey,
        // A repo with a queued job and nothing derived YET is deriving; one with
        // neither has simply never been read.
        state: derivingRepoKeys.includes(repoKey)
          ? ('deriving' as const)
          : ('not_audited' as const),
        grade: null,
        conformancePct: null,
        findingCount: 0,
        auditedAt: null,
      };
    }
    // A repo whose PREVIOUS audit is still on screen while a fresh one derives
    // reads as deriving, not as its stale grade: the number is about to change,
    // and the design's row table has one state per row, not a grade plus a
    // spinner. Its report keeps rendering underneath (Panel 7 §5, E1).
    if (derivingRepoKeys.includes(repoKey)) {
      return {
        repoKey,
        state: 'deriving' as const,
        grade: null,
        conformancePct: null,
        findingCount: surface.total,
        auditedAt: surface.audit.createdAt,
      };
    }
    const summary = surface.audit.healthSummary;
    return {
      repoKey,
      state: 'audited' as const,
      grade: summary.grade ?? null,
      conformancePct: summary.conformancePct ?? null,
      findingCount: surface.total,
      auditedAt: surface.audit.createdAt,
    };
  });
}

/**
 * Worst-first: ascending `conformancePct`, then the deriving rows, then the
 * never-audited rows, then the unloadable ones — with the connected order as the
 * tiebreak, and as the WHOLE order before any audit exists.
 *
 * Pure and total: the caller re-runs it after a COMPLETED read only, so a repo
 * finishing mid-run can never re-sort the list under the reader (Panel 7 §4).
 */
export function orderRepoAuditRows(rows: readonly RepoAuditRow[]): RepoAuditRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const byState = STATE_RANK[a.row.state] - STATE_RANK[b.row.state];
      if (byState !== 0) return byState;
      if (a.row.state === 'audited') {
        const ap = a.row.conformancePct;
        const bp = b.row.conformancePct;
        // An audit that reported no conformance number cannot be ranked against
        // one that did — it goes after the graded rows rather than sorting as 0.
        if (ap === null && bp !== null) return 1;
        if (bp === null && ap !== null) return -1;
        if (ap !== null && bp !== null && ap !== bp) return ap - bp;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}

/**
 * The repo whose report opens the tab: the first row of the ordered list that
 * can actually show one. An `unavailable` row is skipped — its read failed, so
 * defaulting to it would open the tab on an error while readable siblings sit
 * one click away. It remains selectable by hand; this only picks the default.
 * Null when every row is unavailable (or there are no repos at all).
 */
export function defaultSelectedRepoKey(rows: readonly RepoAuditRow[]): string | null {
  return orderRepoAuditRows(rows).find((row) => row.state !== 'unavailable')?.repoKey ?? null;
}

/** Counts that are TRUE BY ADDITION — never a mean (Panel 7 §2). */
export function rollupRepoAuditRows(rows: readonly RepoAuditRow[]): RepoAuditRollup {
  return {
    connected: rows.length,
    audited: rows.filter((r) => r.state === 'audited').length,
    // Findings across the repos that HAVE landed — never what a run queued.
    findings: rows.reduce((sum, r) => (r.state === 'audited' ? sum + r.findingCount : sum), 0),
    deriving: rows.filter((r) => r.state === 'deriving').length,
    notAudited: rows.filter((r) => r.state === 'not_audited').length,
    unavailable: rows.filter((r) => r.state === 'unavailable').length,
  };
}
