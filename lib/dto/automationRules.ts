import type { FilterAst, FilterDecodeResult } from '@/lib/filters/ast';
import type { AutomationActionConfig, AutomationTriggerConfig } from '@/lib/automation/registry';

// The wire shapes the automation-rule routes return (Story 6.6 · Subtask
// 6.6.1). The service maps Prisma rows → these via lib/mappers/automationRuleMappers.ts
// just before returning (never a raw Prisma model crosses the boundary).

/** A rule's stored condition, decoded for the wire: the AST xor a typed decode
 * error — the same recoverable `ast`/`error` pair saved filters use (the
 * durability rule: a corrupt/future-versioned stored envelope degrades to the
 * error state instead of crashing the read). An empty condition group (always
 * match) is `{ combinator: 'and', conditions: [] }`, not null. */
export type AutomationConditionError = Extract<FilterDecodeResult, { ok: false }>;

/** The full rule DTO (the editor read + the create/update response). */
export interface AutomationRuleDto {
  id: string;
  name: string;
  enabled: boolean;
  /** The trigger — its `type` discriminant plus the normalized per-type config. */
  trigger: AutomationTriggerConfig;
  /** The decoded condition AST, or null when the stored envelope failed to
   * decode/validate (then `conditionError` is set). */
  condition: FilterAst | null;
  conditionError: AutomationConditionError | null;
  /** The ordered action list (normalized configs). */
  actions: AutomationActionConfig[];
  owner: { id: string; name: string };
  /** The current consecutive-failure tally (the engine, 6.6.2, drives it). */
  consecutiveFailureCount: number;
  /** The auto-disable threshold (10) — surfaced so the UI (6.6.6) can render
   * "n / 10 failures" without re-deriving the constant. */
  autoDisableThreshold: number;
  createdAt: string;
  updatedAt: string;
}

/** A rule list row — the same shape as the full DTO today (the list view in
 * 6.6.5 reads name / enabled / owner / failure state); kept as its own alias so
 * the two can diverge (the audit-log last-run join lands on the list row in
 * 6.6.6) without churning callers. */
export type AutomationRuleSummaryDto = AutomationRuleDto;
