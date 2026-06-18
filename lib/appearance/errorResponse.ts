import { NextResponse } from 'next/server';
import { InvalidAppearanceValueError } from '@/lib/appearance/errors';

/**
 * Shared typed-error → HTTP mapping for the appearance-preference route
 * (Story 7.3 · Subtask 7.3.60), the `mapNotificationPreferenceError` pattern.
 * Returns `null` for errors the caller should rethrow.
 *
 *   InvalidAppearanceValueError → 422 (an unknown axis id / invalid pattern in
 *     the incoming PATCH — a rejection, not a server fault)
 */
export function mapAppearancePreferenceError(err: unknown): NextResponse | null {
  if (err instanceof InvalidAppearanceValueError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
  }
  return null;
}
