import { db } from '@/lib/db';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { createTestPerson } from './testPerson';

// Design-PUBLISH seed (Story MOTIR-3780 · Subtask MOTIR-3788).
//
// ⚠️ THE PUBLISH IS NOT SEEDED HERE, AND THAT IS THE WHOLE POINT OF THE CARD.
// `design-result-seed.ts` inserts its evidence rows DIRECTLY and says why in its
// own header: the register endpoint `head`s the object store from the server,
// and under Playwright the endpoint is `https://e2e.s3.invalid`, which resolves
// nowhere. That note was written for MOTIR-2672 and it is **no longer true**.
//
// MOTIR-2389 / MOTIR-2395 moved the E2E seam from a fabricated URL to an
// IN-PROCESS transport: `instrumentation.ts` installs `lib/test-blob-mock.ts` at
// the S3 SDK's own `requestHandler` behind `E2E_TEST_BLOB=1`, and that mock
// answers PUT, HEAD, GET and DELETE from what was stored. `headPrivateBlob`
// goes through the same `s3Client()`, so the server-side head the old note calls
// unreachable now resolves in process, without touching the network.
//
// Verified before this spec was written, which is what MOTIR-3788's scaffold
// clause asks for: the lane reaches `/api/mcp` (`agent-authored-plan-seed.ts`
// and `cli-connect-seed.ts` already drive real tools against the lane's own
// server), and the store answers HEAD. So the publish under test is the REAL
// one — a bearer token, the real tool, the real service, a real row — and the
// browser arrives afterwards as the REVIEWER.
//
// The seed's job is therefore only to plant what the publish needs: a person, a
// project, two design cards, and a token holding no more than a dispatched run's
// own grant.

export const DESIGN_PUBLISH_PASSWORD = 'design-publish-e2e-pass-7';

export interface DesignPublishSeed {
  email: string;
  password: string;
  workspaceId: string;
  projectKey: string;
  /** The design card the tool publishes onto. */
  publishedKey: string;
  publishedTitle: string;
  /** A second design card, left with nothing — the panel's empty state. */
  emptyKey: string;
  emptyTitle: string;
  /** A token holding EXACTLY `CLI_TOKEN_GRANT`, and nothing more. */
  token: string;
}

/** The note SECTIONS a design card publishes — not the whole area file.
 *
 * ⚠️ THE HEADING SHARES NO WORDS WITH EITHER CARD TITLE, and that is a rule
 * rather than a style choice: `getByRole` matches an accessible name by
 * SUBSTRING, so a note heading of "Readiness rail" under a card titled "Design
 * the readiness rail…" resolves to TWO headings and dies on a strict-mode
 * violation — not on anything the spec is about. (It did, on the first run.) */
export const NOTE_HEADING = 'Composition and spacing';
export const NOTE_BODY = 'Each open blocker gets one chip, with its status beside it.';
export const NOTE_MD = [
  `## ${NOTE_HEADING}`,
  '',
  NOTE_BODY,
  '',
  'It composes `Pill` for each blocker and routes colour through `--el-*` only.',
].join('\n');

export const MOCK_SOURCE_PATH = 'design/work-items/readiness-rail.mock.html';
export const IMAGE_SOURCE_PATH = 'design/work-items/readiness-rail.png';
export const NOTE_SOURCE_PATH = 'design/work-items/design-notes.md';

/** A self-contained mock — inline CSS, no `<script>`, no remote URL (ADR §5). */
export const MOCK_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Readiness rail</title>
<style>body{margin:0;font:14px/1.5 system-ui,sans-serif}section{padding:20px}</style>
</head><body><section><h2>Readiness rail</h2><p>Published by the agent, through the tool.</p></section></body></html>`;

/** A 1x1 PNG — a real image rather than a broken-image glyph in the recording. */
export const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// ⚠️ Deliberately NOT a substring of one another, and not of any heading the
// page renders: `getByRole` matches an accessible name by SUBSTRING, so an
// overlap dies on a strict-mode violation rather than on anything real.
const STORY_TITLE = 'Ship the blocker rail on the work-item page';
const PUBLISHED_TITLE = 'Design the readiness rail for a blocked card';
const EMPTY_TITLE = 'Draw the sprint burndown header';

export async function seedDesignPublish(
  email: string,
  projectKey = 'RAIL',
): Promise<DesignPublishSeed> {
  const owner = await createTestPerson({
    email,
    password: DESIGN_PUBLISH_PASSWORD,
    name: 'Robin Vale',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Design Publish E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: `Rail ${projectKey}`,
    identifier: projectKey,
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });

  const ctx = { userId: owner.id, workspaceId: workspace.id };

  // A design result attaches to the LEAF that produced it (ADR §3), and a
  // subtask needs a parent — so the story is scaffolding, not a subject.
  const story = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: STORY_TITLE },
    ctx,
  );
  const published = await workItemsService.createWorkItem(
    {
      projectId: project.id,
      kind: 'subtask',
      title: PUBLISHED_TITLE,
      parentId: story.id,
      type: 'design',
    },
    ctx,
  );
  const empty = await workItemsService.createWorkItem(
    {
      projectId: project.id,
      kind: 'subtask',
      title: EMPTY_TITLE,
      parentId: story.id,
      type: 'design',
    },
    ctx,
  );

  // ⚠️ THE GRANT COMES FROM THE EXPORTED CONSTANT, never re-listed. This is what
  // makes the spec evidence about the door a DISPATCHED RUN comes through
  // rather than about a broadly-granted workspace token — and a later narrowing
  // of `CLI_TOKEN_GRANT` fails the journey instead of silently un-shipping it.
  const minted = await apiTokensService.create(owner.id, workspace.id, {
    label: 'design-publish-e2e',
    projectId: project.id,
    permissions: [...CLI_TOKEN_GRANT],
  });

  return {
    email,
    password: DESIGN_PUBLISH_PASSWORD,
    workspaceId: workspace.id,
    projectKey: project.identifier,
    publishedKey: published.identifier,
    publishedTitle: PUBLISHED_TITLE,
    emptyKey: empty.identifier,
    emptyTitle: EMPTY_TITLE,
    token: minted.token,
  };
}
