// Fixture SERVICE for the BARE-TRANSACTION scanner (MOTIR-2876) — every verdict
// the scanner can return, one function each, plus the two shapes it must NOT
// report.
//
// Parsed, never executed. The `db` client and the context WRAPPER are declared
// locally for the same reason the repository fixture declares its client: the
// scanner matches identifiers and never needs to resolve them.
//
// ⚠️ The BINDER below is imported, and that is deliberate (MOTIR-2945). The scan
// resolves an imported callee to its declaration to ask whether it binds, so the
// blessed mid-block binder — which is always reached across a module boundary —
// has to arrive here the way it arrives in a real service.

import { fixtureRepository } from '../repositories/fixtureRepository';
import { bindWorkspaceContext, touchWorkspace } from '../workspaces/context';

type Tx = Parameters<typeof fixtureRepository.findWidgetMandatoryTx>[1];
declare const db: {
  $transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
};
declare function withWorkspaceContext<T>(
  workspaceId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T>;

// A same-file helper that binds its OWN GUCs inline — the
// `insertWorkspaceWithOwner` shape. Recognised STRUCTURALLY, by the `set_config`
// in its body, not by its name or its file.
async function insertWidgetWithOwner(id: string, workspaceId: string, tx: Tx) {
  await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
  return fixtureRepository.findWidgetMandatoryTx(id, tx);
}

// A same-file helper that binds NOTHING — the control for the one above, so
// "reaches a helper" can never be mistaken for "is bound".
async function loadWidget(id: string, tx: Tx) {
  return fixtureRepository.findWidgetMandatoryTx(id, tx);
}

export const fixtureService = {
  // (A) gated-statement, via a MANDATORY-`tx` repository read. THE case, and the
  //     one both existing scanners are blind to. `defaultLoadMembers` was this.
  async bareWithMandatoryTxRead(id: string) {
    return db.$transaction((tx) => fixtureRepository.findWidgetMandatoryTx(id, tx));
  },

  // (B) gated-statement, via a statement issued DIRECTLY on the transaction.
  async bareWithDirectRead(workspaceId: string) {
    return db.$transaction((tx) => tx.widget.findMany({ where: { workspaceId } }));
  },

  // (C) gated-statement, via a same-file helper that binds nothing — one hop.
  async bareWithNonBindingHelper(id: string) {
    return db.$transaction((tx) => loadWidget(id, tx));
  },

  // (D) ⚠️ gated-statement DESPITE an inline binding — because the binding comes
  //     AFTER the read. This is `ensureDefaultWorkspace` exactly, and it is the
  //     case a whole-site "does this transaction bind?" boolean gets wrong: the
  //     `countWidgets` below runs on an unbound transaction, and the
  //     `insertWidgetWithOwner` further down cannot retroactively bind it.
  //     MOTIR-2874's duplicate-default-workspace bug is what that mistake costs.
  async bareBindingAfterRead(id: string, workspaceId: string) {
    return db.$transaction(async (tx) => {
      const existing = await fixtureRepository.countWidgets(workspaceId, tx);
      if (existing > 0) return null;
      return insertWidgetWithOwner(id, workspaceId, tx);
    });
  },

  // (E) binds-inline — `set_config` written directly in the body, BEFORE the
  //     read. The `workspaceInvitesService.acceptInvite` shape (MOTIR-2777).
  async bareBindingBeforeRead(id: string, workspaceId: string) {
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      return fixtureRepository.findWidgetMandatoryTx(id, tx);
    });
  },

  // (F) binds-inline via a HELPER that binds before its own statements — the
  //     `workspacesService.createWorkspace` shape.
  async bareBindingHelperOnly(id: string, workspaceId: string) {
    return db.$transaction((tx) => insertWidgetWithOwner(id, workspaceId, tx));
  },

  // (G) no-gated-statement — the table carries no policy, so there is nothing to
  //     be blind to. These are the survivors the ceiling's prose describes.
  async bareNonGated(id: string) {
    return db.$transaction((tx) => fixtureRepository.findGlobalSettingMandatoryTx(id, tx));
  },

  // (H) gated-statement via RAW SQL, whose target the parser cannot name. Reported
  //     so a human adjudicates it rather than the scanner guessing.
  async bareWithRaw(id: string) {
    return db.$transaction((tx) => fixtureRepository.lockWidget(id, tx));
  },

  // (I) NOT REPORTED — a binding context is not a bare transaction. The scanner
  //     keys on `db.$transaction`, so this shape is invisible to it by
  //     construction, which is the point: it is the shape everything is moving to.
  async bound(id: string, workspaceId: string) {
    return withWorkspaceContext(workspaceId, (tx) =>
      fixtureRepository.findWidgetMandatoryTx(id, tx),
    );
  },

  // (J) ⚠️ THE PINNED LIMIT — a helper reached TWO hops deep. `outer` forwards the
  //     `tx` to `loadWidget`, and the scanner does not follow it, so this site
  //     reads as `no-gated-statement`. One hop is the documented depth; deeper is
  //     a call graph and a different card. Pinned as a test rather than left
  //     implicit, so the day someone widens the scan this fixture tells them what
  //     changed.
  async bareTwoHops(id: string) {
    return db.$transaction((tx) => outer(id, tx));
  },

  // (K) binds-inline via the IMPORTED binder — the shape MOTIR-2945 was filed
  //     for, and the one the codebase's own documentation tells you to write
  //     when the workspace is only known partway through the transaction. The
  //     binding is real; before the fix it read as unbound purely because the
  //     callee lived in another module.
  async bareBindingViaImportedBinder(id: string, workspaceId: string) {
    return db.$transaction(async (tx) => {
      await bindWorkspaceContext(tx, workspaceId);
      return fixtureRepository.findWidgetMandatoryTx(id, tx);
    });
  },

  // (L) ⚠️ gated-statement DESPITE the imported binder — because the read comes
  //     FIRST. Case (D) one module over: following an imported callee must add a
  //     POSITION, never a whole-site "this transaction binds" flag. If this ever
  //     reports `binds-inline`, the positional half was lost in the fix and
  //     `ensureDefaultWorkspace`'s defect can come back through the import.
  async bareImportedBinderAfterRead(id: string, workspaceId: string) {
    return db.$transaction(async (tx) => {
      const existing = await fixtureRepository.countWidgets(workspaceId, tx);
      await bindWorkspaceContext(tx, workspaceId);
      return existing;
    });
  },

  // (M) gated-statement — an IMPORTED callee that binds nothing. The control for
  //     (K): what clears a statement is the `set_config` in the callee's body,
  //     not the fact that a `tx` crossed a module boundary.
  async bareWithImportedNonBinder(workspaceId: string) {
    return db.$transaction(async (tx) => {
      await touchWorkspace(tx, workspaceId);
      return tx.widget.findMany({ where: { workspaceId } });
    });
  },
};

async function outer(id: string, tx: Tx) {
  return loadWidget(id, tx);
}
