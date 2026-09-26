import { describe, expect, it } from 'vitest';

import { InvalidProposalError } from '@/lib/plans/errors';
import {
  findMalformedIntraPlanRefs,
  validateProposedBodyRefs,
} from '@/lib/plans/validateProposedBodyRefs';
import { rewriteIntraPlanRefs } from '@/lib/mentions/workItemRefs';

// Bug MOTIR-6494 — the ONE validator every plan-proposal door calls for the
// item links in a proposal's bodies. Pure, so pinned here without a database;
// `tests/mcp/plan-body-refs.test.ts` proves each door reaches it.

function refusal(run: () => void): InvalidProposalError | null {
  try {
    run();
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(InvalidProposalError);
    return err as InvalidProposalError;
  }
}

describe('findMalformedIntraPlanRefs', () => {
  it('finds a `motir-ref:` link without the `planItem:` prefix — the form that shipped dead', () => {
    expect(
      findMalformedIntraPlanRefs('See [the model](motir-ref:cmui7qj5m00rnhvoiruwl7tcd).'),
    ).toEqual(['[the model](motir-ref:cmui7qj5m00rnhvoiruwl7tcd)']);
  });

  it('finds every near-miss the canonical token rejects, once each, in first-seen order', () => {
    const body = [
      '[a](motir-ref:abc)',
      '[b](motir-ref:planitem:abc)',
      '[c](motir-ref:planItem:)',
      '[d](motir-ref:planItem:has space)',
      '[a](motir-ref:abc)',
    ].join(' ');
    expect(findMalformedIntraPlanRefs(body)).toEqual([
      '[a](motir-ref:abc)',
      '[b](motir-ref:planitem:abc)',
      '[c](motir-ref:planItem:)',
      '[d](motir-ref:planItem:has space)',
    ]);
  });

  it('passes the canonical token, an existing-item link, a bare key and plain prose', () => {
    const body =
      '[x](motir-ref:planItem:pi_1-A) [y](motir:cmqfb4dfo001l2d0iq3i0jl6j) MOTIR-12 motir-ref is a word.';
    expect(findMalformedIntraPlanRefs(body)).toEqual([]);
  });

  it('agrees with materialize: every link it passes is one `rewriteIntraPlanRefs` rewrites', () => {
    const body = '[x](motir-ref:planItem:abc) and [y](motir-ref:planItem:def)';
    expect(findMalformedIntraPlanRefs(body)).toEqual([]);
    const { body: rewritten } = rewriteIntraPlanRefs(
      body,
      new Map([
        ['abc', 'w1'],
        ['def', 'w2'],
      ]),
    );
    expect(rewritten).not.toContain('motir-ref:');
  });

  it('ignores a link inside inline code or a fenced block, which renders as text, not a link', () => {
    const body = [
      'The bare form `[x](motir-ref:<id>)` is refused; so is ``[y](motir-ref:abc)``.',
      '```md',
      '[z](motir-ref:abc)',
      '```',
      '~~~',
      '[w](motir-ref:def)',
      '~~~',
    ].join('\n');
    expect(findMalformedIntraPlanRefs(body)).toEqual([]);
  });

  it('still reads a link after a closed fence, and treats an unclosed backtick as text', () => {
    const body = [
      '```',
      'code',
      '```',
      'then [a](motir-ref:abc)',
      'a ` stray [b](motir-ref:def)',
    ].join('\n');
    expect(findMalformedIntraPlanRefs(body)).toEqual(['[a](motir-ref:abc)', '[b](motir-ref:def)']);
  });
});

describe('findMalformedIntraPlanRefs — linear on hostile input (CodeQL js/polynomial-redos)', () => {
  it('scans a body repeating an unclosed `[](motir-ref:` opener in linear time and finds no link', () => {
    const hostile = '[](motir-ref:'.repeat(200_000);
    const started = performance.now();
    expect(findMalformedIntraPlanRefs(hostile)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('reads a link whose destination runs over a later opener as one link, as a regex would', () => {
    expect(findMalformedIntraPlanRefs('[a](motir-ref:x [b](motir-ref:y)')).toEqual([
      '[a](motir-ref:x [b](motir-ref:y)',
    ]);
  });
});

describe('validateProposedBodyRefs', () => {
  it('refuses on either body with INVALID_PROPOSAL, naming the field, the token and the canonical form', () => {
    for (const field of ['descriptionMd', 'explanationMd'] as const) {
      const err = refusal(() =>
        validateProposedBodyRefs(
          { [field]: 'After [the schema](motir-ref:pi42).' },
          'Proposal "X"',
        ),
      );
      expect(err).not.toBeNull();
      expect(err!.code).toBe('INVALID_PROPOSAL');
      expect(err!.message).toContain('Proposal "X"');
      expect(err!.message).toContain(field);
      expect(err!.message).toContain('`[the schema](motir-ref:pi42)`');
      expect(err!.message).toContain('[label](motir-ref:planItem:<planItemId>)');
    }
  });

  it('passes absent, null and well-formed bodies', () => {
    expect(refusal(() => validateProposedBodyRefs({}, 'P'))).toBeNull();
    expect(
      refusal(() => validateProposedBodyRefs({ descriptionMd: null, explanationMd: null }, 'P')),
    ).toBeNull();
    expect(
      refusal(() =>
        validateProposedBodyRefs(
          { descriptionMd: '[a](motir-ref:planItem:x1)', explanationMd: 'why' },
          'P',
        ),
      ),
    ).toBeNull();
  });
});
