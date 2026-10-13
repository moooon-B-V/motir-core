import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { organizationContentLanguageService } from '@/lib/services/organizationContentLanguageService';
import { mapOrgError } from '@/lib/organizations/errorResponse';

// PATCH /api/organizations/[orgId]/content-language (Story MOTIR-7731 ·
// MOTIR-8094) — change the language new work in the organisation is written in.
// Body `{ language }`, one of the eleven locale codes. Thin HTTP layer: 401
// without a session, 400 for a body that is not JSON or carries no string
// `language`, then one service call; the service owns the owner/admin gate (403
// for a member, 404 for a non-member), the closing guard (409), the code check
// (400 INVALID_CONTENT_LANGUAGE) and the transaction.
//
// Its own route rather than a key on the rename PATCH, so that route's "`name` is
// required" contract does not change.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { session } = gate;
  const { orgId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }
  const { language } = (body ?? {}) as Record<string, unknown>;
  if (typeof language !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`language` is required.' },
      { status: 400 },
    );
  }

  try {
    const organization = await organizationContentLanguageService.changeContentLanguage({
      organizationId: orgId,
      actorUserId: session.user.id,
      language,
    });
    return NextResponse.json({ organization });
  } catch (err) {
    const mapped = mapOrgError(err);
    if (mapped) return mapped;
    throw err;
  }
}
