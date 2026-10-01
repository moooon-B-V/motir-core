import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import {
  AgentImageCatalogUnavailableError,
  AgentInstanceNotFoundError,
  AgentInstanceRunActiveError,
  AgentInstanceStateConflictError,
  AgentInstanceUpToDateError,
} from '@/lib/agentInstances/errors';
import {
  FAKE_BASE_VERSION,
  fakeDigestFor,
  imageCatalog,
  imageCatalogSeam,
} from '@/lib/agentInstances/imageCatalog';
import { pinnedImageReference } from '@/lib/agentInstances/imageDigest';
import {
  AGENT_LIVENESS_COMMANDS,
  OFFERED_AGENT_PROFILES,
  sandboxImageTag,
} from '@/lib/agentInstances/profiles';
import { isLegalTransition, RUNNING_STATES } from '@/lib/agentInstances/stateMachine';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import { agentInstanceSweepService as sweeper } from '@/lib/services/agentInstanceSweepService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { adminDb } from '../helpers/adminDb';
import {
  MIN,
  clock,
  fleet,
  fx,
  intervals,
  otherMember,
  setUpHarness,
  slots,
  tearDownHarness,
} from './_harness';

// UPDATE AN AGENT TO A NEWER SANDBOX IMAGE (Story MOTIR-6862 · MOTIR-6952,
// `docs/decisions/agent-image-update.md` Q2–Q8) — over the real services and a
// real Postgres, on the FAKE persistent fleet, with the catalog's fake-fleet
// stand-in naming every agent's create-time digest `FAKE_BASE_VERSION` and a test
// making 1.1.0 the newest.
//
// ⚠️ THE VOLUME IS THE ASSERTION THAT MATTERS on every branch: the same volume
// id before and after, whatever the update did.

const session = { user: null as { id: string; email: string } | null };
const ctxRef = { current: null as WorkspaceContext | null };
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => (session.user ? { user: session.user } : null)),
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => ctxRef.current,
}));
const updateRoute = await import('@/app/api/projects/[key]/instances/[id]/update/route');

const NEW = '1.1.0';
const NEW_DIGEST = fakeDigestFor('claude', NEW);
const BASE_DIGEST = fakeDigestFor('claude', FAKE_BASE_VERSION);
const ref = (digest: string) => pinnedImageReference(sandboxImageTag('claude'), digest);

beforeEach(async () => {
  await setUpHarness();
  imageCatalogSeam.reset();
  const user = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ownerId } });
  session.user = { id: user.id, email: user.email };
  ctxRef.current = { userId: user.id, workspaceId: fx.workspaceId } as WorkspaceContext;
});
afterEach(async () => {
  imageCatalogSeam.reset();
  await tearDownHarness();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function agent(name = 'yue-claude') {
  const dto = await lifecycle.create(fx.projectIdentifier, { name, profileId: 'claude' }, fx.ctx);
  return adminDb.agentInstance.findUniqueOrThrow({ where: { id: dto.id } });
}
const row = (id: string) => adminDb.agentInstance.findUniqueOrThrow({ where: { id } });
const update = (id: string) => lifecycle.update(fx.projectIdentifier, id, fx.ctx);

describe('a RUNNING agent (Q2, Q3, Q7)', () => {
  it('moves to the newest image on the same machine and volume, and comes back running on it', async () => {
    const a = await agent();
    expect(a).toMatchObject({ state: 'running', imageDigest: BASE_DIGEST, imageVersion: '1.0.0' });
    const before = await intervals();
    imageCatalogSeam.setFakeNewest('claude', NEW);

    const dto = await update(a.id);

    expect(dto).toMatchObject({
      state: 'running',
      imageDigest: NEW_DIGEST,
      imageVersion: NEW,
      update: null,
      pendingImageVersion: null,
      updateFailureReason: null,
    });
    const after = await row(a.id);
    expect(after).toMatchObject({
      machineId: a.machineId,
      volumeId: a.volumeId,
      targetImageDigest: null,
      targetImageVersion: null,
    });
    expect(fleet.machineImage(a.machineId!)).toBe(ref(NEW_DIGEST));
    expect(fleet.liveVolumeIds()).toEqual([a.volumeId]);
    // Q7: the open interval and its slot are kept — nothing closed, nothing opened.
    const now = await intervals();
    expect(now.map((i) => i.id)).toEqual(before.map((i) => i.id));
    expect(now[0]!.endedAt).toBeNull();
    expect(await slots()).toHaveLength(1);
  });

  it('rolls back to the old image when the new one fails its liveness check, saying why', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    fleet.markImageFailing(ref(NEW_DIGEST));

    const dto = await update(a.id);

    expect(dto.state).toBe('running');
    expect(dto.imageDigest).toBe(BASE_DIGEST);
    expect(dto.imageVersion).toBe('1.0.0');
    expect(dto.updateFailureReason).toBe(
      'The update to 1.1.0 didn’t work: claude --version exited 127 (command not found). ' +
        'Your agent is back on 1.0.0.',
    );
    // The update is still offered: a fixed release can be tried again.
    expect(dto.update).toEqual({ version: NEW, digest: NEW_DIGEST });
    expect(fleet.machineImage(a.machineId!)).toBe(ref(BASE_DIGEST));
    expect(fleet.liveVolumeIds()).toEqual([a.volumeId]);
    expect((await row(a.id)).targetImageDigest).toBeNull();
  });

  it('a move the provider refuses leaves the agent running on its old image, with the refusal in words', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    fleet.failNextMove('version mismatch');
    const dto = await update(a.id);
    expect(dto).toMatchObject({ state: 'running', imageDigest: BASE_DIGEST });
    expect(dto.updateFailureReason).toContain('version mismatch');
    expect(fleet.machineImage(a.machineId!)).toBe(ref(BASE_DIGEST));
  });

  it('a later successful update clears the last failure', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    fleet.markImageFailing(ref(NEW_DIGEST));
    await update(a.id);
    imageCatalogSeam.setFakeNewest('claude', '1.2.0');
    const dto = await update(a.id);
    expect(dto).toMatchObject({ imageVersion: '1.2.0', updateFailureReason: null });
  });
});

