import { describe, expect, it } from 'vitest';
import {
  actionConfigOf,
  actionDraftProblem,
  canAddAction,
  emptyActionDraft,
  emptyRuleDraft,
  ruleDraftCompleteness,
  ruleDraftFromDto,
  ruleWritePayload,
  triggerConfigOf,
  triggerDraftProblem,
  type ActionDraft,
  type RuleDraft,
} from '@/lib/automation/automationRuleForm';
import { decodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import type { AutomationRuleDto } from '@/lib/dto/automationRules';

// Subtask 6.6.5 — the editor form model: DTO ↔ draft ↔ wire payload + the Save
// completeness gate. Pure (no React), so it pins the serialization contract the
// 6.6.1 routes consume and the gate the editor renders, in isolation.

const SAMPLE_AST: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }],
};

function dto(over: Partial<AutomationRuleDto> = {}): AutomationRuleDto {
  return {
    id: 'rule-1',
    name: 'Bug verification handoff',
    enabled: true,
    trigger: { type: 'transitioned', fromStatusId: null, toStatusId: 'status-done' },
    condition: SAMPLE_AST,
    conditionError: null,
    actions: [
      { type: 'transition', toStatusId: 'status-review' },
      { type: 'set_field', field: 'priority', value: 'high' },
    ],
    owner: { id: 'u1', name: 'Zhu Yue' },
    consecutiveFailureCount: 0,
    autoDisableThreshold: 10,
    createdAt: '2026-06-12T00:00:00.000Z',
    updatedAt: '2026-06-12T00:00:00.000Z',
    ...over,
  };
}

describe('automationRuleForm — draft seeds', () => {
  it('emptyRuleDraft is a blank, enabled, created-trigger rule with no actions', () => {
    const d = emptyRuleDraft();
    expect(d.name).toBe('');
    expect(d.enabled).toBe(true);
    expect(d.trigger.type).toBe('created');
    expect(d.conditionAst).toBeNull();
    expect(d.actions).toEqual([]);
  });

  it('emptyActionDraft seeds set_field with the assignee slot, transition with none', () => {
    expect(emptyActionDraft('set_field').setField).toBe('assignee');
    expect(emptyActionDraft('transition').setField).toBeNull();
  });
});

describe('automationRuleForm — DTO → draft → payload round-trip', () => {
  it('hydrates a draft from a DTO with its trigger, condition, and ordered actions', () => {
    const d = ruleDraftFromDto(dto());
    expect(d.name).toBe('Bug verification handoff');
    expect(d.trigger).toMatchObject({ type: 'transitioned', toStatusId: 'status-done' });
    expect(d.conditionAst).toEqual(SAMPLE_AST);
    expect(d.actions.map((a) => a.type)).toEqual(['transition', 'set_field']);
    expect(d.actions[1]).toMatchObject({ setField: 'priority', priority: 'high' });
  });

  it('serializes a draft into the 6.6.1 wire payload', () => {
    const payload = ruleWritePayload(ruleDraftFromDto(dto()));
    expect(payload.name).toBe('Bug verification handoff');
    expect(payload.triggerType).toBe('transitioned');
    expect(payload.triggerConfig).toEqual({ fromStatusId: null, toStatusId: 'status-done' });
    expect(payload.actions).toEqual([
      { type: 'transition', toStatusId: 'status-review' },
      { type: 'set_field', field: 'priority', value: 'high' },
    ]);
    // The condition encodes through the shared 6.1 codec and decodes back.
    expect(payload.condition).toBeTypeOf('string');
    const decoded = decodeFilterParam(payload.condition!);
    expect(decoded.ok && decoded.ast).toEqual(SAMPLE_AST);
  });

  it('an empty condition group serializes to null (always-match)', () => {
    const payload = ruleWritePayload({
      ...emptyRuleDraft(),
      conditionAst: { combinator: 'and', conditions: [] },
    });
    expect(payload.condition).toBeNull();
  });
});

describe('automationRuleForm — config builders', () => {
  it('triggerConfigOf is empty for created/commented, slotted otherwise', () => {
    expect(
      triggerConfigOf({ type: 'created', fromStatusId: null, toStatusId: null, field: null }),
    ).toEqual({});
    expect(
      triggerConfigOf({
        type: 'field_changed',
        fromStatusId: null,
        toStatusId: null,
        field: 'assignee',
      }),
    ).toEqual({ field: 'assignee' });
  });

  it('actionConfigOf fans the set_field value into the targeted slot', () => {
    const base = emptyActionDraft('set_field');
    expect(actionConfigOf({ ...base, setField: 'assignee', assignee: 'u2' })).toEqual({
      type: 'set_field',
      field: 'assignee',
      value: 'u2',
    });
    expect(actionConfigOf({ ...base, setField: 'estimate', estimate: 180 })).toEqual({
      type: 'set_field',
      field: 'estimate',
      value: 180,
    });
  });
});

describe('automationRuleForm — completeness gate', () => {
  const transitionAction = (over: Partial<ActionDraft> = {}): ActionDraft => ({
    ...emptyActionDraft('transition'),
    ...over,
  });

  it('a fully specified rule is ok', () => {
    const draft: RuleDraft = {
      name: 'Move to review',
      enabled: true,
      trigger: emptyRuleDraft().trigger,
      conditionAst: null,
      actions: [transitionAction({ toStatusId: 'status-review' })],
    };
    expect(ruleDraftCompleteness(draft).ok).toBe(true);
  });

  it('flags a missing name, no actions, and a target-less transition', () => {
    const c = ruleDraftCompleteness({
      name: '   ',
      enabled: true,
      trigger: emptyRuleDraft().trigger,
      conditionAst: null,
      actions: [],
    });
    expect(c.nameOk).toBe(false);
    expect(c.hasActions).toBe(false);
    expect(c.ok).toBe(false);
  });

  it('pins a per-action problem on the offending action', () => {
    const a = transitionAction({ toStatusId: null });
    expect(actionDraftProblem(a)).toBe('no-target-status');
    const c = ruleDraftCompleteness({
      name: 'X',
      enabled: true,
      trigger: emptyRuleDraft().trigger,
      conditionAst: null,
      actions: [a],
    });
    expect(c.actions.get(a.key)).toBe('no-target-status');
    expect(c.ok).toBe(false);
  });

  it('set_field assignee=null (Unassign) is legitimate, priority needs a value', () => {
    expect(
      actionDraftProblem({
        ...emptyActionDraft('set_field'),
        setField: 'assignee',
        assignee: null,
      }),
    ).toBeNull();
    expect(
      actionDraftProblem({
        ...emptyActionDraft('set_field'),
        setField: 'priority',
        priority: null,
      }),
    ).toBe('no-value');
  });

  it('field_changed trigger needs a field; transitioned from/to are optional', () => {
    expect(
      triggerDraftProblem({
        type: 'field_changed',
        fromStatusId: null,
        toStatusId: null,
        field: null,
      }),
    ).toBe('no-field');
    expect(
      triggerDraftProblem({
        type: 'transitioned',
        fromStatusId: null,
        toStatusId: null,
        field: null,
      }),
    ).toBeNull();
  });

  it('canAddAction stops at the 10-action cap', () => {
    const ten = Array.from({ length: 10 }, () => emptyActionDraft('transition'));
    expect(canAddAction({ ...emptyRuleDraft(), actions: ten })).toBe(false);
    expect(canAddAction({ ...emptyRuleDraft(), actions: ten.slice(0, 9) })).toBe(true);
  });
});
