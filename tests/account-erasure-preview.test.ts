import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { accountErasureService } from '@/lib/services/accountErasureService';
import { commentsService } from '@/lib/services/commentsService';
import { organizationsService } from '@/lib/services/organizationsService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { AccountErasurePreviewDTO } from '@/lib/dto/accountErasure';
import { createTestProject, createTestUser, createTestWorkItem } from './fixtures';
import type { WorkItemFixture } from './fixtures/workItemFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// The account-erasure IMPACT PREVIEW (Story 8.4 · Subtask MOTIR-3699) —
// `accountErasureService.previewAccountErasure`, against the real Postgres.
//
// Four things this suite is here to pin, in the order the card states them:
//
//   1. the three ledger groups and their per-category counts;
//   2. the BLOCK — `true` exactly when the reader is the last owner of a SHARED
//      organization — computed as a READ, with the delete path never invoked;
//   3. the sole-MEMBER workspace, which is a CHOICE and not a block, and which
//      the ledger names;
//   4. the SCOPE rule: a workspace the reader cannot read contributes nothing.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── The read-only probe ──────────────────────────────────────────────────────
//
// The card asks for two assertions the ordinary result cannot make: that the
// preview performs NO WRITE and opens NO `FOR UPDATE`, and that it never reaches
// the delete path to discover the block. Both are properties of HOW the answer
// was produced, so they need an instrument rather than an expectation.
//
// It observes the two surfaces this service can reach:
//
//   * every TRANSACTION client — `db.$transaction` is intercepted and its client
//     handed to the callback through a Proxy, so a write on any model and every
//     raw statement (which is the only way `FOR UPDATE` can arrive: Prisma has
//     no locking option on `count`/`findMany`) is recorded on the bound path;
//   * the SINGLETON, for the three Better-Auth tables this service reads with
//     nothing bound (`account` / `passkey` / `two_factor` carry no RLS) plus the
//     tenant models, so an unbound write cannot slip past the transaction proxy.
//
// The `set_config` statements the `with*Context` helpers issue are the expected
// traffic and are asserted ON — a probe that saw no raw SQL at all would be
// reporting that the contexts never bound, which is the failure mode these
// counts exist to avoid.

const WRITE_METHODS = [
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
] as const;

/** The models this service can address, singleton-side. */
const OBSERVED_MODELS = [
  'account',
  'passkey',
  'twoFactor',
  'apiToken',
  'dataExportRequest',
  'workspace',
  'workspaceMembership',
  'organization',
  'organizationMembership',
  'project',
  'workItem',
  'comment',
] as const;

const RAW_METHODS = ['$executeRaw', '$executeRawUnsafe', '$queryRaw', '$queryRawUnsafe'] as const;

interface ReadOnlyProbe<T> {
  result: T;
  /** `<model>.<method>` for every write attempted, on any client. */
  writes: string[];
  /** The text of every raw statement issued, on any client. */
  rawSql: string[];
}

/** The slice of a vitest spy this file uses — `vi.spyOn` on a Prisma delegate
 *  types as `never`, which is why `countDelegateCalls` casts the same way. */
interface Spy {
  mockImplementation: (impl: (...args: unknown[]) => unknown) => void;
  mockRestore: () => void;
}

/** Render a tagged-template / `Prisma.Sql` / string argument as its SQL text. */
function sqlText(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (Array.isArray(arg)) return arg.join('?');
  if (arg && typeof arg === 'object' && 'strings' in arg) {
    return (arg as { strings: string[] }).strings.join('?');
  }
  if (arg && typeof arg === 'object' && 'sql' in arg) return String((arg as { sql: unknown }).sql);
  return String(arg);
}

