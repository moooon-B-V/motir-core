import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The PRODUCER seam of code-aware planning (Subtask 7.10.15 · MOTIR-1598): a
// planning-job submit resolves the workspace's connected repo SET from the
// persisted installation grant mirror (7.10.3) and carries it on the envelope
// as `context.code.repos[]` — the cross-repo contract with motir-ai's
// multi-repo reads (7.10.16 · MOTIR-1599). Real Postgres (the motir-core
// convention): seed a workspace + project + installation grants for real; mock
// ONLY the boundary client (no network). Exact-shape assertions per the
// seam-test convention — the ABSENT case must leave the envelope byte-identical
// to today's (no `code` key, not an empty one).
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
}));

import { db } from '@/lib/db';
import { submitJob } from '@/lib/ai/motirAiClient';
import { resolveCodeContext } from '@/lib/ai/codeContext';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { truncateAuthTables } from '../helpers/db';
import type { ProjectContext } from '@/lib/projects';

const PASSWORD = 'hunter2hunter2';

async function seedProjectContext(): Promise<ProjectContext> {
  const user = await usersService.createUser({
    email: 'code-ctx@example.com',
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Alpha',
    identifier: 'ALPHA',
  });
  return {
    userId: user.id,
    workspaceId: workspace.id,
    projectId: project.id,
    project,
  };
}

/** The Motir-shaped grant: ONE workspace (one product), FOUR connected repos. */
const FOUR_REPOS = [
  { providerRepoId: '101', owner: 'moooon', name: 'motir-core', defaultBranch: 'main' },
  { providerRepoId: '102', owner: 'moooon', name: 'motir-ai', defaultBranch: 'main' },
  { providerRepoId: '103', owner: 'moooon', name: 'motir-gateway', defaultBranch: 'master' },
  { providerRepoId: '104', owner: 'moooon', name: 'motir-meta', defaultBranch: 'main' },
];

beforeEach(async () => {
  await truncateAuthTables();
  vi.mocked(submitJob).mockReset();
  vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_code_1' });
});

afterAll(async () => {
  await db.$disconnect();
});

describe('resolveCodeContext', () => {
  it('resolves EVERY granted repo of the workspace installation, stable-ordered', async () => {
    const ctx = await seedProjectContext();
    await githubInstallationService.persistInstallation({
      workspaceId: ctx.workspaceId,
      installation: {
        installationId: 'inst-1',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: FOUR_REPOS,
    });

    const code = await resolveCodeContext({ userId: ctx.userId, workspaceId: ctx.workspaceId });

    // Exact shape — the contract with the 7.10.16 consumer. A 4-repo workspace
    // produces 4 entries (owner asc, name asc — the mirror's display order).
    expect(code).toEqual({
      repos: [
        { provider: 'github', repoRef: 'moooon/motir-ai', defaultBranch: 'main' },
        { provider: 'github', repoRef: 'moooon/motir-core', defaultBranch: 'main' },
        { provider: 'github', repoRef: 'moooon/motir-gateway', defaultBranch: 'master' },
        { provider: 'github', repoRef: 'moooon/motir-meta', defaultBranch: 'main' },
      ],
    });
  });

  it('resolves undefined when the workspace has no installation', async () => {
    const ctx = await seedProjectContext();
    const code = await resolveCodeContext({ userId: ctx.userId, workspaceId: ctx.workspaceId });
    expect(code).toBeUndefined();
  });

  it('resolves undefined when the installation has no granted repos', async () => {
    const ctx = await seedProjectContext();
    await githubInstallationService.persistInstallation({
      workspaceId: ctx.workspaceId,
      installation: {
        installationId: 'inst-2',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [],
    });
    const code = await resolveCodeContext({ userId: ctx.userId, workspaceId: ctx.workspaceId });
    expect(code).toBeUndefined();
  });
});

describe('aiGenerationService.startGeneration — the context.code envelope seam', () => {
  it('carries context.code.repos[] on the generate_tree envelope when an installation exists', async () => {
    const ctx = await seedProjectContext();
    await githubInstallationService.persistInstallation({
      workspaceId: ctx.workspaceId,
      installation: {
        installationId: 'inst-3',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: FOUR_REPOS,
    });

    await aiGenerationService.startGeneration(ctx, { prompt: 'extend the tracker' });

    const [jobKind, , context] = vi.mocked(submitJob).mock.calls[0]!;
    expect(jobKind).toBe('generate_tree');
    // The WHOLE context bag, exact shape (the read-back seam-test convention):
    // the code set rides beside the existing fields, nothing else drifts.
    expect(context).toEqual({
      prompt: 'extend the tracker',
      generateExplanations: false,
      code: {
        repos: [
          { provider: 'github', repoRef: 'moooon/motir-ai', defaultBranch: 'main' },
          { provider: 'github', repoRef: 'moooon/motir-core', defaultBranch: 'main' },
          { provider: 'github', repoRef: 'moooon/motir-gateway', defaultBranch: 'master' },
          { provider: 'github', repoRef: 'moooon/motir-meta', defaultBranch: 'main' },
        ],
      },
    });
  });

  it('OMITS context.code entirely when the workspace has no installation (byte-identical envelope)', async () => {
    const ctx = await seedProjectContext();

    await aiGenerationService.startGeneration(ctx, { prompt: 'start fresh' });

    const [jobKind, , context] = vi.mocked(submitJob).mock.calls[0]!;
    expect(jobKind).toBe('generate_tree');
    // Exact shape: today's envelope, with NO `code` key (absent, not empty).
    expect(context).toEqual({ prompt: 'start fresh', generateExplanations: false });
    expect(Object.keys(context as object)).not.toContain('code');
  });
});
