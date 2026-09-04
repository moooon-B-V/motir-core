// Fixture repository for the singleton-read scanner's negative case (MOTIR-2784).
//
// Nothing imports this and it is not part of the app. It exists to be PARSED, so the
// guard's own detection is exercised in both directions rather than assumed. The
// `db` / `tx` shapes below are DECLARED locally rather than imported from
// `@/lib/db`: the scanner resolves no imports (it matches the identifier), and a
// fixture that referenced the real client would have to name real models, which
// would make it a schema-drift liability for no benefit.

interface Client {
  widget: { findUnique(args: unknown): Promise<unknown> };
  globalSetting: { findUnique(args: unknown): Promise<unknown> };
  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  $transaction(fn: () => Promise<unknown>): Promise<unknown>;
}

declare const db: Client;
// The SAME client under a narrower type (MOTIR-4295) — what `lib/db.ts` exports
// as `dbRead` so a `tx ?? dbRead` fallback does not form a union of two whole
// Prisma clients. Declared here for the same reason `db` is.
declare const dbRead: Omit<Client, '$transaction'>;

export const fixtureRepository = {
  // (1) UNBOUND read of a workspace-scoped model — the scanner MUST flag this.
  async findWidgetUnbound(id: string) {
    return db.widget.findUnique({ where: { id } });
  },

  // (2) BINDABLE read — `tx ?? db` means the caller decides. MUST NOT be flagged.
  async findWidgetBindable(id: string, tx?: Client) {
    const client = tx ?? db;
    return client.widget.findUnique({ where: { id } });
  },

  // (3) Singleton read of a NON-tenant model. MUST NOT be flagged: there is no
  //     policy to be blind to.
  async findGlobalSetting(id: string) {
    return db.globalSetting.findUnique({ where: { id } });
  },

  // (4) Raw SQL on the singleton — target unknowable to the parser, so the scanner
  //     MUST flag it and force a human verdict.
  async rawUnbound(id: string) {
    return db.$queryRaw`SELECT 1 FROM "widget" WHERE "id" = ${id}`;
  },

  // (5) `$transaction` / `$disconnect` are not reads. MUST NOT be flagged.
  async notARead() {
    return db.$transaction(async () => undefined);
  },

  // (6) BINDABLE through `dbRead` (MOTIR-4295) — the same fallback under the
  //     narrowed client. MUST NOT be flagged, for exactly the reason (2) is not:
  //     a scanner that read only `db` would have called all 247 swept sites
  //     newly unbound, which is the loudest possible way to be wrong.
  async findWidgetBindableViaDbRead(id: string, tx?: Client) {
    const client = tx ?? dbRead;
    return client.widget.findUnique({ where: { id } });
  },

  // (7) UNBOUND through `dbRead`. MUST be flagged: the narrowing is a fact about
  //     the TYPE, not about the tenant GUC, so a bare read off it is as blind as
  //     (1). This is the half a name-keyed scanner silently loses.
  async findWidgetUnboundViaDbRead(id: string) {
    return dbRead.widget.findUnique({ where: { id } });
  },
};
