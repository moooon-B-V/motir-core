import { adminDb } from '@/tests/helpers/adminDb';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import { CUSTOM_ROLE_TIER } from '@/lib/permissions/builtinRoles';
import { createTestPerson } from './testPerson';
import { addToProjectAs, setProjectRoleDefinitionFor } from '../../helpers/workspaceRoleFixtures';

// THE SEED FOR *A PERSON WRITES HOW TO TEST* (Story MOTIR-5450 · Subtask
// MOTIR-5457) — the acceptance receipt's world, and deliberately a SMALL one.
//
// ⚠️ NO PULL REQUEST, NO REPOSITORY, NO DISPATCH RUN. That is the point of the
// story rather than a shortcut: `approval-gates.md` §9's 2026-09-17 amendment
// exists for a team that keeps its pull requests on the host and its work items
// here, and the whole claim is that such a team can still write testing
// instructions. A seed that linked one would be testing the easy case.
//
// It seeds three things, one per thing the clip has to show:
//
//   * a WRITER — the owner, who holds `work_item:edit` and gets the doors;
//   * a VIEWER on a CUSTOM role carrying `project:browse` and nothing else, so
//     the no-door assertion is about the PERMISSION rather than about a built-in
//     role somebody might widen later;
//   * a STORY with a CHILD, and a record on the story, so the child can show its
//     *Tested as part of* pointer and no door of its own.
//
// Everything goes through a service. Nothing here is a row the product would
// not have written itself.

export const PERSON_HOW_TO_TEST_PASSWORD = 'person-how-to-test-e2e-pass-3';

/** The card the person writes on: no record, no pull request, nothing. */
export const BLANK_TITLE = 'Throttle the public API end to end';
/** The story whose child points at it — it carries a record from the start. */
export const PARENT_TITLE = 'Rate-limit the public API per key';
export const CHILD_TITLE = 'The limiter middleware';

/** The body the clip types is SHORT — a viewer watches it appear. */
export const TYPED_HEADING = 'Click-path';
export const TYPED_STEP = 'Sign in and open Settings → API keys.';
/** The fence whose LANGUAGE has to survive the round trip (MOTIR-5458). */
export const TYPED_LANGUAGE = 'sh';
export const TYPED_COMMAND = 'pnpm dev';
export const TYPED_PREVIEW_PATH = '/settings/api-keys';
/** The line the EDIT adds, so *Earlier versions (1)* has something to be about. */
export const EDITED_STEP = 'Then copy the seeded key.';

const PARENT_RECORD_BODY = [
  '## Precondition',
  '',
  'Sign in as a workspace member.',
  '',
  '## Click-path',
  '',
  '1. Open the limiter settings.',
].join('\n');

export interface PersonHowToTestSeed {
  /** The WRITER — holds `work_item:edit`. */
  email: string;
  password: string;
  ownerName: string;
  /** The VIEWER — `project:browse` on a custom role, and nothing else. */
  viewerEmail: string;
  viewerPassword: string;
  /** The card with nothing on it, which the clip writes How to test onto. */
  blank: { id: string; identifier: string; title: string };
  /** A story carrying a record, and its child, for the pointer case. */
  parent: { id: string; identifier: string; title: string };
  child: { id: string; identifier: string; title: string };
  workspaceId: string;
  projectId: string;
  projectKey: string;
  ownerId: string;
}

export async function seedPersonHowToTest(slug: string): Promise<PersonHowToTestSeed> {
  const email = `phtt-owner-${slug}@example.com`;
  const owner = await createTestPerson({
    email,
    password: PERSON_HOW_TO_TEST_PASSWORD,
    name: 'Ada Lovelace',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'A person writes How to test',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Public API',
    identifier: 'PHTT',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  const ctx = { userId: owner.id, workspaceId: workspace.id };

  // ── THE CARD THE CLIP WRITES ON ─────────────────────────────────────────
  // A task with no pull request and no record. The Development block therefore
  // shows the *no run has written how to test* callout, which is where the
  // **Add how to test** door lives (§24 panel 13a, decision 1).
  const blank = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: BLANK_TITLE },
    ctx,
  );

  // ── THE STORY AND ITS CHILD ─────────────────────────────────────────────
  // The record sits on the STORY, so the child resolves `tested_via_ancestor`
  // and draws its pointer. It is published through the same `publish` a person's
  // save lands on, with `attributeToRunningDispatch` left false — so it is a
  // PERSON's record, and the child's pointer is not incidentally testing an
  // agent path.
  const parent = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: PARENT_TITLE },
    ctx,
  );
  const child = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'subtask', title: CHILD_TITLE, parentId: parent.id },
    ctx,
  );
  await testInstructionsService.publish(
    { workItemId: parent.id, bodyMd: PARENT_RECORD_BODY, attributeToRunningDispatch: false },
    ctx,
  );

  // ── THE VIEWER ──────────────────────────────────────────────────────────
  // A CUSTOM role, not a built-in one: the claim is that the doors are gated on
  // `work_item:edit`, and a built-in role could be widened later without this
  // assertion noticing.
  const viewerEmail = `phtt-viewer-${slug}@example.com`;
  const viewer = await createTestPerson({
    email: viewerEmail,
    password: PERSON_HOW_TO_TEST_PASSWORD,
    name: 'Vera Viewer',
  });
  await workspacesService.addMember({ userId: viewer.id, workspaceId: workspace.id });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: viewer.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  await addToProjectAs({
    key: project.identifier,
    actorUserId: owner.id,
    ctx,
    targetUserId: viewer.id,
    role: 'member',
  });
  const role = await adminDb.workspaceRoleDefinition.create({
    data: {
      workspaceId: workspace.id,
      name: 'Reader',
      permissions: ['project:browse', 'comment:add'],
    },
  });
  await adminDb.$transaction((tx) =>
    setProjectRoleDefinitionFor(
      viewer.id,
      project.id,
      { roleDefinitionId: role.id, role: CUSTOM_ROLE_TIER },
      tx,
    ),
  );

  return {
    email,
    password: PERSON_HOW_TO_TEST_PASSWORD,
    ownerName: owner.name,
    viewerEmail,
    viewerPassword: PERSON_HOW_TO_TEST_PASSWORD,
    blank: { id: blank.id, identifier: blank.identifier, title: BLANK_TITLE },
    parent: { id: parent.id, identifier: parent.identifier, title: PARENT_TITLE },
    child: { id: child.id, identifier: child.identifier, title: CHILD_TITLE },
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
    ownerId: owner.id,
  };
}