async function probeReadOnly<T>(fn: () => Promise<T>): Promise<ReadOnlyProbe<T>> {
  const writes: string[] = [];
  const rawSql: string[] = [];
  const spies: Spy[] = [];

  /** Replace `holder[method]`, recording from its arguments, then forwarding. */
  const observe = (holder: object, method: string, record: (args: unknown[]) => void): void => {
    const original = (holder as Record<string, unknown>)[method];
    if (typeof original !== 'function') return;
    const call = original as (...a: unknown[]) => unknown;
    const spy = vi.spyOn(holder as never, method as never) as unknown as Spy;
    spy.mockImplementation((...args: unknown[]) => {
      record(args);
      return call.apply(holder, args);
    });
    spies.push(spy);
  };

  // Every TRANSACTION client, through a Proxy — the bound path, where both the
  // repository writes and the only possible `FOR UPDATE` would live.
  const wrap = (client: Prisma.TransactionClient): Prisma.TransactionClient =>
    new Proxy(client as object, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof prop !== 'string') return value;
        if ((RAW_METHODS as readonly string[]).includes(prop) && typeof value === 'function') {
          return (...args: unknown[]) => {
            rawSql.push(sqlText(args[0]));
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        if (value === null || typeof value !== 'object' || prop.startsWith('$')) return value;
        return new Proxy(value as object, {
          get(delegate, method, delegateReceiver) {
            const fnValue = Reflect.get(delegate, method, delegateReceiver) as unknown;
            if (typeof method !== 'string' || typeof fnValue !== 'function') return fnValue;
            if (!(WRITE_METHODS as readonly string[]).includes(method)) return fnValue;
            return (...args: unknown[]) => {
              writes.push(`${prop}.${method}`);
              return (fnValue as (...a: unknown[]) => unknown).apply(delegate, args);
            };
          },
        });
      },
    }) as Prisma.TransactionClient;

  const realTransaction = db.$transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
  const txSpy = vi.spyOn(db, '$transaction') as unknown as Spy;
  txSpy.mockImplementation((...args: unknown[]) => {
    const [first, ...rest] = args;
    // The ARRAY form (`db.$transaction([...])`) carries no client to wrap.
    if (typeof first !== 'function') return realTransaction(...args);
    const callback = first as (tx: Prisma.TransactionClient) => Promise<unknown>;
    return realTransaction((tx: Prisma.TransactionClient) => callback(wrap(tx)), ...rest);
  });
  spies.push(txSpy);

  // The SINGLETON's model delegates, for the unbound writes this service could
  // otherwise make without ever opening a transaction.
  //
  // ⚠️ THE SINGLETON'S RAW METHODS ARE DELIBERATELY NOT OBSERVED, and the reason
  // is worth more than the coverage it costs: a transaction client resolves
  // `$executeRaw` back through the parent client, so replacing `db.$executeRaw`
  // makes `withUserContext`'s own `SELECT set_config('app.user_id', …)` run on
  // the SINGLETON — outside the transaction it was meant to bind. The GUC dies
  // with that implicit statement, every policy-gated read inside the
  // transaction then sees NULL, and the preview comes back all-zero AND
  // UNBLOCKED with nothing raised. Measured here: the probe turned a `blocked:
  // true` fixture into `blocked: false`, which is precisely the failure this
  // suite exists to catch, manufactured by the instrument watching for it. Raw
  // statements are captured on the TRANSACTION side instead, which is where
  // every one this service can reach is issued.
  for (const model of OBSERVED_MODELS) {
    const delegate = (db as unknown as Record<string, object | undefined>)[model];
    if (!delegate) continue;
    for (const method of WRITE_METHODS) {
      observe(delegate, method, () => writes.push(`${model}.${method}`));
    }
  }

  try {
    const result = await fn();
    return { result, writes, rawSql };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function orgIdOfWorkspace(workspaceId: string): Promise<string> {
  const ws = await adminDb.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  return ws.organizationId;
}

/**
 * A `WorkItemFixture` in an EXISTING workspace, acting as `userId` — so the
 * items it creates are REPORTED by that user. `createTestWorkItem` reads
 * `ownerId` for the reporter and `ctx` for the binding, which is exactly the
 * pair a shared-workspace case needs to vary.
 */
async function fixtureFor(
  userId: string,
  workspaceId: string,
  identifier: string,
): Promise<WorkItemFixture> {
  const project = await createTestProject({ workspaceId, actorUserId: userId, identifier });
  return {
    owner: await adminDb.user.findUniqueOrThrow({ where: { id: userId } }),
    workspace: await adminDb.workspace.findUniqueOrThrow({ where: { id: workspaceId } }),
    project,
    ownerId: userId,
    workspaceId,
    projectId: project.id,
    projectIdentifier: project.identifier,
    ctx: { userId, workspaceId },
  };
}

describe('previewAccountErasure — the block (DECISION 5: the ORGANIZATION tier)', () => {
  it('BLOCKS the last owner of an organization other people belong to, and names it with its member count', async () => {
    const user = await createTestUser();
    const colleague = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: user.id,
    });
    const organizationId = await orgIdOfWorkspace(workspace.id);
    await organizationsService.addMember({
      organizationId,
      userId: colleague.id,
      role: 'member',
      actorUserId: user.id,
    });

    const preview = await accountErasureService.previewAccountErasure(user.id);

    expect(preview.blocked).toBe(true);
    expect(preview.blockingOrganization).toEqual({
      id: organizationId,
      name: expect.any(String),
      memberCount: 2,
    });
  });

  it('does NOT block a sole owner whose organization has no other members — nobody is left behind', async () => {
    const user = await createTestUser();
    await workspacesService.createWorkspace({ name: 'Personal', ownerUserId: user.id });

    const preview = await accountErasureService.previewAccountErasure(user.id);

    expect(preview.blocked).toBe(false);
    expect(preview.blockingOrganization).toBeNull();
  });

  it('does NOT block when the organization has a SECOND owner — the guard it mirrors would pass', async () => {
    const user = await createTestUser();
    const coOwner = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: user.id,
    });
    const organizationId = await orgIdOfWorkspace(workspace.id);
    await organizationsService.addMember({
      organizationId,
      userId: coOwner.id,
      role: 'owner',
      actorUserId: user.id,
    });

    const preview = await accountErasureService.previewAccountErasure(user.id);

    expect(preview.blocked).toBe(false);
    expect(preview.blockingOrganization).toBeNull();
  });

  it('does NOT block a plain MEMBER of a shared organization — only an owner can drop the owner count', async () => {
    const owner = await createTestUser();
    const user = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const organizationId = await orgIdOfWorkspace(workspace.id);
    await organizationsService.addMember({
      organizationId,
      userId: user.id,
      role: 'member',
      actorUserId: owner.id,
    });

    const preview = await accountErasureService.previewAccountErasure(user.id);

    expect(preview.blocked).toBe(false);
    expect(preview.blockingOrganization).toBeNull();
  });
});

