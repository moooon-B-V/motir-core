import {
  DispatchCardDisposition,
  DispatchCommand,
  DispatchEventKind,
  DispatchRunOrigin,
  DispatchRunStatus,
  DispatchSkipReason,
  DispatchStopReason,
  Prisma,
} from '@/generated/prisma/client';
import { describe, expect, it } from 'vitest';

// The DISPATCH RUN record's THREE NON-OWNERSHIP BOUNDARIES, asserted over the
// GENERATED client rather than by review (Story MOTIR-1789 · MOTIR-1791,
// `docs/decisions/dispatch-run-record.md` Q3).
//
// ── Why a test and not a comment ────────────────────────────────────────────
// Each of the three facts this record refuses to hold ALREADY HAS EXACTLY ONE
// OWNER, and a second copy does not announce itself. It looks like a
// convenience: the run knows the pull request it opened, so why make the page
// join? It becomes a defect the first time the two disagree, and by then it is a
// column two epics read. A comment saying "never add this" is read by whoever is
// already thinking about the rule; this fails the build for whoever is not.
//
// ── Why the GENERATED client and not `schema.prisma` ────────────────────────
// The schema is what someone wrote; the generated client is what shipped. A
// field added in a migration and mirrored into the datamodel reaches the client;
// so does one added by a merge nobody re-read. Reading the artefact the
// application actually imports means the assertion cannot be satisfied by
// editing the thing it is about.
//
// ── Why NAME MATCHING and not an allowlist of the current fields ────────────
// An exact-field-set assertion would be tighter and would fail on every
// legitimate addition, which teaches the next person to update the list without
// reading it — the failure mode of a snapshot. These predicates encode the RULE:
// they pass for any column the record legitimately grows and fail for the three
// classes it may never grow, whatever those columns end up being called.

/** Every scalar field name on the three models, tagged with its model. */
const FIELDS: ReadonlyArray<{ model: string; field: string }> = [
  ...Object.keys(Prisma.DispatchRunScalarFieldEnum).map((field) => ({
    model: 'DispatchRun',
    field,
  })),
  ...Object.keys(Prisma.DispatchRunCardScalarFieldEnum).map((field) => ({
    model: 'DispatchRunCard',
    field,
  })),
  ...Object.keys(Prisma.DispatchRunEventScalarFieldEnum).map((field) => ({
    model: 'DispatchRunEvent',
    field,
  })),
];

const matching = (re: RegExp): string[] =>
  FIELDS.filter(({ field }) => re.test(field)).map(({ model, field }) => `${model}.${field}`);

describe('the dispatch-run record holds no pull-request or CI column', () => {
  // Owner: `WorkItemDelivery` → `GithubPullRequest` → `GithubCheckRun`, with the
  // ONE verdict `derivePrCiState` derives (MOTIR-3655 / MOTIR-3697). The run's
  // EVENTS may record that a pull request was opened — that is a row in
  // `dispatch_run_event`, not a column — and the run's SURFACES read the
  // delivery set.
  it('names no pull request', () => {
    // ⚠️ CASE-SENSITIVE on the `pr` prefix, deliberately. Written `/i` it also
    // matches `projectId` — `\bpr[A-Z_]` with the flag lets `[A-Z_]` match the
    // `o` — and a guard that fails on a column the record legitimately owns gets
    // relaxed rather than obeyed.
    expect(matching(/pull ?request|pullRequest|prUrl|prNumber|\bpr[A-Z_]/)).toEqual([]);
    expect(matching(/pull ?request/i)).toEqual([]);
  });

  it('names no CI state', () => {
    // `ci_verdict` / `ci_fix_attempt` / `ci_gave_up` are EVENT KINDS, not
    // columns, and the distinction is the whole boundary: the run says what it
    // OBSERVED of CI at a moment, the delivery set says what CI's verdict IS.
    expect(matching(/^ci[A-Z]|checkRun|checkSuite|conclusion/i)).toEqual([]);
  });

  it('keeps the CI vocabulary in the EVENT enum, where it belongs', () => {
    // The positive half of the same boundary — an assertion that fails if
    // somebody "fixes" the negative ones by deleting the observation instead of
    // the column.
    expect(Object.keys(DispatchEventKind)).toEqual(
      expect.arrayContaining(['ci_verdict', 'ci_fix_attempt', 'ci_gave_up', 'delivery_linked']),
    );
  });
});

describe('the dispatch-run record writes no work-item status', () => {
  // Owner: the CLI, which makes every transition; the CI-green → `in_review`
  // promotion is server-side (MOTIR-2999). A second status writer is a duplicate
  // write path, and the two would first disagree in exactly the window a run
  // surface exists to make legible.
  //
  // ⚠️ `status` on `DispatchRun` and `disposition` on `DispatchRunCard` are the
  // RUN's own states and are not this. The predicate is deliberately narrow
  // enough to say so.
  it('names no work-item status', () => {
    expect(matching(/workItemStatus|statusKey|workflowStatus|itemStatus/i)).toEqual([]);
  });

  it('still carries the run and leg states it does own', () => {
    expect(Object.keys(Prisma.DispatchRunScalarFieldEnum)).toContain('status');
    expect(Object.keys(Prisma.DispatchRunCardScalarFieldEnum)).toContain('disposition');
  });
});

