import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { fakeDigestFor, imageCatalog, imageCatalogSeam } from '@/lib/agentInstances/imageCatalog';
import { pinnedImageReference } from '@/lib/agentInstances/imageDigest';
import { sandboxImageTag } from '@/lib/agentInstances/profiles';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { adminDb } from '../helpers/adminDb';
import { fleet, fx, setUpHarness, tearDownHarness } from './_harness';

// THE IMAGE-UPDATE STORY'S INTEGRATION GATE (Story MOTIR-6862 · MOTIR-6954) —
// the assembled story below the browser: the catalog's answer through the DTO
// and the list route, the update route moving the FAKE fleet's machine, the
// liveness check rolling it back, and the record, the volume, the home and the
// run refusal all agreeing. Real Postgres; the fake fleet is the only orchestrator.
//
// ⚠️ THE HOME FILE IS THE STORY'S PROMISE: a file written into the agent's home
// before the update is there after it, whatever the update did.

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
const listRoute = await import('@/app/api/projects/[key]/instances/route');
const updateRoute = await import('@/app/api/projects/[key]/instances/[id]/update/route');
const hibernateRoute = await import('@/app/api/projects/[key]/instances/[id]/hibernate/route');
const wakeRoute = await import('@/app/api/projects/[key]/instances/[id]/wake/route');

// The story's own words: an agent on 0.4.0, a published 0.5.0.
const OLD = '0.4.0';
const NEW = '0.5.0';
const OLD_DIGEST = fakeDigestFor('claude', OLD);
const NEW_DIGEST = fakeDigestFor('claude', NEW);
const ref = (digest: string) => pinnedImageReference(sandboxImageTag('claude'), digest);
const HOME_FILE = 'workspace/notes.txt';

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

const keyParams = () => ({ params: Promise.resolve({ key: fx.projectIdentifier }) });
const idParams = (id: string) => ({ params: Promise.resolve({ key: fx.projectIdentifier, id }) });
const base = () => `http://test/api/projects/${fx.projectIdentifier}/instances`;
const post = (id: string, verb: string) =>
  new Request(`${base()}/${id}/${verb}`, { method: 'POST' });

/** An agent on 0.4.0, its home holding a file the owner wrote. */
async function agentOnOld(name = 'yue-claude') {
  imageCatalogSeam.setFakeNewest('claude', OLD);
  const dto = await lifecycle.create(fx.projectIdentifier, { name, profileId: 'claude' }, fx.ctx);
  const row = await adminDb.agentInstance.findUniqueOrThrow({ where: { id: dto.id } });
  // `create` booted the moving tag's stand-in; pin it to 0.4.0 the way a real
  // agent created at 0.4.0 is, on its machine as on its record.
  await adminDb.agentInstance.update({
    where: { id: row.id },
    data: { imageDigest: OLD_DIGEST, imageVersion: OLD },
  });
  await fleet.moveImage(handle(row), ref(OLD_DIGEST), { launch: true });
  fleet.writeHomeFile(row.volumeId!, HOME_FILE, 'written before the update');
  imageCatalogSeam.setFakeNewest('claude', NEW);
  return row;
}

function handle(row: { flyApp: string | null; machineId: string | null; volumeId: string | null }) {
  return {
    provider: 'fake' as const,
    app: row.flyApp!,
    machineId: row.machineId!,
    volumeId: row.volumeId!,
    region: 'iad',
    createdAt: new Date(),
  };
}

const record = (id: string) => adminDb.agentInstance.findUniqueOrThrow({ where: { id } });

