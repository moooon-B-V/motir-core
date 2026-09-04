// Fixture SERVICE for the call-site scanner (MOTIR-2845) — the four positions a
// call to a bindable, policy-gated read can occupy, one method each.
//
// Parsed, never executed. The context wrappers are declared locally for the same
// reason the repository fixture declares its client: the scanner matches
// identifiers and resolves no imports.

import { fixtureRepository } from '../repositories/fixtureRepository';

// The transaction handle's SHAPE is irrelevant to a parser; `unknown` keeps the
// fixture free of the real client's model list, which would make it a
// schema-drift liability for no benefit.
type Tx = Parameters<typeof fixtureRepository.findWidget>[1];
// The detector keys on the TYPE NAME carrying `TransactionClient` (the real code
// writes `Prisma.TransactionClient`), so the fixture has to say it too — the alias
// exists for that reason and nothing else.
type TransactionClient = Tx;
declare const db: { $transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> };
declare function withWorkspaceServiceContext<T>(
  workspaceId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T>;

// (I) a MODULE-LOCAL forwarding helper — takes its own `tx?`, hands it to a
//     bindable read, and falls through to the singleton when the caller passes
//     none. The helper's own line looks bound; the gap is at its CALL SITES, and
//     MOTIR-2846's second pass taught the scanner to reach exactly one frame up
//     to find them. `unboundHelperCaller` below is the finding.
async function resolveWidget(id: string, tx?: TransactionClient) {
  return fixtureRepository.findWidget(id, tx);
}

// (J) the SAME shape, repaired: it binds its own fallback. NOT a finding, and its
//     callers owe nothing — without this exclusion, fixing a helper would leave
//     every one of its call sites reported forever.
async function resolveWidgetBound(id: string, workspaceId: string, tx?: TransactionClient) {
  return tx
    ? fixtureRepository.findWidget(id, tx)
    : withWorkspaceServiceContext(workspaceId, (t) => fixtureRepository.findWidget(id, t));
}

export const fixtureService = {
  // (A) receives-tx OUTSIDE a context — the caller's own optional `tx`, forwarded.
  //     NOT a finding here. The scanner reaches one frame up for a MODULE-LOCAL
  //     helper (see (I)); an EXPORTED method like this one is called from other
  //     files, so its gap stays out of reach. That boundary is deliberate and is
  //     pinned by the guard.
  async forwarded(id: string, tx?: Tx) {
    return fixtureRepository.findWidget(id, tx);
  },

  // (B) receives-tx INSIDE a context — the shape the whole story is moving to.
  //     NOT a finding.
  async bound(id: string, workspaceId: string) {
    return withWorkspaceServiceContext(workspaceId, (tx) => fixtureRepository.findWidget(id, tx));
  },

  // (C) in-context but UNBOUND — the transaction is open, in scope, and the read
  //     is issued beside it instead of through it. A FINDING, and the sharper one.
  async inContextUnbound(id: string, workspaceId: string) {
    return withWorkspaceServiceContext(workspaceId, async () => {
      return fixtureRepository.findWidget(id);
    });
  },

  // (D) no-context — no bound transaction anywhere up the chain. A FINDING.
  async noContext(id: string) {
    return fixtureRepository.findWidget(id);
  },

  // (D') the same finding through a read whose fallback names `dbRead`
  //      (MOTIR-4295). A FINDING, and the one that proves the widened recogniser
  //      bites rather than merely not-crashing.
  async noContextViaDbRead(id: string) {
    return fixtureRepository.findWidgetViaDbRead(id);
  },

  // (E) raw SQL, no context. A FINDING — the policy is on the table, not on the
  //     query style.
  async rawNoContext(id: string) {
    return fixtureRepository.rawWidget(id);
  },

  // (F) a read of a NON-gated model, unbound. NOT a finding.
  async nonGated(id: string) {
    return fixtureRepository.findGlobalSetting(id);
  },

  // (G) a read that is not bindable at all, unbound. NOT this scanner's — the
  //     singleton scan owns it, and double-reporting would make two ratchets
  //     move for one fix.
  async unbindable(id: string) {
    return fixtureRepository.findWidgetUnbindable(id);
  },

  // (H) a BARE `db.$transaction` — reported separately by `bareTransactionSites`,
  //     because it binds no GUCs and yet looks bound at a glance.
  async bareTransaction(id: string) {
    return db.$transaction(async (tx) => fixtureRepository.findWidget(id, tx));
  },

  // (I') the finding (I) produces: the helper is called with no transaction.
  async unboundHelperCaller(id: string) {
    return resolveWidget(id);
  },

  // (J') the repaired helper's caller — NOT a finding.
  async boundHelperCaller(id: string, workspaceId: string) {
    return resolveWidgetBound(id, workspaceId);
  },
};