describe('the dispatch-run record holds no token, usage or cost column — ever', () => {
  // Owner: motir-ai's metering record (9.1.6), correlated by run id and never
  // merged. NOT "not yet": a BYOK-local run never touches the gateway and has no
  // metering row at all, so a cost column here would be null for the only kind
  // of run that exists today and would quietly become a second billing store the
  // moment hosted execution lands.
  it('names no token count, credit or cost', () => {
    expect(matching(/token|credit|cost|spend|usage|price|billed/i)).toEqual([]);
  });
});

describe('the columns the record DOES own are present', () => {
  // The other half of a boundary test: a negative assertion alone is satisfied
  // by an empty table, so the fields the ADR requires are pinned here too.
  it('the run header carries its set-level facts', () => {
    expect(Object.keys(Prisma.DispatchRunScalarFieldEnum)).toEqual(
      expect.arrayContaining([
        'command',
        'origin',
        'scopeWorkItemId',
        'scopeLabel',
        'status',
        'stopReason',
        'agent',
        'model',
        'idempotencyKey',
      ]),
    );
  });

  it('the leg carries the order, the disposition and the skip reason', () => {
    expect(Object.keys(Prisma.DispatchRunCardScalarFieldEnum)).toEqual(
      expect.arrayContaining([
        'position',
        'disposition',
        'skipReason',
        'workItemId',
        'workItemKey',
        'sessionBranch',
        'exitCode',
      ]),
    );
  });

  it('the event carries seq, kind, structured data and the opt-in body', () => {
    expect(Object.keys(Prisma.DispatchRunEventScalarFieldEnum)).toEqual(
      expect.arrayContaining(['seq', 'kind', 'data', 'body', 'dispatchRunCardId']),
    );
  });
});

describe('the closed enums are the ADR vocabulary, exactly', () => {
  // Every renderer downstream must be TOTAL over these, so a member added
  // without a decision is a member no surface knows how to draw. Exact equality
  // here, unlike the field-name rules above, because the ADR's whole point is
  // that this vocabulary is CLOSED and derived from the shipped lifecycle at
  // `origin/main` 435bce9bd — growing it is a decision to record, not a field to
  // add.
  it('DispatchCommand', () => {
    expect(Object.keys(DispatchCommand)).toEqual(['next', 'run', 'run_scope', 'batch', 'auto']);
  });

  it('DispatchRunOrigin — the discriminator that lets one table serve two writers', () => {
    expect(Object.keys(DispatchRunOrigin)).toEqual(['local', 'hosted']);
  });

  it('DispatchRunStatus', () => {
    expect(Object.keys(DispatchRunStatus)).toEqual([
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'timed_out',
    ]);
  });

  it('DispatchStopReason — the union of the auto and batch stop reasons, plus the reap', () => {
    expect(Object.keys(DispatchStopReason)).toEqual([
      'drained',
      'completed',
      'max',
      'halted',
      'interrupted',
      'replanned',
      'gated',
      'abandoned',
    ]);
  });

  it('DispatchCardDisposition', () => {
    expect(Object.keys(DispatchCardDisposition)).toEqual([
      'queued',
      'running',
      'integrated',
      'implemented',
      'failed',
      'replanned',
      'skipped',
      'not_reached',
    ]);
  });

  it('DispatchSkipReason', () => {
    expect(Object.keys(DispatchSkipReason)).toEqual([
      'needs_planning',
      'needs_human',
      'claim_refused',
      'blocked_in_scope',
      'integrated_dep',
      'replan_submitted',
      'checkout_unavailable',
    ]);
  });

  it('DispatchEventKind — six run-scoped, fifteen card-scoped', () => {
    const kinds = Object.keys(DispatchEventKind);
    expect(kinds).toEqual([
      'run_opened',
      'scope_claimed',
      'snapshot_frozen',
      'session_pr',
      'plan_approved',
      'run_closed',
      'card_claimed',
      'card_skipped',
      'checkout_ready',
      'prompt_issued',
      'agent_started',
      'agent_exited',
      'leg_verdict',
      'delivery_linked',
      'ci_verdict',
      'ci_fix_attempt',
      'ci_gave_up',
      'card_settled',
      'log',
      // What the run PRODUCED beyond code (MOTIR-3981). CARD-scoped, and the
      // only two the CLI never emits — the SERVICE that files the bug or
      // produces the plan appends them, because the ids exist only there.
      'bug_filed',
      'plan_submitted',
    ]);
    expect(kinds).toHaveLength(21);
  });
});
