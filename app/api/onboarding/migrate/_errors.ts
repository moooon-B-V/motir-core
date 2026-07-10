import { NextResponse } from 'next/server';

import {
  MigrateOnboardingExitConditionError,
  MigrateOnboardingNotFoundError,
  MigrateOnboardingStepError,
} from '@/lib/migrateOnboarding/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { MotirAiError, MotirAiOutOfCreditsError } from '@/lib/ai/errors';

// Shared typed-error → HTTP mapping for the migrate-onboarding id routes
// (`GET …/:id`, `POST …/:id/advance`; Story 7.15 · MOTIR-931). Returns null for
// an unrecognized error so the route can rethrow (a 500). Kept out of the route
// files so the resume + advance handlers map identically.
export function mapMigrateError(err: unknown): NextResponse | null {
  if (err instanceof MigrateOnboardingNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  // Wrong-step (double-advance / lost race) and an unmet exit condition are both
  // conflicts with the run's current state — the generic advance guard.
  if (
    err instanceof MigrateOnboardingStepError ||
    err instanceof MigrateOnboardingExitConditionError
  ) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  if (err instanceof ProjectAccessDeniedError) {
    return NextResponse.json(
      { code: err.code, error: err.message },
      { status: err.kind === 'browse' ? 404 : 403 },
    );
  }
  // A metered motir-ai kick (discovery / generation submit) surfaced a credit /
  // transport failure — the same mapping the AI plan/generate route uses.
  if (err instanceof MotirAiOutOfCreditsError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 402 });
  }
  if (err instanceof MotirAiError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
  }
  return null;
}
