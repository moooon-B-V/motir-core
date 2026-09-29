// THE APPROVAL RECORDS ROOM's PAGE ADDRESS (Story MOTIR-5299 · MOTIR-6333).
//
// ⚠️ IT ANSWERS THE MEMBER ROUTE, AND EVERY CALLER ON A SHARED BODY WRAPS IT. The
// room's list is rendered on the Visitor tree too (`/p/<identifier>/approvals`,
// MOTIR-6648), where `/approvals?page=N` is the READER's own project. So the list
// pushes `useReaderRoutes().view(approvalRecordsHref(…))` (MOTIR-6891), and
// `tests/visitor/visitorReaderRoutesGuard.test.ts` lists this function as a
// BUILDER: a call to it that is not wrapped fails that guard.

/**
 * The room's page address — the only query the list writes besides the overlay's.
 * It carries the SERVED view (MOTIR-6333) when the reader has the switch, so a
 * page turn stays in the view it was on; each view has its own pager and clamp.
 */
export function approvalRecordsHref(page: number, view?: 'mine' | 'project'): string {
  const params = new URLSearchParams();
  if (view) params.set('view', view);
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  return query ? `/approvals?${query}` : '/approvals';
}
