import { describe, expect, it } from 'vitest';
import { isMotirHostedOwner } from '@/lib/git/hostOwnership';
import { toOrgRepoOptionDto } from '@/lib/mappers/organizationRepoMappers';
import { organizationConnected } from '@/lib/projectRepos/roomSections';
import type { GithubRepo } from '@/generated/prisma/client';
import type { ProjectRepoConnectedDto } from '@/lib/dto/projectRepos';

// WHOSE IS THIS REPOSITORY — asked at TWO TIERS, answered ONCE (bug MOTIR-4892).
//
// `/settings/organization/git` (the inventory) and `/settings/project/repositories`
// (the room) both have to sort a repository into *the organisation's* or *Motir's*,
// and until this card they did it with two implementations and one of them did not
// exist: the room subtracted the hosted rows (MOTIR-4867) while the inventory drew
// every row stamped with the organisation's id and offered every one of them a
// `Disconnect`. Both reads are correct about what they read —
// `github_repo.workspace_id` and `github_repo.organization_id` answer *"can this
// tenant dispatch into it?"*, deliberately (MOTIR-1931, MOTIR-4649) — and NEITHER
// answers the ownership question the two surfaces were putting to them.
//
// So this file holds the two claims the card's criteria 1 and 4 make, and it is
// PURE: no database, no render. Both are properties of the classification itself.
//
//   1. The inventory's DTO can TELL THEM APART — by a field the row can draw,
//      case-insensitively, and with a no-provisioning-org arm that classifies
//      nothing.
//   2. The two surfaces AGREE, over one fixture holding both kinds — asserted as a
//      captured comparison of the two answers, not as two separate expectations
//      that happen to be written next to each other.

/** The provisioning organisation, as an operator typed it into the env. */
const HOST_OWNER = 'motir-projects';

/** A `github_repo` row, only the columns the mapper reads. */
const repoRow = (owner: string, name: string): GithubRepo =>
  ({
    id: `${owner}/${name}`,
    installationId: 'inst-1',
    workspaceId: 'ws1',
    organizationId: 'org1',
    repoId: `r-${name}`,
    owner,
    name,
    defaultBranch: 'main',
    provider: 'github',
    archived: false,
  }) as unknown as GithubRepo;

/** The same repository as the ROOM's domain read hands it over — `owner/name` in
 *  a `repoRef`, because `ProjectRepoConnectedDto` carries no `owner` column. */
const connected = (owner: string, name: string): ProjectRepoConnectedDto =>
  ({ repoRef: `${owner}/${name}`, name }) as unknown as ProjectRepoConnectedDto;

/**
 * ONE FIXTURE, BOTH KINDS — two repositories the organisation connected and one
 * MOTIR hosts, in the two shapes the two surfaces read them in. Every assertion
 * below is over this list, so the two tiers cannot be compared on two different
 * populations.
 */
const FIXTURE = [
  { owner: 'moooon', name: 'motir-core' },
  { owner: HOST_OWNER, name: 'motir' },
  { owner: 'moooon', name: 'motir-gateway' },
];

