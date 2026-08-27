import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { twoFactorPolicyService } from '@/lib/services/twoFactorPolicyService';
import { twoFactorPolicyRepository } from '@/lib/repositories/twoFactorPolicyRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { withUserContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { OrganizationNotFoundError, OrgForbiddenError } from '@/lib/organizations/errors';
import { NotAMemberError, WorkspaceForbiddenError } from '@/lib/workspaces/errors';
import { UserNotFoundError } from '@/lib/users/errors';
import {
  toOrganizationTwoFactorPolicyDTO,
  toTwoFactorRequirementDTO,
  toWorkspaceTwoFactorPolicyDTO,
} from '@/lib/mappers/twoFactorPolicyMappers';
import type { TwoFactorRequirementRow } from '@/lib/repositories/twoFactorPolicyRepository';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// Story MOTIR-1215 · Subtask MOTIR-3645 — the require-2FA policy layer.
//
// Real Postgres, and `@/lib/db` connects as the non-bypass `motir_app` role
// (MOTIR-2734 made that the suite's only connection), so the RLS policies
// execute against the code under test. Fixtures use `adminDb`, the owner
// client — the two-client model (MOTIR-2513).
//
// The block that matters most is *the admitting context*, at the bottom. Every
// other failure on this card would be loud; that one is a shorter list and a
// `required: false` for somebody who should have been held at the door.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;
const makeUser = (): Promise<{ id: string }> =>
  usersService.createUser({
    email: `two-factor-policy-${++seq}@example.com`,
    password: 'hunter2hunter2',
    name: 'Ada',
  });

/**
 * One org, one workspace, one owner — the shape every account starts in.
 * `createWorkspace` with no `organizationId` mints the org and both owner
 * memberships in one transaction, exactly as signup does.
 */
async function makeOrgWithWorkspace(name = 'Acme') {
  const owner = await makeUser();
  const { workspace } = await workspacesService.createWorkspace({
    name,
    ownerUserId: owner.id,
  });
  return { owner, workspace, organizationId: workspace.organizationId };
}

/** Set a tier's policy column directly — fixture setup, never the code under test. */
const setOrgColumn = (organizationId: string, requiresTwoFactor: boolean) =>
  adminDb.organization.update({ where: { id: organizationId }, data: { requiresTwoFactor } });
const setWorkspaceColumn = (workspaceId: string, requiresTwoFactor: boolean) =>
  adminDb.workspace.update({ where: { id: workspaceId }, data: { requiresTwoFactor } });

// ── The precedence rule, as a pure function ─────────────────────────────────
// Asserted on the mapper rather than through a database, so the four
// combinations read as an assertion about the RULE.

const row = (over: Partial<TwoFactorRequirementRow> = {}): TwoFactorRequirementRow => ({
  orgId: null,
  orgName: null,
  workspaceId: null,
  workspaceName: null,
  enabled: false,
  passkeyCount: 0,
  ...over,
});

describe('the precedence rule — all four combinations of the two booleans', () => {
  it('neither tier requires it ⇒ not required, nobody mandating', () => {
    const dto = toTwoFactorRequirementDTO(row());
    expect(dto.required).toBe(false);
    expect(dto.mandatedBy).toBeNull();
  });

  it('the WORKSPACE alone requires it ⇒ required, mandated by the workspace', () => {
    const dto = toTwoFactorRequirementDTO(row({ workspaceId: 'w1', workspaceName: 'Engineering' }));
    expect(dto.required).toBe(true);
    expect(dto.mandatedBy).toEqual({ tier: 'workspace', id: 'w1', name: 'Engineering' });
  });

  it('the ORGANIZATION alone requires it ⇒ required, mandated by the organization', () => {
    const dto = toTwoFactorRequirementDTO(row({ orgId: 'o1', orgName: 'Acme' }));
    expect(dto.required).toBe(true);
    expect(dto.mandatedBy).toEqual({ tier: 'organization', id: 'o1', name: 'Acme' });
  });

  it('BOTH require it ⇒ the ORGANIZATION is reported, because it is the floor', () => {
    // Naming the workspace here would tell the reader that switching the
    // workspace policy off would let them in. It would not.
    const dto = toTwoFactorRequirementDTO(
      row({ orgId: 'o1', orgName: 'Acme', workspaceId: 'w1', workspaceName: 'Engineering' }),
    );
    expect(dto.required).toBe(true);
    expect(dto.mandatedBy).toEqual({ tier: 'organization', id: 'o1', name: 'Acme' });
  });
});

