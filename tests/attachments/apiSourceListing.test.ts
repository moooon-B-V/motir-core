import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Attachment, AttachmentSource } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  attachmentRepository,
  LIFECYCLE_OWNED_SOURCES,
} from '@/lib/repositories/attachmentRepository';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from '../fixtures';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// The `api` attachment source (Story MOTIR-3000 · MOTIR-3056;
// docs/decisions/attachment-api-door.md §2) — a file uploaded through the
// GENERAL public-API door.
//
// ⚠️ WHAT THIS FILE GUARDS IS AN ABSENCE, and that is the whole point. The panel
// queries filter with `notIn` — a DENYLIST — so `api` is listed and counted BY
// DEFAULT and MOTIR-3056 changed no query at all. The risk is therefore not
// forgetting to include it; it is a later "tidy the exclusions" edit ADDING it,
// which produces no compile error and no runtime error — only a row nobody can
// see. `acceptance_trace` is the live proof that a denylist drifts silently
// (documented as excluded, in neither array — MOTIR-3085).
//
// Writes run through `adminDb` like the sibling repository suites (MOTIR-2751):
// the subject is which rows the QUERY's own predicate returns, and under the
// non-bypass role a row missing from a result proves nothing about the predicate
// because the policy could have filtered it.

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "attachment", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(truncateAll);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makeAttachment(
  fx: WorkItemFixture,
  workItemId: string,
  source: AttachmentSource,
): Promise<Attachment> {
  return adminDb.attachment.create({
    data: {
      workspaceId: fx.workspaceId,
      uploaderUserId: fx.ownerId,
      workItemId,
      source,
      blobPathname: `https://blob.example/attachments/${fx.workspaceId}/${source}.png`,
      mimeType: 'image/png',
      sizeBytes: 4,
      originalFilename: `${source}.png`,
    },
  });
}

describe('AttachmentSource.api — the general public-API door', () => {
  it('is a member of the enum', async () => {
    const values = await adminDb.$queryRawUnsafe<Array<{ enumlabel: string }>>(
      `SELECT e.enumlabel FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'attachment_source'`,
    );
    expect(values.map((v) => v.enumlabel)).toContain('api');
  });

  it('a linked `api` row is RETURNED by listByWorkItem and COUNTED by countByWorkItem', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Holder' });
    const row = await makeAttachment(fx, issue.id, 'api');

    const [listed, counted] = await withWorkspaceServiceContext(fx.workspaceId, async (tx) => [
      await attachmentRepository.listByWorkItem(issue.id, {}, tx),
      await attachmentRepository.countByWorkItem(issue.id, tx),
    ]);

    expect(listed.map((a) => a.id)).toContain(row.id);
    expect(counted).toBe(1);
  });

  it('is listed ALONGSIDE editor and panel, while the lifecycle-owned sources stay excluded', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Holder' });

    const api = await makeAttachment(fx, issue.id, 'api');
    const editor = await makeAttachment(fx, issue.id, 'editor');
    const panel = await makeAttachment(fx, issue.id, 'panel');
    const video = await makeAttachment(fx, issue.id, 'acceptance_video');
    const design = await makeAttachment(fx, issue.id, 'design_asset');

    const [listed, counted] = await withWorkspaceServiceContext(fx.workspaceId, async (tx) => [
      await attachmentRepository.listByWorkItem(issue.id, {}, tx),
      await attachmentRepository.countByWorkItem(issue.id, tx),
    ]);
    const ids = listed.map((a) => a.id);

    // The point of the story: a general-door upload is an ORDINARY attachment.
    expect(ids).toEqual(expect.arrayContaining([api.id, editor.id, panel.id]));

    // …and making it visible must NOT have widened the door for the two the
    // panel deliberately hides. Only a test holding both cases at once can tell
    // a correct change from a merely permissive one.
    expect(ids).not.toContain(video.id);
    expect(ids).not.toContain(design.id);

    // The badge and the list are two independently-written predicates.
    expect(counted).toBe(3);
  });
});

describe('the denylist itself — the regression this story can silently ship', () => {
  // The predicate is ONE exported constant since MOTIR-3085, so this reads the
  // value rather than the source. What it guards is unchanged and is still an
  // ABSENCE: `api` must never join it. Adding it there produces no compile
  // error and no runtime error — only a row nobody can see.
  it('NEITHER query excludes `api` — adding it is the invisible-attachment regression', () => {
    expect(LIFECYCLE_OWNED_SOURCES).not.toContain('api');
  });

  it('is ONE constant, so the list and the count cannot drift apart', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'lib/repositories/attachmentRepository.ts'),
      'utf8',
    );
    // Two call sites, one constant, and no literal array left to fall out of
    // step — which is exactly how `acceptance_trace` went missing from one copy.
    expect(source.match(/notIn:\s*\[\.\.\.LIFECYCLE_OWNED_SOURCES\]/g)).toHaveLength(2);
    expect(source).not.toMatch(/notIn:\s*\['/);
  });

  it('holds exactly the lifecycle-owned sources — the three that own a panel', () => {
    // Pinned as a set: a member ADDED here disappears from the panel, which is
    // the change most worth making somebody say out loud.
    expect([...LIFECYCLE_OWNED_SOURCES].sort()).toEqual([
      'acceptance_trace',
      'acceptance_video',
      'design_asset',
    ]);
  });
});
