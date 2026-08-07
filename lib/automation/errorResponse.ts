import { NextResponse } from 'next/server';
import {
  NotProjectAdminError,
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import { FilterValidationError } from '@/lib/filters/errors';
import { AutomationRuleNotFoundError, AutomationValidationError } from '@/lib/automation/errors';

/**
 * Shared typed-error → HTTP mapping for the automation-rule routes (Story 6.6 ·
 * Subtask 6.6.1), the `mapSavedFilterError` pattern. Returns null for errors the
 * route should rethrow (a real 500).
 *
 *   ProjectNotFoundError / AutomationRuleNotFoundError → 404 (missing,
 *     cross-tenant, or merely non-browsable — indistinguishable, finding #44)
 *   NotProjectAdminError / ProjectAccessDeniedError    → 403 (visible project,
 *     but the actor isn't a project admin — the Automation surface is admin-only)
 *   AutomationValidationError (unknown trigger/action, bad config, caps) /
 *   FilterValidationError (the condition AST)          → 422 (forged / over-cap
 *     input — the registries are TOTAL, so a bad value is a typed rejection,
 *     never a silent pass-through)
 */
export function mapAutomationError(err: unknown): NextResponse | null {
  if (err instanceof ProjectNotFoundError || err instanceof AutomationRuleNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  // MOTIR-2256 — the domain gate now asks `assertPermission(…, '<key>')`, which
  // refuses with `PermissionDeniedError` CARRYING THE KEY. Its own arm, not a
  // third alternative bolted onto the one below, because the whole value of the
  // new error is the `permission` on the body — naming which grant was missing.
  // A shared arm returns the right status and silently drops that, which is
  // exactly what the story E2E caught.
  //
  // `NotProjectAdminError` stays mapped: `project:administer` still raises it
  // (the compatibility branch in `projectAccessService.assertPermission`).
  if (err instanceof PermissionDeniedError) {
    return NextResponse.json(
      { error: err.message, code: err.code, permission: err.permission },
      { status: 403 },
    );
  }
  if (err instanceof NotProjectAdminError || err instanceof ProjectAccessDeniedError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  if (err instanceof AutomationValidationError || err instanceof FilterValidationError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
  }
  return null;
}
