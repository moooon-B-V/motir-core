// Fixture repository for the ORG-CONTEXT descriptor (MOTIR-2959).
//
// Nothing imports this and it is not part of the app. It exists to be PARSED, so
// the descriptor's own detection is exercised in both directions rather than
// assumed. The client shape is DECLARED locally for the reason every sibling
// fixture gives: the scanner resolves no imports, and referencing the real client
// would force real model names and make this a schema-drift liability.
//
// ⚠️ `sumWidgetsByOwner` is the org descriptor's own fixture for `notes.html`
// #269 — the FROM clause is `widget` and the `include` reaches `gadget_row`. It
// is `attachmentRepository.sumSizeByOrganization` in miniature: arming only the
// table the query NAMES leaves the answer at zero, which is the fix reading as
// applied while changing nothing.

interface Client {
  widget: {
    findUnique(args: unknown): Promise<unknown>;
    findFirst(args: unknown): Promise<unknown>;
  };
  gadget: { findUnique(args: unknown): Promise<unknown> };
  globalSetting: { findUnique(args: unknown): Promise<unknown> };
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
  async sumWidgetsByOwner(id: string, tx: Prisma.TransactionClient) {
    return tx.widget.findFirst({ where: { id }, include: { owner: true } });
  },

  // (3) A gated read of the JOINED table alone, so a fixture can distinguish
  //     "reported because it is the FROM clause" from "reported because it is
  //     reachable at all".
  async findGadget(id: string, tx: Prisma.TransactionClient) {
    return tx.gadget.findUnique({ where: { id } });
  },

  // (4) A model carrying no policy — nothing for an org context to be blind to.
  async findGlobalSetting(id: string, tx: Prisma.TransactionClient) {
    return tx.globalSetting.findUnique({ where: { id } });
  },
};