describe('a HIBERNATED agent (Q5)', () => {
  async function hibernated() {
    const a = await agent();
    await lifecycle.hibernate(fx.projectIdentifier, a.id, fx.ctx);
    expect((await row(a.id)).state).toBe('hibernated');
    return a;
  }

  it('stays hibernated with the target recorded, its machine untouched; the next wake applies it', async () => {
    const a = await hibernated();
    imageCatalogSeam.setFakeNewest('claude', NEW);

    const dto = await update(a.id);
    expect(dto).toMatchObject({
      state: 'hibernated',
      imageDigest: BASE_DIGEST,
      pendingImageVersion: NEW,
    });
    expect(await row(a.id)).toMatchObject({
      targetImageDigest: NEW_DIGEST,
      targetImageVersion: NEW,
    });
    expect(fleet.machineImage(a.machineId!)).toBe(ref(BASE_DIGEST));
    expect((await fleet.describePersistent({ ...handleOf(a) })).state).toBe('stopped');

    const woken = await lifecycle.wake(fx.projectIdentifier, a.id, fx.ctx);
    expect(woken).toMatchObject({ state: 'running', imageDigest: NEW_DIGEST, imageVersion: NEW });
    expect(fleet.machineImage(a.machineId!)).toBe(ref(NEW_DIGEST));
    expect(fleet.liveVolumeIds()).toEqual([a.volumeId]);
    expect((await row(a.id)).targetImageDigest).toBeNull();
  });

  it('a wake whose new image fails rolls back BEFORE it reports running', async () => {
    const a = await hibernated();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    fleet.markImageFailing(ref(NEW_DIGEST));
    await update(a.id);

    const woken = await lifecycle.wake(fx.projectIdentifier, a.id, fx.ctx);
    expect(woken).toMatchObject({ state: 'running', imageDigest: BASE_DIGEST });
    expect(woken.updateFailureReason).toContain('exited 127');
    expect(fleet.machineImage(a.machineId!)).toBe(ref(BASE_DIGEST));
    expect(fleet.liveVolumeIds()).toEqual([a.volumeId]);
  });

  it('an agent never updated keeps its digest across hibernate and wake', async () => {
    const a = await hibernated();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    const woken = await lifecycle.wake(fx.projectIdentifier, a.id, fx.ctx);
    expect(woken).toMatchObject({ state: 'running', imageDigest: BASE_DIGEST });
    expect(fleet.machineImage(a.machineId!)).toBe(ref(BASE_DIGEST));
  });
});

