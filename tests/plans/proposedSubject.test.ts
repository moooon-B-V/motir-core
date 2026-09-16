import { describe, expect, it } from 'vitest';
import { validatePlanProposals, type ProposalNode } from '@/lib/plans/validateProposals';
import { PlanGrammarError } from '@/lib/plans/errors';
import { TYPEABLE_KINDS } from '@/lib/issues/executorDefaults';
import {
  describeSubjectShape,
  isWellFormedSubject,
  SUBJECT_MAX_LENGTH,
} from '@/lib/plans/subjectShape';

// The SUBJECT coordinate's PURE gate (Story MOTIR-5062 · MOTIR-5065).
//
// ── What this file pins, and the one thing it pins by NOT asserting ─────────
// `subject` is the fourth coordinate of `pack(phase, kind, type, subject)`. This
// repository is the BOUNDARY it crosses, and it now checks exactly ONE of the
// three questions somebody will expect it to check:
//
//   · SHAPE — a bounded lowercase slug. Refused.
//   · KIND  — **NO LONGER REFUSED (MOTIR-5607).** A container may carry a subject.
//     The refusal mirrored `type`, and the two axes are deliberately uncoupled
//     now: `TYPEABLE_KINDS` still gates `type` / `executor` and no longer has any
//     say over a subject. The test below pins BOTH halves, because re-coupling
//     them is the obvious edit and it would hand an epic a `type`.
//   · MEMBERSHIP — **deliberately NOT checked**, and the test that says so is
//     the most important one here.
//
// The vocabulary IS the rule-pack file set in motir-meta: a member exists iff
// `prompts/plan-rules/subject-<name>.md` exists. If this repository carried the
// list, adding a rule pack would require a schema change, a migration and a
// platform deploy — so the list lives with the corpus that owns it, and an
// unrecognised member is refused one hop later, at motir-ai's
// `resolvePlanningRulePacks`, by name.
//
// That permissiveness looks exactly like an oversight, which is why it is
// asserted with the reason in the test name: a later reader tightening it into a
// vocabulary check would be reversing a decision, not fixing a bug.

/** The minimal `add` the graph gate reads. */
function add(id: string, proposedFields: Record<string, unknown>): ProposalNode {
  return {
    id,
    op: 'add',
    workItemId: null,
    parentRef: null,
    blockedByRefs: [],
    proposedFields: proposedFields as ProposalNode['proposedFields'],
    patch: null,
  };
}

/** Run the gate over one proposal against an empty live tree. */
function validateOne(node: ProposalNode): void {
  validateAll([node]);
}

/** The same, over a SET — a subtask needs its parent in the batch. */
function validateAll(nodes: ProposalNode[]): void {
  validatePlanProposals({
    items: nodes,
    liveById: new Map(),
    terminalStatusKeys: new Set(['done', 'cancelled']),
    planProjectId: 'proj_plan',
    ancestorIdsById: new Map(),
    existingBlockedByEdges: [],
  });
}

describe('the subject SHAPE guard', () => {
  it('accepts the slugs a `subject-<name>.md` filename can take', () => {
    for (const ok of ['data', 'jobs', 'llm', 'mcp', 'a', 'a1', 'event-driven', 'x-y-z9']) {
      expect(isWellFormedSubject(ok)).toBe(true);
    }
  });

  it('rejects everything that could not name a pack file', () => {
    for (const bad of [
      'Data', // uppercase
      'has space',
      '-leading',
      'trailing-',
      'double--hyphen',
      '9leading-digit',
      'under_score',
      'dot.separated',
      '',
      'a'.repeat(SUBJECT_MAX_LENGTH + 1),
    ]) {
      expect({ bad, ok: isWellFormedSubject(bad) }).toEqual({ bad, ok: false });
    }
  });

  it('rejects a non-string, because the value arrives over a boundary as untyped JSON', () => {
    for (const bad of [null, undefined, 42, true, ['data'], { subject: 'data' }]) {
      expect(isWellFormedSubject(bad)).toBe(false);
    }
  });

  it('describes the shape without naming a single member — the vocabulary is not ours', () => {
    const described = describeSubjectShape();
    expect(described).toContain('lowercase slug');
    // If this file ever learns the members, the check above has been turned into
    // the vocabulary gate this design deliberately does not have.
    for (const member of ['data', 'jobs', 'llm', 'mcp']) {
      expect(described.includes(`\`${member}\``)).toBe(false);
    }
  });
});