describe('the policy DTO mappers', () => {
  it('an organization policy carries its id and its column', () => {
    expect(toOrganizationTwoFactorPolicyDTO({ id: 'o1', requiresTwoFactor: true })).toEqual({
      organizationId: 'o1',
      requiresTwoFactor: true,
    });
  });

  it('`lockedByOrganization` follows the ORG, in all four combinations', () => {
    // Including the one that is easy to collapse: locked while the workspace's
    // OWN column is already true. Losing that distinction is how turning the org
    // policy off would silently drop a requirement a workspace admin set.
    for (const orgRequires of [false, true]) {
      for (const workspaceRequires of [false, true]) {
        const dto = toWorkspaceTwoFactorPolicyDTO(
          { id: 'w1', requiresTwoFactor: workspaceRequires },
          orgRequires,
        );
        expect(dto).toEqual({
          workspaceId: 'w1',
          requiresTwoFactor: workspaceRequires,
          organizationRequiresTwoFactor: orgRequires,
          lockedByOrganization: orgRequires,
        });
      }
    }
  });
});

// ── resolveRequirement, against a real database ─────────────────────────────

describe('resolveRequirement', () => {
  it('is not required when no tier asks for it', async () => {
    const { owner } = await makeOrgWithWorkspace();
    const dto = await twoFactorPolicyService.resolveRequirement(owner.id);
    expect(dto).toEqual({ required: false, mandatedBy: null, compliant: false });
  });

  it('is required, and names the ORGANIZATION, when the org asks for it', async () => {
    const { owner, organizationId } = await makeOrgWithWorkspace('Acme');
    await setOrgColumn(organizationId, true);

    const dto = await twoFactorPolicyService.resolveRequirement(owner.id);
    expect(dto.required).toBe(true);
    expect(dto.mandatedBy).toEqual({ tier: 'organization', id: organizationId, name: 'Acme' });
  });

  it('is required, and names the WORKSPACE, when only a workspace asks for it', async () => {
    const { owner, workspace } = await makeOrgWithWorkspace('Acme');
    await setWorkspaceColumn(workspace.id, true);

    const dto = await twoFactorPolicyService.resolveRequirement(owner.id);
    expect(dto.required).toBe(true);
    expect(dto.mandatedBy).toEqual({
      tier: 'workspace',
      id: workspace.id,
      name: workspace.name,
    });
  });

  it('names the ORGANIZATION when both tiers ask, against the real query', async () => {
    const { owner, workspace, organizationId } = await makeOrgWithWorkspace('Acme');
    await setOrgColumn(organizationId, true);
    await setWorkspaceColumn(workspace.id, true);

    const dto = await twoFactorPolicyService.resolveRequirement(owner.id);
    expect(dto.mandatedBy?.tier).toBe('organization');
    expect(dto.mandatedBy?.id).toBe(organizationId);
  });

  it('ignores a tier the person does not belong to', async () => {
    // Somebody else's organization requiring 2FA is not this person's problem,
    // and a query that leaked it would hold half the product at the door.
    const mine = await makeOrgWithWorkspace('Mine');
    const theirs = await makeOrgWithWorkspace('Theirs');
    await setOrgColumn(theirs.organizationId, true);
    await setWorkspaceColumn(theirs.workspace.id, true);

    const dto = await twoFactorPolicyService.resolveRequirement(mine.owner.id);
    expect(dto.required).toBe(false);
  });

  it('reports COMPLIANT for a passkey with `twoFactorEnabled` false', async () => {
    // The explicit regression `lib/dto/twoFactor.ts` warns about: the account
    // MOTIR-1214 made the most secure is the one an `enabled` check locks out.
    const { owner, organizationId } = await makeOrgWithWorkspace();
    await setOrgColumn(organizationId, true);
    await adminDb.passkey.create({
      data: {
        id: `pk-${owner.id}`,
        userId: owner.id,
        publicKey: 'pk',
        credentialID: `cred-${owner.id}`,
        counter: 0,
        deviceType: 'singleDevice',
        backedUp: false,
      },
    });

    const dto = await twoFactorPolicyService.resolveRequirement(owner.id);
    expect(dto.required).toBe(true);
    expect(dto.compliant).toBe(true);
  });

  it('reports COMPLIANT for an account with two-factor enabled and no passkey', async () => {
    const { owner } = await makeOrgWithWorkspace();
    await adminDb.user.update({ where: { id: owner.id }, data: { twoFactorEnabled: true } });

    const dto = await twoFactorPolicyService.resolveRequirement(owner.id);
    expect(dto.compliant).toBe(true);
  });

  it('raises UserNotFoundError for an account that does not exist', async () => {
    await expect(twoFactorPolicyService.resolveRequirement('nobody')).rejects.toBeInstanceOf(
      UserNotFoundError,
    );
  });

  it('issues ONE statement beyond the context binding — it is on the hot path', async () => {
    // It runs in the `(authed)` layout on every signed-in page load and again on
    // every cookie-authenticated API call, so the round-trip count is a
    // contract, not a nicety.
    const { owner, organizationId } = await makeOrgWithWorkspace();
    await setOrgColumn(organizationId, true);

    const statements = await countStatements(() =>
      twoFactorPolicyService.resolveRequirement(owner.id),
    );

    // One `set_config` for `app.user_id`, then the single read.
    expect(statements.binding).toBe(1);
    expect(statements.reads).toBe(1);
  });
});

