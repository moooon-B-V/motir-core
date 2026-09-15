import type { StatusCategoryDto } from '@/lib/dto/workflows';

/**
 * A status INTENT — "the status meaning X in this project" — as a gate kind or
 * a merged pull request asks for it: a preferred key, and the category to fall
 * back to when a project has renamed its statuses.
 */
export interface StatusIntent {
  key: string;
  category: StatusCategoryDto;
}

/**
 * Resolve an intent against a project's statuses: the preferred KEY if the
 * workflow has it, else the first status of the target CATEGORY, else null.
 *
 * ⚠️ PURE, and that is why it exists (MOTIR-5526). `workflowsService.resolveStatusKey`
 * reads the statuses in a context of its own, which is right for a caller holding
 * no lock and wrong for `applyStatusTransition`'s approval-gate guard, which runs
 * while this transaction holds the work item `FOR UPDATE` — a second pooled
 * connection there is the deadlock that method's own notes warn about. So the
 * RULE lives here, once, and both callers apply it to statuses they read their
 * own way. Two copies of key-then-category would eventually disagree about which
 * status a gate owns.
 *
 * `null` is a legitimate answer (a custom workflow with nothing in the category):
 * callers turn it into "owns nothing" / "wrote no status", never a crash.
 */
export function resolveStatusIntent(
  statuses: ReadonlyArray<{ key: string; category: StatusCategoryDto }>,
  target: StatusIntent,
): string | null {
  const byKey = statuses.find((s) => s.key === target.key);
  if (byKey) return byKey.key;
  const byCategory = statuses.find((s) => s.category === target.category);
  return byCategory?.key ?? null;
}
