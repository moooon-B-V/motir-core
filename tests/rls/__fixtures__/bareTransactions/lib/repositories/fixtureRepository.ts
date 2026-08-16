// Fixture repository for the BARE-TRANSACTION scanner (MOTIR-2876).
//
// Nothing imports this and it is not part of the app. It exists to be PARSED, so
// the guard's own detection is exercised in both directions rather than assumed.
// The client shape is DECLARED locally for the reason the sibling fixtures give:
// the scanner resolves no imports, and referencing the real client would force
// real model names and make this a schema-drift liability.
//
// ⚠️ The FIRST method is the whole point of the module. `findWidgetMandatoryTx`
// takes a REQUIRED `tx` — no `?`, no `tx ?? db` — which is the shape both
// existing scanners are structurally blind to:
//
//   * `singletonReadScan` never sees it: it never mentions `db`.
//   * `callSiteScan` never sees it: `bindableGatedReads` filters on
//     `hasOptionalTxParam`, which requires a `questionToken`.
//
// All three reads MOTIR-2874 found by hand were exactly this shape, which is why
// three live defects sat inside a green `BARE_TRANSACTION_CEILING` for a month.

interface Client {
  widget: {
    findUnique(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
    count(args: unknown): Promise<number>;
  };
  globalSetting: { findUnique(args: unknown): Promise<unknown> };
  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

declare const db: Client;

// A LOCAL stand-in for Prisma's namespace, so the annotations below read
// `Prisma.TransactionClient` — byte-identical to a shipped repository's.
// eslint-disable-next-line @typescript-eslint/no-namespace -- a parse fixture must reproduce the real annotation form
declare namespace Prisma {
  type TransactionClient = Client;
}

export const fixtureRepository = {
  // (1) MANDATORY `tx` + policy-gated. THE blind spot: in scope here, in scope
  //     nowhere else.
  async findWidgetMandatoryTx(id: string, tx: Prisma.TransactionClient) {
    return tx.widget.findUnique({ where: { id } });
  },

  // (2) MANDATORY `tx` + policy-gated, raw SQL — the target is a string the
  //     parser cannot resolve, so the site is reported for adjudication rather
  //     than silently cleared. `lockById` / `lockCredentialByUserId` are this.
  async lockWidget(id: string, tx: Prisma.TransactionClient) {
    return tx.$queryRaw`SELECT id FROM "widget" WHERE id = ${id} FOR UPDATE`;
  },

  // (3) MANDATORY `tx`, model carries NO POLICY. Out of scope: there is nothing
  //     for an unbound statement to be blind to.
  async findGlobalSettingMandatoryTx(id: string, tx: Prisma.TransactionClient) {
    return tx.globalSetting.findUnique({ where: { id } });
  },

  // (4) OPTIONAL `tx` + policy-gated — `callSiteScan`'s population. In scope here
  //     too: the question this scanner asks ("what did the transaction bind?") is
  //     the same whether or not the caller had a choice.
  async findWidget(id: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? db;
    return client.widget.findUnique({ where: { id } });
  },

  async countWidgets(workspaceId: string, tx: Prisma.TransactionClient) {
    return tx.widget.count({ where: { workspaceId } });
  },
};