describe('1 · the catalog → DTO → route seam', () => {
  it('the list route says Update available on 0.4.0, nothing on 0.5.0, and unknown on every row when the catalog fails', async () => {
    const old = await agentOnOld('old-agent');
    const fresh = await agentOnOld('new-agent');
    await adminDb.agentInstance.update({
      where: { id: fresh.id },
      data: { imageDigest: NEW_DIGEST, imageVersion: NEW },
    });

    const res = await listRoute.GET(new Request(`${base()}?limit=10`), keyParams());
    expect(res.status).toBe(200);
    const rows = new Map(
      (
        (await res.json()) as {
          instances: Array<{ name: string; update: unknown; imageVersion: string }>;
        }
      ).instances.map((i) => [i.name, i]),
    );
    expect(rows.get('old-agent')).toMatchObject({
      imageVersion: OLD,
      update: { version: NEW, digest: NEW_DIGEST },
    });
    expect(rows.get('new-agent')).toMatchObject({ imageVersion: NEW, update: null });

    imageCatalogSeam.setFakeUnavailable(true);
    const failed = await listRoute.GET(new Request(`${base()}?limit=10`), keyParams());
    const updates = (
      (await failed.json()) as { instances: Array<{ update: unknown }> }
    ).instances.map((i) => i.update);
    expect(updates).toEqual(['unknown', 'unknown']);
    expect(old.id).toBeTruthy();
  });
});

describe('2 · an update, and its rollback, end to end', () => {
  it('POST …/update ends running on 0.5.0, on the same volume, the home file still there', async () => {
    const a = await agentOnOld();
    const res = await updateRoute.POST(post(a.id, 'update'), idParams(a.id));
    expect(res.status).toBe(200);
    const { instance } = (await res.json()) as { instance: Record<string, unknown> };
    expect(instance).toMatchObject({
      state: 'running',
      imageVersion: NEW,
      imageDigest: NEW_DIGEST,
    });
    // No route returns a Fly id.
    for (const key of ['machineId', 'volumeId', 'flyApp', 'app'])
      expect(instance).not.toHaveProperty(key);

    const after = await record(a.id);
    expect(after.volumeId).toBe(a.volumeId);
    expect(fleet.machineImage(a.machineId!)).toBe(ref(NEW_DIGEST));
    expect(fleet.readHomeFile(a.volumeId!, HOME_FILE)).toBe('written before the update');
  });

  it('a failing 0.5.0 rolls back to 0.4.0: the reason on the DTO, the volume and the home file unchanged', async () => {
    const a = await agentOnOld();
    fleet.markImageFailing(ref(NEW_DIGEST));
    const res = await updateRoute.POST(post(a.id, 'update'), idParams(a.id));
    expect(res.status).toBe(200);
    const { instance } = (await res.json()) as {
      instance: { state: string; imageDigest: string; updateFailureReason: string };
    };
    expect(instance.state).toBe('running');
    expect(instance.imageDigest).toBe(OLD_DIGEST);
    expect(instance.updateFailureReason).toBe(
      'The update to 0.5.0 didn’t work: claude --version exited 127 (command not found). ' +
        'Your agent is back on 0.4.0.',
    );
    expect((await record(a.id)).volumeId).toBe(a.volumeId);
    expect(fleet.machineImage(a.machineId!)).toBe(ref(OLD_DIGEST));
    expect(fleet.readHomeFile(a.volumeId!, HOME_FILE)).toBe('written before the update');
  });

  it.each([
    ['passes', false, NEW_DIGEST],
    ['fails', true, OLD_DIGEST],
  ])(
    'a hibernated agent stays hibernated; its next wake applies 0.5.0 when it %s',
    async (_label, failing, endsOn) => {
      const a = await agentOnOld();
      expect((await hibernateRoute.POST(post(a.id, 'hibernate'), idParams(a.id))).status).toBe(200);
      if (failing) fleet.markImageFailing(ref(NEW_DIGEST));

      const res = await updateRoute.POST(post(a.id, 'update'), idParams(a.id));
      expect(((await res.json()) as { instance: unknown }).instance).toMatchObject({
        state: 'hibernated',
        imageDigest: OLD_DIGEST,
        pendingImageVersion: NEW,
      });
      expect(fleet.machineImage(a.machineId!)).toBe(ref(OLD_DIGEST));

      const woken = await wakeRoute.POST(post(a.id, 'wake'), idParams(a.id));
      expect(((await woken.json()) as { instance: unknown }).instance).toMatchObject({
        state: 'running',
        imageDigest: endsOn,
      });
      expect(fleet.readHomeFile(a.volumeId!, HOME_FILE)).toBe('written before the update');
    },
  );
});

