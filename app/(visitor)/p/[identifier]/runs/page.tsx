import RunsView from '@/app/(authed)/runs/_view';
import { renderVisitorView } from '../_render';

/** `/p/<identifier>/runs` — the member's `/runs`, read by a Visitor (MOTIR-6648). */
export default async function VisitorRunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ identifier: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return renderVisitorView(params, (ctx) => RunsView({ ctx, searchParams }));
}