function handleOf(a: { flyApp: string | null; machineId: string | null; volumeId: string | null }) {
  return {
    provider: 'fake' as const,
    app: a.flyApp!,
    machineId: a.machineId!,
    volumeId: a.volumeId!,
    region: 'iad',
    createdAt: new Date(),
  };
}

describe('the refusals (Q8) — each moves nothing', () => {
  async function expectUntouched(id: string, before: Awaited<ReturnType<typeof row>>) {
    const after = await row(id);
    expect(after.state).toBe(before.state);
    expect(after.imageDigest).toBe(before.imageDigest);
    expect(after.targetImageDigest).toBeNull();
    expect(fleet.machineImage(before.machineId!)).toBe(ref(before.imageDigest));
  }

  it('already on the newest image', async () => {
    const a = await agent();
    await expect(update(a.id)).rejects.toThrow(AgentInstanceUpToDateError);
    await expect(update(a.id)).rejects.toThrow(
      'This agent already runs the newest version (1.0.0).',
    );
    await expectUntouched(a.id, a);
  });

  it('a run is running in the agent — the refusal names it', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'a card' },
      fx.ctx,
    );
    await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        origin: 'instance',
        agentInstanceId: a.id,
        agent: 'claude',
        cards: [{ key: item.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    const err = await update(a.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentInstanceRunActiveError);
    expect((err as Error).message).toBe(
      `This agent is running ${item.identifier}, so it can’t be updated. Cancel the run first.`,
    );
    await expectUntouched(a.id, a);
  });

  it.each(['starting', 'waking', 'hibernating', 'deleting', 'failed', 'updating'] as const)(
    'an agent that is %s',
    async (state) => {
      const a = await agent();
      imageCatalogSeam.setFakeNewest('claude', NEW);
      await adminDb.agentInstance.update({ where: { id: a.id }, data: { state } });
      const err = await update(a.id).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentInstanceStateConflictError);
      expect((err as Error).message).toBe(
        `This agent is ${state}, so it can't be updated right now.`,
      );
      expect(await row(a.id)).toMatchObject({ state, imageDigest: BASE_DIGEST });
    },
  );

  it('another person’s agent is not found — the same answer as no agent at all', async () => {
    const other = await otherMember();
    const theirs = await lifecycle.create(
      fx.projectIdentifier,
      { name: 'theirs', profileId: 'claude' },
      { ...fx.ctx, userId: other.userId },
    );
    imageCatalogSeam.setFakeNewest('claude', NEW);
    await expect(update(theirs.id)).rejects.toThrow(AgentInstanceNotFoundError);
    await expect(update('no-such-agent')).rejects.toThrow(AgentInstanceNotFoundError);
  });

  it('a registry that cannot be asked is a wait, never "up to date"', async () => {
    const a = await agent();
    vi.spyOn(imageCatalog, 'newestFor').mockResolvedValue('unknown');
    await expect(update(a.id)).rejects.toThrow(AgentImageCatalogUnavailableError);
    await expectUntouched(a.id, a);
  });
});

describe('real concurrency — every move is a guarded compare-and-set', () => {
  it('two Updates at once: exactly one moves the machine, the other is refused', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    const results = await Promise.allSettled([update(a.id), update(a.id)]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    // Either the second arrived after the first settled (up to date) or raced it (conflict).
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const reason = (lost[0] as PromiseRejectedResult).reason;
    expect(
      reason instanceof AgentInstanceStateConflictError ||
        reason instanceof AgentInstanceUpToDateError,
    ).toBe(true);
    expect(await row(a.id)).toMatchObject({ state: 'running', imageDigest: NEW_DIGEST });
    expect(fleet.liveVolumeIds()).toEqual([a.volumeId]);
  });

  it.each(['hibernate', 'delete'] as const)(
    'Update racing %s: one wins, the loser is refused, and the agent lands in one coherent state',
    async (other) => {
      const a = await agent();
      imageCatalogSeam.setFakeNewest('claude', NEW);
      const results = await Promise.allSettled([
        update(a.id),
        other === 'hibernate'
          ? lifecycle.hibernate(fx.projectIdentifier, a.id, fx.ctx)
          : lifecycle.delete(fx.projectIdentifier, a.id, fx.ctx),
      ]);
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      for (const r of results) {
        if (r.status === 'rejected') {
          expect(r.reason).toBeInstanceOf(AgentInstanceStateConflictError);
        }
      }
      const final = await row(a.id);
      expect(['running', 'hibernated', 'deleting']).toContain(
        final.deletedAt ? 'deleting' : final.state,
      );
      expect(final.state).not.toBe('updating');
    },
  );
});

