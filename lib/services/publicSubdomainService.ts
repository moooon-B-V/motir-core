import type { Prisma } from '@/generated/prisma/client';

import { isCloud } from '@/lib/billing/availability';
import type { PublicSubdomainDto, RetiredSubdomainDto } from '@/lib/dto/publicAddresses';
import {
  HostnameTakenError,
  NoSubdomainClaimedError,
  PublicAddressesUnavailableError,
  ReservedLabelError,
  SubdomainForbiddenError,
  SubdomainRenameCapReachedError,
  WorkspaceNotVisibleError,
} from '@/lib/publicAddresses/errors';
import { hostnameReservationHash } from '@/lib/publicAddresses/hostnameReservation';
import { MAX_SUBDOMAIN_RENAMES, refuseLabel } from '@/lib/publicAddresses/reservedNames';
import { tenantBaseDomain, tenantHostname } from '@/lib/publicAddresses/tenantDomain';
import { publicAddressRepository } from '@/lib/repositories/publicAddressRepository';
import { publicHostnameReservationRepository } from '@/lib/repositories/publicHostnameReservationRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { readMembership } from '@/lib/workspaces/membershipGate';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// A WORKSPACE'S TENANT SUBDOMAIN — claim it, rename it, read it back.
// Story MOTIR-3878 · Subtask MOTIR-4215. `docs/decisions/public-tenant-addresses.md`
// §3 (a subdomain names a WORKSPACE), §8 (never released, capped), §11 (cloud).
//
// This is the FREE tier's address and it works on every tier. Custom domains are
// MOTIR-4216's; nothing here touches a certificate, because the wildcard
// `*.<base>` already covers every label (ADR §6) — claiming one writes a row.
//
// ── AUTHORISATION: a WORKSPACE resource, not a project one ─────────────────
//
// The address names the workspace, so the gate is the workspace membership's
// ROLE — `owner` or `admin` on `MemberRole` — and NOT project `canManage`. A
// project admin who is an ordinary member of the workspace must not be able to
// rename an address every other project in that workspace answers under.
//
// ⚠️ The role test is written against `MemberRole` (`owner` | `admin` | `member`
// | `viewer`, the schema's enum) rather than against `lib/workspaces/roles.ts`'s
// `WORKSPACE_ROLE`, which is a NARROWER legacy constant carrying only
// `owner` / `member` — its own comment says it "only materializes the owner tier
// the replay gate depends on". Using it here would silently refuse every
// workspace `admin`.
//
// The two refusals are deliberately different: a MEMBER gets 403 (they can see
// the workspace, so telling them the control is admin-only leaks nothing and is
// the answer they need), a NON-MEMBER gets 404 (the no-existence-leak posture
// the rest of the tenancy boundary takes).
//
// ── CONCURRENCY: lock the WORKSPACE row, then read ─────────────────────────
//
// Two admins claiming at once is the warm-pool TOCTOU `entitlementsService`'s
// header describes. The workspace row is the single row all of one workspace's
// claims contend on, so it is the anchor — and the `hostname` unique index is
// the SECOND line of defence for the cross-workspace race the row lock cannot
// see (two different workspaces claiming one label lock two different rows).
// Both are needed and neither is redundant.

/** Roles that may change a workspace's public address. */
const ADDRESS_ADMIN_ROLES = new Set(['owner', 'admin']);

/**
 * Whether a workspace ROLE may change the address — the predicate the settings
 * pane's read-only arm asks (MOTIR-4221, design panel 8).
 *
 * ⚠️ EXPORTED SO THE RULE HAS ONE HOME. The pane has to decide whether to render
 * controls at all, and the alternative was a second `['owner', 'admin']` in a
 * page component — a copy of a security-shaped rule that drifts silently, since
 * the copy going stale shows up as controls that appear and then refuse. This is
 * presentation only: {@link assertAddressAdmin} still enforces on every write.
 */
export function roleMayManageAddress(role: string): boolean {
  return ADDRESS_ADMIN_ROLES.has(role);
}

