import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { publicRequestsService } from '@/lib/services/publicRequestsService';
import { commentsService } from '@/lib/services/commentsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { PublicRequestNotFoundError } from '@/lib/publicRequests/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// Public request DETAIL read (Story 6.12 · Subtask 6.12.12) — the read behind the
// public `/p/<project>/requests/<request>` page. Real Postgres (the standing
// rule). It must: render anonymously + cross-org through the public projection
// (no internal fields, only `isPublic` comments), 404 a non-public project / a
// missing or archived request (404-not-403, no existence leak), and carry the
// upvote demand signal + the viewer's `voted` flag.

let counter = 0;
async function makeUser(name: string) {
  counter += 1;
  return usersService.createUser({
    email: `prd-${counter}@ex.com`,
    password: 'hunter2hunter2',
    name,
  });
}

/** A PUBLIC project + one public request (a work item with internal fields set,
 *  so the projection assertions prove the fields are STRIPPED not never-set). */
async function publicRequestFixture(): Promise<{
  fx: WorkItemFixture;
  requestId: string;
  requestIdentifier: string;
}> {
  const fx = await makeWorkItemFixture({ name: 'Acme' });
  await db.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'public' } });
  const item = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title: 'Dark mode please',
      descriptionMd: 'Would love a dark theme.',
    },
    fx.ctx,
  );
  await db.workItem.update({
    where: { id: item.id },
    data: { assigneeId: fx.ownerId, estimateMinutes: 480, storyPoints: 8 },
  });
  return { fx, requestId: item.id, requestIdentifier: item.identifier };
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('publicProjectsService.getRequestDetail (6.12.12)', () => {
  it('renders anonymously + cross-org with the public projection (no internal fields)', async () => {
    const { fx, requestId, requestIdentifier } = await publicRequestFixture();
    const crossOrg = await makeUser('Cross Org');

    for (const actor of [null, crossOrg.id]) {
      const detail = await publicProjectsService.getRequestDetail(
        fx.projectIdentifier,
        requestIdentifier,
        actor,
      );
      expect(detail.id).toBe(requestId);
      expect(detail.identifier).toBe(requestIdentifier);
      expect(detail.title).toBe('Dark mode please');
      expect(detail.descriptionMd).toBe('Would love a dark theme.');
      expect(detail.kind).toBe('task');
      // Internal fields are absent from the DTO shape (structural projection).
      const asRecord = detail as unknown as Record<string, unknown>;
      for (const k of ['assignee', 'assigneeId', 'estimateMinutes', 'storyPoints']) {
        expect(asRecord).not.toHaveProperty(k);
      }
    }
  });

  it('returns ONLY the public (isPublic) comments — internal discussion never crosses', async () => {
    const { fx, requestId, requestIdentifier } = await publicRequestFixture();
    const commenter = await makeUser('Public Commenter');

    // A PUBLIC request comment (6.12.6) + an INTERNAL work-item comment (5.1).
    await publicRequestsService.addComment(
      requestId,
      { bodyMd: 'I want this too!' },
      { userId: commenter.id },
    );
    await commentsService.addComment(requestId, { bodyMd: 'Internal triage note' }, fx.ctx);

    const detail = await publicProjectsService.getRequestDetail(
      fx.projectIdentifier,
      requestIdentifier,
      null,
    );
    expect(detail.comments).toHaveLength(1);
    expect(detail.comments[0]!.bodyMd).toBe('I want this too!');
    expect(detail.comments.map((c) => c.bodyMd)).not.toContain('Internal triage note');
  });

  it('carries the upvote tally + the viewer-specific voted flag', async () => {
    const { fx, requestId, requestIdentifier } = await publicRequestFixture();
    const voter = await makeUser('Voter');
    const other = await makeUser('Other');

    await publicRequestsService.toggleUpvote(requestId, { userId: voter.id });

    const asVoter = await publicProjectsService.getRequestDetail(
      fx.projectIdentifier,
      requestIdentifier,
      voter.id,
    );
    expect(asVoter.voteCount).toBe(1);
    expect(asVoter.voted).toBe(true);

    const asOther = await publicProjectsService.getRequestDetail(
      fx.projectIdentifier,
      requestIdentifier,
      other.id,
    );
    expect(asOther.voteCount).toBe(1);
    expect(asOther.voted).toBe(false);

    const anon = await publicProjectsService.getRequestDetail(
      fx.projectIdentifier,
      requestIdentifier,
      null,
    );
    expect(anon.voted).toBe(false);
  });

  it('404s a non-public project, an unknown request, and an archived request (404-not-403)', async () => {
    // A non-public project → ProjectNotFoundError through the browse gate.
    const priv = await makeWorkItemFixture({ name: 'Private Co' });
    const item = await workItemsService.createWorkItem(
      { projectId: priv.projectId, kind: 'task', title: 'Secret' },
      priv.ctx,
    );
    await expect(
      publicProjectsService.getRequestDetail(priv.projectIdentifier, item.identifier, null),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    // A public project but an unknown / archived request → PublicRequestNotFoundError.
    const { fx, requestId, requestIdentifier } = await publicRequestFixture();
    await expect(
      publicProjectsService.getRequestDetail(fx.projectIdentifier, 'PROD-9999', null),
    ).rejects.toBeInstanceOf(PublicRequestNotFoundError);

    await db.workItem.update({ where: { id: requestId }, data: { archivedAt: new Date() } });
    await expect(
      publicProjectsService.getRequestDetail(fx.projectIdentifier, requestIdentifier, null),
    ).rejects.toBeInstanceOf(PublicRequestNotFoundError);
  });
});