// ── ⚠️ THE ADMITTING CONTEXT ────────────────────────────────────────────────
// The card's own words: the failure here is silent and permissive. This block
// is built so the actor's VIEW and the true population differ — a user in two
// workspaces of one org where only the SECOND requires 2FA — and it asserts
// both directions: the shipped path answers correctly, and the wrongly-bound
// one returns the plausible shorter answer rather than an error.

describe('the admitting context — a user-bound read, not a workspace-bound one', () => {
  async function twoWorkspaceFixture() {
    const { owner, workspace: first, organizationId } = await makeOrgWithWorkspace('Acme');
    const { workspace: second } = await workspacesService.createWorkspace({
      name: 'Second',
      ownerUserId: owner.id,
      organizationId,
    });
    // Only the SECOND requires it, and the org does not.
    await setWorkspaceColumn(second.id, true);
    return { owner, first, second, organizationId };
  }

  it('resolves `required: true` from a workspace that is not the active one', async () => {
    const { owner, second } = await twoWorkspaceFixture();

    const dto = await twoFactorPolicyService.resolveRequirement(owner.id);

    expect(dto.required).toBe(true);
    expect(dto.mandatedBy).toEqual({ tier: 'workspace', id: second.id, name: 'Second' });
  });

  it('an UNBOUND transaction returns the plausible short answer — no error, no log', async () => {
    // The failure this binding exists to prevent, demonstrated rather than
    // described. With no `app.user_id`, the membership arms admit nothing: the
    // `user` row still comes back (that table carries no RLS at all), so the
    // query SUCCEEDS, both mandating ids are null, and `required` computes
    // FALSE for somebody who should have been held at the door. A refused write
    // would be loud; a denied read is a plausible subset.
    const { owner } = await twoWorkspaceFixture();

    const unbound = await db.$transaction((tx) =>
      twoFactorPolicyRepository.findRequirement(owner.id, tx),
    );
    expect(unbound).not.toBeNull();
    expect(unbound?.workspaceId).toBeNull();
    expect(toTwoFactorRequirementDTO(unbound!).required).toBe(false);

    const bound = await withUserContext(owner.id, (tx) =>
      twoFactorPolicyRepository.findRequirement(owner.id, tx),
    );
    expect(bound?.workspaceId).not.toBeNull();
    expect(toTwoFactorRequirementDTO(bound!).required).toBe(true);
  });

  it('a WORKSPACE-bound context would ALSO answer correctly — the policies are PERMISSIVE', async () => {
    // ⚠️ MEASURED, AND IT CORRECTS THE CARD. MOTIR-3645 predicted that binding
    // the wrong workspace would hide the mandating one, because `workspace`
    // would be "admitted only by `id = app.workspace_id`". It is not: RLS
    // policies are OR'd, and `withWorkspaceContext` binds `app.user_id` TOO, so
    // `workspace_membership_visible` still admits every workspace the person
    // belongs to. The load-bearing GUC is `app.user_id`, and the contexts that
    // fail are the ones which omit it — a bare transaction (above) or a
    // service-to-service context.
    //
    // `withUserContext` remains the right choice for the shipped path, for a
    // reason that survives this correction: it is the MINIMAL binding that
    // works, and the `(authed)` layout that calls it has not resolved an active
    // workspace yet, so there is no workspace id to bind.
    const { owner, first, second } = await twoWorkspaceFixture();

    const viaWorkspace = await withWorkspaceContext(
      { userId: owner.id, workspaceId: first.id },
      (tx) => twoFactorPolicyRepository.findRequirement(owner.id, tx),
    );
    expect(viaWorkspace?.workspaceId).toBe(second.id);
  });
});