export const publicSubdomainService = {
  /**
   * The workspace's subdomain, or `null` when it has never claimed one.
   *
   * Readable by any workspace member — an address is not a secret from the team
   * that answers at it, and the pane needs it to render the read-only arm.
   */
  async getForWorkspace(
    workspaceId: string,
    actorUserId: string,
  ): Promise<PublicSubdomainDto | null> {
    assertAvailable();
    await assertMember(workspaceId, actorUserId);
    const addresses = await withWorkspaceContext({ userId: actorUserId, workspaceId }, (tx) =>
      publicAddressRepository.listForWorkspaceInTx(workspaceId, tx),
    );
    return toDto(addresses);
  },

  /**
   * Claim a label for a workspace that has none.
   *
   * ONE transaction: lock, re-read under the lock, validate, write. The re-read
   * is the point of the lock — a claim decided from a read taken before it is a
   * decision about a state that may already be gone.
   */
  async claim(
    workspaceId: string,
    label: string,
    actorUserId: string,
  ): Promise<PublicSubdomainDto> {
    assertAvailable();
    await assertAddressAdmin(workspaceId, actorUserId);
    assertLabelClaimable(label);

    return withWorkspaceContext({ userId: actorUserId, workspaceId }, async (tx) => {
      await lockWorkspaceOrRefuse(workspaceId, tx);
      const live = await publicAddressRepository.findLiveSubdomainForWorkspace(workspaceId, tx);
      if (live) {
        // Already claimed — a claim is not a rename, and quietly turning one
        // into the other would spend a rename from the cap without saying so.
        throw new HostnameTakenError(live.hostname);
      }
      const hostname = tenantHostname(label);
      await publicAddressRepository.createSubdomain({ workspaceId, hostname }, tx);
      await assertNotReserved(hostname, tx);
      const addresses = await publicAddressRepository.listForWorkspaceInTx(workspaceId, tx);
      return toDto(addresses)!;
    });
  },

  /**
   * Rename the workspace's subdomain, retaining the old label FOR EVER.
   *
   * The retirement and the new claim are ONE transaction, so there is no instant
   * at which the workspace has two live subdomains or none.
   */
  async rename(
    workspaceId: string,
    newLabel: string,
    actorUserId: string,
  ): Promise<PublicSubdomainDto> {
    assertAvailable();
    await assertAddressAdmin(workspaceId, actorUserId);
    assertLabelClaimable(newLabel);

    return withWorkspaceContext({ userId: actorUserId, workspaceId }, async (tx) => {
      await lockWorkspaceOrRefuse(workspaceId, tx);
      const live = await publicAddressRepository.findLiveSubdomainForWorkspace(workspaceId, tx);
      if (!live) throw new NoSubdomainClaimedError();

      const used = await publicAddressRepository.countAliasesForWorkspace(workspaceId, tx);
      if (used >= MAX_SUBDOMAIN_RENAMES) {
        throw new SubdomainRenameCapReachedError(used, MAX_SUBDOMAIN_RENAMES);
      }

      const hostname = tenantHostname(newLabel);
      if (hostname === live.hostname) {
        // Renaming to the name you already hold would burn a rename from the cap
        // and write an alias row pointing at itself. Refused as taken, which is
        // what it is.
        throw new HostnameTakenError(hostname);
      }

      // ORDER MATTERS: retire first, then claim. The reverse would hold two
      // `workspace_subdomain` rows for an instant — a state
      // `findLiveSubdomainForWorkspace` resolves arbitrarily.
      await publicAddressRepository.retireSubdomainToAlias(live.id, tx);
      await publicAddressRepository.createSubdomain({ workspaceId, hostname }, tx);
      await assertNotReserved(hostname, tx);

      const addresses = await publicAddressRepository.listForWorkspaceInTx(workspaceId, tx);
      return toDto(addresses)!;
    });
  },
};

// ── Internals ──────────────────────────────────────────────────────────────

/** Public addresses are a cloud capability — ABSENT off-cloud, not hidden. */
function assertAvailable(): void {
  if (!isCloud()) throw new PublicAddressesUnavailableError();
}

async function assertMember(workspaceId: string, actorUserId: string): Promise<string> {
  const membership = await readMembership(actorUserId, workspaceId);
  if (!membership) throw new WorkspaceNotVisibleError();
  return membership.role;
}

async function assertAddressAdmin(workspaceId: string, actorUserId: string): Promise<void> {
  const role = await assertMember(workspaceId, actorUserId);
  if (!ADDRESS_ADMIN_ROLES.has(role)) throw new SubdomainForbiddenError();
}