describe('previewAccountErasure — a sole WORKSPACE membership is a choice, not a block', () => {
  it('lists the workspace by name in the DELETED group and leaves the verdict unblocked', async () => {
    // The org has TWO owners, so the org-tier guard cannot fire — which isolates
    // the workspace tier. This is the case the card says the original framing got
    // wrong: `removeMemberInTx` refuses the last member LEAVING, but
    // `deleteWorkspace` asserts membership without checking a role, so a
    // sole-membership workspace has two futures rather than none.
    const coOwner = await createTestUser();
    const user = await createTestUser();
    const { workspace: shared } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: coOwner.id,
    });
    const organizationId = await orgIdOfWorkspace(shared.id);
    await organizationsService.addMember({
      organizationId,
      userId: user.id,
      role: 'owner',
      actorUserId: coOwner.id,
    });
    const { workspace: mine } = await workspacesService.createWorkspace({
      name: 'moooon labs',
      ownerUserId: user.id,
      organizationId,
    });

    const preview = await accountErasureService.previewAccountErasure(user.id);

    expect(preview.blocked).toBe(false);
    expect(preview.deleted.soleMemberWorkspaces).toEqual([{ id: mine.id, name: 'moooon labs' }]);
    // The shared workspace the user is NOT in is absent from the ledger entirely.
    expect(preview.deleted.soleMemberWorkspaces.map((w) => w.id)).not.toContain(shared.id);
  });
});

