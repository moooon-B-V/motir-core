import { NextResponse } from 'next/server';
import { OrgFeatureDisabledError } from '@/lib/featureFlags/errors';

/**
 * The ONE wire shape of a kill-switch refusal (MOTIR-750): 403
 * `ORG_FEATURE_DISABLED`, naming the switch (`key`) and why (`refusal`:
 * `switched_off` or `organization_suspended`). Every route that reaches a guarded
 * entry point calls this from its catch, so none of them answers the refusal as
 * a 500 or as a misleading 402/502. Returns null for any other error.
 */
export function orgFeatureDisabledResponse(err: unknown): NextResponse | null {
  if (!(err instanceof OrgFeatureDisabledError)) return null;
  return NextResponse.json(
    { code: err.code, error: err.message, key: err.key, refusal: err.refusal },
    { status: 403, headers: { 'Cache-Control': 'private, no-store' } },
  );
}
