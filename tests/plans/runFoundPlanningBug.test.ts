import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkItemApprovedShapeVerdictDto } from '@/lib/dto/plans';
import {
  RUN_FOUND_BUG_TITLE_STEM,
  composeRunFoundPlanningBug,
  toRunFoundBugPointer,
  type RunFoundBugInput,
} from '@/lib/plans/runFoundPlanningBug';

// THE RUN-FOUND PLANNING BUG's COMPOSITION (Story MOTIR-5544 · MOTIR-6283) —
// `docs/decisions/run-found-trigger-dispatched-path.md`, *Which plan, and where
// the bug lands*. Pure, so every property is proven without a database: the
// Motir regime carries everything verbatim, the customer regime carries only the
// allowlist and CANNOT reach a free-text input.

const SOURCE = readFileSync(join(process.cwd(), 'lib/plans/runFoundPlanningBug.ts'), 'utf8');

/** Four distinct sentinels, one per free-text input. */
const SENTINEL = {
  reason: 'SENTINEL_REASON_the customer wrote this `with ticks`',
  key: 'CUSTX-4242',
  planTitle: 'SENTINEL_PLAN_TITLE_secret roadmap',
  verdictPlanTitle: 'SENTINEL_VERDICT_PLAN_TITLE_also secret',
} as const;

function verdictOf(
  over: Partial<WorkItemApprovedShapeVerdictDto> = {},
): WorkItemApprovedShapeVerdictDto {
  return {
    workItemId: 'wi_target',
    verdict: 'unchanged',
    planId: 'plan_1',
    planTitle: SENTINEL.verdictPlanTitle,
    decidedAt: '2026-09-20T10:00:00.000Z',
    proposalId: 'prop_1',
    divergingRevision: null,
    childSet: null,
    ...over,
  };
}

function inputOf(over: Partial<RunFoundBugInput> = {}): RunFoundBugInput {
  return {
    workspaceId: 'ws_customer',
    projectId: 'proj_1',
    workItemId: 'wi_target',
    key: SENTINEL.key,
    reason: SENTINEL.reason,
    verdict: verdictOf(),
    plan: {
      id: 'plan_1',
      title: SENTINEL.planTitle,
      authorSource: 'native',
      authorHarness: 'Motir',
      authorModel: 'claude-opus-5-5',
    },
    dispatchRunId: 'run_1',
    dispatchRunCardId: 'leg_1',
    reportedAt: '2026-09-25T08:00:00.000Z',
    ...over,
  };
}

/** A CHANGED leaf — the diverging revision is present. */
const changedLeaf = (): RunFoundBugInput =>
  inputOf({
    verdict: verdictOf({
      verdict: 'changed',
      divergingRevision: {
        id: 'rev_9',
        changedAt: '2026-09-21T00:00:00.000Z',
        changedById: 'user_7',
        changeKind: 'edited',
        changedKeys: ['title', 'descriptionMd'],
      },
    }),
  });

/** A CONTAINER whose child set moved. */
const container = (): RunFoundBugInput =>
  inputOf({
    verdict: verdictOf({
      verdict: 'changed',
      childSet: {
        verdict: 'changed',
        approvedChildIds: ['c_1', 'c_2'],
        currentChildIds: ['c_1', 'c_3'],
        added: ['c_3'],
        removed: ['c_2'],
      },
    }),
  });

describe('the composer is PURE', () => {
  it('imports nothing from repositories, services or the Prisma client', () => {
    const imports = [...SOURCE.matchAll(/^import[\s\S]*?from\s+'([^']+)';/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec).not.toMatch(/lib\/repositories|lib\/services|@\/generated\/prisma/);
    }
    expect(SOURCE).not.toMatch(/require\(/);
  });

  it('is deterministic — the same input and regime give the same text', () => {
    expect(composeRunFoundPlanningBug(inputOf(), 'customer_workspace')).toEqual(
      composeRunFoundPlanningBug(inputOf(), 'customer_workspace'),
    );
  });
});

