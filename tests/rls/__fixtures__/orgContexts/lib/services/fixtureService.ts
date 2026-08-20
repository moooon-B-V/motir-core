// Fixture SERVICE for the ORG-CONTEXT descriptor (MOTIR-2959) — every verdict the
// descriptor can return, one function each, plus the shapes it must NOT report.
//
// Parsed, never executed. The context wrappers are declared locally for the same
// reason the repository fixture declares its client: the scanner matches
// identifiers and resolves no imports.
//
// ⚠️ WHAT THIS FIXTURE ADDS OVER `__fixtures__/systemContexts`, and why it is a
// second tree rather than three more functions in that one: the org family is
// the first descriptor with a `bind` ENTRY — a helper that binds its GUC on a
// transaction that is ALREADY OPEN. That inverts the window. A `wrapper` runs
// from the top of its callback UNTIL a narrowing bind; a `bind` runs FROM the
// call to the end of the enclosing function, so the statements a `wrapper`
// adjudicates and the ones a `bind` adjudicates sit on opposite sides of a line.
// Getting that backwards would report every pre-bind statement as bound by a GUC
// that was not set yet — the mirror of the mistake `bindsAfterRead` pins one
// axis over, and invisible without a fixture that puts reads on both sides.

import { fixtureRepository as repo } from '../repositories/fixtureRepository';

type Tx = Parameters<typeof repo.findWidget>[1];
declare function withOrgServiceWriteContext<T>(
  organizationId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T>;
declare function withOrgContext<T>(
  ctx: { userId: string; organizationId: string },
  fn: (tx: Tx) => Promise<T>,
): Promise<T>;
declare function withWorkspaceContext<T>(
  workspaceId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T>;
declare function bindOrganizationContext(tx: Tx, organizationId: string): Promise<void>;

// A same-file helper that forwards its `tx` to a repository — the
// `historicalPullRequestBackfillService#applyOne` shape, and the reason the scan
// follows a helper's own repository calls rather than only its inline statements.
async function loadWidget(id: string, tx: Tx) {
  return repo.findWidget(id, tx);
}

export const fixtureService = {
  // (A) context-only — the plain case. One gated read under the org binding.
  //     ⚠️ AND IT PINS THE CALLBACK ARITY: this wrapper takes the org id FIRST
  //     and the callback SECOND, where `withSystemContext` takes only a callback.
  //     The scan finds the callback as the first FUNCTION-VALUED argument rather
  //     than at a fixed index, and this is the fixture that says so.
  async orgOnlyRead(id: string, organizationId: string) {
    return withOrgServiceWriteContext(organizationId, (tx) => repo.findWidget(id, tx));
  },

  // (B) ⚠️ context-only ON THE JOINED TABLE — MOTIR-2956 in miniature. The FROM
  //     clause is `widget`; the `include` reaches `gadget_row`. Both must appear,
  //     because the guard adjudicates per (table, context) and an admitted FROM
  //     clause does not admit the query.
  async orgJoinedRead(id: string, organizationId: string) {
    return withOrgServiceWriteContext(organizationId, (tx) => repo.sumWidgetsByOwner(id, tx));
  },

  // (C) no-gated-statement — the model carries no policy.
  async orgNonGated(id: string, organizationId: string) {
    return withOrgServiceWriteContext(organizationId, (tx) => repo.findGlobalSetting(id, tx));
  },

  // (D) One hop into a same-file helper that forwards to a repository.
  async orgViaHelper(id: string, organizationId: string) {
    return withOrgServiceWriteContext(organizationId, (tx) => loadWidget(id, tx));
  },

  // (E) ⚠️ THE `bind` ENTRY, AND ITS POSITION. `findGadget` runs BEFORE the bind
  //     and `findWidget` AFTER it. Only the second is under `app.organization_id`;
  //     the first is under whatever the ENCLOSING context bound, and is that
  //     descriptor's business rather than this one's. A window that opened at the
  //     top of the block would report `gadget` as org-bound when the GUC was not
  //     yet set — a claim in the dangerous direction, since it reads as coverage.
  async bindsMidBlock(id: string, workspaceId: string, organizationId: string) {
    return withWorkspaceContext(workspaceId, async (tx) => {
      const before = await repo.findGadget(id, tx);
      await bindOrganizationContext(tx, organizationId);
      const after = await repo.findWidget(id, tx);
      return { before, after };
    });
  },

  // (F) `narrowed` — every gated read sits ABOVE the bind, so this descriptor has
  //     nothing to adjudicate. This is `workspacesService.addMember`'s shape: the
  //     workspace rows are read first, and the bind exists for the write beneath
  //     it. A site with no in-window statement is still REPORTED, so the guard's
  //     expected-set can tell "swept and empty" from "never seen".
  async bindsAfterEveryRead(id: string, workspaceId: string, organizationId: string) {
    return withWorkspaceContext(workspaceId, async (tx) => {
      const widget = await repo.findWidget(id, tx);
      await bindOrganizationContext(tx, organizationId);
      return widget;
    });
  },

  // (G) NOT REPORTED — `withOrgContext` binds an acting user as well, so the org
  //     arms MOTIR-2956 added (guarded on `app.user_id` being EMPTY) do not fire
  //     for it and its reads are admitted member-scoped instead. It is its own
  //     descriptor (`ORG_USER_CONTEXT`), and this pins that the org-SERVICE one
  //     does not claim it.
  async orgUserRead(id: string, userId: string, organizationId: string) {
    return withOrgContext({ userId, organizationId }, (tx) => repo.findWidget(id, tx));
  },

  // (H) ⚠️ THE WALL (MOTIR-2910) under a `bind` entry. The transaction is handed
  //     to a callee the walk cannot resolve BY NAME — a function-typed PARAMETER
  //     — so everything it reads is unread and the verdict describes only part of
  //     the window. Pinned here as well as one axis over because the `bind` entry
  //     computes its window differently, and a wall inside one is exactly as
  //     invisible.
  async bindsThenUnresolved(
    workspaceId: string,
    organizationId: string,
    resolveContext: (tx: Tx) => Promise<unknown>,
  ) {
    return withWorkspaceContext(workspaceId, async (tx) => {
      await bindOrganizationContext(tx, organizationId);
      return resolveContext(tx);
    });
  },
};
