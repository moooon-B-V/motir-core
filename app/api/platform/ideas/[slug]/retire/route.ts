import { reasonBodySchema } from '@/lib/ideas/schemas';
import { ideasErrorResponse, ideasJson, parseIdeasBody } from '@/lib/ideas/routeErrors';
import { requirePlatformStaffForIdeas } from '@/lib/platform/ideasGate';
import { ideasAdminService } from '@/lib/services/ideasAdminService';

// Retire an idea, with a stated reason (Story MOTIR-7662 · MOTIR-7675).
// Transport only; the contract is `docs/platform-ideas-api.md`.

/** Retire an active idea. Operator. */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const actor = await requirePlatformStaffForIdeas(req, 'operator');
    const { slug } = await params;
    const { reason } = await parseIdeasBody(req, reasonBodySchema);
    return ideasJson(await ideasAdminService.retireIdea(actor, slug, reason));
  } catch (err) {
    return ideasErrorResponse(err);
  }
}
