import PlanDetailView from '@/app/(authed)/plans/[id]/_view';
import { renderVisitorView } from '../../_render';

/**
 * `/p/<identifier>/plans/<id>` — one plan, read by a Visitor (MOTIR-6648). The
 * plan read confines a Visitor to their one public project: a plan of another
 * project, or one touching a private epic's descendants, is not-found.
 */
export default async function VisitorPlanPage({
  params,
}: {
  params: Promise<{ identifier: string; id: string }>;
}) {
  return renderVisitorView(params, (ctx) =>
    PlanDetailView({
      ctx: { actorUserId: ctx.actorUserId, reader: ctx.reader },
      params: params.then(({ id }) => ({ id })),
    }),
  );
}