/** Refuse a label the ADR §8 grammar or reserved set rejects. */
function assertLabelClaimable(label: string): void {
  const refusal = refuseLabel(label);
  if (refusal) throw new ReservedLabelError(label, refusal);
}

/**
 * Refuse a hostname a DELETED workspace retired — the second half of ADR §8's
 * never-released rule (Bug MOTIR-4366).
 *
 * The first half is the `public_address.hostname` unique index, which holds a
 * name for as long as its row exists. This is the half that holds it once the
 * row is gone: `workspacesService.deleteWorkspace` writes a digest into
 * `public_hostname_reservation` before the cascade takes the addresses, and this
 * is what reads it back.
 *
 * ⚠️ CALLED AFTER THE INSERT, NOT BEFORE IT, AND THE ORDER IS THE RACE
 * ARGUMENT. Checked BEFORE, this would be a count-then-write — the exact shape
 * the model's own comment says the global unique exists to avoid — with a real
 * window: a workspace delete committing between the check and the insert frees
 * a name we have already decided is free. Checked AFTER, the window closes by
 * construction. Our insert holds the `hostname` slot, so no other row carried
 * that hostname at insert time; any deletion that could reserve it must
 * therefore have removed its own row BEFORE our insert, hence committed before
 * it, hence is visible to this read under READ COMMITTED. Throwing rolls the
 * whole transaction back, so the refusal costs the caller nothing.
 *
 * `HostnameTakenError`, not a fourth error: `errors.ts` is explicit that the
 * situations behind a taken hostname are deliberately NOT distinguished, and
 * "held by a workspace that no longer exists" is the one a claimer has least
 * business being told about.
 */
async function assertNotReserved(hostname: string, tx: Prisma.TransactionClient): Promise<void> {
  const reserved = await publicHostnameReservationRepository.isReservedInTx(
    hostnameReservationHash(hostname),
    tx,
  );
  if (reserved) throw new HostnameTakenError(hostname);
}

/**
 * Take the workspace row lock, and REFUSE when it matched nothing.
 *
 * A `SELECT … FOR UPDATE` over zero rows locks nothing and reports success, so
 * ignoring the result gives a guard that silently does not serialize — the
 * failure `entitlementsService`'s `lockOrgRowOrRefuse` was written against. A
 * workspace that vanished mid-request is a 404, which is what the caller sees.
 */
async function lockWorkspaceOrRefuse(
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (!(await workspaceRepository.lockByIdForUpdate(workspaceId, tx))) {
    throw new WorkspaceNotVisibleError();
  }
}

/** The label half of `<label>.<base>`. */
function labelOf(hostname: string): string {
  const base = tenantBaseDomain();
  return hostname.endsWith(`.${base}`) ? hostname.slice(0, -(base.length + 1)) : hostname;
}

/**
 * Map the workspace's address rows to the DTO.
 *
 * `null` when there is no LIVE subdomain — which includes the case of a
 * workspace holding only aliases. That cannot happen through this service (a
 * rename always claims), and the mapping still handles it rather than asserting
 * it away, because an unreachable branch that returns `null` is cheaper than one
 * that throws in production if the assumption ever stops holding.
 */
function toDto(
  addresses: Array<{ hostname: string; kind: string; createdAt: Date; updatedAt: Date }>,
): PublicSubdomainDto | null {
  const live = addresses.find((a) => a.kind === 'workspace_subdomain');
  if (!live) return null;
  const aliases: RetiredSubdomainDto[] = addresses
    .filter((a) => a.kind === 'workspace_subdomain_alias')
    // `updatedAt`, not `createdAt`: an alias was CREATED when the workspace
    // first claimed that label and RETIRED when the rename moved off it, and
    // those are different dates — often months apart. `retireSubdomainToAlias`
    // is the write that stamps `updatedAt`, so it is the retirement's clock.
    .map((a) => ({ hostname: a.hostname, retiredAt: a.updatedAt.toISOString() }));
  return {
    label: labelOf(live.hostname),
    hostname: live.hostname,
    url: `https://${live.hostname}`,
    claimedAt: live.createdAt.toISOString(),
    aliases,
    renamesLeft: Math.max(0, MAX_SUBDOMAIN_RENAMES - aliases.length),
  };
}
