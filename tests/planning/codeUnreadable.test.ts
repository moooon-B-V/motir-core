import { describe, expect, it } from 'vitest';
import { readCodeUnreadable } from '@/lib/planning/codeUnreadable';

// The consuming half of motir-ai's code-graph outage signal (Story MOTIR-8136 ·
// MOTIR-8141). Total over arbitrary JSON: anything that is not the `code_unreadable`
// halt reads as no outage, and the kind is told by the result's own unit.

const halt = { halt: 'code_unreadable', repoRef: 'acme/web', reason: 'unavailable' };

describe('readCodeUnreadable', () => {
  it('reads a plan-writing halt as declined', () => {
    expect(readCodeUnreadable({ codeUnreadable: halt })).toBe('declined');
  });

  it('reads an answered question job as answered', () => {
    expect(readCodeUnreadable({ codeUnreadable: halt, ask: { answer: 'x' } })).toBe('answered');
    expect(readCodeUnreadable({ codeUnreadable: halt, debugBug: { outcome: 'x' } })).toBe(
      'answered',
    );
  });

  it('reads an array-valued unit as no unit', () => {
    expect(readCodeUnreadable({ codeUnreadable: halt, ask: [] })).toBe('declined');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'code_unreadable'],
    ['a number', 7],
    ['an array', [{ codeUnreadable: halt }]],
    ['an empty object', {}],
    ['a null signal', { codeUnreadable: null }],
    ['an array signal', { codeUnreadable: [halt] }],
    ['a string signal', { codeUnreadable: 'code_unreadable' }],
    ['another halt', { codeUnreadable: { halt: 'something_else' } }],
    ['a signal with no halt', { codeUnreadable: {} }],
  ])('reads %s as no outage', (_label, value) => {
    expect(readCodeUnreadable(value)).toBeNull();
  });
});