describe('previewAccountErasure — the three ledger groups', () => {
  it('counts a sole-membership workspace’s projects and work items into DELETED, archived rows included', async () => {
    const user = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Personal',
      ownerUserId: user.id,
    });
    const fx = await fixtureFor(user.id, workspace.id, 'SOLO');
    await createTestProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
      name: 'Second',
      identifier: 'SEC',
    });
    const live = await createTestWorkItem(fx, { kind: 'task', title: 'Live' });
    const archived = await createTestWorkItem(fx, { kind: 'task', title: 'Archived' });
    await adminDb.workItem.update({
      where: { id: archived.id },
      data: { archivedAt: new Date() },
    });

    const preview = await accountErasureService.previewAccountErasure(user.id);

    expect(preview.deleted.soleMemberWorkspaces).toEqual([{ id: workspace.id, name: 'Personal' }]);
    expect(preview.deleted.projects).toBe(2);
    // Both items — deletion reaches the archived one too, so the ledger says so.
    expect(preview.deleted.workItems).toBe(2);
    expect(live.archivedAt).toBeNull();
    // Nothing in a sole-membership workspace is anonymised: it goes with the account.
    expect(preview.anonymised).toEqual({ comments: 0, workItems: 0 });
  });

  it('counts the reader’s comments and attributions in a SHARED workspace into ANONYMISED', async () => {
    const owner = await createTestUser();
    const user = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    await workspacesService.addMember({ userId: user.id, workspaceId: workspace.id });

    const ownerFx = await fixtureFor(owner.id, workspace.id, 'SHR');
    const userFx = {
      ...ownerFx,
      ownerId: user.id,
      ctx: { userId: user.id, workspaceId: workspace.id },
    };

    // Reported by the reader.
    await createTestWorkItem(userFx, { kind: 'task', title: 'Reported by user' });
    // Reported by somebody else, assigned to the reader.
    const assigned = await createTestWorkItem(ownerFx, { kind: 'task', title: 'Assigned to user' });
    await adminDb.workItem.update({ where: { id: assigned.id }, data: { assigneeId: user.id } });
    // Neither reported by nor assigned to the reader — must NOT count.
    const theirs = await createTestWorkItem(ownerFx, { kind: 'task', title: 'Theirs alone' });

    await commentsService.addComment(theirs.id, { bodyMd: 'One' }, userFx.ctx);
    await commentsService.addComment(theirs.id, { bodyMd: 'Two' }, userFx.ctx);
    await commentsService.addComment(theirs.id, { bodyMd: 'Not theirs' }, ownerFx.ctx);

    const preview = await accountErasureService.previewAccountErasure(user.id);

    expect(preview.anonymised).toEqual({ comments: 2, workItems: 2 });
    // A shared workspace is NOT deleted, so it contributes nothing to that group.
    expect(preview.deleted.soleMemberWorkspaces).toEqual([]);
    expect(preview.deleted.projects).toBe(0);
    expect(preview.deleted.workItems).toBe(0);
  });

  it('counts an item the reader BOTH reported and was assigned exactly ONCE', async () => {
    const owner = await createTestUser();
    const user = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    await workspacesService.addMember({ userId: user.id, workspaceId: workspace.id });
    const ownerFx = await fixtureFor(owner.id, workspace.id, 'DUP');
    const userFx = {
      ...ownerFx,
      ownerId: user.id,
      ctx: { userId: user.id, workspaceId: workspace.id },
    };

    const both = await createTestWorkItem(userFx, { kind: 'task', title: 'Both' });
    await adminDb.workItem.update({ where: { id: both.id }, data: { assigneeId: user.id } });

    const preview = await accountErasureService.previewAccountErasure(user.id);

    expect(preview.anonymised.workItems).toBe(1);
  });

  it('counts the identity rows — credentials, passkeys, two-factor enrolment, API tokens', async () => {
    const user = await createTestUser();
    await workspacesService.createWorkspace({ name: 'Personal', ownerUserId: user.id });

    const before = await accountErasureService.previewAccountErasure(user.id);
    // `createTestUser` mints a credential account; nothing else is enrolled yet.
    expect(before.deleted.credentials).toBe(1);
    expect(before.deleted.passkeys).toBe(0);
    expect(before.deleted.twoFactorEnrolments).toBe(0);
    expect(before.deleted.apiTokens).toBe(0);

    await adminDb.passkey.create({
      data: {
        userId: user.id,
        name: 'Laptop',
        publicKey: 'pk',
        credentialID: `cred-${user.id}`,
        counter: 0,
        deviceType: 'singleDevice',
        backedUp: false,
        transports: 'internal',
      },
    });
    await adminDb.twoFactor.create({
      data: { userId: user.id, secret: 'sec', backupCodes: 'codes' },
    });

    const after = await accountErasureService.previewAccountErasure(user.id);
    expect(after.deleted.passkeys).toBe(1);
    expect(after.deleted.twoFactorEnrolments).toBe(1);
  });

  // ── The personal-data export (Bug MOTIR-3747) ──────────────────────────────
  // MOTIR-3732 made erasure delete every `data_export_request` and the archive
  // each one built; the ledger never named it. These pin the number the ledger
  // renders — the CONTRACT half. That it equals what the sweep actually deletes
  // is asserted where both halves can be driven, in
  // `tests/account-erasure-sweep.test.ts`.

  it('counts EVERY export request the reader holds, whatever its status', async () => {
    const user = await createTestUser();
    const bystander = await createTestUser();

    // A reader who has never asked for one loses none — and the ledger's row is
    // hidden at zero, so this is the value that decides whether it renders.
    expect((await accountErasureService.previewAccountErasure(user.id)).deleted.dataExports).toBe(
      0,
    );

    // Every status, matching `deleteAllForUser`'s own predicate. A count
    // narrowed to `ready` — the shape `listExpirable` invites — would tell a
    // reader on a consent surface that two of these four survive the erasure.
    for (const status of ['ready', 'preparing', 'failed', 'expired'] as const) {
      await adminDb.dataExportRequest.create({ data: { userId: user.id, status } });
    }
    // Somebody else's archive is not this reader's loss.
    await adminDb.dataExportRequest.create({ data: { userId: bystander.id, status: 'ready' } });

    const preview = await accountErasureService.previewAccountErasure(user.id);

    expect(preview.deleted.dataExports).toBe(4);
    expect(
      (await accountErasureService.previewAccountErasure(bystander.id)).deleted.dataExports,
    ).toBe(1);
  });

  it('states the KEPT exceptions without counting them from the database', async () => {
    const user = await createTestUser();

    const preview = await accountErasureService.previewAccountErasure(user.id);

    // Article 17 erasure is not absolute, and the ledger names the exceptions in
    // approved copy (`content/legal/privacy.md` §6) rather than deriving them.
    expect(preview.kept).toEqual(['billing_records', 'backups']);
  });

  it('answers a reader with NOTHING with zeros — not an error', async () => {
    const user = await createTestUser();

    const preview = await accountErasureService.previewAccountErasure(user.id);

    expect(preview).toEqual<AccountErasurePreviewDTO>({
      blocked: false,
      blockingOrganization: null,
      deleted: {
        credentials: 1,
        passkeys: 0,
        twoFactorEnrolments: 0,
        apiTokens: 0,
        dataExports: 0,
        soleMemberWorkspaces: [],
        projects: 0,
        workItems: 0,
      },
      anonymised: { comments: 0, workItems: 0 },
      kept: ['billing_records', 'backups'],
    });
  });

  it('sums a MIXED membership — a sole-membership workspace and a shared one, each into its own group', async () => {
    const colleague = await createTestUser();
    const user = await createTestUser();

    const { workspace: mine } = await workspacesService.createWorkspace({
      name: 'Personal',
      ownerUserId: user.id,
    });
    const mineFx = await fixtureFor(user.id, mine.id, 'MINE');
    await createTestWorkItem(mineFx, { kind: 'task', title: 'Mine one' });
    await createTestWorkItem(mineFx, { kind: 'task', title: 'Mine two' });

    const { workspace: shared } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: colleague.id,
    });
    await workspacesService.addMember({ userId: user.id, workspaceId: shared.id });
    const sharedOwnerFx = await fixtureFor(colleague.id, shared.id, 'SHRD');
    const sharedUserFx = {
      ...sharedOwnerFx,
      ownerId: user.id,
      ctx: { userId: user.id, workspaceId: shared.id },
    };
    const item = await createTestWorkItem(sharedUserFx, { kind: 'task', title: 'Shared' });
    await commentsService.addComment(item.id, { bodyMd: 'Hello' }, sharedUserFx.ctx);

    const preview = await accountErasureService.previewAccountErasure(user.id);

    expect(preview.deleted.soleMemberWorkspaces).toEqual([{ id: mine.id, name: 'Personal' }]);
    expect(preview.deleted.projects).toBe(1);
    expect(preview.deleted.workItems).toBe(2);
    expect(preview.anonymised).toEqual({ comments: 1, workItems: 1 });
  });
});

