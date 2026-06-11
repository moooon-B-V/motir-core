import { decodeFilterEnvelope, type FilterAst } from '@/lib/filters/ast';
import { validateFilterAst } from '@/lib/filters/registry';
import { AUTOMATION_AUTO_DISABLE_THRESHOLD } from '@/lib/automation/constants';
import type { AutomationActionConfig, AutomationTriggerConfig } from '@/lib/automation/registry';
import type { AutomationRuleWithOwner } from '@/lib/repositories/automationRuleRepository';
import type { AutomationConditionError, AutomationRuleDto } from '@/lib/dto/automationRules';

// Prisma row → DTO conversion for the automation domain (Story 6.6 · Subtask
// 6.6.1). Pure transforms (the mapper layer). The three JSON columns were
// validated on write by the service (the registries + the 6.1 condition
// validation), so the trigger/action casts are sound; the CONDITION is decoded
// defensively anyway — the durability rule: a hand-corrupted or future-versioned
// stored envelope degrades to the typed `conditionError` state, never a read
// crash (the saved-filter `resolveStoredEnvelope` pattern).

/** Decode + deep-validate a stored condition envelope into the recoverable
 * pair (`ast` xor `error`). NEVER throws — a structurally-bad envelope decodes
 * to a typed decode error; a decodable-but-registry-invalid one (e.g. an
 * unknown field id smuggled into the stored row) degrades to the same `invalid`
 * state. The durability rule: a read never crashes on a corrupt stored
 * condition. */
function decodeStoredCondition(envelope: unknown): {
  ast: FilterAst | null;
  error: AutomationConditionError | null;
} {
  const decoded = decodeFilterEnvelope(envelope);
  if (!decoded.ok) return { ast: null, error: decoded };
  try {
    validateFilterAst(decoded.ast);
  } catch {
    return {
      ast: null,
      error: { ok: false, reason: 'invalid', detail: 'condition failed validation' },
    };
  }
  return { ast: decoded.ast, error: null };
}

export function toAutomationRuleDto(row: AutomationRuleWithOwner): AutomationRuleDto {
  const condition = decodeStoredCondition(row.conditionAst);
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    trigger: row.triggerConfig as unknown as AutomationTriggerConfig,
    condition: condition.ast,
    conditionError: condition.error,
    actions: row.actions as unknown as AutomationActionConfig[],
    owner: { id: row.owner.id, name: row.owner.name },
    consecutiveFailureCount: row.consecutiveFailureCount,
    autoDisableThreshold: AUTOMATION_AUTO_DISABLE_THRESHOLD,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
