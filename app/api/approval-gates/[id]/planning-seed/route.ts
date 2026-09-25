import { NextResponse } from 'next/server';
import { getLocale } from 'next-intl/server';
import { getActiveProject } from '@/lib/projects';
import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';
import { defaultLocale, isLocale } from '@/lib/i18n/locales';
import { planningSeedService } from '@/lib/services/planningSeedService';
import { PlanningSeedNotFoundError } from '@/lib/planChange/errors';
import type { PlanningSeedReadDTO } from '@/lib/dto/planningSeed';

// GET /api/approval-gates/[id]/planning-seed (story MOTIR-6068 · MOTIR-6208;
// `approval-gates.md` §10f) — the REFUSAL SEED the planning overlay opens with:
// the refused card to anchor on and the first turn to pre-fill UNSENT.
//
// ⚠️ ADDRESSED BY THE GATE ID, NEVER BY THE REASON'S TEXT. The reason would leak
// into history, logs and referrers from a URL, and a link anyone can edit could
// make Motir claim a refusal said something it did not. So the server reads the
// decided gate and composes the turn itself (`REFUSAL_SEED_COMPOSERS`).
//
// Session-authed through the ACTIVE project, exactly as the overlay's gate read
// (`app/api/work-items/approval-gate/route.ts`): the no-project arm, then the 2FA
// hold, then ONE service call. Every "nothing here for you" — unknown id, another
// workspace or project, a card the viewer cannot browse, a gate that is not a
// seedable refusal — is the SAME 404 body, never a 403 and never a reason.
//
// Thin HTTP layer (CLAUDE.md § 4-layer): no `db`, no transaction, no logic.

const NOT_FOUND = { code: 'NOT_FOUND' } as const;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const active = await getActiveProject();
  if (!active) {
    return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const hold = await refuseIfNonCompliant(active.userId);
  if (hold) return hold;

  const { id } = await params;
  const requested = await getLocale().catch(() => defaultLocale);
  const locale = isLocale(requested) ? requested : defaultLocale;

  try {
    const seed = await planningSeedService.getRefusalSeed(id, active, locale);
    const body: PlanningSeedReadDTO = { seed };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (err instanceof PlanningSeedNotFoundError) {
      return NextResponse.json(NOT_FOUND, {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    /* v8 ignore next -- the RE-THROW: every "nothing here" is the typed error
       above; anything else is a real fault for Next's error boundary. */
    throw err;
  }
}
