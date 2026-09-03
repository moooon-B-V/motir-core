// Fixture repository for the CALL-SITE scanner's negative case (MOTIR-2845).
//
// Nothing imports this and it is not part of the app. It exists to be PARSED, so
// the guard's own detection is exercised in both directions rather than assumed.
// `db` / the client shape are DECLARED locally for the same reason the sibling
// fixture does it: the scanner resolves no imports, and referencing the real
// client would force real model names and make this a schema-drift liability.
//
// The scanner's FIRST job is deciding which reads are even in scope, so this
// file carries the three shapes that decision has to separate.

interface Client {
  widget: {
    findUnique(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
  };
  globalSetting: { findUnique(args: unknown): Promise<unknown> };
  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

declare const db: Client;
// The SAME client under a narrower type (MOTIR-4295) — what `lib/db.ts` exports
// as `dbRead`, so a `tx ?? dbRead` fallback does not hand every call a union of
// two whole Prisma clients. Declared here for the same reason `db` is.
declare const dbRead: Client;

// A LOCAL stand-in for Prisma's namespace, so the parameter annotations below
// read `Prisma.TransactionClient` — byte-identical to a shipped repository's,
// which is what the scanner matches on. Importing the real one would drag in the
// real model list and make this fixture a schema-drift liability, which is the
// same reason `Client` above is declared rather than imported.
// eslint-disable-next-line @typescript-eslint/no-namespace -- a parse fixture must reproduce the real annotation form
declare namespace Prisma {
  type TransactionClient = Client;
}

export const fixtureRepository = {
  // (1) BINDABLE + policy-gated. IN SCOPE: every call site of this is classified.
  async findWidget(id: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? db;
    return client.widget.findUnique({ where: { id } });
  },

  // (2) BINDABLE + policy-gated, raw SQL. Also in scope — RLS applies to raw SQL
  //     exactly as to a model call.
  async rawWidget(id: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? db;
    return client.$queryRaw`SELECT 1 FROM "widget" WHERE "id" = ${id}`;
  },

  // (3) BINDABLE but the model carries NO POLICY. OUT of scope: there is nothing
  //     for an unbound read to be blind to, so its call sites are not findings.
  async findGlobalSetting(id: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? db;
    return client.globalSetting.findUnique({ where: { id } });
  },

  // (5) BINDABLE + policy-gated, through `dbRead` (MOTIR-4295). IN SCOPE for
  //     exactly the reason (1) is: the narrowing is a fact about the TYPE, and
  //     nothing about which GUC is bound. A scanner keyed on the name `db` alone
  //     would have dropped this read — and 247 real ones — out of the bindable
  //     set with no assertion failing anywhere.
  async findWidgetViaDbRead(id: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? dbRead;
    return client.widget.findMany({ where: { id } });
  },

  // (4) NOT bindable at all — no `tx` parameter. That is the SIBLING scanner's
  //     class (singletonReadScan); this one must not double-report it.
  async findWidgetUnbindable(id: string) {
    return db.widget.findUnique({ where: { id } });
  },
};
