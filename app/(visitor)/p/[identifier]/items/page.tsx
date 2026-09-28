import type { IssueFilterParams } from '@/lib/issues/issueListFilter';
import ItemsView from '@/app/(authed)/items/_view';
import { renderVisitorView } from '../_render';

type ItemsSearchParams = {
  view?: string;
  sort?: string;
  page?: string;
  peek?: string;
} & IssueFilterParams;

/**
 * `/p/<identifier>/items` — the member's `/items?view=list`, read by a Visitor
 * (MOTIR-6648). The list/tree choice is the PATH here (`/tree` is the other
 * segment of the switch), so a `?view=` in the query is overridden.
 */
export default async function VisitorItemsPage({
  params,
  searchParams,
}: {
  params: Promise<{ identifier: string }>;
  searchParams: Promise<ItemsSearchParams>;
}) {
  const listed = searchParams.then((sp): ItemsSearchParams => ({ ...sp, view: 'list' }));
  return renderVisitorView(params, (ctx) => ItemsView({ ctx, searchParams: listed }));
}