describe('previewAccountErasure — the SCOPE rule (a preview is not a privilege escalation)', () => {
  it('omits a shared workspace the reader cannot read from EVERY count', async () => {
    const stranger = await createTestUser();
    const user = await createTestUser();

    // A workspace the reader is not in, holding a project, two work items and a
    // comment. None of it may reach the reader's ledger.
    const { workspace: theirs } = await workspacesService.createWorkspace({
      name: 'Not yours',
      ownerUserId: stranger.id,
    });
    const strangerFx = await fixtureFor(stranger.id, theirs.id, 'NOPE');
    const item = await createTestWorkItem(strangerFx, { kind: 'task', title: 'Theirs' });
    await createTestWorkItem(strangerFx, { kind: 'task', title: 'Also theirs' });
    await commentsService.addComment(item.id, { bodyMd: 'Theirs' }, strangerFx.ctx);
    // The reader is even the ASSIGNEE and REPORTER on a row there — a membership
    // they once had and no longer do is the real shape of this case, and the
    // attribution alone must not open the count back up.
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { assigneeId: user.id, reporterId: user.id },
    });

    const { workspace: mine } = await workspacesService.createWorkspace({
      name: 'Personal',
      ownerUserId: user.id,
    });

    const preview = await accountErasureService.previewAccountErasure(user.id);

    expect(preview.deleted.soleMemberWorkspaces).toEqual([{ id: mine.id, name: 'Personal' }]);
    expect(preview.deleted.projects).toBe(0);
    expect(preview.deleted.workItems).toBe(0);
    expect(preview.anonymised).toEqual({ comments: 0, workItems: 0 });
  });
});

