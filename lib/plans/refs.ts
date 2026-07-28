// The intra-plan temp-ref contract (Story 7.21 · MOTIR-1336), extracted here so
// the persist-time confirmation gate (7.12.5 · MOTIR-911) can share it with
// `plansService` without importing the service (which would be a module cycle —
// the service imports the gate).
//
// A PlanItem's `parentRef` / `blockedByRefs` entry is EITHER a real
// `work_item.id` OR a temp-ref `planItem:<planItemId>` pointing at another `add`
// in the SAME plan (resolved to the created work-item id at materialize).
// `plansService` re-exports `TEMP_REF_PREFIX` so its existing consumers
// (`planValidityService`) keep importing it from there unchanged.

/** The intra-plan temp-ref prefix: `planItem:<planItemId>`. */
export const TEMP_REF_PREFIX = 'planItem:';

/** True when `ref` points at another `add` in the same plan (not a real id). */
export function isTempRef(ref: string): boolean {
  return ref.startsWith(TEMP_REF_PREFIX);
}

/** The PlanItem id inside a temp-ref (`planItem:abc` → `abc`). */
export function tempRefId(ref: string): string {
  return ref.slice(TEMP_REF_PREFIX.length);
}
