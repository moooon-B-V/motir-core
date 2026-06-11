import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_TRIGGER_TYPES,
  automationActionDef,
  automationTriggerDef,
  parseAction,
  parseTriggerConfig,
  type AutomationActionType,
  type AutomationTriggerType,
} from '@/lib/automation/registry';
import {
  AUTOMATION_FIELD_CHANGED_FIELDS,
  AUTOMATION_PRIORITIES,
  AUTOMATION_SET_FIELDS,
} from '@/lib/automation/fields';
import {
  InvalidAutomationActionConfigError,
  InvalidAutomationTriggerConfigError,
  UnknownAutomationActionError,
  UnknownAutomationTriggerError,
} from '@/lib/automation/errors';

// Pure registry tests (Story 6.6 · Subtask 6.6.1) — no DB. The two registries
// are TOTAL over an open input space (mistake #29): the enumeration tests below
// assert every entry's (config-schema × validate × editor) triple holds, and
// the fuzzed-input tests assert every forgery is a typed 422 rather than a
// silent pass. A registry entry added without its wiring fails these (the
// 6.1.6 totality-guard pattern).

const KNOWN_TRIGGER_EDITOR_KINDS = new Set(['none', 'transition', 'field-changed']);
const KNOWN_ACTION_EDITOR_KINDS = new Set(['transition', 'set-field']);

// A canonical valid raw config per trigger type — the enumeration fixture.
const VALID_TRIGGER_CONFIG: Record<AutomationTriggerType, unknown> = {
  created: {},
  commented: {},
  transitioned: { fromStatusId: 's-todo', toStatusId: 's-done' },
  field_changed: { field: 'assignee' },
};

// A canonical valid raw action per action type — the enumeration fixture.
const VALID_ACTION: Record<AutomationActionType, unknown> = {
  transition: { type: 'transition', toStatusId: 's-done' },
  set_field: { type: 'set_field', field: 'priority', value: 'high' },
};

