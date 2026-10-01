import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  FAKE_BASE_VERSION,
  IMAGE_CATALOG_TTL_MS,
  compareVersions,
  fakeDigestFor,
  imageCatalog,
  imageCatalogSeam,
  type ImageRegistry,
} from '@/lib/agentInstances/imageCatalog';
import { sandboxImageTag } from '@/lib/agentInstances/profiles';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE PUBLISHED-IMAGE CATALOG (Story MOTIR-6862 · MOTIR-6949,
// `docs/decisions/agent-image-update.md` Q1): the newest version per profile,
// a digest named by its version, the cache, and the two fields every listed
// agent carries — against a stubbed registry, and the list against a real
// Postgres.

const D = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;
const D040 = D(4);
const D050 = D(5);
const DCODEX = D(7);

/** A registry: `claude-0.4.0`, `claude-0.5.0` and `:claude` → 0.5.0; codex at 0.5.0. Counts its calls. */
function stubRegistry(overrides: Record<string, string | null> = {}) {
  const counts = { listTags: 0, resolveDigest: new Map<string, number>() };
  const digests: Record<string, string | null> = {
    [sandboxImageTag('claude')]: D050,
    [`${sandboxImageTag('claude')}-0.4.0`]: D040,
    [`${sandboxImageTag('claude')}-0.5.0`]: D050,
    [sandboxImageTag('codex')]: DCODEX,
    [`${sandboxImageTag('codex')}-0.5.0`]: DCODEX,
    ...overrides,
  };
  const registry: ImageRegistry = {
    async listTags() {
      counts.listTags += 1;
      return ['claude', 'claude-0.4.0', 'claude-0.5.0', 'codex', 'codex-0.5.0', 'base-0.5.0'];
    },
    async resolveDigest(reference) {
      counts.resolveDigest.set(reference, (counts.resolveDigest.get(reference) ?? 0) + 1);
      return digests[reference] ?? null;
    },
  };
  return { registry, counts };
}

beforeEach(() => {
  imageCatalogSeam.reset();
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
});

afterEach(() => {
  imageCatalogSeam.reset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the version rule (Q1)', () => {
  it('names the newest by the moving tag, and any digest by its immutable tag', async () => {
    imageCatalogSeam.setRegistry(stubRegistry().registry);
    expect(await imageCatalog.newestFor('claude')).toEqual({ version: '0.5.0', digest: D050 });
    expect(await imageCatalog.versionOf('claude', D040)).toBe('0.4.0');
    expect(await imageCatalog.versionOf('claude', D(9))).toBeNull();
  });

  it('offers the newest to an older agent, nothing on the newest, and never a downgrade', async () => {
    imageCatalogSeam.setRegistry(stubRegistry().registry);
    expect(await imageCatalog.updateFor('claude', D040)).toEqual({
      imageVersion: '0.4.0',
      update: { version: '0.5.0', digest: D050 },
    });
    expect(await imageCatalog.updateFor('claude', D050)).toEqual({
      imageVersion: '0.5.0',
      update: null,
    });
    // An operator moved `:claude` back to 0.4.0: an agent on 0.5.0 is offered nothing.
    imageCatalogSeam.reset();
    imageCatalogSeam.setRegistry(stubRegistry({ [sandboxImageTag('claude')]: D040 }).registry);
    expect(await imageCatalog.updateFor('claude', D050)).toEqual({
      imageVersion: '0.5.0',
      update: null,
    });
  });

  it('offers the newest to an agent whose digest no tag names, as "an earlier build"', async () => {
    imageCatalogSeam.setRegistry(stubRegistry().registry);
    expect(await imageCatalog.updateFor('claude', D(9))).toEqual({
      imageVersion: null,
      update: { version: '0.5.0', digest: D050 },
    });
  });

  it('a moving tag no versioned tag shares is unknown — no update is offered on it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    imageCatalogSeam.setRegistry(stubRegistry({ [sandboxImageTag('claude')]: D(8) }).registry);
    expect(await imageCatalog.newestFor('claude')).toBe('unknown');
    expect((await imageCatalog.updateFor('claude', D040)).update).toBe('unknown');
    expect(warn).toHaveBeenCalled();
  });

  it('a registry that cannot be read is unknown — never "up to date"', async () => {
    imageCatalogSeam.setRegistry({ listTags: async () => null, resolveDigest: async () => null });
    expect(await imageCatalog.newestFor('claude')).toBe('unknown');
    expect(await imageCatalog.versionOf('claude', D040)).toBe('unknown');
    expect(await imageCatalog.updateFor('claude', D050)).toEqual({
      imageVersion: null,
      update: 'unknown',
    });
  });

  it('compares versions numerically, not as strings', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.4.0', '0.5.0')).toBeLessThan(0);
  });
});

describe('the cache (Q1)', () => {
  it('reads a profile once per window, re-reads after it, and `fresh` bypasses it', async () => {
    let now = 1_000_000;
    imageCatalogSeam.setClock(() => now);
    const { registry, counts } = stubRegistry();
    imageCatalogSeam.setRegistry(registry);
    await Promise.all([imageCatalog.newestFor('claude'), imageCatalog.newestFor('claude')]);
    await imageCatalog.versionOf('claude', D040);
    expect(counts.listTags).toBe(1);
    expect(counts.resolveDigest.get(sandboxImageTag('claude'))).toBe(1);
    // An immutable tag is asked once for the life of the process.
    expect(counts.resolveDigest.get(`${sandboxImageTag('claude')}-0.5.0`)).toBe(1);

    now += IMAGE_CATALOG_TTL_MS + 1;
    await imageCatalog.newestFor('claude');
    expect(counts.listTags).toBe(2);
    expect(counts.resolveDigest.get(`${sandboxImageTag('claude')}-0.5.0`)).toBe(1);

    await imageCatalog.newestFor('claude', { fresh: true });
    expect(counts.listTags).toBe(3);
  });
});

