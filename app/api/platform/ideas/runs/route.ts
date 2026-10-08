import { researchRunBodySchema, researchRunQuerySchema } from '@/lib/ideas/schemas';
import {
  ideasErrorResponse,
  ideasJson,
  parseIdeasBody,
  parseIdeasQuery,
} from '@/lib/ideas/routeErrors';
import { requirePlatformStaffForIdeas } from '@/lib/platform/ideasGate';
import { ideasAdminService } from '@/lib/services/ideasAdminService';

// The `motir-ideas` skill's research-run log (Story MOTIR-7662 · MOTIR-7675).
// Transport only; the contract is `docs/platform-ideas-api.md`.

/** The most recent runs, newest first (`?limit=`, default 10). Operator. */
export async function GET(req: Request) {
  try {
    const actor = await requirePlatformStaffForIdeas(req, 'operator');
    const { limit } = parseIdeasQuery(req, researchRunQuerySchema);
    return ideasJson(await ideasAdminService.listResearchRuns(actor, limit));
  } catch (err) {
    return ideasErrorResponse(err);
  }
}

/** Record one run. Operator. */
export async function POST(req: Request) {
  try {
    const actor = await requirePlatformStaffForIdeas(req, 'operator');
    const input = await parseIdeasBody(req, researchRunBodySchema);
    return ideasJson(await ideasAdminService.recordResearchRun(actor, input), 201);
  } catch (err) {
    return ideasErrorResponse(err);
  }
}
