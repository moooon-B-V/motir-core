// E2E fixture for the MOTIR-7582 acceptance receipt ("Motir's warm touches").
//
// Mirrors the attachments-seed shape: the user signs up through the real browser
// UI (shell-session signUp — the page needs a live session, and an account that
// has never touched Appearance is exactly the "never chose a palette" reader the
// story is about) and creates the project through the switcher's create door,
// which pins it active. Then, server-side via the sanctioned test cross-layer
// reach, the three cards whose type hues the story re-colours are minted through
// the real service: an Epic, a Story under it, and a `design`-typed leaf under
// the Story.

import { expect, type Page } from '@playwright/test';
import { db } from './db-reset';
import { createFirstProject, signUp } from './shell-session';
import { workItemsService } from '@/lib/services/workItemsService';

export interface WarmTouchesCard {
  identifier: string;
  title: string;
}

export interface WarmTouchesFixture {
  projectIdentifier: string;
  epic: WarmTouchesCard;
  story: WarmTouchesCard;
  design: WarmTouchesCard;
}

const PROJECT_NAME = 'Warm touches';

/**
 * Browser sign-up + first project, then the Epic → Story → Design leaf chain.
 * Leaves the page signed in with the project active and NO appearance
 * preference saved.
 */
export async function seedWarmTouchesFixture(
  page: Page,
  email: string,
): Promise<WarmTouchesFixture> {
  await signUp(page, email);
  await createFirstProject(page, PROJECT_NAME);

  const local = email.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'user exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();
  // Bound to the project the browser is in, by name — a default project is also
  // seeded per workspace (MOTIR-4870), so an unordered read could pick that one.
  const project = await db.project.findFirst({
    where: { workspaceId: ws!.id, name: PROJECT_NAME },
  });
  expect(project, 'first project exists').not.toBeNull();

  const ctx = { userId: user!.id, workspaceId: ws!.id };
  const epic = await workItemsService.createWorkItem(
    { projectId: project!.id, kind: 'epic', title: 'Checkout redesign' },
    ctx,
  );
  const story = await workItemsService.createWorkItem(
    { projectId: project!.id, kind: 'story', title: 'Pay in one tap', parentId: epic.id },
    ctx,
  );
  const design = await workItemsService.createWorkItem(
    {
      projectId: project!.id,
      kind: 'task',
      type: 'design',
      title: 'Draw the one-tap sheet',
      parentId: story.id,
    },
    ctx,
  );

  const card = (dto: { identifier: string; title: string }): WarmTouchesCard => ({
    identifier: dto.identifier,
    title: dto.title,
  });
  return {
    projectIdentifier: project!.identifier,
    epic: card(epic),
    story: card(story),
    design: card(design),
  };
}