describe('motir_workspace — everything VERBATIM', () => {
  const leaf = composeRunFoundPlanningBug(changedLeaf(), 'motir_workspace').descriptionMd;
  const box = composeRunFoundPlanningBug(container(), 'motir_workspace').descriptionMd;

  it('carries the plan id', () => expect(leaf).toContain('`plan_1`'));
  it('carries the plan title', () => expect(leaf).toContain(SENTINEL.planTitle));
  it('carries the shaping proposal id', () => expect(leaf).toContain('`prop_1`'));
  it('carries the target key', () => expect(leaf).toContain(SENTINEL.key));
  it("carries the runner's reason byte-for-byte, inside a fence it cannot close", () => {
    expect(leaf).toContain(`\n${SENTINEL.reason}\n`);
    // A reason holding a triple-backtick run still round-trips intact.
    const tricky = 'line one\n```\nline three';
    const body = composeRunFoundPlanningBug(
      inputOf({ reason: tricky }),
      'motir_workspace',
    ).descriptionMd;
    expect(body).toContain(`\`\`\`\`text\n${tricky}\n\`\`\`\``);
  });
  it('carries the verdict', () => expect(leaf).toContain('**Verdict:** `changed`'));
  it("carries the diverging revision's id", () => expect(leaf).toContain('`rev_9`'));
  it("carries the diverging revision's changeKind", () =>
    expect(leaf).toContain('change kind `edited`'));
  it("carries the diverging revision's changedKeys", () =>
    expect(leaf).toContain('changed keys `title`, `descriptionMd`'));
  it("carries a container's child-set added ids", () => expect(box).toContain('added `c_3`'));
  it("carries a container's child-set removed ids", () => expect(box).toContain('removed `c_2`'));
  it('carries the author source', () => expect(leaf).toContain('source `native`'));
  it('carries the author harness', () => expect(leaf).toContain('harness `Motir`'));
  it('carries the author model', () => expect(leaf).toContain('model `claude-opus-5-5`'));
  it('carries the dispatch run id', () => expect(leaf).toContain('`run_1`'));
  it('carries the dispatch leg id', () => expect(leaf).toContain('`leg_1`'));
});

describe('customer_workspace — ids, enums, timestamps and field names ONLY', () => {
  it('emits NONE of the free-text sentinels, in the title or the body, in any shape', () => {
    for (const input of [inputOf(), changedLeaf(), container()]) {
      const { title, descriptionMd } = composeRunFoundPlanningBug(input, 'customer_workspace');
      for (const sentinel of Object.values(SENTINEL)) {
        expect(title).not.toContain(sentinel);
        expect(descriptionMd).not.toContain(sentinel);
      }
      // …nor a recognisable fragment of one.
      expect(`${title}\n${descriptionMd}`).not.toMatch(/SENTINEL|CUSTX/);
    }
  });

  const leaf = composeRunFoundPlanningBug(changedLeaf(), 'customer_workspace').descriptionMd;
  const box = composeRunFoundPlanningBug(container(), 'customer_workspace').descriptionMd;

  it('carries the workspace id', () => expect(leaf).toContain('`ws_customer`'));
  it('carries the project id', () => expect(leaf).toContain('`proj_1`'));
  it('carries the target work item id', () => expect(leaf).toContain('`wi_target`'));
  it('carries the dispatch run id', () => expect(leaf).toContain('`run_1`'));
  it('carries the dispatch leg id', () => expect(leaf).toContain('`leg_1`'));
  it('carries the plan id', () => expect(leaf).toContain('`plan_1`'));
  it('carries the proposal id', () => expect(leaf).toContain('`prop_1`'));
  it('carries the verdict', () => expect(leaf).toContain('**Verdict:** `changed`'));
  it("carries the diverging revision's id", () => expect(leaf).toContain('`rev_9`'));
  it("carries the diverging revision's changeKind", () =>
    expect(leaf).toContain('change kind `edited`'));
  it("carries the diverging revision's changedKeys", () =>
    expect(leaf).toContain('changed keys `title`, `descriptionMd`'));
  it('carries the child-set added ids', () => expect(box).toContain('added `c_3`'));
  it('carries the child-set removed ids', () => expect(box).toContain('removed `c_2`'));
  it('carries the author source', () => expect(leaf).toContain('source `native`'));
  it('carries the author harness', () => expect(leaf).toContain('harness `Motir`'));
  it('carries the author model', () => expect(leaf).toContain('model `claude-opus-5-5`'));
  it('carries decidedAt', () => expect(leaf).toContain('`2026-09-20T10:00:00.000Z`'));
  it('carries reportedAt', () => expect(leaf).toContain('`2026-09-25T08:00:00.000Z`'));
  it("points at the leg's event by workspace id and leg id", () => {
    expect(leaf).toContain(
      'on the `unbuildable_reported` event of dispatch leg `leg_1` in workspace `ws_customer`',
    );
  });
});