describe('trigger registry — totality', () => {
  it('every trigger type resolves to a def with an event, a known editor kind, and a parser', () => {
    expect(AUTOMATION_TRIGGER_TYPES.length).toBeGreaterThan(0);
    for (const type of AUTOMATION_TRIGGER_TYPES) {
      const def = automationTriggerDef(type);
      expect(def.type).toBe(type);
      expect(def.event).toMatch(/^work-item\//);
      expect(KNOWN_TRIGGER_EDITOR_KINDS.has(def.editorKind)).toBe(true);
      // validate × editor agree: the canonical config parses, stamping the type.
      const parsed = parseTriggerConfig(type, VALID_TRIGGER_CONFIG[type]);
      expect(parsed.type).toBe(type);
    }
  });

  it('an unknown trigger type is a typed 422 (UnknownAutomationTriggerError)', () => {
    expect(() => automationTriggerDef('nope')).toThrow(UnknownAutomationTriggerError);
    expect(() => parseTriggerConfig('nope', {})).toThrow(UnknownAutomationTriggerError);
  });
});

describe('trigger config validation', () => {
  it('created / commented take no config (extra keys ignored)', () => {
    expect(parseTriggerConfig('created', { junk: 1 })).toEqual({ type: 'created' });
    expect(parseTriggerConfig('commented', undefined)).toEqual({ type: 'commented' });
  });

  it('transitioned narrows optionally; blank/absent → null; non-string → 422', () => {
    expect(parseTriggerConfig('transitioned', {})).toEqual({
      type: 'transitioned',
      fromStatusId: null,
      toStatusId: null,
    });
    expect(parseTriggerConfig('transitioned', { fromStatusId: 'a', toStatusId: '' })).toEqual({
      type: 'transitioned',
      fromStatusId: 'a',
      toStatusId: null,
    });
    expect(() => parseTriggerConfig('transitioned', { fromStatusId: 5 })).toThrow(
      InvalidAutomationTriggerConfigError,
    );
  });

  it('field_changed requires a known built-in field; assignee is the assigned preset', () => {
    for (const field of AUTOMATION_FIELD_CHANGED_FIELDS) {
      expect(parseTriggerConfig('field_changed', { field })).toEqual({
        type: 'field_changed',
        field,
      });
    }
    expect(() => parseTriggerConfig('field_changed', { field: 'bogus' })).toThrow(
      InvalidAutomationTriggerConfigError,
    );
    expect(() => parseTriggerConfig('field_changed', {})).toThrow(
      InvalidAutomationTriggerConfigError,
    );
  });
});

describe('action registry — totality', () => {
  it('every action type resolves to a def with a known editor kind and a parser', () => {
    expect(AUTOMATION_ACTION_TYPES.length).toBeGreaterThan(0);
    for (const type of AUTOMATION_ACTION_TYPES) {
      const def = automationActionDef(type);
      expect(def.type).toBe(type);
      expect(KNOWN_ACTION_EDITOR_KINDS.has(def.editorKind)).toBe(true);
      const parsed = parseAction(VALID_ACTION[type]);
      expect(parsed.type).toBe(type);
    }
  });

  it('an unknown / missing action type is a typed 422 (UnknownAutomationActionError)', () => {
    expect(() => automationActionDef('nope')).toThrow(UnknownAutomationActionError);
    expect(() => parseAction({ type: 'nope' })).toThrow(UnknownAutomationActionError);
    expect(() => parseAction({})).toThrow(UnknownAutomationActionError);
    expect(() => parseAction({ type: 5 })).toThrow(UnknownAutomationActionError);
  });
});

describe('action config validation', () => {
  it('transition requires a non-empty toStatusId (open id — not whitelisted)', () => {
    expect(parseAction({ type: 'transition', toStatusId: 's1' })).toEqual({
      type: 'transition',
      toStatusId: 's1',
    });
    expect(() => parseAction({ type: 'transition' })).toThrow(InvalidAutomationActionConfigError);
    expect(() => parseAction({ type: 'transition', toStatusId: '' })).toThrow(
      InvalidAutomationActionConfigError,
    );
  });

  it('set_field rejects an unknown field', () => {
    expect(() => parseAction({ type: 'set_field', field: 'nope', value: 1 })).toThrow(
      InvalidAutomationActionConfigError,
    );
  });

  it('set_field assignee takes a user id or null; other types → 422', () => {
    expect(parseAction({ type: 'set_field', field: 'assignee', value: 'u1' })).toEqual({
      type: 'set_field',
      field: 'assignee',
      value: 'u1',
    });
    expect(parseAction({ type: 'set_field', field: 'assignee', value: null })).toEqual({
      type: 'set_field',
      field: 'assignee',
      value: null,
    });
    expect(() => parseAction({ type: 'set_field', field: 'assignee', value: 5 })).toThrow(
      InvalidAutomationActionConfigError,
    );
  });

  it('set_field priority is whitelisted to the priority vocabulary', () => {
    for (const value of AUTOMATION_PRIORITIES) {
      expect(parseAction({ type: 'set_field', field: 'priority', value })).toEqual({
        type: 'set_field',
        field: 'priority',
        value,
      });
    }
    expect(() => parseAction({ type: 'set_field', field: 'priority', value: 'urgent' })).toThrow(
      InvalidAutomationActionConfigError,
    );
  });

  it('set_field dueDate takes a valid ISO date or null; a bad date → 422', () => {
    expect(parseAction({ type: 'set_field', field: 'dueDate', value: '2026-06-30' })).toEqual({
      type: 'set_field',
      field: 'dueDate',
      value: '2026-06-30',
    });
    expect(parseAction({ type: 'set_field', field: 'dueDate', value: null })).toEqual({
      type: 'set_field',
      field: 'dueDate',
      value: null,
    });
    expect(() => parseAction({ type: 'set_field', field: 'dueDate', value: 'not-a-date' })).toThrow(
      InvalidAutomationActionConfigError,
    );
    expect(() => parseAction({ type: 'set_field', field: 'dueDate', value: '2026-13-40' })).toThrow(
      InvalidAutomationActionConfigError,
    );
  });

  it('set_field estimate takes a non-negative number or null; bad values → 422', () => {
    expect(parseAction({ type: 'set_field', field: 'estimate', value: 120 })).toEqual({
      type: 'set_field',
      field: 'estimate',
      value: 120,
    });
    expect(parseAction({ type: 'set_field', field: 'estimate', value: null })).toEqual({
      type: 'set_field',
      field: 'estimate',
      value: null,
    });
    expect(() => parseAction({ type: 'set_field', field: 'estimate', value: -5 })).toThrow(
      InvalidAutomationActionConfigError,
    );
    expect(() => parseAction({ type: 'set_field', field: 'estimate', value: 'x' })).toThrow(
      InvalidAutomationActionConfigError,
    );
    expect(() =>
      parseAction({ type: 'set_field', field: 'estimate', value: 2_000_000_000 }),
    ).toThrow(InvalidAutomationActionConfigError);
  });

  it('the set-field field vocabulary is exactly the field-changed vocabulary (one settable set)', () => {
    expect([...AUTOMATION_SET_FIELDS].sort()).toEqual([...AUTOMATION_FIELD_CHANGED_FIELDS].sort());
  });
});
