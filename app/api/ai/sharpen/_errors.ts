import { NextResponse } from 'next/server';

import {
  SharpenActionInvalidError,
  SharpenSessionEndedError,
  SharpenSessionNotFoundError,
  SharpenTargetClosedError,
  SharpenTargetNotAvailableError,
  SharpenTurnInFlightError,
  SharpenTurnNotFoundError,
} from '@/lib/sharpening/errors';
import { mapPlanChangeError } from '../plan-change/_errors';

// Typed-error → HTTP mapping for the Sharpen session routes (Task MOTIR-1101 ·
// Subtask MOTIR-8181). The Sharpen errors are mapped here; the classes the
// Sharpen door shares with the planning conversation (permission, project,
// feature switch, the motir-ai client's out-of-credits / unavailable / not
// configured) fall through to `mapPlanChangeError`, so the two doors cannot
// disagree. Returns null for an unrecognised error so the route rethrows (500).
export function mapSharpenError(err: unknown): NextResponse | null {
  if (
    err instanceof SharpenTargetNotAvailableError ||
    err instanceof SharpenSessionNotFoundError ||
    err instanceof SharpenTurnNotFoundError
  ) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (
    err instanceof SharpenTargetClosedError ||
    err instanceof SharpenSessionEndedError ||
    err instanceof SharpenTurnInFlightError
  ) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  if (err instanceof SharpenActionInvalidError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
  }
  return mapPlanChangeError(err);
}

export function badRequest(error: string): NextResponse {
  return NextResponse.json({ code: 'BAD_REQUEST', error }, { status: 400 });
}

export const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;
