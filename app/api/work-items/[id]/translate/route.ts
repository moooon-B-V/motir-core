import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { currentLocale } from '@/lib/i18n/serverLocale';
import { workItemTranslationService } from '@/lib/services/workItemTranslationService';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { workItemGateErrorResponse } from '@/lib/workItems/gateResponse';

// POST /api/work-items/[id]/translate (Story MOTIR-7735 · Subtask MOTIR-8121) —
// a reader's Translate press. Thin HTTP layer over the translation door; no db,
// no transaction, no business logic here (CLAUDE.md).
//
// ⚠️ NOTHING IN THE REQUEST IS AN INPUT BUT THE ITEM. The target language is the
// reader's ACTIVE INTERFACE LANGUAGE as this request resolved it — next-intl's
// request config (`i18n/request.ts`): the session's saved account language, then
// the `NEXT_LOCALE` cookie, then `Accept-Language`, then English — read through
// `currentLocale()`, which falls back to the default locale outside a request
// scope. A body or query naming a language, a user or an organisation is never
// read. The payer is resolved inside the door from the item's project.
//
// Open to anyone who can OPEN the item (the door's reads are browse-gated).
//
// 200 → TranslateResponseDTO. A `no_credit`, `failed` or `timeout` field is an
//       ordinary 200 entry beside `ready` ones: other fields of the same press
//       may have succeeded.
// 401 → no session · 404 → no such item, or one the reader cannot open (a
//       browse refusal is a 404, indistinguishable from a missing item — no
//       existence leak) · 403 → an access refusal of another kind.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;
  const { id } = await params;
  const targetLanguage = await currentLocale();

  try {
    const body = await workItemTranslationService.translateForReader({
      workItemId: id,
      targetLanguage,
      actor: ctx,
    });
    return NextResponse.json(body);
  } catch (err) {
    const gated = workItemGateErrorResponse(err);
    if (gated) return gated;
    if (err instanceof WorkItemNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    // The item read's browse gate (`projectAccessService.assertCanBrowse`):
    // without this arm a reader who cannot open the project got a 500.
    if (err instanceof ProjectAccessDeniedError) {
      return NextResponse.json(
        { code: err.code, error: err.message },
        { status: err.kind === 'browse' ? 404 : 403 },
      );
    }
    throw err;
  }
}