describe('3 · the guards', () => {
  it('two concurrent POSTs: one update, one refusal — and the agent on 0.5.0 exactly once', async () => {
    const a = await agentOnOld();
    const answers = await Promise.all([
      updateRoute.POST(post(a.id, 'update'), idParams(a.id)),
      updateRoute.POST(post(a.id, 'update'), idParams(a.id)),
    ]);
    const statuses = answers.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    const refused = (await answers.find((r) => r.status === 409)!.json()) as { code: string };
    // Raced (a conflict), or arrived after the first settled (already newest): both legitimate.
    expect(['agent_instance_state_conflict', 'agent_instance_up_to_date']).toContain(refused.code);
    expect(await record(a.id)).toMatchObject({ state: 'running', imageDigest: NEW_DIGEST });
  });

  it('a press that read the agent before an earlier update settled is refused, not run a second time (MOTIR-7340)', async () => {
    const a = await agentOnOld();
    // The interleaving a loaded runner produces by chance, pinned: press B reads
    // the agent on 0.4.0, then press A runs start to finish, then B carries on
    // from its stale read. Only the catalog read is held; the rest is real.
    const newestFor = imageCatalog.newestFor.bind(imageCatalog);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const bHasRead = new Promise<void>((resolve) => (entered = resolve));
    let calls = 0;
    const spy = vi.spyOn(imageCatalog, 'newestFor').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 1) {
        entered();
        await held;
      }
      return newestFor(...args);
    });
    try {
      const b = updateRoute.POST(post(a.id, 'update'), idParams(a.id));
      await bHasRead;
      const first = await updateRoute.POST(post(a.id, 'update'), idParams(a.id));
      expect(first.status).toBe(200);
      expect(await record(a.id)).toMatchObject({ state: 'running', imageDigest: NEW_DIGEST });
      const settledAt = (await record(a.id)).stateChangedAt;

      release();
      const second = await b;
      expect(second.status).toBe(409);
      expect(((await second.json()) as { code: string }).code).toBe('agent_instance_up_to_date');
      // B moved nothing: no second `updating`, the agent where A left it.
      expect(await record(a.id)).toMatchObject({
        state: 'running',
        imageDigest: NEW_DIGEST,
        stateChangedAt: settledAt,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('update racing hibernate: one wins, the loser is refused, and the agent is never left mid-update', async () => {
    const a = await agentOnOld();
    const answers = await Promise.all([
      updateRoute.POST(post(a.id, 'update'), idParams(a.id)),
      hibernateRoute.POST(post(a.id, 'hibernate'), idParams(a.id)),
    ]);
    expect(answers.some((r) => r.status === 200)).toBe(true);
    for (const r of answers.filter((x) => x.status !== 200)) {
      expect(r.status).toBe(409);
      expect(((await r.json()) as { code: string }).code).toBe('agent_instance_state_conflict');
    }
    expect(['running', 'hibernated']).toContain((await record(a.id)).state);
    expect(fleet.readHomeFile(a.volumeId!, HOME_FILE)).toBe('written before the update');
  });

  it('a run recorded against the agent refuses the update, naming the run, and the machine is not touched', async () => {
    const a = await agentOnOld();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'a card' },
      fx.ctx,
    );
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        origin: 'instance',
        agentInstanceId: a.id,
        agent: 'claude',
        cards: [{ key: item.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    const moves = () => fleet.operations.filter((o) => o.startsWith('machine:move:')).length;
    const before = moves();
    const res = await updateRoute.POST(post(a.id, 'update'), idParams(a.id));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'agent_instance_run_active',
      runId: run.id,
      workItemKey: item.identifier,
    });
    expect(moves()).toBe(before);
    expect(await record(a.id)).toMatchObject({ state: 'running', imageDigest: OLD_DIGEST });
  });
});