describe('previewAccountErasure — it is a READ', () => {
  it('performs no write, opens no FOR UPDATE, and never calls the delete path to learn the block', async () => {
    const user = await createTestUser();
    const colleague = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: user.id,
    });
    const organizationId = await orgIdOfWorkspace(workspace.id);
    await organizationsService.addMember({
      organizationId,
      userId: colleague.id,
      role: 'member',
      actorUserId: user.id,
    });
    const fx = await fixtureFor(user.id, workspace.id, 'RO');
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Something' });
    await commentsService.addComment(item.id, { bodyMd: 'A comment' }, fx.ctx);

    // The delete paths the block must NOT be discovered through. Spied rather
    // than merely absent from the source: the card asks for the assertion
    // BECAUSE catching `LastOrgOwnerError` off a real removal is the obvious
    // implementation and the one the design rejects.
    const orgRemove = vi.spyOn(organizationsService, 'removeMember');
    const orgDemote = vi.spyOn(organizationsService, 'changeMemberRole');
    const wsDelete = vi.spyOn(workspacesService, 'deleteWorkspace');
    const wsRemove = vi.spyOn(workspacesService, 'removeMember');

    const probe = await probeReadOnly(() => accountErasureService.previewAccountErasure(user.id));

    try {
      // The block was still computed — a read that answered `false` here would
      // make the assertions below vacuous.
      expect(probe.result.blocked).toBe(true);

      expect(probe.writes).toEqual([]);
      expect(probe.rawSql.filter((sql) => /FOR\s+UPDATE/i.test(sql))).toEqual([]);
      // The contexts DID bind — otherwise every count above is a denial read as
      // absence, and "no writes" would be true of a preview that saw nothing.
      expect(probe.rawSql.some((sql) => sql.includes('set_config'))).toBe(true);

      expect(orgRemove).not.toHaveBeenCalled();
      expect(orgDemote).not.toHaveBeenCalled();
      expect(wsDelete).not.toHaveBeenCalled();
      expect(wsRemove).not.toHaveBeenCalled();
    } finally {
      orgRemove.mockRestore();
      orgDemote.mockRestore();
      wsDelete.mockRestore();
      wsRemove.mockRestore();
    }
  });
});
