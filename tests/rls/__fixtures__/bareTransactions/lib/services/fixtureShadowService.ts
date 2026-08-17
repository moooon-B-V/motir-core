// Fixture SERVICE for the one case that separates "resolved through the import"
// from "matched by name" (MOTIR-2945) — a LOCAL declaration wearing the blessed
// binder's name.
//
// It lives in its own file because the case cannot be written in
// `fixtureService.ts` at all: a module cannot both import `bindWorkspaceContext`
// and declare one. That is not an inconvenience — it is the shape of the
// hazard. A recogniser that keys on the identifier `bindWorkspaceContext` reads
// this file as bound and is wrong; one that resolves the callee to a declaration
// and asks whether that declaration binds reads it as unbound and is right. The
// same-file rule already in the scan gets the answer right for the same reason,
// so the two halves agree by construction rather than by a shared list of names.

import { fixtureRepository } from '../repositories/fixtureRepository';

type Tx = Parameters<typeof fixtureRepository.findWidgetMandatoryTx>[1];
declare const db: {
  $transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
};

// A LOCAL function with the blessed binder's exact name that binds NOTHING.
async function bindWorkspaceContext(tx: Tx, workspaceId: string): Promise<void> {
  await tx.widget.count({ where: { workspaceId } });
}

export const fixtureShadowService = {
  // (N) gated-statement — the call LOOKS like the blessed binder and is not one.
  //     A local declaration shadows the import, so what decides is the body: this
  //     one issues a statement and binds no GUC, and the read below it is as
  //     unbound as it was before the call.
  async bareWithLocalNamesakeBinder(id: string, workspaceId: string) {
    return db.$transaction(async (tx) => {
      await bindWorkspaceContext(tx, workspaceId);
      return fixtureRepository.findWidgetMandatoryTx(id, tx);
    });
  },
};
