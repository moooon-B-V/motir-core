import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STATUS_TRANSITION_REFUSALS,
  isStatusTransitionRefusal,
} from '@/lib/workItems/statusTransitionRefusals';
import { classifyTransitionError } from '@/lib/services/changeRequestStatusSync';
import {
  ContainerHasOpenChildrenError,
  IllegalTransitionError,
  MissingArtifactEvidenceError,
  StaleWorkItemError,
  UnknownStatusError,
  WorkItemNotFoundError,
} from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';

// MOTIR-3364 — THE OMISSION GUARD.
//
// Two gates were added to `applyStatusTransition` four days apart. MOTIR-2709's
// artifact-evidence gate updated NEITHER merge-driven consumer; MOTIR-3229's
// container gate updated one. Nothing in the repository could tell the two apart,
// because "the set of refusals" existed only as two hand-written `instanceof`
// ladders. Production found it: a merged pull request threw out of the webhook,
// returned a 500 for a successful delivery, and left the card at In Review with
// no note on it.
//
// This file exists so the NEXT gate is caught by a red build. It asserts three
// things, and the third is the one that does the work:
//
//   1. The predicate accepts every member of the refusal set (and rejects a fault).
//   2. `classifyTransitionError` has an arm for every member — it maps each to a
//      DISTINCT outcome rather than one shared branch, so this cannot be satisfied
//      by a catch-all.
//   3. Every `throw new …Error(` site inside `applyStatusTransition`'s own source
//      is either IN the refusal set or named in the FAULTS allow-list below.
//
// (3) fires on the TYPE LIST, never on a count: adding a seventh gate fails this
// test by name, and the fix is either an entry in `STATUS_TRANSITION_REFUSALS` or
// a deliberate line in `FAULTS` saying why a 500 is the right answer.

/** One constructed instance per refusal, keyed by class name.
 *
 *  ⚠️ Deliberately a map that must be kept in step by hand — adding a class to
 *  `STATUS_TRANSITION_REFUSALS` without adding it here fails the first assertion
 *  below, which is the point: a refusal nobody can construct is a refusal nobody
 *  tested. */
const INSTANCES: Record<string, () => Error> = {
  IllegalTransitionError: () => new IllegalTransitionError('in_review', 'done'),
  UnknownStatusError: () => new UnknownStatusError('done'),
  ProjectAccessDeniedError: () => new ProjectAccessDeniedError('proj_1', 'edit'),
  ProjectNotFoundError: () => new ProjectNotFoundError('proj_1'),
  MissingArtifactEvidenceError: () => new MissingArtifactEvidenceError('done'),
  ContainerHasOpenChildrenError: () => new ContainerHasOpenChildrenError('in_review', ['ACME-2']),
};

/**
 * The throw sites inside `applyStatusTransition` that are FAULTS, not refusals —
 * each with the reason a 500 (and the host's retry) is the right answer.
 *
 * `WorkItemNotFoundError`: every consumer resolved that row moments earlier in the
 * same flow, so its disappearance mid-transition is the data being wrong, not a
 * condition anyone is expected to clear.
 */
const FAULTS: Record<string, string> = {
  WorkItemNotFoundError: 'the row was resolved moments earlier in the same flow',
};

/** `applyStatusTransition`'s own source, sliced out of the service file — from its
 *  declaration to the next method declaration at the same indent. */
function applyStatusTransitionSource(): string {
  const source = readFileSync(
    join(process.cwd(), 'lib', 'services', 'workItemsService.ts'),
    'utf8',
  );
  const lines = source.split('\n');
  const start = lines.findIndex((line) => /^\s*async applyStatusTransition\(/.test(line));
  expect(start, 'applyStatusTransition was renamed — update this guard').toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}(async )?[A-Za-z_$][\w$]*[<(]/.test(line));
  expect(end, 'could not find the end of applyStatusTransition').toBeGreaterThan(-1);
  return rest.slice(0, end).join('\n');
}

const refusalNames = STATUS_TRANSITION_REFUSALS.map((E) => E.name);

describe('the refusal set is complete and every consumer knows it', () => {
  it('names every refusal it can construct, and every construct-able refusal is named', () => {
    expect([...refusalNames].sort()).toEqual(Object.keys(INSTANCES).sort());
  });

  it('the predicate accepts every refusal', () => {
    for (const name of refusalNames) {
      expect(isStatusTransitionRefusal(INSTANCES[name]!()), name).toBe(true);
    }
  });

  it('the predicate REJECTS a fault, so a real defect still reaches the host as a 500', () => {
    expect(isStatusTransitionRefusal(new WorkItemNotFoundError('wi_1'))).toBe(false);
    expect(isStatusTransitionRefusal(new StaleWorkItemError())).toBe(false);
    expect(isStatusTransitionRefusal(new Error('connection reset'))).toBe(false);
    expect(isStatusTransitionRefusal(undefined)).toBe(false);
  });

  it('`classifyTransitionError` has an arm for every refusal — no rethrow', () => {
    for (const name of refusalNames) {
      const result = classifyTransitionError(INSTANCES[name]!(), 'wi_1', 'done');
      expect(result, name).toMatchObject({ event: 'pull_request', workItemId: 'wi_1' });
      expect(typeof result.outcome, name).toBe('string');
    }
  });

  it('…and a DISTINCT outcome for each, so a log line says which rule held', () => {
    const outcomes = refusalNames.map(
      (name) => classifyTransitionError(INSTANCES[name]!(), 'wi_1', 'done').outcome,
    );
    // `ProjectAccessDeniedError` and `ProjectNotFoundError` deliberately share
    // `access_denied` — one is "you may not", the other "there is nothing to";
    // both are the same answer to the caller. Everything else is its own.
    expect(new Set(outcomes).size).toBe(refusalNames.length - 1);
  });

  it('still RETHROWS a fault — the classifier is not a catch-all', () => {
    expect(() => classifyTransitionError(new Error('connection reset'), 'wi_1', 'done')).toThrow(
      'connection reset',
    );
    expect(() =>
      classifyTransitionError(new WorkItemNotFoundError('wi_1'), 'wi_1', 'done'),
    ).toThrow(WorkItemNotFoundError);
  });
});

describe('the guard that catches the NEXT gate', () => {
  it('every error `applyStatusTransition` throws is a declared refusal or a declared fault', () => {
    const body = applyStatusTransitionSource();
    const thrown = [...body.matchAll(/throw new (\w+Error)\(/g)].map((m) => m[1]!);
    expect(
      thrown.length,
      'the slice found no throw sites — the guard is not reading the method',
    ).toBeGreaterThan(0);

    const unclassified = [...new Set(thrown)].filter(
      (name) => !refusalNames.includes(name) && !(name in FAULTS),
    );
    expect(
      unclassified,
      'A gate was added to applyStatusTransition without telling its consumers. Add the error to ' +
        'STATUS_TRANSITION_REFUSALS (and give classifyTransitionError an arm), or list it in FAULTS ' +
        'with the reason a 500 is correct.',
    ).toEqual([]);
  });

  it('reads the real method — the two shipped gates are visible in the slice', () => {
    // Guards the guard: a slice that silently matched nothing would pass the test
    // above forever. These two are the throws this whole card is about.
    const body = applyStatusTransitionSource();
    expect(body).toContain('throw new MissingArtifactEvidenceError(');
    expect(body).toContain('throw new ContainerHasOpenChildrenError(');
  });
});
