// The type→executor default map + the leaf-only type guard — the SINGLE
// SOURCE OF TRUTH for "what executor does a freshly-typed work item default to"
// and "which kinds may carry a type at all" (Story 2.7 · Subtask 2.7.3).
//
// WHY THIS MODULE EXISTS. Story 2.7 promotes two pieces of plan metadata —
// `type` (the NATURE of the work) and `executor` (WHO does it) — from
// description prose to real `work_item` columns. The 2.7.2 ADR
// (docs/decisions/work-item-type-taxonomy.md) froze the ten-member
// `WorkItemType` enum AND the type→executor default map. This module encodes
// that map ONCE so every consumer calls it instead of re-stating it: the picker
// UI (2.7.4) seeds the executor control from `defaultExecutorForType` on type
// selection, the seed loader (2.7.5) seeds `executor` for a plan leaf that
// carries a `type` but no explicit `executor`, and the service write authority
// (workItemsService) seeds it on a structural create/update. Two copies of the
// map is exactly the drift hazard parentRules.ts was carved out to kill.
//
// WHY A SEPARATE PURE MODULE (the parentRules.ts precedent). This is UI-free,
// Prisma-free domain logic typed against the DTO string unions
// (`WorkItemTypeDto` / `ExecutorDto`), NOT the Prisma enums — so it can be
// imported by the server-only service graph, the client-side picker, the test
// harness, and the seed loader alike without dragging `@prisma/client` or
// `lucide-react` into any of their module graphs. Mirrors lib/issues/priority.ts
// (DTO-typed presentation/logic constants) and lib/issues/parentRules.ts
// (the pure rule module the service validates through).

import type { ExecutorDto, WorkItemKindDto, WorkItemTypeDto } from '@/lib/dto/workItems';

/**
 * Every `WorkItemType` member, in the canonical order the 2.7.2 ADR froze.
 * Mirrors the `WorkItemType` Prisma enum 1:1. Exported so pickers / filter
 * facets / the loader's validate-against-the-enum check read one list instead
 * of re-declaring it (the priority.ts `PRIORITY_OPTIONS` precedent).
 */
export const WORK_ITEM_TYPES = [
  'code',
  'design',
  'test',
  'content',
  'research',
  'review',
  'decision',
  'deploy',
  'manual',
  'chore',
] as const satisfies readonly WorkItemTypeDto[];

/**
 * The type→executor DEFAULT map (2.7.2 ADR §3). The default SEEDS `executor`
 * when a type is first chosen and is ALWAYS overridable afterward. A
 * `Record<WorkItemTypeDto, ExecutorDto>` so the compiler proves it TOTAL over
 * the enum — adding an eleventh `WorkItemType` member without extending this
 * map is a compile error here (and a failed table-test in 2.7.7), never a
 * silent `default` fall-through. Read as three groups: always-agent
 * (`code` / `test` / `deploy`), always-human (`manual` / `decision` /
 * `review`), and either-default-agent (`design` / `content` / `research` /
 * `chore`).
 */
export const DEFAULT_EXECUTOR_BY_TYPE: Record<WorkItemTypeDto, ExecutorDto> = {
  code: 'coding_agent',
  test: 'coding_agent',
  deploy: 'coding_agent',
  manual: 'human',
  decision: 'human',
  review: 'human',
  design: 'coding_agent',
  content: 'coding_agent',
  research: 'coding_agent',
  chore: 'coding_agent',
};

/**
 * The work-item kinds that may carry a `type` / `executor` — the executable
 * LEAVES. `epic` / `story` are containers (units of organisation, not
 * execution), so they are never typed. This is the kind set the service-layer
 * leaf-only enforcement (`assertTypeAllowedForKind`) permits; everything not in
 * it is rejected with a typed error.
 */
export const TYPEABLE_KINDS: ReadonlySet<WorkItemKindDto> = new Set<WorkItemKindDto>([
  'task',
  'subtask',
  'bug',
]);

/**
 * The default `executor` for a freshly-chosen `type`. A TOTAL function over the
 * `WorkItemType` enum (it indexes the type-checked {@link DEFAULT_EXECUTOR_BY_TYPE}
 * record — no `default` branch, no hole). Called by the picker (2.7.4), the seed
 * loader (2.7.5), and the service (2.7.3) so the seeded value is identical no
 * matter which surface first sets the type.
 */
export function defaultExecutorForType(type: WorkItemTypeDto): ExecutorDto {
  return DEFAULT_EXECUTOR_BY_TYPE[type];
}

/**
 * True when a work item of `kind` may carry a `type` / `executor` — i.e. it is
 * an executable leaf (task / subtask / bug). False for the container kinds
 * (epic / story). The service uses this to gate writes; the picker uses it to
 * decide whether to render the type control at all.
 */
export function isTypeableKind(kind: WorkItemKindDto): boolean {
  return TYPEABLE_KINDS.has(kind);
}

/** Narrowing guard: true when `value` is one of the ten work-item types. */
export function isWorkItemType(value: unknown): value is WorkItemTypeDto {
  return typeof value === 'string' && (WORK_ITEM_TYPES as readonly string[]).includes(value);
}
