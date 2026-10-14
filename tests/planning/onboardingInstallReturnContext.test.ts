import { describe, expect, it } from 'vitest';
import { INSTALL_RETURN_CONTEXT_MAX_LENGTH } from '@/lib/github/installReturnContext';
import {
  onboardingReturnContextFrom,
  onboardingReturnContextParams,
} from '@/lib/planning/onboardingHandoff';

// Story MOTIR-8241 · MOTIR-8471 — THE RETURN CONTEXT'S DISCIPLINE. The starting
// step's own query rides beside the origin and comes back onto a `Location`
// header, so it is held to the origin's rule: a value that does not read back
// through the reader its destination uses is not a value at all.
describe('the return context — nothing unread reaches an address', () => {
  const q = (s: string) => new URLSearchParams(s);

  it('carries the five hand-off values when each reads back', () => {
    expect(
      onboardingReturnContextFrom(
        q('via=onboard_existing_project&steps=connect,index&backKind=work-item&backItem=MOTIR-7'),
      ),
    ).toStrictEqual({
      via: 'onboard_existing_project',
      steps: 'connect,index',
      backKind: 'work-item',
      backItem: 'MOTIR-7',
    });
    expect(
      onboardingReturnContextFrom(q('backKind=convention-refine&backRepo=acme/api')),
    ).toStrictEqual({ backKind: 'convention-refine', backRepo: 'acme/api' });
  });

  it('drops an outcome the routing verdict does not have', () => {
    expect(onboardingReturnContextFrom(q('via=https://evil.example'))).toStrictEqual({});
    expect(onboardingReturnContextFrom(q('via=/settings'))).toStrictEqual({});
  });

  it('drops the step list unless EVERY member is a step', () => {
    expect(onboardingReturnContextFrom(q('steps=connect,//evil.example'))).toStrictEqual({});
    expect(onboardingReturnContextFrom(q('steps=connect,,index'))).toStrictEqual({});
  });

  it('carries the return address only as readHandoffReturn reads it', () => {
    // A `backItem` with no kind, or beside a kind that does not use it, is not
    // part of any address the wizard reads.
    expect(onboardingReturnContextFrom(q('backItem=MOTIR-1'))).toStrictEqual({});
    expect(onboardingReturnContextFrom(q('backKind=project&backItem=MOTIR-1'))).toStrictEqual({
      backKind: 'project',
    });
    expect(onboardingReturnContextFrom(q('backKind=work-item'))).toStrictEqual({});
    expect(onboardingReturnContextFrom(q('backKind=elsewhere'))).toStrictEqual({});
  });

  it('bounds every value', () => {
    const long = 'M'.repeat(INSTALL_RETURN_CONTEXT_MAX_LENGTH + 1);
    expect(onboardingReturnContextFrom(q(`backKind=work-item&backItem=${long}`))).toStrictEqual({});
  });

  it('re-narrows on the way OUT, in a fixed order', () => {
    expect(
      onboardingReturnContextParams({
        backItem: 'MOTIR-7',
        backKind: 'work-item',
        via: 'nope',
        steps: 'index',
      }),
    ).toEqual([
      ['steps', 'index'],
      ['backKind', 'work-item'],
      ['backItem', 'MOTIR-7'],
    ]);
    expect(onboardingReturnContextParams(undefined)).toEqual([]);
  });
});
