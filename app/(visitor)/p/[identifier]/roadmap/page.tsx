import RoadmapPageView from '@/app/(authed)/roadmap/_view';
import { renderVisitorView } from '../_render';

/** `/p/<identifier>/roadmap` — the member's `/roadmap`, read by a Visitor (MOTIR-6648). */
export default async function VisitorRoadmapPage({
  params,
  searchParams,
}: {
  params: Promise<{ identifier: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return renderVisitorView(params, (ctx) => RoadmapPageView({ ctx, searchParams }));
}
