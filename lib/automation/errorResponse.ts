import { NextResponse } from 'next/server';
import {
  NotProjectAdminError,
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
  if (err instanceof NotProjectAdminError || err instanceof ProjectAccessDeniedError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  if (err instanceof AutomationValidationError || err instanceof FilterValidationError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
  }
  return null;
}
