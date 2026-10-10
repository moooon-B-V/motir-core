import { ideaTagTranslationsBodySchema } from '@/lib/ideas/schemas';
import { ideasErrorResponse, ideasJson, parseIdeasBody } from '@/lib/ideas/routeErrors';
import { requirePlatformStaffForIdeas } from '@/lib/platform/ideasGate';
import { ideasAdminService } from '@/lib/services/ideasAdminService';

// One vocabulary tag (Story MOTIR-7772 · MOTIR-7774). Transport only; the
// contract is `docs/platform-ideas-api.md`.

type Ctx = { params: Promise<{ slug: string }> };

/** Merge label translations into an existing tag. Operator. */
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const actor = await requirePlatformStaffForIdeas(req, 'operator');
    const { slug } = await params;
    const { labelTranslations } = await parseIdeasBody(req, ideaTagTranslationsBodySchema);
    return ideasJson(
      await ideasAdminService.setTagLabelTranslations(actor, slug, labelTranslations),
    );
  } catch (err) {
    return ideasErrorResponse(err);
  }
}
