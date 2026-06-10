import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkItem, WorkItemRevision } from '@prisma/client';
import { db } from '@/lib/db';
import {
  labelsService,
  LABELS_PER_ISSUE_LIMIT,
  LABEL_NAME_MAX_LENGTH,
  LABEL_SEARCH_LIMIT,
} from '@/lib/services/labelsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectNotFoundError, ProjectAccessDeniedError } from '@/lib/projects/errors';
import {
  InvalidLabelNameError,
  LabelLimitExceededError,
  LabelNameTooLongError,
} from '@/lib/labels/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestUser, createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import type { WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// labelsService (Story 5.4 · Subtask 5.4.2) — the folksonomy BUSINESS rules
// over the 5.4.1 leaves, against a REAL Postgres (no-mocks rule): the
// verified Jira mechanics (type-to-create, case-insensitive find-or-create
// with first-typed casing, no-spaces/length/per-issue-cap 422s,
// delete-on-last-use — including under CONCURRENT removal, the locked
// count), the bounded autocomplete, the revision diffs, the permission
// matrix (member edits / viewer 403 / cross-workspace + non-browsable 404),
// and the labels slot on getIssueDetail.

beforeEach(async () => {
  // workspace TRUNCATE … CASCADE walks workspace → project → label and
  // workspace → work_item → work_item_label (all Cascade FK chains).
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

interface LabelScenario {
  fx: WorkItemFixture;
  issue: WorkItem;
  /** Plain workspace member — may edit (open project). */
  memberCtx: ServiceContext;
  /** Workspace member holding the read-only project `viewer` role. */
  viewerCtx: ServiceContext;
}

/** An OPEN project + one issue + a plain-member actor and a project-viewer actor. */
async function buildScenario(): Promise<LabelScenario> {
  const fx = await makeWorkItemFixture();
  const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Labelled task' });

  async function wsMember(email: string, name: string) {
    const user = await createTestUser({ email, name });
    await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
    return { user, ctx: { userId: user.id, workspaceId: fx.workspaceId } };
  }

  const { ctx: memberCtx } = await wsMember('member@ex.com', 'Plain Member');
  const { user: viewer, ctx: viewerCtx } = await wsMember('viewer@ex.com', 'Read Only');

  await projectMembersService.addMember({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: viewer.id,
    role: 'viewer',
  });

  return { fx, issue, memberCtx, viewerCtx };
}

/** The work item's revisions, oldest-first (repo reach — asserting DB state). */
async function revisionsOf(workItemId: string): Promise<WorkItemRevision[]> {
  const rows = await workItemRevisionRepository.listByWorkItem(workItemId);
  return [...rows].reverse();
}

/** The `{ labels: … }` diffs among the item's revisions, oldest-first. */
async function labelDiffsOf(workItemId: string): Promise<unknown[]> {
  const rows = await revisionsOf(workItemId);
  return rows
    .map((r) => r.diff as Record<string, unknown>)
    .filter((d) => 'labels' in d)
    .map((d) => d.labels);
}

async function labelRowCount(): Promise<number> {
  return db.label.count();
}

/** First element, asserted present (noUncheckedIndexedAccess-safe). */
function first<T>(arr: T[]): T {
  const v = arr[0];
  if (v === undefined) throw new Error('expected a non-empty array');
  return v;
}

describe('labelsService.addLabel — type-to-create find-or-create', () => {
  it('creates a label by typing, preserving the first-typed display casing, and records the added diff', async () => {
    const s = await buildScenario();

    const labels = await labelsService.addLabel(s.issue.id, 'Perf-Q3', s.memberCtx);
    expect(labels.map((l) => l.name)).toEqual(['Perf-Q3']);

    expect(await labelDiffsOf(s.issue.id)).toEqual([{ added: ['Perf-Q3'] }]);
  });

  it("matches case-insensitively across issues — 'PERF-Q3' reuses the 'Perf-Q3' row and returns the original casing", async () => {
    const s = await buildScenario();
    const other = await createTestWorkItem(s.fx, { kind: 'task', title: 'Second task' });

    const created = first(await labelsService.addLabel(s.issue.id, 'Perf-Q3', s.memberCtx));
    const reused = first(await labelsService.addLabel(other.id, 'PERF-Q3', s.memberCtx));

    expect(reused.id).toBe(created.id); // one row, two uses
    expect(reused.name).toBe('Perf-Q3'); // first-typed casing displayed
    expect(await labelRowCount()).toBe(1);
  });

  it('is idempotent — re-adding an attached label (any casing) changes nothing and writes no revision', async () => {
    const s = await buildScenario();
    await labelsService.addLabel(s.issue.id, 'backend', s.memberCtx);

    const labels = await labelsService.addLabel(s.issue.id, 'BACKEND', s.memberCtx);
    expect(labels.map((l) => l.name)).toEqual(['backend']);
    expect(await labelDiffsOf(s.issue.id)).toHaveLength(1); // only the first add
  });

  it('trims surrounding whitespace before validating', async () => {
    const s = await buildScenario();
    const labels = await labelsService.addLabel(s.issue.id, '  tidy  ', s.memberCtx);
    expect(labels.map((l) => l.name)).toEqual(['tidy']);
  });

  it('survives a concurrent find-or-create race on the SAME new label (the P2002 retry)', async () => {
    const s = await buildScenario();
    const other = await createTestWorkItem(s.fx, { kind: 'task', title: 'Race partner' });

    const results = await Promise.all([
      labelsService.addLabel(s.issue.id, 'raced', s.memberCtx),
      labelsService.addLabel(other.id, 'raced', s.memberCtx),
    ]);

    for (const result of results) expect(result.map((l) => l.name)).toEqual(['raced']);
    expect(await labelRowCount()).toBe(1); // one row despite the race
  });
});

describe('labelsService — the folksonomy validation rules', () => {
  it('rejects a label with spaces, naming the hyphen convention (422)', async () => {
    const s = await buildScenario();
    await expect(labelsService.addLabel(s.issue.id, 'perf q3', s.memberCtx)).rejects.toThrow(
      InvalidLabelNameError,
    );
    await expect(labelsService.addLabel(s.issue.id, 'perf q3', s.memberCtx)).rejects.toThrow(
      /hyphens/,
    );
    // Any whitespace counts — tabs included.
    await expect(labelsService.addLabel(s.issue.id, 'perf\tq3', s.memberCtx)).rejects.toThrow(
      InvalidLabelNameError,
    );
  });

  it('rejects a blank label (422)', async () => {
    const s = await buildScenario();
    await expect(labelsService.addLabel(s.issue.id, '   ', s.memberCtx)).rejects.toThrow(
      InvalidLabelNameError,
    );
  });

  it(`rejects a label over ${LABEL_NAME_MAX_LENGTH} characters (422)`, async () => {
    const s = await buildScenario();
    const tooLong = 'x'.repeat(LABEL_NAME_MAX_LENGTH + 1);
    await expect(labelsService.addLabel(s.issue.id, tooLong, s.memberCtx)).rejects.toThrow(
      LabelNameTooLongError,
    );
    // The boundary value passes.
    const max = 'y'.repeat(LABEL_NAME_MAX_LENGTH);
    const labels = await labelsService.addLabel(s.issue.id, max, s.memberCtx);
    expect(labels.map((l) => l.name)).toContain(max);
  });

  it(`caps an issue at ${LABELS_PER_ISSUE_LIMIT} labels — the sanity guard (422), while re-adding an existing one still no-ops`, async () => {
    const s = await buildScenario();
    await labelsService.setLabels(
      s.issue.id,
      Array.from({ length: LABELS_PER_ISSUE_LIMIT }, (_, i) => `tag-${String(i).padStart(2, '0')}`),
      s.memberCtx,
    );

    await expect(labelsService.addLabel(s.issue.id, 'one-too-many', s.memberCtx)).rejects.toThrow(
      LabelLimitExceededError,
    );
    // At the cap, an already-attached name is still the idempotent no-op.
    const labels = await labelsService.addLabel(s.issue.id, 'TAG-00', s.memberCtx);
    expect(labels).toHaveLength(LABELS_PER_ISSUE_LIMIT);

    await expect(
      labelsService.setLabels(
        s.issue.id,
        Array.from({ length: LABELS_PER_ISSUE_LIMIT + 1 }, (_, i) => `set-${i}`),
        s.memberCtx,
      ),
    ).rejects.toThrow(LabelLimitExceededError);
  });
});

describe('labelsService.removeLabel — delete-on-last-use', () => {
  it('deletes the label row when its last use goes, and records the removed diff', async () => {
    const s = await buildScenario();
    const label = first(await labelsService.addLabel(s.issue.id, 'ephemeral', s.memberCtx));

    const labels = await labelsService.removeLabel(s.issue.id, label.id, s.memberCtx);
    expect(labels).toEqual([]);
    expect(await labelRowCount()).toBe(0); // unused labels disappear
    expect(await labelDiffsOf(s.issue.id)).toEqual([
      { added: ['ephemeral'] },
      { removed: ['ephemeral'] },
    ]);
  });

  it('keeps the label row while another issue still uses it', async () => {
    const s = await buildScenario();
    const other = await createTestWorkItem(s.fx, { kind: 'task', title: 'Keeper' });
    const label = first(await labelsService.addLabel(s.issue.id, 'shared', s.memberCtx));
    await labelsService.addLabel(other.id, 'shared', s.memberCtx);

    await labelsService.removeLabel(s.issue.id, label.id, s.memberCtx);
    expect(await labelRowCount()).toBe(1); // still in use elsewhere

    await labelsService.removeLabel(other.id, label.id, s.memberCtx);
    expect(await labelRowCount()).toBe(0); // last use gone → row gone
  });

  it('no-ops (no revision) when the issue does not carry the label', async () => {
    const s = await buildScenario();
    const other = await createTestWorkItem(s.fx, { kind: 'task', title: 'Other' });
    const label = first(await labelsService.addLabel(other.id, 'elsewhere', s.memberCtx));

    const labels = await labelsService.removeLabel(s.issue.id, label.id, s.memberCtx);
    expect(labels).toEqual([]);
    expect(await labelDiffsOf(s.issue.id)).toEqual([]); // nothing changed here
    expect(await labelRowCount()).toBe(1); // the other issue's label untouched
  });

  it('exactly one of two CONCURRENT removals observes zero — the locked count never double-deletes or leaks', async () => {
    const s = await buildScenario();
    const other = await createTestWorkItem(s.fx, { kind: 'task', title: 'Race partner' });
    const label = first(await labelsService.addLabel(s.issue.id, 'contested', s.memberCtx));
    await labelsService.addLabel(other.id, 'contested', s.memberCtx);

    // Both removals run concurrently; the FOR UPDATE lock on the label row
    // serializes them, so the loser sees the winner's join delete and the
    // label dies exactly once (no P2025 double-delete, no orphan row).
    await Promise.all([
      labelsService.removeLabel(s.issue.id, label.id, s.memberCtx),
      labelsService.removeLabel(other.id, label.id, s.memberCtx),
    ]);

    expect(await labelRowCount()).toBe(0);
    expect(await db.workItemLabel.count()).toBe(0);
  });
});

describe('labelsService.setLabels — the bulk replace', () => {
  it('applies additions and removals in one transaction with ONE combined revision diff', async () => {
    const s = await buildScenario();
    await labelsService.setLabels(s.issue.id, ['keep', 'drop'], s.memberCtx);

    const labels = await labelsService.setLabels(s.issue.id, ['keep', 'fresh'], s.memberCtx);
    expect(labels.map((l) => l.name)).toEqual(['fresh', 'keep']); // name-ordered

    expect(await labelDiffsOf(s.issue.id)).toEqual([
      { added: ['keep', 'drop'] },
      { added: ['fresh'], removed: ['drop'] },
    ]);
    expect(await labelRowCount()).toBe(2); // 'drop' died on last use
  });

  it('dedupes case-insensitively (first casing wins) and treats a same-set replace as a no-op', async () => {
    const s = await buildScenario();
    const labels = await labelsService.setLabels(
      s.issue.id,
      ['Backend', 'BACKEND', 'backend'],
      s.memberCtx,
    );
    expect(labels.map((l) => l.name)).toEqual(['Backend']);

    await labelsService.setLabels(s.issue.id, ['backend'], s.memberCtx); // same set, other casing
    expect(await labelDiffsOf(s.issue.id)).toHaveLength(1); // no second revision
  });

  it('clears the set with [] (every label detaches, last-use rows die)', async () => {
    const s = await buildScenario();
    await labelsService.setLabels(s.issue.id, ['a-tag', 'b-tag'], s.memberCtx);

    const labels = await labelsService.setLabels(s.issue.id, [], s.memberCtx);
    expect(labels).toEqual([]);
    expect(await labelRowCount()).toBe(0);
  });

  it('validates every incoming name before touching the DB', async () => {
    const s = await buildScenario();
    await expect(
      labelsService.setLabels(s.issue.id, ['fine', 'not fine'], s.memberCtx),
    ).rejects.toThrow(InvalidLabelNameError);
    expect(await labelRowCount()).toBe(0); // nothing was written
  });
});

describe('labelsService.searchLabels — the bounded autocomplete', () => {
  it('prefix-matches case-insensitively and returns display names', async () => {
    const s = await buildScenario();
    await labelsService.setLabels(s.issue.id, ['Perf-Q3', 'perf-q4', 'backend'], s.memberCtx);

    const hits = await labelsService.searchLabels(s.fx.projectIdentifier, 'PERF', s.memberCtx);
    expect(hits.map((l) => l.name)).toEqual(['Perf-Q3', 'perf-q4']);
  });

  it(`lists the first window on an empty query and never exceeds ${LABEL_SEARCH_LIMIT}`, async () => {
    const s = await buildScenario();
    const second = await createTestWorkItem(s.fx, { kind: 'task', title: 'More tags' });
    // Two capped issues → more distinct labels than one window holds.
    await labelsService.setLabels(
      s.issue.id,
      Array.from({ length: LABELS_PER_ISSUE_LIMIT }, (_, i) => `aa-${String(i).padStart(2, '0')}`),
      s.memberCtx,
    );
    await labelsService.setLabels(
      second.id,
      Array.from({ length: 5 }, (_, i) => `zz-${i}`),
      s.memberCtx,
    );

    const all = await labelsService.searchLabels(s.fx.projectIdentifier, '', s.memberCtx);
    expect(all).toHaveLength(LABEL_SEARCH_LIMIT); // bounded, name-ordered window
    expect(first(all).name).toBe('aa-00');
  });

  it('is project-scoped — the deliberate deviation from site-global Jira labels', async () => {
    const s = await buildScenario();
    const otherTenant = await makeWorkItemFixture({ name: 'Globex', identifier: 'GLX' });
    const otherIssue = await createTestWorkItem(otherTenant, { kind: 'task', title: 'Theirs' });
    await labelsService.addLabel(otherIssue.id, 'leaky', otherTenant.ctx);

    const hits = await labelsService.searchLabels(s.fx.projectIdentifier, 'leak', s.memberCtx);
    expect(hits).toEqual([]); // another project's folksonomy never leaks in
  });

  it('hides a cross-tenant project key as 404 (no existence leak)', async () => {
    const s = await buildScenario();
    const otherTenant = await makeWorkItemFixture({ name: 'Globex', identifier: 'GLX' });
    await expect(
      labelsService.searchLabels(otherTenant.projectIdentifier, '', s.memberCtx),
    ).rejects.toThrow(ProjectNotFoundError);
  });

  it('stays readable for a viewer (view-gated, not edit-gated)', async () => {
    const s = await buildScenario();
    await labelsService.addLabel(s.issue.id, 'visible', s.memberCtx);
    const hits = await labelsService.searchLabels(s.fx.projectIdentifier, 'vis', s.viewerCtx);
    expect(hits.map((l) => l.name)).toEqual(['visible']);
  });
});

describe('labelsService — the permission matrix', () => {
  it('rejects every write from a read-only viewer with the typed edit denial (403)', async () => {
    const s = await buildScenario();
    const label = first(await labelsService.addLabel(s.issue.id, 'held', s.memberCtx));

    for (const write of [
      () => labelsService.addLabel(s.issue.id, 'nope', s.viewerCtx),
      () => labelsService.setLabels(s.issue.id, ['nope'], s.viewerCtx),
      () => labelsService.removeLabel(s.issue.id, label.id, s.viewerCtx),
    ]) {
      const err = await write().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProjectAccessDeniedError);
      expect((err as ProjectAccessDeniedError).kind).toBe('edit');
    }
  });

  it('hides a cross-workspace issue as WorkItemNotFoundError (404, finding #44)', async () => {
    const s = await buildScenario();
    const otherTenant = await makeWorkItemFixture({ name: 'Globex', identifier: 'GLX' });
    const theirIssue = await createTestWorkItem(otherTenant, { kind: 'task', title: 'Theirs' });

    await expect(labelsService.addLabel(theirIssue.id, 'probe', s.memberCtx)).rejects.toThrow(
      WorkItemNotFoundError,
    );
    await expect(
      labelsService.removeLabel(theirIssue.id, 'any-label-id', s.memberCtx),
    ).rejects.toThrow(WorkItemNotFoundError);
    await expect(labelsService.setLabels(theirIssue.id, [], s.memberCtx)).rejects.toThrow(
      WorkItemNotFoundError,
    );
  });

  it('hides a PRIVATE project from a non-member as 404 — never "exists but forbidden"', async () => {
    const s = await buildScenario();
    // Flip private FIRST, then add the late joiner (auto-enrolment only
    // covers then-current members — the comments-suite pattern).
    await projectMembersService.setAccessLevel({
      key: s.fx.projectIdentifier,
      actorUserId: s.fx.ownerId,
      ctx: s.fx.ctx,
      level: 'private',
    });
    const outsider = await createTestUser({ email: 'late@ex.com', name: 'Late Joiner' });
    await workspacesService.addMember({ userId: outsider.id, workspaceId: s.fx.workspaceId });
    const outsiderCtx = { userId: outsider.id, workspaceId: s.fx.workspaceId };

    await expect(labelsService.addLabel(s.issue.id, 'probe', outsiderCtx)).rejects.toThrow(
      WorkItemNotFoundError,
    );
    await expect(
      labelsService.searchLabels(s.fx.projectIdentifier, '', outsiderCtx),
    ).rejects.toThrow(ProjectNotFoundError);
  });
});

describe('getIssueDetail carries the labels (the parallel-fetch slot)', () => {
  it('returns the issue labels name-ordered without a second service call', async () => {
    const s = await buildScenario();
    await labelsService.setLabels(s.issue.id, ['zeta', 'Alpha'], s.memberCtx);

    const detail = await workItemsService.getIssueDetail(
      s.fx.projectId,
      s.issue.identifier,
      s.fx.ctx,
    );
    expect(detail.labels.map((l) => l.name)).toEqual(['Alpha', 'zeta']);
  });

  it('returns [] for an unlabelled issue', async () => {
    const s = await buildScenario();
    const detail = await workItemsService.getIssueDetail(
      s.fx.projectId,
      s.issue.identifier,
      s.fx.ctx,
    );
    expect(detail.labels).toEqual([]);
  });
});
