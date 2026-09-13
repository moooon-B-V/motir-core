import type { GithubRepo } from '@/generated/prisma/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import enMessages from '@/messages/en.json';
import { db } from '@/lib/db';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { derivePrMergeModeDefault } from '@/lib/projects/prMergeModeDefault';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { codeGraphIndexService } from '@/lib/services/codeGraphIndexService';
import { projectPrMergeModeService } from '@/lib/services/projectPrMergeModeService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectsService } from '@/lib/services/projectsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { ToastProvider } from '@/components/ui/Toast';
import { PrMergeModeCard } from '@/app/(authed)/settings/project/approvals/_components/PrMergeModeCard';
import { createTestProject } from '../fixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { organizationIdOf } from '../helpers/organizationOf';
import { randomToken } from '../helpers/random';

// STORY VITEST GATE — Story MOTIR-4880 · MOTIR-5182. The seams BETWEEN the story's
// cards, against real Postgres, plus the arms a per-card unit could not reach.
//
// Already pinned by the cards themselves, and deliberately NOT repeated here:
//   - the backfill on a POPULATED database and the deployed type's two members —
//     `tests/project-pr-merge-mode-backfill.test.ts`;
//   - the provenance MATRIX through the real establishment seams, all five cases
//     (all-hosted, imported, MIXED, empty, `hostOwner: null`) —
//     `tests/projectRepos/prMergeModeEstablishment.test.ts`;
//   - the manage-only read and write, and the retired value refused —
//     `tests/projectRepos/prMergeModeReadWrite.test.ts`,
//     `tests/settings/pr-merge-mode-route.test.ts`.
//
// What only this file asserts:
//   1. ESTABLISH → ProjectDTO → CONTROL: the value the room renders is the value
//      establishment persisted, through the real mapper and the real card.
//   2. THE TIER: a write to one project leaves its sibling in the same workspace
//      exactly where it was.
//   3. The two defensive arms of the service — a project deleted between the
//      permission check and the read, and a seed that loses the race to a
//      person's decision — and the derivation's row-without-a-mirror arm.

const HOST = 'motir-projects';

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('GITHUB_FALLBACK_ORG', HOST);
  vi.spyOn(codeGraphIndexService, 'enqueueFirstIndexForRepos').mockResolvedValue();
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function repoOwnedBy(owner: string, name: string): Promise<GithubRepo> {
  const installationId = `inst-${fx.workspaceId}-${owner}`;
  const organizationId = await organizationIdOf(fx.workspaceId);
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      workspaceId: fx.workspaceId,
      organizationId,
      accountLogin: owner,
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  return adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId,
      repoId: `${name}-${randomToken(8)}`,
      owner,
      name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
}

/** Establish the fixture project with one repository Motir hosts. */
async function establishHosted(): Promise<void> {
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role: 'web', name: 'web' },
    fx.ctx,
  );
  await projectRepoSetService.markCreating(row.id, fx.ctx);
  await projectRepoSetService.attachRealizedRepo(
    row.id,
    (await repoOwnedBy(HOST, 'web')).id,
    fx.ctx,
  );
}

/** The card as the room's page renders it, to static markup. */
function renderControl(projectKey: string, initialMode: 'auto' | 'manual'): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ToastProvider>
        <PrMergeModeCard projectKey={projectKey} initialMode={initialMode} />
      </ToastProvider>
    </NextIntlClientProvider>,
  );
}

/** The `aria-checked` of the option carrying `label`, read from markup. */
function checkedOf(html: string, label: string): string | null {
  const buttons = html.match(/<button[^>]*role="radio"[^>]*>[\s\S]*?<\/button>/g) ?? [];
  const hit = buttons.find((b) => b.includes(label));
  return hit?.match(/aria-checked="(true|false)"/)?.[1] ?? null;
}

describe('ESTABLISH → ProjectDTO → the control', () => {
  it('the room renders the value establishment persisted, through the real DTO and card', async () => {
    await establishHosted();

    const dto = await projectsService.getByKey(fx.projectIdentifier, fx.ctx);
    expect(dto.prMergeMode, 'an all-hosted set seeds auto').toBe('auto');
    const read = await projectPrMergeModeService.getPrMergeMode(fx.projectId, fx.ctx);
    expect(read.prMergeMode).toBe(dto.prMergeMode);

    const html = renderControl(dto.identifier, read.prMergeMode);
    expect(checkedOf(html, 'Merge automatically')).toBe('true');
    expect(checkedOf(html, 'Ask before merging')).toBe('false');
  });

  it('CONTROL: an unestablished project renders the manual floor, so the case above is not a default', async () => {
    const dto = await projectsService.getByKey(fx.projectIdentifier, fx.ctx);
    expect(dto.prMergeMode).toBe('manual');
    const html = renderControl(dto.identifier, dto.prMergeMode);
    expect(checkedOf(html, 'Ask before merging')).toBe('true');
  });
});

describe('THE TIER — two projects in one workspace', () => {
  it('writing one leaves the other untouched, and each read returns its own', async () => {
    const second = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ctx.userId,
      identifier: 'TWIN',
    });
    await projectPrMergeModeService.setPrMergeMode(second.id, 'auto', fx.ctx);
    const before = await adminDb.project.findUniqueOrThrow({ where: { id: second.id } });

    await projectPrMergeModeService.setPrMergeMode(fx.projectId, 'manual', fx.ctx);
    await projectPrMergeModeService.setPrMergeMode(fx.projectId, 'auto', fx.ctx);
    await projectPrMergeModeService.setPrMergeMode(fx.projectId, 'manual', fx.ctx);

    const after = await adminDb.project.findUniqueOrThrow({ where: { id: second.id } });
    expect(after.prMergeMode).toBe('auto');
    expect(after.prMergeModeDecidedAt).toEqual(before.prMergeModeDecidedAt);
    expect((await projectPrMergeModeService.getPrMergeMode(fx.projectId, fx.ctx)).prMergeMode).toBe(
      'manual',
    );
    expect((await projectPrMergeModeService.getPrMergeMode(second.id, fx.ctx)).prMergeMode).toBe(
      'auto',
    );
  });
});

describe('the defensive arms', () => {
  it('a project gone between the permission check and the read is ProjectNotFoundError', async () => {
    vi.spyOn(projectRepository, 'findPrMergeMode').mockResolvedValueOnce(null);
    await expect(
      projectPrMergeModeService.getPrMergeMode(fx.projectId, fx.ctx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('a seed that writes no row (a decision landed first) answers null', async () => {
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'web' },
      fx.ctx,
    );
    const repo = await repoOwnedBy(HOST, 'web');
    await adminDb.projectRepo.update({
      where: { id: row.id },
      data: { state: 'created', githubRepoId: repo.id },
    });
    vi.spyOn(projectRepository, 'seedPrMergeModeIfUndecided').mockResolvedValueOnce(0);

    const seeded = await withWorkspaceContext(
      { userId: fx.ctx.userId, workspaceId: fx.workspaceId, projectId: fx.projectId },
      (tx) => projectPrMergeModeService.seedAtEstablishment(fx.projectId, fx.workspaceId, tx, HOST),
    );
    expect(seeded).toBeNull();
  });

  it('a settled row with no repository mirror is not hosted, so the set seeds manual', () => {
    expect(
      derivePrMergeModeDefault(
        [
          { state: 'created', githubRepo: { owner: HOST } },
          { state: 'created', githubRepo: null },
        ],
        HOST,
      ),
    ).toBe('manual');
  });
});
