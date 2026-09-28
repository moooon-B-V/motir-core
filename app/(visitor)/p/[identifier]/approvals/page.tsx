import ApprovalRecordsView from '@/app/(authed)/approvals/_view';
import { renderVisitorView } from '../_render';

/** `/p/<identifier>/approvals` — the member's `/approvals`, read by a Visitor (MOTIR-6648). */
export default async function VisitorApprovalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ identifier: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return renderVisitorView(params, (ctx) => ApprovalRecordsView({ ctx, searchParams }));
}
