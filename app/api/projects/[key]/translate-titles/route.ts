import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { currentLocale } from '@/lib/i18n/serverLocale';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { projectErrorResponse } from '@/lib/projects/projectErrorResponse';
import { projectsService } from '@/lib/services/projectsService';
import { workItemTranslationService } from '@/lib/services/workItemTranslationService';

// POST /api/projects/[key]/translate-titles (Story MOTIR-7738 · Subtask
// MOTIR-8831) — a surface asks for many work items' TITLES in the reader's
// language. Thin HTTP layer over the many-titles door; no db, no transaction, no
// business logic here (CLAUDE.md). The route makes exactly ONE door call per
// request and never loops over chunks.
//
// Body: `{ "workItemIds": ["<id>", …] }` — nothing else is read.
//
// ⚠️ NOTHING IN THE REQUEST IS AN INPUT BUT THE PROJECT AND THE IDS. The project
// comes from the address. The target language is the reader's ACTIVE INTERFACE
// LANGUAGE as this request resolved it (`currentLocale()`, i.e. next-intl's
// request config), never the body's or the query's; a body or query naming a
// language, a user, an organisation or a project is ignored. The payer is
// resolved inside the door from the project. The ids go to the door exactly as
// sent: collapsing repeats and applying the bound are the door's job.
//
// Open to anyone who can OPEN the project (the key read and the door are both
// browse-gated). The auto-translate switch is not an access rule: a switched-off
// project answers 200 `enabled: false`.
//
// 200 → TitlesTranslateResponseDTO. A per-title `no_credit`, `failed` or
//       `timeout` is an ordinary 200 entry beside `ready` ones. `enabled: false`
//       means the switch is off and nothing was read or spent; `truncated: true`
//       means more titles were asked for than one request answers — the first
//       ones were, and asking again for the rest is the caller's decision.
// 400 → the body is not JSON, or `workItemIds` is not an array of non-empty strings.
// 401 → no session · 404 → no such project, or one the reader cannot open (a
//       browse refusal is a 404, no existence leak) · 403 → an access refusal of
//       another kind.

interface RouteParams {
  params: Promise<{ key: string }>;
}

function badRequest(error: string): Response {
  return NextResponse.json({ code: 'BAD_REQUEST', error }, { status: 400 });
}

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;
  const { key } = await params;
  const targetLanguage = await currentLocale();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('Expected a JSON body.');
  }
  const workItemIds =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>).workItemIds
      : null;
  if (
    !Array.isArray(workItemIds) ||
    !workItemIds.every((id): id is string => typeof id === 'string' && id.length > 0)
  ) {
    return badRequest('Expected { "workItemIds": [<non-empty string>, …] }.');
  }

  try {
    const project = await projectsService.getByKey(key, ctx);
    const answer = await workItemTranslationService.translateTitlesForReader({
      projectId: project.id,
      workItemIds,
      targetLanguage,
      actor: ctx,
    });
    return NextResponse.json(answer);
  } catch (err) {
    // The door's own browse gate: `projectErrorResponse` would answer 403 for it,
    // confirming the project exists. A browse refusal is a 404 here, as on the press.
    if (err instanceof ProjectAccessDeniedError) {
      return NextResponse.json(
        { code: err.code, error: err.message },
        { status: err.kind === 'browse' ? 404 : 403 },
      );
    }
    const mapped = projectErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
