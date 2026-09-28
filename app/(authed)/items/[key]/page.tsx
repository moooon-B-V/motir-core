import { memberPageContext } from '@/lib/pages/projectPageContext';
import ItemView from './_view';

// A work item's page for a MEMBER — the body is `ItemView`, handed the member's
// page context (MOTIR-6643).
export default async function IssueDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ activity?: string }>;
}) {
  const ctx = await memberPageContext();
  // Called, not mounted: the view IS this page's body, so a caller of the page
  // (a test included) runs it exactly as it ran before the move.
  return ItemView({ ctx, params, searchParams });
}