describe('the inventory classifies a row by OWNERSHIP (criterion 1)', () => {
  it('returns two rows a consumer can TELL APART, by a field the row draws', () => {
    const hosted = toOrgRepoOptionDto(repoRow(HOST_OWNER, 'motir'), HOST_OWNER);
    const theirs = toOrgRepoOptionDto(repoRow('moooon', 'motir-core'), HOST_OWNER);

    expect(hosted.hostedByMotir).toBe(true);
    expect(theirs.hostedByMotir).toBe(false);

    // ⚠️ AND THE FIELD IS WHAT DISTINGUISHES THEM, which is the criterion rather
    // than a restatement of the two lines above. Before it, the two DTOs differed
    // ONLY in fields that say nothing about ownership — `connectedFromWorkspaceId`
    // is documented as provenance and names the customer's workspace for BOTH —
    // so the row could not have been drawn differently even if the list had
    // wanted to.
    const withoutOwnership = ({ hostedByMotir: _drop, ...rest }: typeof hosted) => rest;
    expect(withoutOwnership(hosted)).toEqual({
      ...withoutOwnership(theirs),
      id: hosted.id,
      owner: HOST_OWNER,
      name: 'motir',
      fullName: `${HOST_OWNER}/motir`,
    });
    expect(hosted.connectedFromWorkspaceId).toBe(theirs.connectedFromWorkspaceId);
  });

  it('compares case-INSENSITIVELY — a login`s casing is not part of its identity', () => {
    // The env value is whatever an operator typed; the row's casing is whatever
    // the webhook payload echoed. Neither is authoritative over the other.
    expect(toOrgRepoOptionDto(repoRow('Motir-Projects', 'motir'), 'motir-projects')).toMatchObject({
      hostedByMotir: true,
    });
    expect(toOrgRepoOptionDto(repoRow('motir-projects', 'motir'), 'MOTIR-PROJECTS')).toMatchObject({
      hostedByMotir: true,
    });
  });

  it('⚠️ classifies NOTHING when there is no provisioning org — byte-for-byte today`s answer', () => {
    // A deployment that cannot provision (self-hosted, no `GITHUB_FALLBACK_ORG`)
    // hosts no repositories. `null` is the ANSWER, not a missing input, and the
    // empty string is the same answer arriving through an env var an operator
    // left blank.
    for (const hostOwner of [null, '', '   ']) {
      expect(toOrgRepoOptionDto(repoRow(HOST_OWNER, 'motir'), hostOwner)).toMatchObject({
        hostedByMotir: false,
      });
    }
    expect(isMotirHostedOwner(null, HOST_OWNER)).toBe(false);
    expect(isMotirHostedOwner(undefined, HOST_OWNER)).toBe(false);
  });
});

describe('the two surfaces AGREE about which repositories are the organisation`s (criterion 4)', () => {
  it('answers the same set over ONE fixture holding both kinds', () => {
    // ⚠️ A CAPTURED COMPARISON, not two assertions side by side. Each surface is
    // asked its own question through its own entry point, in its own DTO shape,
    // and the two ANSWERS are diffed — which is the only form that can fail when
    // one of them drifts. The room answers by SUBTRACTION (`organizationConnected`,
    // MOTIR-4867); the inventory answers by CLASSIFICATION (`hostedByMotir`,
    // MOTIR-4892). Two different renderings of one predicate, and the predicate is
    // `isMotirHostedOwner`.
    const roomSaysOrganisations = organizationConnected(
      FIXTURE.map((r) => connected(r.owner, r.name)),
      HOST_OWNER,
    ).map((r) => r.repoRef);

    const inventorySaysOrganisations = FIXTURE.map((r) =>
      toOrgRepoOptionDto(repoRow(r.owner, r.name), HOST_OWNER),
    )
      .filter((dto) => !dto.hostedByMotir)
      .map((dto) => dto.fullName);

    expect(inventorySaysOrganisations).toEqual(roomSaysOrganisations);
    expect(roomSaysOrganisations).toEqual(['moooon/motir-core', 'moooon/motir-gateway']);

    // …and the fixture really did hold both kinds, so the agreement above is not
    // two empty sets agreeing.
    expect(
      FIXTURE.map((r) => toOrgRepoOptionDto(repoRow(r.owner, r.name), HOST_OWNER))
        .filter((dto) => dto.hostedByMotir)
        .map((dto) => dto.fullName),
    ).toEqual([`${HOST_OWNER}/motir`]);
  });

  it('agrees in the NO-PROVISIONING-ORG case too — both surfaces call every row the organisation`s', () => {
    // The arm that must not diverge quietly: with nothing hosted, the room
    // subtracts nothing and the inventory classifies nothing, so both name the
    // whole fixture. A surface that hard-coded a login would fail exactly here.
    const room = organizationConnected(
      FIXTURE.map((r) => connected(r.owner, r.name)),
      null,
    ).map((r) => r.repoRef);
    const inventory = FIXTURE.map((r) => toOrgRepoOptionDto(repoRow(r.owner, r.name), null))
      .filter((dto) => !dto.hostedByMotir)
      .map((dto) => dto.fullName);

    expect(inventory).toEqual(room);
    expect(room).toHaveLength(FIXTURE.length);
  });
});
