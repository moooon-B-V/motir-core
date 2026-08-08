import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { parseFilterParam } from '@/lib/api/v1/workItems/filterParam';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';

// GET /api/v1/projects/{projectKey}/work-items/count (Story 11.5 · Subtask
// 11.5.16 — MOTIR-2318), the operation ADR Amendment 14 decided on.
//
// ── Why this is not a field on the collection ───────────────────────────────
// The collection returns the PLAIN page envelope, because its read is a keyset
// walk that computes no total (Amendment 3 Q2). Promoting it to the ranked
// envelope would run a `COUNT` under an arbitrary filter on every page of every
// caller — including the paging walks that want no count at all, and including
// page 7 of 9, where the answer has already been sent six times. As a sibling
// operation the count is paid for exactly once, by the caller who asked.
//
// ── What it promises ────────────────────────────────────────────────────────
// That it counts what the COLLECTION would page. It takes the same `?filter=`,
// decodes it with the same codec (`parseFilterParam`, shared rather than
// copied), and calls a service method that mirrors `listProjectWorkItemsPage`'s
// gates and predicate build step for step. A count that disagreed with its own
// collection would be worse than no count at all.
//
// ── No `cursor`, no `limit` ─────────────────────────────────────────────────
// A count has no position and no page size. Accepting either would invite a
// caller to read the answer as a count of some WINDOW, which is the confusion
// `?limit=0` would have institutionalised.
export const GET = withV1Route<{ projectKey: string }>({ scope: 'read' }, async (ctx) => {
  // Parse BEFORE reading, the same order the collection uses: a bad filter is
  // the caller's to fix, and answering 422 without touching the database is
  // both faster and honest.
  const filter = parseFilterParam(ctx.req);

  const project = await projectsService.getByKey(ctx.params.projectKey, ctx.service);
  const count = await workItemsService.countProjectWorkItems(project.id, filter, ctx.service);

  return NextResponse.json({ count });
});
