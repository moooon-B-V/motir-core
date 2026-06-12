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

/** The three terminal states a single rule execution can land in (Subtask
 * 6.6.2's `AutomationExecutionStatus`): every action ran (`success`), an action
 * threw (`failure`), or the condition didn't match so nothing ran
 * (`no_actions`). The DTO wire-narrows the Prisma enum to this literal union. */
export type AutomationExecutionStatusDto = 'success' | 'failure' | 'no_actions';

/** The last (most-recent) run of a rule — the glyph + relative-time the list row
 * renders (6.6.6). Only the terminal status and the time are surfaced; the full
 * run detail lives in the per-rule audit log. Null when the rule has never
 * fired. */
export interface AutomationRuleLastRunDto {
  status: AutomationExecutionStatusDto;
  /** ISO-8601 timestamp of the run (the list row formats it as "{time} ago"). */
  at: string;
}

/** A rule list row — the full rule DTO PLUS the last-run summary the 6.6.6 list
 * renders (the populated last-run glyph). `lastRun` is null for a rule that has
 * never fired. The list read attaches it (per-rule latest-execution join);
 * the editor / create / update single-rule reads return the bare
 * `AutomationRuleDto` (no last-run join). */
export interface AutomationRuleSummaryDto extends AutomationRuleDto {
  lastRun: AutomationRuleLastRunDto | null;
}

/** One row in the per-rule audit log (6.6.6) — a single execution, narrowed to
 * exactly what Subtask 6.6.2 persisted (status, the triggering item, the typed
 * error, the duration, the time). `triggerItem` is null when the work item was
 * deleted after the run (the FK is `SetNull` on delete — the key is
 * unrecoverable, so the UI renders a tombstone, not a dead link). */
export interface AutomationExecutionDto {
  id: string;
  status: AutomationExecutionStatusDto;
  triggerItem: { key: string; title: string } | null;
  /** The typed error text on a `failure` run, else null. */
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}

/** One bounded page of a rule's audit log (6.6.6) — never a load-all read
 * (finding #57). `total` drives the "Showing a–b of total" footer + the pager;
 * `page` is 1-based; `pageSize` is the server's fixed page size. */
export interface AutomationExecutionPageDto {
  executions: AutomationExecutionDto[];
  total: number;
  page: number;
  pageSize: number;
}
