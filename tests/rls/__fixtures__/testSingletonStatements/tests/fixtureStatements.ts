// The STATEMENTS the direct-statement scanner is pointed at (MOTIR-2918).
//
// This file is never executed — it is PARSED. Each statement below is one
// verdict (or one deliberate silence), so the scanner is proven in both
// directions instead of trusted. The declarations are local because the scanner
// resolves no imports; it matches identifiers.
//
// ⚠️ Line positions are NOT load-bearing — the guard asserts on
// `(model, op, verdict)` triples, so adding a comment here cannot break it.
//
// ⚠️ THE FIXTURE ONLY EVER PROVES THE SHAPES ITS AUTHOR THOUGHT OF. That is the
// second rule out of MOTIR-2911: `testCallSiteScan`'s fixture hoisted
// `const client = tx ?? db` in every case — a form the real repositories mostly
// do not use — so the fixture AGREED with the bug for months. Hence the inline
// `(tx ?? db)` case below, and hence the adjudication channels being pinned
// against the REAL suite in the guard rather than only here.

declare const db: {
  widget: { findMany(a?: unknown): Promise<unknown[]>; deleteMany(a?: unknown): Promise<unknown> };
  globalSetting: { findMany(a?: unknown): Promise<unknown[]> };
  ghost: { findMany(a?: unknown): Promise<unknown[]> };
  $queryRaw(...a: unknown[]): Promise<unknown>;
  $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
};
declare const adminDb: {
  widget: { deleteMany(a?: unknown): Promise<unknown>; count(): Promise<number> };
};
declare const tx: { widget: { findMany(a?: unknown): Promise<unknown[]> } };
declare const workspaceId: string;

export async function statements(): Promise<void> {
  // GATED, on the singleton — the class this scanner exists to enumerate.
  // `widget` carries `workspaceId`, so the policy applies and an unbound read
  // returns [] without raising.
  await db.widget.findMany({ where: { workspaceId } });

  // GATED, a WRITE. Same verdict — the operation name is not the discriminator,
  // which is the whole reason this walk matches `db.<model>.<ANY>(…)` instead of
  // a whitelist of fourteen names (`notes.html` #231).
  await db.widget.deleteMany({ where: { workspaceId } });

  // GATED, through the INLINE `(tx ?? db)` fallback. `tx` alone is the bound
  // form and must NOT be reported; `(tx ?? db)` REACHES the singleton whenever
  // no `tx` was supplied, so it must be. Requiring the head to be a bare
  // identifier reads the first case and misses this one — the exact blind spot
  // MOTIR-2911 found in `testCallSiteScan`, pinned here so the shared predicate
  // cannot re-narrow without a red build.
  await (tx ?? db).widget.findMany({ where: { workspaceId } });

  // NOT GATED — `globalSetting` carries no `workspaceId`, so no policy applies
  // and the singleton is correct. LEAVE IT.
  await db.globalSetting.findMany();

  // ── The three deliberate SILENCES ────────────────────────────────────────
  // A statement on `adminDb` is the OWNER — the client a fixture, a teardown and
  // a direct-DB assertion are supposed to use. Reporting it would invert the
  // advice this whole family gives, so it must not appear at all.
  await adminDb.widget.deleteMany({ where: { workspaceId } });
  await adminDb.widget.count();

  // A statement on a BARE `tx` is already bound — inside
  // `withWorkspaceServiceContext(ws, (tx) => …)` this is the FIXED form.
  // Reporting it would ask an author to un-fix a fixed line.
  await tx.widget.findMany({ where: { workspaceId } });

  // `$transaction` is not a statement against a table, and it already has an
  // owner: `bareTransactionScan`. Two enumerations of one construct drift.
  await db.$transaction(async () => undefined);

  // ── RAW: reported, but SEPARATELY ────────────────────────────────────────
  // The target table is not nameable from the syntax, so it cannot carry a
  // model verdict. It is not silently dropped either — that is how this whole
  // class stayed invisible. It ratchets on its own.
  await db.$queryRaw`select 1`;

  // ── UNCLASSIFIABLE ───────────────────────────────────────────────────────
  // `ghost` is not a model in the fixture schema. It must NOT be filed as
  // `not-gated`: an ungated verdict is a POSITIVE claim that no policy applies,
  // and reporting a blind spot as a clean verdict is precisely what cost
  // MOTIR-2911 eleven methods and sixteen call sites. It fails the guard.
  await db.ghost.findMany();
}