describe('the fake fleet — no registry, a settable newest version', () => {
  it('names every fake agent’s digest the base version, and a set release as newer', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    const { registry, counts } = stubRegistry();
    imageCatalogSeam.setRegistry(registry);
    const base = fakeDigestFor('claude', FAKE_BASE_VERSION);
    expect(await imageCatalog.updateFor('claude', base)).toEqual({
      imageVersion: FAKE_BASE_VERSION,
      update: null,
    });
    imageCatalogSeam.setFakeNewest('claude', '1.1.0');
    expect(await imageCatalog.updateFor('claude', base)).toEqual({
      imageVersion: FAKE_BASE_VERSION,
      update: { version: '1.1.0', digest: fakeDigestFor('claude', '1.1.0') },
    });
    expect(await imageCatalog.versionOf('claude', fakeDigestFor('claude', '1.1.0'))).toBe('1.1.0');
    expect(counts.listTags).toBe(0);
    expect(counts.resolveDigest.size).toBe(0);
  });

  it('reads the newest version from MOTIR_FAKE_IMAGE_NEWEST, for a lane whose server is another process', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    vi.stubEnv('MOTIR_FAKE_IMAGE_NEWEST', JSON.stringify({ codex: '2.0.0' }));
    expect(await imageCatalog.newestFor('codex')).toMatchObject({ version: '2.0.0' });
    expect(await imageCatalog.newestFor('claude')).toMatchObject({ version: FAKE_BASE_VERSION });
    vi.stubEnv('MOTIR_FAKE_IMAGE_NEWEST', 'not json');
    expect(await imageCatalog.newestFor('codex')).toMatchObject({ version: FAKE_BASE_VERSION });
  });
});

describe('the list carries imageVersion and update on every agent', () => {
  let fx: WorkItemFixture;

  beforeEach(async () => {
    await truncateAuthTables();
    fx = await makeWorkItemFixture();
    vi.stubEnv('FLY_INSTANCES_API_TOKEN', 'instances-token');
  });

  async function seedAgent(name: string, profileId: string, imageDigest: string) {
    await adminDb.agentInstance.create({
      data: {
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId!,
        projectId: fx.projectId,
        ownerId: fx.ownerId,
        name,
        profileId,
        imageTag: sandboxImageTag(profileId),
        imageDigest,
        region: 'iad',
        state: 'hibernated',
      },
    });
  }

  const list = async () =>
    new Map(
      (await lifecycle.list(fx.projectIdentifier, { take: 50, skip: 0 }, fx.ctx)).instances.map(
        (i) => [i.name, i],
      ),
    );

  it('an agent on 0.4.0 is offered 0.5.0; one on 0.5.0 is offered nothing — asking the registry once per profile', async () => {
    const { registry, counts } = stubRegistry();
    imageCatalogSeam.setRegistry(registry);
    await seedAgent('old-claude', 'claude', D040);
    await seedAgent('new-claude', 'claude', D050);
    await seedAgent('also-old', 'claude', D040);
    await seedAgent('codex-one', 'codex', DCODEX);

    const rows = await list();
    expect(rows.get('old-claude')).toMatchObject({
      imageVersion: '0.4.0',
      update: { version: '0.5.0', digest: D050 },
    });
    expect(rows.get('new-claude')).toMatchObject({ imageVersion: '0.5.0', update: null });
    expect(rows.get('codex-one')).toMatchObject({ imageVersion: '0.5.0', update: null });
    // Four agents, two profiles: each profile's listing and moving tag asked ONCE.
    expect(counts.listTags).toBe(2);
    expect(counts.resolveDigest.get(sandboxImageTag('claude'))).toBe(1);
    expect(counts.resolveDigest.get(sandboxImageTag('codex'))).toBe(1);

    await list();
    expect(counts.listTags).toBe(2);
  });

  it('a registry that refuses gives update "unknown" on every row, and the list still returns', async () => {
    imageCatalogSeam.setRegistry({ listTags: async () => null, resolveDigest: async () => null });
    await seedAgent('a', 'claude', D040);
    await seedAgent('b', 'codex', DCODEX);
    const rows = await list();
    expect([...rows.values()].map((r) => r.update)).toEqual(['unknown', 'unknown']);
  });

  it('a catalog that throws is "unknown" on the row, never a failed list', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(imageCatalog, 'updateFor').mockRejectedValue(new Error('boom'));
    await seedAgent('a', 'claude', D040);
    expect((await list()).get('a')).toMatchObject({ imageVersion: null, update: 'unknown' });
  });

  it('a deployment with no instance lane asks no registry at all', async () => {
    vi.stubEnv('FLY_INSTANCES_API_TOKEN', '');
    const { registry, counts } = stubRegistry();
    imageCatalogSeam.setRegistry(registry);
    await seedAgent('a', 'claude', D040);
    expect((await list()).get('a')).toMatchObject({ update: 'unknown' });
    expect(counts.listTags).toBe(0);
  });
});
