import { describe, expect, it } from 'vitest';
import {
  assertTempRefsResolvable,
  tempRefsOf,
  TEMP_REF_PREFIX,
  type ProposalRefCarrier,
} from '@/lib/plans/refs';
import { UnresolvedPlanRefError } from '@/lib/plans/errors';

// Story MOTIR-3533 · Subtask MOTIR-3539 — the APPEND-time temp-ref check, as
// pure logic (no DB).
//
// These pin the VERDICT. The other half — that a refusal actually leaves
// Postgres byte-identical, and that the refusal reaches an MCP caller as a typed
// code rather than a JSON-RPC internal error — is
// `tests/integration/plans/appendRefRefusal.test.ts`.
//
// The resolvable set is passed IN rather than derived here, which is the whole
// reason this function is pure: the service reads the plan's already-persisted
// `add`s under its row lock, and this decides. Written independently of the
// service so it pins the contract rather than mirroring the caller.

const boom = (ref: string, proposal: string): Error => new UnresolvedPlanRefError(ref, proposal);

function carrier(overrides: Partial<ProposalRefCarrier> = {}): ProposalRefCarrier {
  return { label: '“A proposal”', ...overrides };
}

describe('tempRefsOf — the four carriers an intra-plan edge can travel on', () => {
  it('reads a parentRef and an `add`s blockedByRefs', () => {
    const found = tempRefsOf(
      carrier({
        parentRef: `${TEMP_REF_PREFIX}p1`,
        blockedByRefs: [`${TEMP_REF_PREFIX}p2`, `${TEMP_REF_PREFIX}p3`],
      }),
    );
    expect(found).toEqual([
      { ref: `${TEMP_REF_PREFIX}p1`, where: 'parentRef' },
      { ref: `${TEMP_REF_PREFIX}p2`, where: 'blockedByRefs' },
      { ref: `${TEMP_REF_PREFIX}p3`, where: 'blockedByRefs' },
    ]);
  });

  it('reads a `modify`s patch edges — the carrier the live artifact used', () => {
    // ⚠️ The regression this test exists for. A check that read only an `add`s
    // own fields would pass every case above and still accept the exact plan
    // MOTIR-3539 was written from, whose bad ref rides `patch.blockedByAdd`.
    const found = tempRefsOf(
      carrier({
        patch: {
          blockedByAdd: [`${TEMP_REF_PREFIX}gone`],
          blockedByRemove: [`${TEMP_REF_PREFIX}x`],
        },
      }),
    );
    expect(found).toEqual([
      { ref: `${TEMP_REF_PREFIX}gone`, where: 'patch.blockedByAdd' },
      { ref: `${TEMP_REF_PREFIX}x`, where: 'patch.blockedByRemove' },
    ]);
  });

  it('ignores a REAL work-item id in every field — it is the other legal form', () => {
    expect(
      tempRefsOf(
        carrier({
          parentRef: 'wi_real_parent',
          blockedByRefs: ['wi_real_blocker'],
          patch: { blockedByAdd: ['wi_real_add'], blockedByRemove: ['wi_real_rm'] },
        }),
      ),
    ).toEqual([]);
  });

  it('treats an absent / null / empty carrier as carrying nothing', () => {
    expect(tempRefsOf(carrier())).toEqual([]);
    expect(tempRefsOf(carrier({ parentRef: null, blockedByRefs: null, patch: null }))).toEqual([]);
    expect(tempRefsOf(carrier({ blockedByRefs: [], patch: { blockedByAdd: [] } }))).toEqual([]);
  });
});

describe('assertTempRefsResolvable — decidable at the moment the ref arrives', () => {
  it('ACCEPTS a ref naming an `add` the plan already holds', () => {
    expect(() =>
      assertTempRefsResolvable(
        [carrier({ blockedByRefs: [`${TEMP_REF_PREFIX}earlier`] })],
        new Set(['earlier']),
        boom,
      ),
    ).not.toThrow();
  });

  it('REFUSES a ref naming nothing, and the message carries the ref AND the proposal', () => {
    let thrown: unknown;
    try {
      assertTempRefsResolvable(
        [carrier({ label: '“Two”', blockedByRefs: [`${TEMP_REF_PREFIX}PLACEHOLDER`] })],
        new Set(['earlier']),
        boom,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnresolvedPlanRefError);
    const message = (thrown as Error).message;
    expect(message).toContain(`${TEMP_REF_PREFIX}PLACEHOLDER`);
    expect(message).toContain('“Two”');
    // The rule, not just the fact — so the author can fix it without a diff.
    expect(message).toContain('EARLIER');
  });

  it('REFUSES a ref to a proposal in the SAME batch — the contract, and the live mistake', () => {
    // Both proposals arrive in one call, so the first one's id does not exist
    // yet. The set of resolvable ids is what the plan ALREADY holds: empty here.
    const first = carrier({ label: '“One”' });
    const second = carrier({
      label: '“Two”',
      patch: { blockedByAdd: [`${TEMP_REF_PREFIX}not-yet-assigned`] },
    });
    expect(() => assertTempRefsResolvable([first, second], new Set(), boom)).toThrow(
      UnresolvedPlanRefError,
    );
  });

  it('leaves a REAL work-item id alone — it is resolved live, not here', () => {
    expect(() =>
      assertTempRefsResolvable(
        [carrier({ parentRef: 'wi_that_this_check_never_reads' })],
        new Set(),
        boom,
      ),
    ).not.toThrow();
  });

  it('reports the FIRST offender, so one refusal names one thing to fix', () => {
    const message = (() => {
      try {
        assertTempRefsResolvable(
          [
            carrier({ label: '“First bad”', parentRef: `${TEMP_REF_PREFIX}a` }),
            carrier({ label: '“Second bad”', parentRef: `${TEMP_REF_PREFIX}b` }),
          ],
          new Set(),
          boom,
        );
        return '';
      } catch (err) {
        return (err as Error).message;
      }
    })();
    expect(message).toContain('“First bad”');
    expect(message).not.toContain('“Second bad”');
  });
});

describe('UnresolvedPlanRefError — the approve path’s message is unchanged', () => {
  it('one argument produces the pre-MOTIR-3539 sentence, byte for byte', () => {
    // AC5: `resolveRef` and the approve path are unchanged. The optional second
    // argument is what makes that true rather than merely intended — every
    // approve-side construction still takes this branch.
    expect(new UnresolvedPlanRefError('planItem:x').message).toBe(
      'Plan reference "planItem:x" could not be resolved to a work item.',
    );
  });

  it('two arguments produce the append-side refusal, which names the proposal', () => {
    const message = new UnresolvedPlanRefError('planItem:x', '“Two”').message;
    expect(message).toContain('“Two”');
    expect(message).not.toBe('Plan reference "planItem:x" could not be resolved to a work item.');
  });

  it('carries the shared code either way', () => {
    expect(new UnresolvedPlanRefError('r').code).toBe('UNRESOLVED_PLAN_REF');
    expect(new UnresolvedPlanRefError('r', 'p').code).toBe('UNRESOLVED_PLAN_REF');
  });
});
