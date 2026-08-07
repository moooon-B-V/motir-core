import { describe, it, expect } from 'vitest';

// The one-shot object migration (MOTIR-2389 ships it, MOTIR-2401 runs it).
//
// The script's whole risk is that it will be run ONCE, by a person, against two
// live stores, with no chance to iterate — so the copy logic is separated from
// the network and tested here against a faked source listing and a faked
// destination. What is asserted is the behaviour a nervous operator depends on:
// a dry run writes nothing, a re-run does not re-upload, a half-copied object is
// repaired rather than skipped, and the verify pass reports what is actually on
// the far side rather than what the copy believed it did.
import {
  migrateStore,
  runMigration,
  verifyStore,
  formatStoreReport,
  formatVerifyReport,
  type MigrationDeps,
  type SourceObject,
  type StoreName,
} from '../scripts/migrate-blob-objects';

interface FakeWorld {
  source: Record<StoreName, SourceObject[]>;
  dest: Record<StoreName, Map<string, { size: number; contentType: string }>>;
  reads: string[];
  writes: string[];
}

function fakeWorld(overrides: Partial<FakeWorld['source']> = {}): {
  world: FakeWorld;
  deps: MigrationDeps;
} {
  const world: FakeWorld = {
    source: { private: [], public: [], ...overrides },
    dest: { private: new Map(), public: new Map() },
    reads: [],
    writes: [],
  };
  const deps: MigrationDeps = {
    async listSource(store) {
      return world.source[store];
    },
    async readSource(store, pathname) {
      world.reads.push(`${store}/${pathname}`);
      const found = world.source[store].find((o) => o.pathname === pathname);
      if (!found) throw new Error(`no such source object: ${pathname}`);
      return { body: Buffer.alloc(found.size, 1), contentType: 'application/octet-stream' };
    },
    async headDest(store, key) {
      return world.dest[store].get(key) ?? null;
    },
    async putDest(store, key, body, contentType) {
      world.writes.push(`${store}/${key}`);
      world.dest[store].set(key, { size: body.length, contentType });
    },
  };
  return { world, deps };
}

describe('the inventory — the first thing the operator writes onto the card', () => {
  it('reports object COUNT and total BYTES per store, before anything is copied', async () => {
    const { deps } = fakeWorld({
      private: [
        { pathname: 'attachments/w1/a.pdf', size: 100 },
        { pathname: 'attachments/w1/b.png', size: 250 },
      ],
      public: [{ pathname: 'avatars/u1/me.png', size: 40 }],
    });

    const [priv, pub] = await runMigration(deps, { dryRun: true });

    expect(priv).toMatchObject({ store: 'private', objects: 2, bytes: 350 });
    expect(pub).toMatchObject({ store: 'public', objects: 1, bytes: 40 });
  });

  it('an EMPTY store is a reading, not a failure — zero objects, zero bytes', async () => {
    const { deps } = fakeWorld();
    const reports = await runMigration(deps, { dryRun: true });
    expect(reports.map((r) => [r.store, r.objects, r.bytes])).toEqual([
      ['private', 0, 0],
      ['public', 0, 0],
    ]);
    expect(reports.every((r) => r.failed.length === 0)).toBe(true);
  });
});

describe('--dry-run is the default posture: it reads and writes NOTHING', () => {
  it('names what it would copy without reading a body or writing an object', async () => {
    const { world, deps } = fakeWorld({
      private: [{ pathname: 'attachments/w1/a.pdf', size: 100 }],
    });

    const report = await migrateStore('private', deps, { dryRun: true });

    expect(report.copied).toEqual(['attachments/w1/a.pdf']);
    expect(world.writes).toEqual([]);
    expect(world.reads).toEqual([]);
    expect(world.dest.private.size).toBe(0);
  });
});

