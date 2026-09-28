import { memberPageContext } from '@/lib/pages/projectPageContext';
import ApprovalRecordsView from './_view';

// The Approvals room for a MEMBER — the body is `ApprovalRecordsView`, handed the
// member's page context (MOTIR-6643).
export default async function ApprovalRecordsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await memberPageContext();
  // Called, not mounted: the view IS this page's body, so a caller of the page
  // (a test included) runs it exactly as it ran before the move.
  return ApprovalRecordsView({ ctx, searchParams });
}
