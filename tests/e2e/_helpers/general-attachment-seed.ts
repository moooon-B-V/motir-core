import { db } from '@/lib/db';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { createTestPerson } from './testPerson';

// Fixture for the GENERAL attachment door's journey (Story MOTIR-3000 ·
// Subtask MOTIR-3061).
//
// ⚠️ Seeded through the SERVICES rather than driven through the browser, and
// the reason is the point of the card: what this story adds is a path a browser
// does not have. Signing a person in to create the work item would prove
// nothing about it — the upload under test is the one an AGENT makes, with a
// bearer token and no session at all. The browser arrives afterwards, as the
// REVIEWER, which is the whole claim: the deliverable is on the card before
// anyone opens a pull request.
//
// The UPLOAD itself is NOT seeded. Unlike `design-result-seed.ts`, which must
// insert its rows directly because the register endpoint `head`s the object
// store from the server, this door's route takes the bytes in the request and
// the E2E server runs with `E2E_TEST_BLOB=1` — so the real route, the real
// gates and the real row write are all reachable, and the spec drives them.

export const GENERAL_ATTACHMENT_PASSWORD = 'general-door-e2e-pass-7';

export interface GeneralAttachmentSeed {
  email: string;
  password: string;
  workspaceId: string;
  projectKey: string;
  /** The work item the deliverable lands on. */
  itemKey: string;
  itemTitle: string;
  /** A PAT holding exactly what the door asserts, and nothing more. */
  token: string;
}

/** A findings document — the deliverable class that had no path before. */
export const FINDINGS_MARKDOWN = [
  '# Ranking spike — findings',
  '',
  'Three candidate orderings were measured against the 120-row fixture.',
  'The lexicographic key wins on every read and costs one index.',
].join('\n');

export const FINDINGS_FILENAME = 'ranking-findings.md';

// ⚠️ Deliberately NOT a substring of the filename or of any heading the page
// renders: `getByRole` matches an accessible name by SUBSTRING, and an overlap
// dies on a strict-mode violation rather than on anything real.
const ITEM_TITLE = 'Spike: choose a ranking key for the ready set';

/**
 * @param projectKey the project's identifier. ⚠️ A SECOND tenant must be given a
 * DIFFERENT one: a work-item key names its project by prefix, so two workspaces
 * both keyed `SRCH` each own a real `SRCH-1`, and a "cross-tenant" probe would
 * quietly resolve the CALLER's own item and succeed. That is not a leak — it is
 * the key namespace working — but it makes the refusal untestable.
 */
export async function seedGeneralAttachment(
  email: string,
  projectKey = 'SRCH',
): Promise<GeneralAttachmentSeed> {
  const owner = await createTestPerson({
    email,
    password: GENERAL_ATTACHMENT_PASSWORD,
    name: 'Robin Vale',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'General Door E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: `Search ${projectKey}`,
    identifier: projectKey,
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });

  const item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: ITEM_TITLE },
    { userId: owner.id, workspaceId: workspace.id },
  );

  // Exactly what the door asserts — so a green run is evidence about THIS
  // permission rather than about a broadly-granted token.
  const minted = await apiTokensService.create(owner.id, workspace.id, {
    label: 'general-attachment-e2e',
    projectId: project.id,
    permissions: ['project:browse', 'work_item:edit'],
  });

  return {
    email,
    password: GENERAL_ATTACHMENT_PASSWORD,
    workspaceId: workspace.id,
    projectKey: project.identifier,
    itemKey: item.identifier,
    itemTitle: ITEM_TITLE,
    token: minted.token,
  };
}
