import { ideaPatchBodySchema, reasonBodySchema } from '@/lib/ideas/schemas';
import { ideasErrorResponse, ideasJson, parseIdeasBody } from '@/lib/ideas/routeErrors';
import { requirePlatformStaffForIdeas } from '@/lib/platform/ideasGate';
import { ideasAdminService } from '@/lib/services/ideasAdminService';

// One idea, any status (Story MOTIR-7662 · MOTIR-7675). Transport only; the
// contract is `docs/platform-ideas-api.md`. DELETE is the one SUPERADMIN route —
// gated here at that level and re-checked by the service.

type Ctx = { params: Promise<{ slug: string }> };

/** One idea of any status. Operator. */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const actor = await requirePlatformStaffForIdeas(req, 'operator');
    const { slug } = await params;
    return ideasJson(await ideasAdminService.getForStaff(actor, slug));
  } catch (err) {
    return ideasErrorResponse(err);
  }
}

/** A sparse edit; `evidence` and `tags` replace their lists wholesale. Operator. */
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const actor = await requirePlatformStaffForIdeas(req, 'operator');
    const { slug } = await params;
    const patch = await parseIdeasBody(req, ideaPatchBodySchema);
    return ideasJson(await ideasAdminService.updateIdea(actor, slug, patch));
  } catch (err) {
    return ideasErrorResponse(err);
  }
}

/** Hard delete, with a stated reason. SUPERADMIN. */
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const actor = await requirePlatformStaffForIdeas(req, 'superadmin');
    const { slug } = await params;
    const { reason } = await parseIdeasBody(req, reasonBodySchema);
    await ideasAdminService.deleteIdea(actor, slug, reason);
    return ideasJson({ deleted: slug });
  } catch (err) {
    return ideasErrorResponse(err);
  }
}
