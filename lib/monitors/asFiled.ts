// THE AS-FILED PREDICATE (Story MOTIR-4930 · MOTIR-5851; shared by MOTIR-5983).
//
// Whether a bug is still EXACTLY as the reconciler filed it — its description is
// the body its `created` revision recorded and its explanation is still empty.
// THE one rule that decides both whether an authored body may be written
// (`monitorBugEnrichmentService.applyAuthoredBug`'s `card-changed` skip) and
// whether the poll's backfill sweep may spend a model call on the bug at all —
// so a card a person has edited is refused by the same rule on both sides, never
// by two copies of it.
//
// ⚠️ IT LIVES HERE, PURE, AND NOT IN THE ENRICHMENT SERVICE, so the reconciler can
// read it without importing the service that calls motir-ai — the dependency
// `tests/monitors/monitorEnrichmentGuards.test.ts` GUARD 4 forbids.

export function isStillAsFiled(
  bug: { descriptionMd: string | null; explanationMd?: string | null },
  filedBody: string | null,
): boolean {
  return bug.descriptionMd === filedBody && (bug.explanationMd ?? null) === null;
}