// ── The setters ─────────────────────────────────────────────────────────────

describe('setOrganizationPolicy', () => {
  it('sets the absolute value an org owner asks for, and is idempotent', async () => {
    const { owner, organizationId } = await makeOrgWithWorkspace();

    const first = await twoFactorPolicyService.setOrganizationPolicy({
      organizationId,
      actorUserId: owner.id,
      requiresTwoFactor: true,
    });
    const again = await twoFactorPolicyService.setOrganizationPolicy({
      organizationId,
      actorUserId: owner.id,
      requiresTwoFactor: true,
    });

    expect(first).toEqual({ organizationId, requiresTwoFactor: true });
    expect(again).toEqual(first);

    const off = await twoFactorPolicyService.setOrganizationPolicy({
      organizationId,
      actorUserId: owner.id,
      requiresTwoFactor: false,
    });
    expect(off.requiresTwoFactor).toBe(false);
  });

  it('refuses a plain org MEMBER with OrgForbiddenError', async () => {
    const { organizationId } = await makeOrgWithWorkspace();
    const member = await makeUser();
    await adminDb.organizationMembership.create({
      data: { organizationId, userId: member.id, role: ORGANIZATION_ROLE.member },
    });

    await expect(
      twoFactorPolicyService.setOrganizationPolicy({
        organizationId,
        actorUserId: member.id,
        requiresTwoFactor: true,
      }),
    ).rejects.toBeInstanceOf(OrgForbiddenError);
  });

  it('refuses a NON-member with OrganizationNotFoundError — 404, not 403', async () => {
    const { organizationId } = await makeOrgWithWorkspace();
    const stranger = await makeUser();

    await expect(
      twoFactorPolicyService.setOrganizationPolicy({
        organizationId,
        actorUserId: stranger.id,
        requiresTwoFactor: true,
      }),
    ).rejects.toBeInstanceOf(OrganizationNotFoundError);
  });

  it('allows an org ADMIN, not only the owner', async () => {
    const { organizationId } = await makeOrgWithWorkspace();
    const admin = await makeUser();
    await adminDb.organizationMembership.create({
      data: { organizationId, userId: admin.id, role: ORGANIZATION_ROLE.admin },
    });

    const dto = await twoFactorPolicyService.setOrganizationPolicy({
      organizationId,
      actorUserId: admin.id,
      requiresTwoFactor: true,
    });
    expect(dto.requiresTwoFactor).toBe(true);
  });
});

describe('getOrganizationPolicy', () => {
  it('reads the org column for a member', async () => {
    const { owner, organizationId } = await makeOrgWithWorkspace();
    await setOrgColumn(organizationId, true);

    expect(await twoFactorPolicyService.getOrganizationPolicy(organizationId, owner.id)).toEqual({
      organizationId,
      requiresTwoFactor: true,
    });
  });

  it('is readable by a PLAIN member — they are owed the name of whoever is asking', async () => {
    const { organizationId } = await makeOrgWithWorkspace();
    const member = await makeUser();
    await adminDb.organizationMembership.create({
      data: { organizationId, userId: member.id, role: ORGANIZATION_ROLE.member },
    });
    await setOrgColumn(organizationId, true);

    const dto = await twoFactorPolicyService.getOrganizationPolicy(organizationId, member.id);
    expect(dto.requiresTwoFactor).toBe(true);
  });

  it('raises OrganizationNotFoundError for a non-member', async () => {
    const { organizationId } = await makeOrgWithWorkspace();
    const stranger = await makeUser();

    await expect(
      twoFactorPolicyService.getOrganizationPolicy(organizationId, stranger.id),
    ).rejects.toBeInstanceOf(OrganizationNotFoundError);
  });
});

