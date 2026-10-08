import { ideaTagBodySchema } from '@/lib/ideas/schemas';
import { ideasErrorResponse, ideasJson, parseIdeasBody } from '@/lib/ideas/routeErrors';
import { requirePlatformStaffForIdeas } from '@/lib/platform/ideasGate';
import { ideasAdminService } from '@/lib/services/ideasAdminService';

// The curated tag vocabulary (Story MOTIR-7662 · MOTIR-7675). Transport only;
// the contract is `docs/platform-ideas-api.md`.

/** Every tag, with how many ideas of any status carry it. Operator. */
export async function GET(req: Request) {
  try {
    const actor = await requirePlatformStaffForIdeas(req, 'operator');
    return ideasJson(await ideasAdminService.listTags(actor));
  } catch (err) {
    return ideasErrorResponse(err);
  }
}

/** Add a tag; its `description` is the stated reason it exists. Operator. */
export async function POST(req: Request) {
  try {
    const actor = await requirePlatformStaffForIdeas(req, 'operator');
    const input = await parseIdeasBody(req, ideaTagBodySchema);
    return ideasJson(await ideasAdminService.addTag(actor, input), 201);
  } catch (err) {
    return ideasErrorResponse(err);
  }
}