describe('the sweep resolves an agent left mid-update (Q6)', () => {
  it('a machine that came up on the new image after the inline wait: liveness, then running on it', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    fleet.setBootBehaviour('never_start');
    const dto = await update(a.id);
    expect(dto.state).toBe('updating');
    fleet.completeBoot(a.machineId!);

    // Fresh: the inline settle's, not the sweep's.
    await sweeper.sweep();
    expect((await row(a.id)).state).toBe('updating');

    clock.advance(11 * MIN);
    await sweeper.sweep();
    expect(await row(a.id)).toMatchObject({ state: 'running', imageDigest: NEW_DIGEST });
  });

  it('a new image that never starts is rolled back; a rollback that never starts ends failed, the volume kept', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    fleet.setBootBehaviour('never_start');
    await update(a.id);

    clock.advance(11 * MIN);
    await sweeper.sweep();
    const rolling = await row(a.id);
    expect(rolling.state).toBe('updating');
    expect(rolling.updateFailureReason).toContain('did not start within 5 minutes');
    expect(fleet.machineImage(a.machineId!)).toBe(ref(BASE_DIGEST));

    clock.advance(6 * MIN);
    await sweeper.sweep();
    const failed = await row(a.id);
    expect(failed.state).toBe('failed');
    expect(failed.failureReason).toContain('couldn’t be brought back on 1.0.0');
    expect(failed.imageDigest).toBe(BASE_DIGEST);
    expect(fleet.liveVolumeIds()).toEqual([a.volumeId]);
  });

  it('an updating agent’s interval rolls like a running one’s', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    fleet.setBootBehaviour('never_start');
    await update(a.id);
    clock.advance(3 * MIN);
    expect(await lifecycle.rollInterval(a.id)).toBe('rolled');
  });
});

describe('POST /api/projects/[key]/instances/[id]/update', () => {
  const params = (id: string) => ({ params: Promise.resolve({ key: fx.projectIdentifier, id }) });
  const post = (id: string) =>
    new Request(`http://test/api/projects/${fx.projectIdentifier}/instances/${id}/update`, {
      method: 'POST',
    });

  it('200 with the updated agent; 409 in words when it is already on the newest', async () => {
    const a = await agent();
    const refused = await updateRoute.POST(post(a.id), params(a.id));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: 'agent_instance_up_to_date',
      error: 'This agent already runs the newest version (1.0.0).',
      version: '1.0.0',
    });

    imageCatalogSeam.setFakeNewest('claude', NEW);
    const res = await updateRoute.POST(post(a.id), params(a.id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { instance: { imageVersion: string } }).instance).toMatchObject({
      imageVersion: NEW,
      state: 'running',
    });
  });

  it('404 for an agent that is not the caller’s', async () => {
    const res = await updateRoute.POST(post('nope'), params('nope'));
    expect(res.status).toBe(404);
  });
});

describe('the state table and the liveness commands', () => {
  it('updating is entered from running and hibernated only, leaves to running or failed, and holds a slot', () => {
    expect(isLegalTransition('running', 'updating')).toBe(true);
    expect(isLegalTransition('hibernated', 'updating')).toBe(true);
    expect(isLegalTransition('failed', 'updating')).toBe(false);
    expect(isLegalTransition('updating', 'running')).toBe(true);
    expect(isLegalTransition('updating', 'failed')).toBe(true);
    expect(isLegalTransition('updating', 'hibernating')).toBe(false);
    expect(isLegalTransition('updating', 'deleting')).toBe(false);
    expect(RUNNING_STATES).toContain('updating');
  });

  it('each offered profile’s liveness command is the sandbox smoke’s, word for word (Q3 drift guard)', () => {
    const smoke = JSON.parse(
      readFileSync(join(process.cwd(), 'packages/cli/sandbox/smoke/profiles.json'), 'utf8'),
    ) as
      | { profiles: Array<{ id: string; liveness: string }> }
      | Array<{ id: string; liveness: string }>;
    const list = Array.isArray(smoke) ? smoke : smoke.profiles;
    for (const profile of OFFERED_AGENT_PROFILES) {
      const published = list.find((p) => p.id === profile.id);
      expect(published, profile.id).toBeDefined();
      expect(AGENT_LIVENESS_COMMANDS[profile.id]).toEqual(published!.liveness.split(/\s+/));
    }
  });
});
