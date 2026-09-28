import { memberPageContext } from '@/lib/pages/projectPageContext';
import type { IssueFilterParams } from '@/lib/issues/issueListFilter';
import BoardView from './_view';

// The Kanban board (Story 3.2) for a MEMBER — the body is `BoardView`, handed the
// member's page context (MOTIR-6643).
export default async function BoardsPage({
  searchParams,
}: {
  searchParams: Promise<{ peek?: string; board?: string } & IssueFilterParams>;
}) {
  const ctx = await memberPageContext();
  // Called, not mounted: the view IS this page's body, so a caller of the page
  // (a test included) runs it exactly as it ran before the move.
  return BoardView({ ctx, searchParams });
}
