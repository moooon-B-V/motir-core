// Fixture repository for the TEST call-site classifier (MOTIR-2817).
//
// Nothing imports this and it is not part of the app. It exists to be PARSED, so
// the classifier's own detection is exercised in every direction rather than
// assumed. `db` / `tx` are DECLARED locally rather than imported: the classifier
// resolves no imports (it matches the identifier), and a fixture referencing the
// real client would have to name real models, making it a schema-drift liability
// for no benefit. Same posture as the MOTIR-2784 scanner's fixture.

interface Client {
  widget: { findMany(args?: unknown): Promise<unknown[]>; count(args?: unknown): Promise<number> };
  globalSetting: { findMany(args?: unknown): Promise<unknown[]> };
  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

declare const db: Client;

export const fixtureRepository = {
  // (1) GATED + BINDABLE. A call passing no `tx` is `in-scope`; a call passing one
  //     is `already-bound`. Both arms are exercised from the fixture's test file.
  async findWidgets(workspaceId: string, tx?: Client) {
    const client = tx ?? db;
    return client.widget.findMany({ where: { workspaceId } });
  },

  // (2) NOT GATED — `globalSetting` carries no `workspaceId`, so no policy applies
  //     and an unbound read is correct. Must classify `not-gated`, never `in-scope`.
  async findGlobalSettings() {
    return db.globalSetting.findMany();
  },

  // (3) PRE-AUTH — gated and bindable by shape, but the guard's VERDICTS map has
  //     adjudicated it actorless. The adjudication must WIN over the shape.
  async countAllUnsafe(workspaceId: string, tx?: Client) {
    const client = tx ?? db;
    return client.widget.count({ where: { workspaceId } });
  },

  // (4) GATED but NOT YET BINDABLE — no `tx` parameter to pass. `needs-binding-first`
  //     (MOTIR-2830's population), never `in-scope`: there is nothing a batch could do.
  async findWidgetsUnbindable(workspaceId: string) {
    return db.widget.findMany({ where: { workspaceId } });
  },

  // (5) The MULTI-LINE signature — the exact shape a single-line `tx?:` regex
  //     mis-read on `countBacklog`, inflating the first measurement by ~60 sites.
  //     The parameter is on its own line and must still be found.
  async findWidgetsWrapped(workspaceId: string, limit: number, tx?: Client): Promise<unknown[]> {
    const client = tx ?? db;
    return client.widget.findMany({ where: { workspaceId }, take: limit });
  },

  // (6b) NOT GATED but BINDABLE — the shape the do-not-touch guard exists for. A
  //      batch CAN pass a `tx` here and it type-checks, but the read was correct
  //      unbound and binding it is churn contradicting the classification. Its
  //      verdict does NOT change when bound (`not-gated` either way), which is
  //      why `bound` is recorded separately from the verdict.
  async findGlobalSettingsBindable(tx?: Client) {
    const client = tx ?? db;
    return client.globalSetting.findMany();
  },

  // (7) RAW SQL — the target is unknowable to a parser, so it counts as gated and
  //     the call site must be ruled on rather than waved through as `not-gated`.
  async rawWidgetCount(workspaceId: string, tx?: Client) {
    const client = tx ?? db;
    return client.$queryRaw`SELECT count(*) FROM "widget" WHERE "workspace_id" = ${workspaceId}`;
  },
};
