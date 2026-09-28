import type { IssueFilterParams } from '@/lib/issues/issueListFilter';
import ItemsView from '@/app/(authed)/items/_view';
import { renderVisitorView } from '../_render';

type ItemsSearchParams = {
  view?: string;
  sort?: string;
  page?: string;
  peek?: string;
} & IssueFilterParams;

/** `/p/<identifier>/tree` — the member's `/items?view=tree`, read by a Visitor (MOTIR-6648). */
export default async function VisitorTreePage({
  params,
  searchParams,
}: {
  params: Promise<{ identifier: string }>;
  searchParams: Promise<ItemsSearchParams>;
}) {
  const tree = searchParams.then((sp): ItemsSearchParams => ({ ...sp, view: 'tree' }));
  return renderVisitorView(params, (ctx) => ItemsView({ ctx, searchParams: tree }));
}
