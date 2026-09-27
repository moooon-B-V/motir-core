import PlansView from '@/app/(authed)/plans/_view';
import { renderVisitorView } from '../_render';

/** `/p/<identifier>/plans` — the member's `/plans`, read by a Visitor (MOTIR-6648). */
export default async function VisitorPlansPage({
  params,
  searchParams,
}: {
  params: Promise<{ identifier: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return renderVisitorView(params, (ctx) => PlansView({ ctx, searchParams }));
}
