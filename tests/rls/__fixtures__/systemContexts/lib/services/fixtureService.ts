// Fixture SERVICE for the SYSTEM-CONTEXT scanner (MOTIR-2880) — every verdict the
// scanner can return, one function each, plus the shapes it must NOT report.
//
// Parsed, never executed. The context wrappers are declared locally for the same
// reason the repository fixture declares its client: the scanner matches
// identifiers and resolves no imports.

import { fixtureRepository as repo } from '../repositories/fixtureRepository';

type Tx = Parameters<typeof repo.findWidget>[1];
declare function withSystemContext<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
declare function withWorkspaceServiceContext<T>(
  workspaceId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T>;
declare function bindWorkspaceContext(tx: Tx, workspaceId: string): Promise<void>;

// A same-file helper that forwards its `tx` to a repository — the
// `historicalPullRequestBackfillService#applyOne` shape, and the reason the scan
// follows a helper's own repository calls rather than only its inline statements.
async function loadWidget(id: string, tx: Tx) {
  return repo.findWidget(id, tx);
}

export const fixtureService = {
  // (A) system-only — the plain case. One gated read, no tenant bound.
  async systemOnlyRead(id: string) {
    return withSystemContext((tx) => repo.findWidget(id, tx));
  },

  // (B) ⚠️ system-only ON THE JOINED TABLE. The FROM clause is `widget`; the
  //     `include` reaches `gadget_row`. Both must appear in `systemOnlyModels`,
  //     because the guard adjudicates per (table, context) and an admitted FROM
  //     clause does not admit the query.
  async systemOnlyJoinedRead(id: string) {
    return withSystemContext((tx) => repo.findWidgetWithOwner(id, tx));
  },

  // (C) The same join expressed as a relation FILTER.
  async systemOnlyRelationFilterRead(workspaceId: string) {
    return withSystemContext((tx) => repo.findWidgetsWithLiveOwner(workspaceId, tx));
  },

  // (D) A raw-SQL JOIN whose targets the parser CAN name.
  async systemOnlyRawJoin() {
    return withSystemContext((tx) => repo.sumWidgetsByOwner(tx));
  },

  // (E) binds-tenant — the fix shape. `bindWorkspaceContext` runs BEFORE the
  //     gated read, so nothing is system-only. This is
  //     `codeGraphIndexService#resolveIndexTarget` after MOTIR-2880.
  async bindsBeforeRead(id: string, workspaceId: string) {
    return withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, workspaceId);
      return repo.findWidget(id, tx);
    });
  },

  // (F) ⚠️ system-only DESPITE a binding — because the binding comes AFTER the
  //     read. THE case a whole-site boolean gets wrong, and the reason `bindPos`
  //     is a position: every site this card fixed binds mid-block, so a boolean
  //     would clear all of them including their surviving pre-bind reads.
  async bindsAfterRead(id: string, workspaceId: string) {
    return withSystemContext(async (tx) => {
      const first = await repo.findWidget(id, tx);
      await bindWorkspaceContext(tx, workspaceId);
      return first;
    });
  },

  // (G) The real shape of the fix at a webhook: an ARMED connection-tier read,
  //     then the bind, then the tenant read. Only the first is system-only, which
  //     is correct — that is what the connection tier's arm is for.
  async discoversThenBinds(id: string, workspaceId: string) {
    return withSystemContext(async (tx) => {
      const gate = await repo.findGlobalSetting(id, tx);
      await bindWorkspaceContext(tx, workspaceId);
      const widget = await repo.findWidget(id, tx);
      return { gate, widget };
    });
  },

  // (H) no-gated-statement — the model carries no policy.
  async systemNonGated(id: string) {
    return withSystemContext((tx) => repo.findGlobalSetting(id, tx));
  },

  // (I) One hop into a same-file helper that forwards to a repository.
  async systemOnlyViaHelper(id: string) {
    return withSystemContext((tx) => loadWidget(id, tx));
  },

  // (J) NOT REPORTED — a tenant-bound context is not a system context. The scanner
  //     keys on `withSystemContext`, so this is invisible by construction, which is
  //     the point: it is the shape most of the fixed sites moved to.
  async bound(id: string, workspaceId: string) {
    return withWorkspaceServiceContext(workspaceId, (tx) => repo.findWidget(id, tx));
  },

  // (K) TWO hops — `outer` forwards the `tx` to `loadWidget`, which reads. IN
  //     REACH, and deliberately so: the shallowest real instance of this class
  //     found by hand sits at exactly two
  //     (`sweepRepo` -> `applyOne` -> `resolveChangeRequestWorkItem`), and a
  //     one-hop walk reported that site fully armed while six of its tests were
  //     red. This is the case that made the walk recursive.
  async systemTwoHops(id: string) {
    return withSystemContext((tx) => outer(id, tx));
  },

  // (L) THREE hops — the last one in reach (`MAX_HELPER_HOPS`).
  async systemThreeHops(id: string) {
    return withSystemContext((tx) => outerOuter(id, tx));
  },

  // (M) ⚠️ THE PINNED LIMIT — FOUR hops, out of reach by design. Pinned as a test
  //     rather than left implicit, so the day someone widens the walk again this
  //     fixture tells them what changed, and so the bound is a decision rather
  //     than an accident of how deep the tree happened to go.
  async systemFourHops(id: string) {
    return withSystemContext((tx) => outerOuterOuter(id, tx));
  },

  // (N) ⚠️ MUTUAL RECURSION — the shape that makes an unbounded walk hang. The
  //     visited set is what makes the depth cap safe rather than merely finite;
  //     this site terminates and reports the read it can reach.
  async systemMutualRecursion(id: string) {
    return withSystemContext((tx) => ping(id, tx));
  },
};

async function outer(id: string, tx: Tx) {
  return loadWidget(id, tx);
}

async function outerOuter(id: string, tx: Tx) {
  return outer(id, tx);
}

async function outerOuterOuter(id: string, tx: Tx) {
  return outerOuter(id, tx);
}

async function ping(id: string, tx: Tx): Promise<unknown> {
  return pong(id, tx);
}

async function pong(id: string, tx: Tx): Promise<unknown> {
  if (id === '') return ping(id, tx);
  return repo.findWidget(id, tx);
}