describe('the customer branch cannot REACH a free-text input', () => {
  it('the projected pointer has no reason, key or title field', () => {
    const pointer = toRunFoundBugPointer(inputOf());
    // @ts-expect-error — the allowlist has no `reason`.
    expect(pointer.reason).toBeUndefined();
    // @ts-expect-error — the allowlist has no `key`.
    expect(pointer.key).toBeUndefined();
    // @ts-expect-error — the allowlist has no `planTitle`.
    expect(pointer.planTitle).toBeUndefined();
    // @ts-expect-error — the allowlist has no `title`.
    expect(pointer.title).toBeUndefined();
    // …and at runtime the projection holds no string equal to a sentinel.
    expect(JSON.stringify(pointer)).not.toMatch(/SENTINEL|CUSTX/);
  });
});

describe('the TITLE — a fixed template in both regimes', () => {
  it('motir_workspace appends the target key', () => {
    const { title } = composeRunFoundPlanningBug(inputOf(), 'motir_workspace');
    expect(title).toBe(`${RUN_FOUND_BUG_TITLE_STEM} — ${SENTINEL.key}`);
  });

  it('customer_workspace appends the leg id, and names no card key', () => {
    const { title } = composeRunFoundPlanningBug(inputOf(), 'customer_workspace');
    expect(title).toBe(`${RUN_FOUND_BUG_TITLE_STEM} — leg leg_1`);
    expect(title).not.toMatch(/[A-Z][A-Z0-9]+-\d+/);
  });
});

describe('the composer composes whatever it is given', () => {
  const noPlan = inputOf({
    plan: null,
    verdict: verdictOf({
      verdict: 'no_plan',
      planId: null,
      planTitle: null,
      decidedAt: null,
      proposalId: null,
    }),
  });

  it('a no_plan-shaped input is not rejected, in either regime', () => {
    const customer = composeRunFoundPlanningBug(noPlan, 'customer_workspace');
    expect(customer.descriptionMd).toContain('**Verdict:** `no_plan`');
    expect(customer.descriptionMd).toContain('**Approving plan id:** _none_');
    expect(customer.descriptionMd).toContain('source _none_');

    const motir = composeRunFoundPlanningBug(noPlan, 'motir_workspace');
    expect(motir.descriptionMd).toContain('**Plan title:** _none_');
    expect(motir.descriptionMd).toContain('**Verdict:** `no_plan`');
  });

  it('a leaf renders no child-set line and a revision-less verdict no revision line', () => {
    const body = composeRunFoundPlanningBug(inputOf(), 'customer_workspace').descriptionMd;
    expect(body).not.toContain('**Child set:**');
    expect(body).not.toContain('**Diverging revision:**');
  });

  it('an empty child-set delta renders as none', () => {
    const body = composeRunFoundPlanningBug(
      inputOf({
        verdict: verdictOf({
          childSet: {
            verdict: 'unchanged',
            approvedChildIds: ['c_1'],
            currentChildIds: ['c_1'],
            added: [],
            removed: [],
          },
        }),
      }),
      'customer_workspace',
    ).descriptionMd;
    expect(body).toContain('**Child set:** added _none_ · removed _none_');
  });

  it('in the Motir regime, the verdict title stands in when no plan row was supplied', () => {
    const body = composeRunFoundPlanningBug(
      inputOf({ plan: null }),
      'motir_workspace',
    ).descriptionMd;
    expect(body).toContain(`**Plan title:** ${SENTINEL.verdictPlanTitle}`);
    // The plan id falls back to the verdict's own.
    expect(body).toContain('**Approving plan id:** `plan_1`');
  });
});
