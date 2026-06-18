import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { appearancePreferenceService } from '@/lib/services/appearancePreferenceService';
import { mapAppearancePreferenceError } from '@/lib/appearance/errorResponse';

// /api/appearance-preference (Story 7.3 · Subtask 7.3.60) — the CURRENT user's
// cross-device appearance preference (the three design-system axes + the
// light/dark pattern). Personal settings, scoped to the session user only (they
// apply across every workspace), so the gate is `getSession`, NOT
// `getWorkspaceContext` — the `/api/notification-preferences` shape.
// Routes are HTTP-only (CLAUDE.md): parse → one service call → typed-error→status.
//
// GET → 200 { preference: AppearancePreferenceDto } (every axis resolved)
// PATCH { pattern?, styleId?, paletteId?, typeId? } → 200 { preference }
//   — partial update; unknown field → 400, wrong type → 400, invalid id → 422.
//   The response carries the resolved preference so the client updates from it
//   (no tree re-fetch — the inline-edit-no-whole-tree-refresh contract).

const AXIS_KEYS = ['pattern', 'styleId', 'paletteId', 'typeId'] as const;

export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const preference = await appearancePreferenceService.getResolved(session.user.id);
  return NextResponse.json({ preference });
}

export async function PATCH(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON object.' },
      { status: 400 },
    );
  }

  const { pattern, styleId, paletteId, typeId, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: `Unknown field: ${Object.keys(rest)[0]}.` },
      { status: 400 },
    );
  }

  // Shape check only — a provided axis must be a string (a value to set) or
  // null (clear to default). The SEMANTIC check (is it a registered id?) is the
  // service's job and surfaces as a typed 422.
  const provided = { pattern, styleId, paletteId, typeId };
  for (const key of AXIS_KEYS) {
    const value = provided[key];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return NextResponse.json(
        { code: 'BAD_REQUEST', error: `\`${key}\` must be a string or null.` },
        { status: 400 },
      );
    }
  }

  try {
    const preference = await appearancePreferenceService.update(session.user.id, {
      pattern: pattern as string | null | undefined,
      styleId: styleId as string | null | undefined,
      paletteId: paletteId as string | null | undefined,
      typeId: typeId as string | null | undefined,
    });
    return NextResponse.json({ preference });
  } catch (err) {
    const mapped = mapAppearancePreferenceError(err);
    if (mapped) return mapped;
    throw err;
  }
}