describe('the subject GATE, over a proposal', () => {
  it('passes a leaf carrying a well-formed member', () => {
    expect(() =>
      validateOne(add('p1', { title: 'Retry the webhook', kind: 'task', subject: 'jobs' })),
    ).not.toThrow();
  });

  it('passes a leaf carrying NO subject — the axis is additive, and this is the common case', () => {
    expect(() => validateOne(add('p2', { title: 'Rename a label', kind: 'task' }))).not.toThrow();
  });

  it('treats an EMPTY string as absent rather than malformed', () => {
    // `''` is what a producer sends when it decided not to pin one and the
    // transport does not distinguish. Refusing it would make omission harder to
    // express than pinning, which is backwards for a field whose correct answer
    // is usually "none".
    expect(() =>
      validateOne(add('p3', { title: 'A card', kind: 'task', subject: '' })),
    ).not.toThrow();
  });

  it('REFUSES a malformed subject, naming the value and the shape', () => {
    let err: unknown;
    try {
      validateOne(add('p4', { title: 'A card', kind: 'task', subject: 'Not A Slug' }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PlanGrammarError);
    const grammar = err as PlanGrammarError;
    expect(grammar.reason).toBe('malformed_subject');
    expect(grammar.planItemId).toBe('p4');
    expect(grammar.message).toContain('Not A Slug');
    expect(grammar.message).toContain('lowercase slug');
  });

  it('ACCEPTS a subject on EVERY kind, containers included (MOTIR-5607)', () => {
    // Decided 2026-09-15: a subject says what a work item is ABOUT, and a
    // container is about something exactly as much as a leaf is. `task`,
    // `subtask` and `bug` already passed — `epic` and `story` are what changed,
    // so all five are asserted rather than only the two that moved.
    for (const kind of ['epic', 'story', 'task', 'bug']) {
      expect(
        () => validateOne(add('p5', { title: `A ${kind}`, kind, subject: 'onboarding' })),
        `a subject was refused on a \`${kind}\``,
      ).not.toThrow();
    }
    // A `subtask` is validated BENEATH a parent because the PLACEMENT grammar —
    // untouched by this change — refuses a parentless one before the subject
    // check is ever reached. Asserting it as a root would pass for the wrong
    // reason today and hide a real regression tomorrow.
    const parent = add('p5parent', { title: 'A task', kind: 'task' });
    const child: ProposalNode = {
      ...add('p5child', { title: 'A subtask', kind: 'subtask', subject: 'onboarding' }),
      parentRef: 'planItem:p5parent',
    };
    expect(
      () => validateAll([parent, child]),
      'a subject was refused on a `subtask`',
    ).not.toThrow();
  });

  it('does NOT re-couple the subject axis to `TYPEABLE_KINDS` — that set still gates `type`', () => {
    // ⚠️ THE EDIT THIS EXISTS TO CATCH: widening `TYPEABLE_KINDS` to admit
    // `epic` / `story` is the shortest way to make the test above pass, and it is
    // wrong. That set answers a DIFFERENT question — may this kind carry a `type`
    // and an `executor` — and `workItemsService` refuses `TYPE_NOT_ALLOWED_ON_KIND`
    // from it. Admitting containers there would silently grant an epic a type,
    // which no decision covers.
    expect([...TYPEABLE_KINDS].sort()).toEqual(['bug', 'subtask', 'task']);
    expect(TYPEABLE_KINDS.has('epic')).toBe(false);
    expect(TYPEABLE_KINDS.has('story')).toBe(false);
  });

  it('ACCEPTS an unrecognised but well-formed member ON PURPOSE — the vocabulary is the rule-pack file set, and this repository does not hold it', () => {
    // ⚠️ DO NOT "FIX" THIS INTO A MEMBERSHIP CHECK.
    //
    // `quantum-telepathy` is not a member and never will be. It is accepted here
    // because the member list lives in motir-meta's `subject-*.md` file set and
    // is mirrored by motir-ai's `PACKS_BY_SUBJECT` — so a vocabulary gate in this
    // repository would mean a schema change, a migration and a platform deploy
    // before anybody could write a new rule pack.
    //
    // The cost is real and is accepted with its eyes open: a typo in a member
    // name persists here and fails ONE HOP LATER, at `resolvePlanningRulePacks`,
    // which refuses it BY NAME and lists the legal set. That is a loud, named,
    // one-line diagnosis at the system that owns the answer — not a silent
    // fall-through.
    expect(() =>
      validateOne(add('p6', { title: 'A card', kind: 'task', subject: 'quantum-telepathy' })),
    ).not.toThrow();
  });
});
