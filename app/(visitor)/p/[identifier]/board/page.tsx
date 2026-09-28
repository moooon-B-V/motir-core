import type { IssueFilterParams } from '@/lib/issues/issueListFilter';
import BoardView from '@/app/(authed)/boards/_view';
import { renderVisitorView } from '../_render';

/** `/p/<identifier>/board` — the member's `/boards`, read by a Visitor (MOTIR-6648). */
export default async function VisitorBoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ identifier: string }>;
  searchParams: Promise<{ peek?: string; board?: string } & IssueFilterParams>;
}) {
  return renderVisitorView(params, (ctx) => BoardView({ ctx, searchParams }));
}
