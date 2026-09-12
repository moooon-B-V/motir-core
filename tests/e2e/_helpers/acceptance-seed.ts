import { adminDb, db } from './db-reset';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// E2E seed helpers for the story-acceptance flow (Story MOTIR-1627 · Subtask
// MOTIR-1638). Plants stories in the states the acceptance panel branches on.
// Runs in the Playwright RUNNER process (not the server), so it inserts the
// evidence rows DIRECTLY — never through the blob uploader (the runner has no
// blob mock; only the server does).

export interface AcceptanceStory {
  id: string;
  identifier: string;
}

/** A story moved to `in_review` — the status the acceptance panel appears on. */
export async function seedInReviewStory(
  ctx: ServiceContext,
  projectId: string,
  title: string,
): Promise<AcceptanceStory> {
  const story = await workItemsService.createWorkItem({ projectId, kind: 'story', title }, ctx);
  await workItemsService.updateStatus(story.id, 'in_progress', ctx);
  await workItemsService.updateStatus(story.id, 'in_review', ctx);
  return { id: story.id, identifier: story.identifier };
}

/**
 * Attach a PENDING acceptance video to a story — the "evidence present" panel
 * state. Direct inserts (an `acceptance_video` Attachment linked to the story +
 * the current AcceptanceEvidence). `blobPathname` is a data: URL so the panel's
 * native `<video>` has a real (tiny) source in the browser.
 */
export async function seedPendingEvidence(
  workspaceId: string,
  uploaderUserId: string,
  storyId: string,
): Promise<void> {
  const attachment = await db.attachment.create({
    data: {
      workspaceId,
      uploaderUserId,
      workItemId: storyId,
      source: 'acceptance_video',
      // A 1-frame black webm is overkill for the seed; an empty data: URL keeps
      // the <video> element valid without a network fetch.
      blobPathname: 'data:video/webm;base64,',
      mimeType: 'video/webm',
      sizeBytes: 1024,
      originalFilename: 'acceptance.webm',
    },
  });
  await db.acceptanceEvidence.create({
    data: {
      workspaceId,
      workItemId: storyId,
      attachmentId: attachment.id,
      chapters: [
        { label: 'Open the story', tSeconds: 0 },
        { label: 'Review & approve', tSeconds: 3 },
      ],
      status: 'pending',
      commitSha: 'e2edeadbeef',
      ciRunUrl: 'https://ci.example/run/1',
      producedByKey: 'MOTIR-1638',
      isCurrent: true,
    },
  });
}

/**
 * Flip the org-wide acceptance-video toggle.
 *
 * ⚠️ THIS IS NO LONGER THE SWITCH THE PANEL READS (MOTIR-4925 · MOTIR-5168).
 * `acceptanceVideoEligibilityService` resolves the toggle from the STORY'S OWN
 * PROJECT now; the organisation still carries `hasPaidAiPlan`, which is a
 * different axis and unchanged. This column survives only until MOTIR-5172
 * vacates the org tier, and it is kept here for the one case that needs the two
 * tiers to DISAGREE — a test that sets them both cannot say which one it read.
 */
export async function setOrgAcceptanceVideo(
  organizationId: string,
  enabled: boolean,
): Promise<void> {
  await db.organization.update({
    where: { id: organizationId },
    data: { acceptanceVideoEnabled: enabled },
  });
}

/**
 * Flip the PROJECT's acceptance-video toggle — the switch that decides whether
 * the gate exists for this project's stories (MOTIR-4925 · MOTIR-5167 added the
 * column, MOTIR-5168 made every consumer read it).
 *
 * The column carries `@default(true)`, so an unset project is ON: a test wanting
 * the ON state passes without calling this, and passes for the wrong reason. Call
 * it in both directions rather than relying on the default.
 */
export async function setProjectAcceptanceVideo(
  projectId: string,
  enabled: boolean,
): Promise<void> {
  // ⚠️ `adminDb`, NOT the `db` singleton its org-tier sibling above uses.
  // `UNCONVERTED_E2E_CEILING` (`tests/rls/test-singleton-statement-guard.test.ts`)
  // is a ratchet that only ever falls, and a new direct singleton statement under
  // `tests/e2e/**` raises it — the guard's own message says to seed through
  // `adminDb` rather than raise the number. It is also the correct client on the
  // merits: under `motir_app` this write would be REFUSED and would not raise, so
  // the spec would drive a browser against a switch it believes it set. The
  // sibling is left as it is; converting it is the ratchet's own card.
  await adminDb.project.update({
    where: { id: projectId },
    data: { acceptanceVideoEnabled: enabled },
  });
}
