import type { Prisma } from '@/generated/prisma/client';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { normalizeWorkItemRefs, parseWorkItemKeys } from '@/lib/mentions/workItemRefs';

// Write-side normalization of bare work-item refs (bug MOTIR-1440). A bare
// `MOTIR-N` typed into a markdown body auto-relates (5.8.3) but never renders as
// a chip (5.8.6) — only the explicit `[KEY](motir:<id>)` token does. This helper
// resolves the bare keys across a set of body fields ONCE and rewrites each to
// the canonical token, so a stored body BOTH relates AND chips. It is the
// service-layer companion to the pure `normalizeWorkItemRefs` (string work) +
// the `findByIdentifiers` repository read (key → id) — composed here because the
// resolution needs the project + an in-tx Prisma client.

/**
 * Resolve the bare `KEY-N` references appearing across `fields` (same project)
 * to their work-item ids and rewrite each field's bare keys to the canonical
 * `[KEY](motir:<id>)` token (the chip form). ONE DB resolve covers all fields.
 *
 * Returns the fields in the SAME order and the SAME presence shape as the input
 * — a `string` field comes back normalized, while `null` / `undefined` /
 * empty-string fields pass through unchanged (so a caller can keep using the
 * `field !== undefined` "was it supplied?" distinction the update path relies
 * on). Explicit tokens and keys that don't resolve are left as-is (the pure
 * `normalizeWorkItemRefs` rules). Used inside the caller's write transaction.
 *
 * ⚠️ `tx` is OPTIONAL in the SIGNATURE and MANDATORY in practice — every caller
 * must pass one (MOTIR-2960). The resolve is `findByIdentifiers`, whose
 * `tx ?? db` falls back to the shared singleton, and `work_item` is
 * workspace-keyed: with no `app.workspace_id` bound, the lookup matches nothing
 * and returns `[]`. This helper then returns the fields UNCHANGED, so an unbound
 * call does not fail — it silently declines to normalize, and every ref stays
 * plain text. There is no error and no log to notice.
 *
 * A caller already inside a write transaction passes its `tx`, so the resolve
 * sees the same snapshot. A caller normalizing BEFORE it opens a transaction —
 * the planner turn (MOTIR-2226), whose write is a short locked append that
 * should not also carry a lookup — opens a read-only binding of its own with
 * `withWorkspaceServiceContext` and passes THAT. It does not omit the argument.
 *
 * (This paragraph previously blessed the omission, naming the planner turn as
 * the legitimate case. That was written while `@/lib/db` was still the BYPASSRLS
 * owner, where the fallback did work; under `motir_app` it cannot, and the
 * comment had authorized the one call site that was wrong. The parameter stays
 * optional only because widening it to required is a separate change across five
 * call sites — treat it as required.)
 */
export async function normalizeBodyRefs(
  args: {
    projectId: string;
    projectIdentifier: string;
    fields: ReadonlyArray<string | null | undefined>;
  },
  tx?: Prisma.TransactionClient,
): Promise<Array<string | null | undefined>> {
  const { projectId, projectIdentifier, fields } = args;

  const combined = fields
    .filter((f): f is string => typeof f === 'string' && f.length > 0)
    .join('\n');
  const keys = projectIdentifier ? parseWorkItemKeys(combined, projectIdentifier) : [];
  if (keys.length === 0) return [...fields];

  const items = await workItemRepository.findByIdentifiers(projectId, keys, tx);
  if (items.length === 0) return [...fields];
  const resolve = new Map(items.map((it) => [it.identifier, it.id]));

  return fields.map((f) =>
    typeof f === 'string' && f.length > 0
      ? normalizeWorkItemRefs(f, projectIdentifier, resolve)
      : f,
  );
}
