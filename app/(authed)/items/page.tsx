import { memberPageContext } from '@/lib/pages/projectPageContext';
import type { IssueFilterParams } from '@/lib/issues/issueListFilter';
import ItemsView from './_view';

// The items list / tree for a MEMBER — the body is `ItemsView`, handed the
// member's page context (MOTIR-6643).
export default async function IssuesPage({
  searchParams,
}: {
  searchParams: Promise<
    { view?: string; sort?: string; page?: string; peek?: string } & IssueFilterParams
  >;
}) {
  const ctx = await memberPageContext();
  // Called, not mounted: the view IS this page's body, so a caller of the page
  // (a test included) runs it exactly as it ran before the move.
  return ItemsView({ ctx, searchParams });
}