describe('getWorkspacePolicy', () => {
  it('carries BOTH tiers, and locks when the organization requires it', async () => {
    const { owner, workspace, organizationId } = await makeOrgWithWorkspace();
    await setWorkspaceColumn(workspace.id, true);
    await setOrgColumn(organizationId, true);

    expect(await twoFactorPolicyService.getWorkspacePolicy(workspace.id, owner.id)).toEqual({
      workspaceId: workspace.id,
      requiresTwoFactor: true,
      organizationRequiresTwoFactor: true,
      lockedByOrganization: true,
    });
  });

  it('is unlocked, with the workspace value standing, when only the workspace asks', async () => {
    const { owner, workspace } = await makeOrgWithWorkspace();
    await setWorkspaceColumn(workspace.id, true);

    const dto = await twoFactorPolicyService.getWorkspacePolicy(workspace.id, owner.id);
    expect(dto.requiresTwoFactor).toBe(true);
    expect(dto.lockedByOrganization).toBe(false);
  });

  it('raises NotAMemberError for someone with no access', async () => {
    const { workspace } = await makeOrgWithWorkspace();
    const stranger = await makeUser();

    await expect(
      twoFactorPolicyService.getWorkspacePolicy(workspace.id, stranger.id),
    ).rejects.toBeInstanceOf(NotAMemberError);
  });
});

describe('setWorkspacePolicy', () => {
  it('sets the absolute value a workspace owner asks for, and is idempotent', async () => {
    const { owner, workspace } = await makeOrgWithWorkspace();

    const first = await twoFactorPolicyService.setWorkspacePolicy({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      requiresTwoFactor: true,
    });
    const again = await twoFactorPolicyService.setWorkspacePolicy({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      requiresTwoFactor: true,
    });

    expect(first.requiresTwoFactor).toBe(true);
    expect(again).toEqual(first);
  });

  it('refuses a workspace MEMBER and a workspace VIEWER with WorkspaceForbiddenError', async () => {
    for (const role of ['member', 'viewer'] as const) {
      const { workspace, organizationId } = await makeOrgWithWorkspace();
      const actor = await makeUser();
      await adminDb.organizationMembership.create({
        data: { organizationId, userId: actor.id, role: ORGANIZATION_ROLE.member },
      });
      await adminDb.workspaceMembership.create({
        data: { workspaceId: workspace.id, userId: actor.id, role },
      });

      await expect(
        twoFactorPolicyService.setWorkspacePolicy({
          workspaceId: workspace.id,
          actorUserId: actor.id,
          requiresTwoFactor: true,
        }),
      ).rejects.toBeInstanceOf(WorkspaceForbiddenError);
    }
  });

  it('allows a workspace ADMIN — `WORKSPACE_ROLE` would have refused them', async () => {
    // `lib/workspaces/roles.ts`'s constant carries only `owner` and `member`, so
    // gating on it refuses a workspace `admin`. This is the case that catches it.
    const { workspace, organizationId } = await makeOrgWithWorkspace();
    const admin = await makeUser();
    await adminDb.organizationMembership.create({
      data: { organizationId, userId: admin.id, role: ORGANIZATION_ROLE.member },
    });
    await adminDb.workspaceMembership.create({
      data: { workspaceId: workspace.id, userId: admin.id, role: 'admin' },
    });

    const dto = await twoFactorPolicyService.setWorkspacePolicy({
      workspaceId: workspace.id,
      actorUserId: admin.id,
      requiresTwoFactor: true,
    });
    expect(dto.requiresTwoFactor).toBe(true);
  });

  it('allows an ORG admin holding NO workspace membership row', async () => {
    const { workspace, organizationId } = await makeOrgWithWorkspace();
    const orgAdmin = await makeUser();
    await adminDb.organizationMembership.create({
      data: { organizationId, userId: orgAdmin.id, role: ORGANIZATION_ROLE.admin },
    });

    const dto = await twoFactorPolicyService.setWorkspacePolicy({
      workspaceId: workspace.id,
      actorUserId: orgAdmin.id,
      requiresTwoFactor: true,
    });
    expect(dto.requiresTwoFactor).toBe(true);
    expect(
      (await adminDb.workspaceMembership.findFirst({
        where: { workspaceId: workspace.id, userId: orgAdmin.id },
      })) === null,
    ).toBe(true);
  });

  it('raises NotAMemberError for someone with no access', async () => {
    const { workspace } = await makeOrgWithWorkspace();
    const stranger = await makeUser();

    await expect(
      twoFactorPolicyService.setWorkspacePolicy({
        workspaceId: workspace.id,
        actorUserId: stranger.id,
        requiresTwoFactor: true,
      }),
    ).rejects.toBeInstanceOf(NotAMemberError);
  });

  it('reports the org tier back, so the caller can render the locked state', async () => {
    const { owner, workspace, organizationId } = await makeOrgWithWorkspace();
    await setOrgColumn(organizationId, true);

    const dto = await twoFactorPolicyService.setWorkspacePolicy({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      requiresTwoFactor: true,
    });
    expect(dto.organizationRequiresTwoFactor).toBe(true);
    expect(dto.lockedByOrganization).toBe(true);
  });
});

