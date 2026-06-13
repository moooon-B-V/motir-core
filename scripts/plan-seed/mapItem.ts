/**
 * Pure plan-leaf → `work_item` field mapping for the seed loader (Story 2.7).
 *
 * Extracted from `seed.ts` so the loader's UNIQUE logic — composing the
 * description and normalising the plan-`type`/`executor` metadata to the
 * structured columns (Subtask 2.7.5) — is unit-testable WITHOUT importing
 * `seed.ts` (which runs `main()` against a real DB on import). These functions
 * are pure (no DB, no env): the seed loader imports them and persists their
 * output through the shipped repositories. Subtask 2.7.7 pins them here.
 */
import { defaultExecutorForType } from '@/lib/issues/executorDefaults';
import type { ExecutorDto, WorkItemTypeDto } from '@/lib/dto/workItems';
import type { PlanItem } from './types';

/**
 * Compose the work-item description: a metadata blockquote + the card prose.
 *
 * As of Subtask 2.7.5 the `type` + `executor` metadata is NO LONGER stringified
 * here — those two pieces of plan metadata now land in the structured
 * `work_item.type` / `work_item.executor` columns (mapped by
 * {@link mapTypeAndExecutor}) and render as chips from there (2.7.4). The
 * description stays the card's real prose; the blockquote keeps only the
 * estimate + depends-on hints (no structured surface renders those yet).
 */
export function composeDescription(item: PlanItem): string | null {
  const meta: string[] = [];
  if (item.estimateMinutes) meta.push(`**Estimate:** ${item.estimateMinutes}m`);
  if (item.dependsOn?.length) meta.push(`**Depends on:** ${item.dependsOn.join(', ')}`);
  const header = meta.length ? `> ${meta.join(' · ')}\n\n` : '';
  const body = item.descriptionMd?.trim() ?? '';
  const out = (header + body).trim();
  return out.length ? out : null;
}

/**
 * The plan's free-string `type` (PlanItem.type — `string` in types.ts) → the
 * frozen ten-member `WorkItemType` enum (the 2.7.2 ADR;
 * `lib/issues/executorDefaults.ts`). The ten members map to themselves; the
 * plan's richer / legacy vocabulary normalises DOWN to the enum:
 *
 *   • `e2e`   → `test`     a Playwright E2E spec IS a test — the enum has no
 *                          separate `e2e` member (unit + e2e both store `test`).
 *   • `spike` → `research` the 2.7.2 ADR glosses `research` as
 *                          "spike/investigation".
 *   • `copy`  → `content`  the ADR glosses `content` as "copy/docs/translate".
 *   • `bug`   → `code`     the bug-logging convention carries the KIND in `type`
 *                          (`kind: 'bug'` + `type: 'bug'`); a bug's executable
 *                          work-nature is code, so it seeds executor coding_agent.
 *
 * Anything NOT in this map is an UNKNOWN type — a typo in a plan module — and
 * {@link mapTypeAndExecutor} ABORTS the seed on it (the structural backstop the
 * prose form never had: a dropped field used to be silent). To add a member,
 * extend the enum (a 2.7.2-ADR change + migration) and this map together.
 */
export const PLAN_TYPE_TO_WORK_ITEM_TYPE: Record<string, WorkItemTypeDto> = {
  code: 'code',
  design: 'design',
  test: 'test',
  content: 'content',
  research: 'research',
  review: 'review',
  decision: 'decision',
  deploy: 'deploy',
  manual: 'manual',
  chore: 'chore',
  e2e: 'test',
  spike: 'research',
  copy: 'content',
  bug: 'code',
};

/**
 * Map a plan leaf's `type` / `executor` to the structured `work_item` columns
 * (Subtask 2.7.5 — the loader bridge). Normalises the free plan-`type` string
 * to the `WorkItemType` enum via {@link PLAN_TYPE_TO_WORK_ITEM_TYPE}, ABORTING
 * on an unknown value (a plan typo is a seed-time error, never a silently
 * dropped field). When a leaf carries a `type` but no explicit `executor`, the
 * executor is SEEDED from the type→executor default map via
 * `defaultExecutorForType` (the SINGLE source the picker (2.7.4) and the
 * service (2.7.3) also call), so the seeded tree matches what the create modal
 * would default; an explicit `executor` always wins. Containers (epic/story)
 * never reach this — they get `{ null, null }` directly (leaf-only).
 */
export function mapTypeAndExecutor(item: PlanItem): {
  type: WorkItemTypeDto | null;
  executor: ExecutorDto | null;
} {
  if (item.type == null) {
    // No type → no executor to seed (executor is seeded WHEN a type is chosen,
    // the 2.7.2 ADR model). An explicit executor with no type is not a shape the
    // plan uses (verified: zero such leaves), but honour it rather than drop it.
    return { type: null, executor: item.executor ?? null };
  }
  const type = PLAN_TYPE_TO_WORK_ITEM_TYPE[item.type];
  if (!type) {
    throw new Error(
      `Seed: work item ${item.id} has an unknown type "${item.type}". ` +
        `Allowed plan types: ${Object.keys(PLAN_TYPE_TO_WORK_ITEM_TYPE).join(', ')}.`,
    );
  }
  return { type, executor: item.executor ?? defaultExecutorForType(type) };
}
