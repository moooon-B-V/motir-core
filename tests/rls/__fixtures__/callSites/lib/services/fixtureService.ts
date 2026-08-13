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
declare const db: { $transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> };
declare function withWorkspaceServiceContext<T>(
  workspaceId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T>;

export const fixtureService = {
  // (A) receives-tx OUTSIDE a context — the caller's own optional `tx`, forwarded.
  //     NOT a finding here: the gap, if there is one, is one frame up. That
  //     limitation is deliberate and is pinned by the guard.
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
};
