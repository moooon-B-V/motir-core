// Design-result seed (Story MOTIR-2664 · Subtask MOTIR-2672).
//
// Plants the two states the Design result panel branches on: a design subtask
// with a PUBLISHED result (note + mock + screenshot) and one with nothing.
//
// ⚠️ WHY THE EVIDENCE ROWS ARE INSERTED DIRECTLY, NOT PUBLISHED THROUGH THE
// REGISTER ENDPOINT. MOTIR-2672 asks for the latter, and it is not reachable
// under E2E — the reason is worth writing down so nobody "fixes" this back.
// `POST /api/work-items/[id]/design-evidence` calls `headPrivateBlob()` on the
// SERVER to read each artifact's authoritative size and content type. Under
// Playwright the server is configured with `MOTIR_S3_ENDPOINT =
// https://e2e.s3.invalid` — the reserved TLD, which resolves nowhere by design.
// `page.route` intercepts requests the BROWSER makes; it cannot intercept a
// server-side fetch. So the register call would fail inside `head`, before any
// row was written, in every environment where this spec can run.
//
// `acceptance-seed.ts` reached the same conclusion for the same reason and says
// so in its own header ("Runs in the Playwright RUNNER process… so it inserts
// the evidence rows DIRECTLY").
//
// What this costs is nothing the spec was there to prove. The publish path is
// already covered at three altitudes on other cards — the service against real
// Postgres, the route with its real auth gate, and the CI uploader's own unit
// suite. What only a browser can prove is the READ path, and that stays
// completely real here: the page renders from the database, the browser fetches
// `/api/attachments/<id>/content`, the server mints a signed URL and 302s to the
// private store, and `servePrivateObjectStore` refuses it unless it carries a
// signature. That seam is exercised end to end, which is the point of the card.

import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';

export const DESIGN_RESULT_PASSWORD = 'design-result-e2e-pass-7';

export interface DesignResultSeed {
  email: string;
  password: string;
  /** The design subtask carrying a published result — the spec's main subject. */
  publishedKey: string;
  publishedTitle: string;
  /** A design subtask with nothing published — the empty state. */
  emptyKey: string;
  emptyTitle: string;
  /**
   * The mock's Attachment id. The spec needs it to address that ONE artifact's
   * content route — see the note in the spec about the sandboxed frame.
   */
  mockAttachmentId: string;
  /** The screenshot's Attachment id — routed alongside the mock. */
  imageAttachmentId: string;
  /** The note text the panel renders, asserted verbatim in the spec. */
  noteHeading: string;
  noteBody: string;
  mockSourcePath: string;
  imageSourcePath: string;
  commitSha: string;
  producedByKey: string;
}

// ⚠️ Deliberately NOT a substring of any work-item title in this seed.
// Playwright's `getByRole('heading', { name })` matches the accessible name by
// SUBSTRING, so a note heading of "The Design result panel" also matches the
// subtask's own `<h1>` ("Design — the Design result panel") and the assertion
// dies on a strict-mode violation rather than on anything real.
const NOTE_HEADING = 'How a reviewer reads this';
const NOTE_BODY =
  'The note renders through the same Markdown path as the description, so a table scrolls inside the section and the page never scrolls sideways.';

export async function seedDesignResult(email: string): Promise<DesignResultSeed> {
  const owner = await usersService.createUser({
    email,
    password: DESIGN_RESULT_PASSWORD,
    name: 'Design Result Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Design Result E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Design Result',
    identifier: 'DSR',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  const ctx = { userId: owner.id, workspaceId: workspace.id };

  const story = await workItemsService.createWorkItem(
    {
      projectId: project.id,
      kind: 'story',
      title: 'The design result on the work item',
    },
    ctx,
  );

  const publishedTitle = 'Design — the Design result panel';
  const published = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'subtask', title: publishedTitle, parentId: story.id },
    ctx,
  );

  const emptyTitle = 'Design — a surface with nothing published yet';
  const empty = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'subtask', title: emptyTitle, parentId: story.id },
    ctx,
  );

  // The keys the artifacts live under. The `design/<ws>/<itemId>/` prefix is the
  // one the service mints and the one its pathname gate enforces, so the seed
  // uses the real shape rather than an arbitrary string — the content route
  // signs whatever is stored, and a wrong-shaped key would still "work" here
  // while being something the publisher could never produce.
  const prefix = `design/${workspace.id}/${published.id}/`;
  const mockSourcePath = 'design/work-items/design-result.mock.html';
  const imageSourcePath = 'design/work-items/design-result.png';
  const noteSourcePath = 'design/work-items/design-notes.md';

  const evidence = await db.designEvidence.create({
    data: {
      workspaceId: workspace.id,
      workItemId: published.id,
      noteMd: `## ${NOTE_HEADING}\n\n${NOTE_BODY}\n`,
      noteTruncated: false,
      commitSha: 'c0389f2',
      ciRunUrl: 'https://github.com/moooon-B-V/motir-core/actions/runs/1',
      producedByKey: 'MOTIR-2669',
      isCurrent: true,
    },
  });

  const artifacts = [
    {
      kind: 'mock' as const,
      name: 'design-result.mock.html',
      type: 'text/html',
      src: mockSourcePath,
    },
    { kind: 'image' as const, name: 'design-result.png', type: 'image/png', src: imageSourcePath },
    {
      kind: 'note_file' as const,
      name: 'design-notes.md',
      type: 'text/markdown',
      src: noteSourcePath,
    },
  ];

  let position = 0;
  let mockAttachmentId = '';
  let imageAttachmentId = '';
  for (const artifact of artifacts) {
    const attachment = await db.attachment.create({
      data: {
        workspaceId: workspace.id,
        uploaderUserId: owner.id,
        workItemId: published.id,
        source: 'design_asset',
        blobPathname: `${prefix}${artifact.name}`,
        mimeType: artifact.type,
        sizeBytes: 4096,
        originalFilename: artifact.name,
      },
    });
    await db.designAsset.create({
      data: {
        workspaceId: workspace.id,
        designEvidenceId: evidence.id,
        kind: artifact.kind,
        attachmentId: attachment.id,
        sourcePath: artifact.src,
        position: position++,
      },
    });
    if (artifact.kind === 'mock') mockAttachmentId = attachment.id;
    if (artifact.kind === 'image') imageAttachmentId = attachment.id;
  }

  return {
    mockAttachmentId,
    imageAttachmentId,
    email,
    password: DESIGN_RESULT_PASSWORD,
    publishedKey: published.identifier,
    publishedTitle,
    emptyKey: empty.identifier,
    emptyTitle,
    noteHeading: NOTE_HEADING,
    noteBody: NOTE_BODY,
    mockSourcePath,
    imageSourcePath,
    commitSha: 'c0389f2',
    producedByKey: 'MOTIR-2669',
  };
}
