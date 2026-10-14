import { NextResponse } from 'next/server';

// The body the four plan-change routes read (Story MOTIR-8387 · MOTIR-8399): a
// `toPlanKey` always, and for the upgrade confirm the `prorationDate` its preview
// returned. A SHAPE check only — whether the key is a plan a change may target is
// the service's call, and whether the date is still fresh is motir-ai's.

export type PlanChangeBody =
  | { ok: true; toPlanKey: string; prorationDate: number | null }
  | { ok: false; response: NextResponse };

function invalid(error: string): PlanChangeBody {
  return {
    ok: false,
    response: NextResponse.json({ code: 'INVALID_REQUEST', error }, { status: 400 }),
  };
}

export async function readPlanChangeBody(
  req: Request,
  opts: { prorationDate: boolean },
): Promise<PlanChangeBody> {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await req.json();
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    // an unreadable body is an empty one: the toPlanKey check refuses it
  }
  const { toPlanKey, prorationDate } = body;
  if (typeof toPlanKey !== 'string' || !toPlanKey) return invalid('toPlanKey is required');
  if (!opts.prorationDate) return { ok: true, toPlanKey, prorationDate: null };
  if (typeof prorationDate !== 'number' || !Number.isInteger(prorationDate) || prorationDate < 1) {
    return invalid('prorationDate must be the integer the preview returned');
  }
  return { ok: true, toPlanKey, prorationDate };
}
