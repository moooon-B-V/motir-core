import { addIdeasBodySchema, staffIdeaQuerySchema } from '@/lib/ideas/schemas';
import {
  ideasErrorResponse,
  ideasJson,
  parseIdeasBody,
  parseIdeasQuery,
} from '@/lib/ideas/routeErrors';
import { requirePlatformStaffForIdeas } from '@/lib/platform/ideasGate';
import { ideasAdminService } from '@/lib/services/ideasAdminService';

// The STAFF ideas collection (Story MOTIR-7662 · MOTIR-7675) — the door the
// `motir-ideas` skill writes through, with a staff member's personal access
// token or the console session (`docs/decisions/platform-staff-auth.md` §2, the
// 2026-10-07 amendment). Transport only: gate FIRST, parse, one service call,
// map errors. The contract is `docs/platform-ideas-api.md`.

/** Every idea of any status, newest first, keyset-paged. Operator. */
export async function GET(req: Request) {
  try {
    const actor = await requirePlatformStaffForIdeas(req, 'operator');
    const query = parseIdeasQuery(req, staffIdeaQuerySchema);
    return ideasJson(await ideasAdminService.listForStaff(actor, query));
  } catch (err) {
    return ideasErrorResponse(err);
  }
}

/** Add a batch of 1–20 ideas, all or none. Operator. */
export async function POST(req: Request) {
  try {
    const actor = await requirePlatformStaffForIdeas(req, 'operator');
    const body = await parseIdeasBody(req, addIdeasBodySchema);
    return ideasJson(await ideasAdminService.addIdeas(actor, body.ideas, body.reason), 201);
  } catch (err) {
    return ideasErrorResponse(err);
  }
}
