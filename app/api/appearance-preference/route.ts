import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { appearancePreferenceService } from '@/lib/services/appearancePreferenceService';
import { mapAppearancePreferenceError } from '@/lib/appearance/errorResponse';
import type { FontPicksPatch } from '@/lib/appearance/fontPicks';
import { isFontSetLocale } from '@motir/design-system';

// /api/appearance-preference (Story 7.3 · Subtask 7.3.60) — the CURRENT user's
// cross-device appearance preference (the three design-system axes + the
// light/dark pattern). Personal settings, scoped to the session user only (they
// apply across every workspace), so the gate is `getSession`, NOT
// `getWorkspaceContext` — the `/api/notification-preferences` shape.
// Routes are HTTP-only (CLAUDE.md): parse → one service call → typed-error→status.
//
// GET → 200 { preference: AppearancePreferenceDto } (every axis resolved)
// PATCH { pattern?, styleId?, paletteId?, typeId?, fontPicks? } → 200 { preference }
//   — partial update; unknown field → 400, wrong type → 400, invalid id → 422.
//   `fontPicks` (Story MOTIR-7736) is `{ [locale]: memberId | null }`: an object
//   whose keys are the eleven locales and whose values are a string or null;
//   whether the member belongs to that locale's set is the service's 422.
//   The response carries the resolved preference so the client updates from it
//   (no tree re-fetch — the inline-edit-no-whole-tree-refresh contract).

const AXIS_KEYS = ['pattern', 'styleId', 'paletteId', 'typeId'] as const;

export async function GET(): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { session } = gate;

  const preference = await appearancePreferenceService.getResolved(session.user.id);
  return NextResponse.json({ preference });
}

export async function PATCH(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { session } = gate;

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

  const { pattern, styleId, paletteId, typeId, fontPicks, ...rest } = body as Record<
    string,
    unknown
  >;
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

  if (fontPicks !== undefined) {
    if (typeof fontPicks !== 'object' || fontPicks === null || Array.isArray(fontPicks)) {
      return NextResponse.json(
        { code: 'BAD_REQUEST', error: '`fontPicks` must be an object.' },
        { status: 400 },
      );
    }
    for (const [locale, value] of Object.entries(fontPicks)) {
      if (!isFontSetLocale(locale)) {
        return NextResponse.json(
          { code: 'BAD_REQUEST', error: `Unknown locale: ${locale}.` },
          { status: 400 },
        );
      }
      if (value !== null && typeof value !== 'string') {
        return NextResponse.json(
          { code: 'BAD_REQUEST', error: `\`fontPicks.${locale}\` must be a string or null.` },
          { status: 400 },
        );
      }
    }
  }

  try {
    const preference = await appearancePreferenceService.update(session.user.id, {
      pattern: pattern as string | null | undefined,
      styleId: styleId as string | null | undefined,
      paletteId: paletteId as string | null | undefined,
      typeId: typeId as string | null | undefined,
      fontPicks: fontPicks as FontPicksPatch | undefined,
    });
    return NextResponse.json({ preference });
  } catch (err) {
    const mapped = mapAppearancePreferenceError(err);
    if (mapped) return mapped;
    throw err;
  }
}
