import { test, expect } from './_helpers/acceptance-video';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { seedProjectAccess, type ProjectAccessSeed } from './_helpers/project-access-seed';
import {
  acceptInvite,
  addPerson,
  editTitle,
  expectNotFound,
  expectPalette,
  expectSwitcher,
  inviteLimited,
  makeMembersOnly,
  signInAs,
  switchProject,
} from './_helpers/project-access-flows';

// ACCESS LIVES ON THE PROJECT — THE ACCEPTANCE RECEIPT (Story MOTIR-6169 ·
// Subtask MOTIR-6553). The story's verification recipe, in a real browser
// against a production build and a real database, recorded and PACED for a
// person to watch.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A Manager invites a contractor as a LIMITED member into one project, Atlas.
// The contractor accepts, and their whole world is Atlas: the project switcher
// and ⌘K list nothing else, another project's address is not-found, and an edit
// inside Atlas saves. Then the Manager makes Cobalt MEMBERS ONLY — the confirm
// names the Full members who lose access — and adds one of them back. A Full
// member who was not added finds Cobalt gone.
//
// The pacing holds (`beat()`) sit on each result a reviewer must see: the
// one-project switcher, the not-found page, the saved edit, the confirm, and the
// project vanishing. Every other wait is an authoritative signal — see
// `_helpers/project-access-flows.ts`. The unrecorded states (the no-project
// shell, a Member's settings, the 0-people confirm, a failed save) are in
// `project-access-contractor.spec.ts`.

let seed: ProjectAccessSeed;

test.beforeEach(async () => {
  await resetDatabase();
  seed = await seedProjectAccess(`pa${Date.now().toString(36)}`);
});

test('a Limited contractor sees only their project, and a project switched to Members only disappears for a Full member not added', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-6169');
  test.setTimeout(300_000);
  let token = '';

  await chapter('The Manager invites a contractor as Limited, into Atlas only', async () => {
    await signInAs(page, seed.manager.email);
    token = await inviteLimited(page, seed, seed.atlas.name);
    await beat();
  });

  await chapter('The contractor accepts — and their world is Atlas', async () => {
    await signInAs(page, seed.contractor.email);
    await acceptInvite(page, token);
    await expect(page.getByRole('button', { name: 'Switch project' })).toContainText(
      seed.atlas.name,
    );
    await expectSwitcher(page, [seed.atlas.name], [seed.borealis.name, seed.cobalt.name]);
    await beat();
    await expectPalette(page, '', [seed.atlas.name], [seed.borealis.name, seed.cobalt.name]);
    await beat();
  });

  await chapter('Borealis is not-found; an edit inside Atlas saves', async () => {
    await expectNotFound(page, `/items/${seed.borealis.itemKey}`);
    await beat();
    const item = await adminDb.workItem.findFirstOrThrow({ where: { projectId: seed.atlas.id } });
    await editTitle(page, seed.atlas.itemKey, item.id, 'Draft the atlas intro — v2');
    await page.goto(`/items/${seed.atlas.itemKey}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Draft the atlas intro — v2',
    );
    await beat();
  });

  await chapter('The Manager makes Cobalt Members only, and adds Kai back', async () => {
    await signInAs(page, seed.manager.email);
    await switchProject(page, seed.cobalt.name);
    await makeMembersOnly(page, seed.cobalt.name, [seed.fran.name, seed.kai.name]);
    await beat();
    await addPerson(page, seed.kai.name);
    await beat();
  });

  await chapter('Fran, Full and not added, finds Cobalt gone', async () => {
    await signInAs(page, seed.fran.email);
    await expectSwitcher(page, [seed.atlas.name, seed.borealis.name], [seed.cobalt.name]);
    await beat();
    await expectNotFound(page, `/items/${seed.cobalt.itemKey}`);
    await beat();
  });
});