// ── The defensive arms ──────────────────────────────────────────────────────
// Three `if (!row)` throws guard a row VANISHING between the access gate and
// the read that follows it inside the same transaction. They are unreachable
// from a fixture, and leaving them unexercised is how a defensive arm quietly
// becomes a `TypeError` on a null field the day it does fire — so each is
// driven by making its own repository return null, the one cross-layer reach
// `CLAUDE.md` sanctions for tests.

describe('a row that vanishes mid-transaction raises a typed error, never a TypeError', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getWorkspacePolicy — the workspace row', async () => {
    const { owner, workspace } = await makeOrgWithWorkspace();
    vi.spyOn(workspaceRepository, 'findByIdInTx').mockResolvedValue(null);

    await expect(
      twoFactorPolicyService.getWorkspacePolicy(workspace.id, owner.id),
    ).rejects.toBeInstanceOf(NotAMemberError);
  });

  it('getWorkspacePolicy — the organization row', async () => {
    const { owner, workspace } = await makeOrgWithWorkspace();
    vi.spyOn(organizationRepository, 'findByIdInTx').mockResolvedValue(null);

    await expect(
      twoFactorPolicyService.getWorkspacePolicy(workspace.id, owner.id),
    ).rejects.toBeInstanceOf(OrganizationNotFoundError);
  });

  it('setWorkspacePolicy — the organization row, AFTER the write', async () => {
    const { owner, workspace } = await makeOrgWithWorkspace();
    vi.spyOn(organizationRepository, 'findByIdInTx').mockResolvedValue(null);

    await expect(
      twoFactorPolicyService.setWorkspacePolicy({
        workspaceId: workspace.id,
        actorUserId: owner.id,
        requiresTwoFactor: true,
      }),
    ).rejects.toBeInstanceOf(OrganizationNotFoundError);
  });
});

describe('the service surface', () => {
  it('exposes exactly the five methods, and NO toggle', async () => {
    // A toggle is a read-derived write: two admins flipping at once both invert
    // the value they read, and the winner is whichever commit landed last — a
    // policy nobody chose. The absence is a decision, so it is asserted.
    expect(Object.keys(twoFactorPolicyService).sort()).toEqual([
      'getOrganizationPolicy',
      'getWorkspacePolicy',
      'resolveRequirement',
      'setOrganizationPolicy',
      'setWorkspacePolicy',
    ]);
  });
});

// ── Statement counting ──────────────────────────────────────────────────────
// `tests/helpers/countDelegateCalls.ts` counts a MODEL DELEGATE, and the hot
// read is a `$queryRaw`, so this counts by the same mechanism one level over:
// intercept `db.$transaction` and proxy the client it hands the callback,
// separating the GUC binds (`$executeRaw`) from the reads.

async function countStatements(fn: () => Promise<unknown>): Promise<{
  binding: number;
  reads: number;
}> {
  const real = db.$transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
  let binding = 0;
  let reads = 0;

  const proxy = (tx: object): object =>
    new Proxy(tx, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== 'function') return value;
        if (prop === '$executeRaw' || prop === '$executeRawUnsafe') {
          return (...args: unknown[]) => {
            binding += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        if (prop === '$queryRaw' || prop === '$queryRawUnsafe') {
          return (...args: unknown[]) => {
            reads += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });

  const spy = db.$transaction as unknown as { bind: unknown };
  void spy;
  (db as unknown as { $transaction: unknown }).$transaction = ((...args: unknown[]) => {
    const [first] = args;
    if (typeof first !== 'function') return real(...args);
    return real((tx: object) => (first as (t: object) => unknown)(proxy(tx)), ...args.slice(1));
  }) as unknown;

  try {
    await fn();
  } finally {
    (db as unknown as { $transaction: unknown }).$transaction = real;
  }
  return { binding, reads };
}