describe('the copy', () => {
  it('copies each object into the matching bucket at the SAME key', async () => {
    // The same key is what lets a pre-migration `Attachment.blobPathname` keep
    // resolving through the new seam with no data rewrite.
    const { world, deps } = fakeWorld({
      private: [{ pathname: 'attachments/w1/a.pdf', size: 100 }],
      public: [{ pathname: 'avatars/u1/me.png', size: 40 }],
    });

    await runMigration(deps, { dryRun: false });

    expect(world.writes).toEqual(['private/attachments/w1/a.pdf', 'public/avatars/u1/me.png']);
    expect(world.dest.private.get('attachments/w1/a.pdf')).toEqual({
      size: 100,
      contentType: 'application/octet-stream',
    });
    // Crucially NOT cross-wired: the avatar is not in the private bucket.
    expect(world.dest.private.has('avatars/u1/me.png')).toBe(false);
  });

  it('is IDEMPOTENT — a re-run skips what is already there at the same size', async () => {
    const { world, deps } = fakeWorld({
      private: [{ pathname: 'attachments/w1/a.pdf', size: 100 }],
    });

    const first = await migrateStore('private', deps, { dryRun: false });
    const second = await migrateStore('private', deps, { dryRun: false });

    expect(first.copied).toEqual(['attachments/w1/a.pdf']);
    expect(second.copied).toEqual([]);
    expect(second.skipped).toEqual(['attachments/w1/a.pdf']);
    expect(world.writes).toHaveLength(1); // uploaded exactly once
  });

  it('RE-COPIES a size mismatch — a truncated object is what a resume must repair', async () => {
    const { world, deps } = fakeWorld({
      private: [{ pathname: 'attachments/w1/a.pdf', size: 100 }],
    });
    // A previous run died mid-upload and left a short object behind.
    world.dest.private.set('attachments/w1/a.pdf', { size: 12, contentType: 'x' });

    const report = await migrateStore('private', deps, { dryRun: false });

    expect(report.copied).toEqual(['attachments/w1/a.pdf']);
    expect(report.skipped).toEqual([]);
    expect(world.dest.private.get('attachments/w1/a.pdf')!.size).toBe(100);
  });

  it('one failing object does not abort the rest — it is reported by name', async () => {
    const { world, deps } = fakeWorld({
      private: [
        { pathname: 'attachments/w1/ok-1.pdf', size: 10 },
        { pathname: 'attachments/w1/boom.pdf', size: 10 },
        { pathname: 'attachments/w1/ok-2.pdf', size: 10 },
      ],
    });
    const failing: MigrationDeps = {
      ...deps,
      async putDest(store, key, body, contentType) {
        if (key.includes('boom')) throw new Error('upstream 500');
        return deps.putDest(store, key, body, contentType);
      },
    };

    const report = await migrateStore('private', failing, { dryRun: false });

    expect(report.copied).toEqual(['attachments/w1/ok-1.pdf', 'attachments/w1/ok-2.pdf']);
    expect(report.failed).toEqual([
      { pathname: 'attachments/w1/boom.pdf', error: expect.stringContaining('upstream 500') },
    ]);
    expect(world.dest.private.size).toBe(2);
  });
});

describe('the verify pass — a claim about the RESULT, not about the copy', () => {
  it('reports zero discrepancies when every object made it across', async () => {
    const { deps } = fakeWorld({
      private: [{ pathname: 'attachments/w1/a.pdf', size: 100 }],
      public: [{ pathname: 'avatars/u1/me.png', size: 40 }],
    });
    await runMigration(deps, { dryRun: false });

    const report = await verifyStore('private', deps);
    expect(report).toEqual({ store: 'private', checked: 1, missing: [], sizeMismatch: [] });
  });

  it('names a MISSING object — the case a "the copy ran" claim cannot see', async () => {
    const { deps } = fakeWorld({
      private: [
        { pathname: 'attachments/w1/a.pdf', size: 100 },
        { pathname: 'attachments/w1/lost.pdf', size: 5 },
      ],
    });
    const dropping: MigrationDeps = {
      ...deps,
      async putDest(store, key, body, contentType) {
        if (key.includes('lost')) return; // "succeeds" and stores nothing
        return deps.putDest(store, key, body, contentType);
      },
    };
    const copied = await migrateStore('private', dropping, { dryRun: false });
    // The copy reported success for both — which is exactly why verify exists.
    expect(copied.copied).toHaveLength(2);
    expect(copied.failed).toEqual([]);

    const report = await verifyStore('private', dropping);
    expect(report.missing).toEqual(['attachments/w1/lost.pdf']);
  });

  it('names a SIZE MISMATCH with both numbers', async () => {
    const { world, deps } = fakeWorld({
      private: [{ pathname: 'attachments/w1/a.pdf', size: 100 }],
    });
    world.dest.private.set('attachments/w1/a.pdf', { size: 12, contentType: 'x' });

    const report = await verifyStore('private', deps);
    expect(report.sizeMismatch).toEqual([
      { pathname: 'attachments/w1/a.pdf', source: 100, dest: 12 },
    ]);
  });
});

describe('the printed report — what gets pasted onto the card', () => {
  it('carries the inventory and the per-store outcome', async () => {
    const { deps } = fakeWorld({
      private: [{ pathname: 'attachments/w1/a.pdf', size: 100 }],
    });
    const report = await migrateStore('private', deps, { dryRun: true });
    const text = formatStoreReport(report, true);

    expect(text).toContain('private store: 1 objects, 100 bytes');
    expect(text).toContain('would copy: 1');
  });

  it('lists every discrepancy the verify pass found', async () => {
    const { world, deps } = fakeWorld({
      private: [
        { pathname: 'attachments/w1/gone.pdf', size: 7 },
        { pathname: 'attachments/w1/short.pdf', size: 100 },
      ],
    });
    world.dest.private.set('attachments/w1/short.pdf', { size: 12, contentType: 'x' });

    const text = formatVerifyReport(await verifyStore('private', deps));
    expect(text).toContain('MISSING  attachments/w1/gone.pdf');
    expect(text).toContain('SIZE     attachments/w1/short.pdf (source 100 != dest 12)');
  });
});
