// Fixture repository for the SYSTEM-CONTEXT scanner (MOTIR-2880).
//
// Nothing imports this and it is not part of the app. It exists to be PARSED, so
// the guard's own detection is exercised in both directions rather than assumed.
// The client shape is DECLARED locally for the reason the sibling fixtures give:
// the scanner resolves no imports, and referencing the real client would force
// real model names and make this a schema-drift liability.
//
// ⚠️ `findWidgetWithOwner` is the method the other three scanners cannot judge.
// Its FROM clause is `widget`; its `include` reaches `gadget_row`. If the scanner
// collected only the delegate it addresses, a site reading it would be cleared on
// `widget`'s arm while dying on `gadget_row`'s absence — which is exactly how
// `projectRepository#findLivePairs` and
// `ciContainerPeriodCostRepository#sumForPeriodByMetaSplit` survived an arm
// inventory that named 45 unarmed tables.

interface Client {
  widget: {
    findUnique(args: unknown): Promise<unknown>;
    findFirst(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
  };
  gadget: { findUnique(args: unknown): Promise<unknown> };
  globalSetting: { findUnique(args: unknown): Promise<unknown> };
  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

// A LOCAL stand-in for Prisma's namespace, so the annotations below read
// `Prisma.TransactionClient` — byte-identical to a shipped repository's.
// eslint-disable-next-line @typescript-eslint/no-namespace -- a parse fixture must reproduce the real annotation form
declare namespace Prisma {
  type TransactionClient = Client;
}

export const fixtureRepository = {
  // (1) A plain gated read — the FROM clause and nothing else.
  async findWidget(id: string, tx: Prisma.TransactionClient) {
    return tx.widget.findUnique({ where: { id } });
  },

  // (2) ⚠️ THE JOIN CASE. `include` names a relation field, so the query touches
  //     `gadget_row` as well as `widget`.
  async findWidgetWithOwner(id: string, tx: Prisma.TransactionClient) {
    return tx.widget.findFirst({ where: { id }, include: { owner: true } });
  },

  // (3) The join expressed as a relation FILTER rather than an include — the
  //     `workspace: { is: {} }` shape that made `findLivePairs` return nothing.
  async findWidgetsWithLiveOwner(workspaceId: string, tx: Prisma.TransactionClient) {
    return tx.widget.findMany({ where: { workspaceId, owner: { is: {} } } });
  },

  // (4) Raw SQL whose JOIN target is a literal the parser CAN resolve, because it
  //     names a table the schema declares.
  async sumWidgetsByOwner(tx: Prisma.TransactionClient) {
    return tx.$queryRaw`
      SELECT g."id", count(*) FROM "Widget" AS w
      JOIN "gadget_row" g ON g."id" = w."ownerId"
      GROUP BY g."id"
    `;
  },

  // (5) A model carrying no policy — nothing for a system context to be blind to.
  async findGlobalSetting(id: string, tx: Prisma.TransactionClient) {
    return tx.globalSetting.findUnique({ where: { id } });
  },
};
