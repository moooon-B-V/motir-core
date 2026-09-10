import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMotirOwnedRepo } from '@/lib/ciMetering/config';
import { isMotirHostedOwner } from '@/lib/git/hostOwnership';
import { toOrgRepoOptionDto } from '@/lib/mappers/organizationRepoMappers';
import type { GithubRepo } from '@/generated/prisma/client';

// WHOSE IS THIS REPOSITORY — asked at TWO TIERS, answered ONCE (bug MOTIR-4892).
//
// `/settings/organization/git` (the inventory) and the CI meter's §5.1 gate both
// have to sort a repository into *the organisation's* or *Motir's*, and until
// MOTIR-4892 they did it with two implementations. The columns each tier reads —
// `github_repo.workspace_id` and `github_repo.organization_id` — answer *"can this
// tenant dispatch into it?"*, deliberately (MOTIR-1931, MOTIR-4649), and NEITHER
// answers the ownership question the surfaces were putting to them. The only fact
// that does is the OWNER LOGIN, and `lib/git/hostOwnership.ts` is where that
// comparison is spelled, once.
//
// So this file holds two claims, and it is PURE: no database, no render. Both are
// properties of the classification itself.
//
//   1. The inventory's DTO can TELL THEM APART — by a field the row can draw,
//      case-insensitively, and with a no-provisioning-org arm that classifies
//      nothing.
//   2. The two surfaces AGREE, over one fixture holding both kinds — asserted as a
//      captured comparison of the two answers, not as two separate expectations
//      that happen to be written next to each other.
//
// ── ⚠️ RE-POINTED BY MOTIR-4998, AND WHICH PAIR THIS IS NOW ──────────────────
// Claim 2 used to compare the inventory against the project ROOM, whose
// `lib/projectRepos/roomSections.ts` answered by SUBTRACTING the hosted entries
// from the repositories the scope ladder layered in (bug MOTIR-4867). That rung is
// retired (MOTIR-4955) and the room stopped drawing the layered list (MOTIR-4954),
// so those helpers had no production caller left and MOTIR-4998 deleted them.
//
// **The PROPERTY is not retired with them, because the room was never its only
// asker.** `hostOwnership.ts`'s own header names THREE, and the other two are
// live: the inventory (`lib/mappers/organizationRepoMappers.ts`) and the CI meter
// (`lib/ciMetering/config.ts`). So claim 2 now pins THOSE two against each other.
//
// ⚠️ AND THIS PAIR IS THE STRONGER ONE, WHICH IS WHY IT WAS PREFERRED OVER
// RE-POINTING AT `isMotirHostedOwner` ITSELF. Asserting the predicate against the
// predicate is a tautology: it cannot fail while the two SURFACES drift. What made
// the original test load-bearing is that each tier derives the predicate's INPUTS
// from a different place, so a captured comparison is the only thing that catches
// one of them changing where it reads from. Here the two differ on BOTH inputs:
//
//   - the inventory reads the owner from the STORED MIRROR (`GithubRepo.owner`)
//     and is HANDED `hostOwner` by its caller;
//   - the CI meter reads the owner from THE RUN'S OWN PAYLOAD — never the mirror,
//     which §5.5 forbids because the mirror can hold a pre-transfer owner until a
//     webhook reconciles it — and reads `hostOwner` from the ENVIRONMENT itself,
//     via `provisioningOrgLogin()`.
//
// Two different owner sources and two different host-owner sources, one predicate,
// one answer required. That is the divergence MOTIR-4867 and MOTIR-4892 were both
// filed about, and it is what this file still detects.

/** The provisioning organisation, as an operator typed it into the env. */
const HOST_OWNER = 'motir-projects';

afterEach(() => {
  vi.unstubAllEnvs();
});

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
    vi.stubEnv('GITHUB_FALLBACK_ORG', HOST_OWNER);

    // ⚠️ A CAPTURED COMPARISON, not two assertions side by side. Each surface is
    // asked its own question through its own entry point, from its own owner
    // source, and the two ANSWERS are diffed — which is the only form that can
    // fail when one of them drifts. The inventory answers by CLASSIFICATION off
    // the stored mirror (`hostedByMotir`, MOTIR-4892); the CI meter answers off
    // the RUN's payload and the environment (`isMotirOwnedRepo`, §5.1). Two
    // different renderings of one predicate, and the predicate is
    // `isMotirHostedOwner`.
    const inventorySaysOrganisations = FIXTURE.map((r) =>
      toOrgRepoOptionDto(repoRow(r.owner, r.name), HOST_OWNER),
    )
      .filter((dto) => !dto.hostedByMotir)
      .map((dto) => dto.fullName);

    const meterSaysOrganisations = FIXTURE.filter((r) => !isMotirOwnedRepo(r.owner)).map(
      (r) => `${r.owner}/${r.name}`,
    );

    expect(inventorySaysOrganisations).toEqual(meterSaysOrganisations);
    expect(meterSaysOrganisations).toEqual(['moooon/motir-core', 'moooon/motir-gateway']);

    // …and the fixture really did hold both kinds, so the agreement above is not
    // two empty sets agreeing.
    expect(
      FIXTURE.filter((r) => isMotirOwnedRepo(r.owner)).map((r) => `${r.owner}/${r.name}`),
    ).toEqual([`${HOST_OWNER}/motir`]);
  });

  it('agrees in the NO-PROVISIONING-ORG case too — both surfaces call every row the organisation`s', () => {
    // The arm that must not diverge quietly: with nothing hosted, the meter
    // classifies nothing and the inventory classifies nothing, so both name the
    // whole fixture. A surface that hard-coded a login would fail exactly here.
    vi.stubEnv('GITHUB_FALLBACK_ORG', undefined);

    const inventory = FIXTURE.map((r) => toOrgRepoOptionDto(repoRow(r.owner, r.name), null))
      .filter((dto) => !dto.hostedByMotir)
      .map((dto) => dto.fullName);
    const meter = FIXTURE.filter((r) => !isMotirOwnedRepo(r.owner)).map(
      (r) => `${r.owner}/${r.name}`,
    );

    expect(inventory).toEqual(meter);
    expect(meter).toHaveLength(FIXTURE.length);
  });

  it('⚠️ agrees on CASING too — the two read their host owner from different places', () => {
    // The case the pair exists to catch, and the one the old room/inventory pair
    // could not state: the inventory is HANDED `hostOwner` by its caller while the
    // meter reads `GITHUB_FALLBACK_ORG` itself. Give the two spellings that differ
    // only in case and they must still answer identically — a tier that started
    // comparing exactly, or stopped trimming, fails here and nowhere else.
    vi.stubEnv('GITHUB_FALLBACK_ORG', '  MOTIR-Projects  ');

    const inventory = FIXTURE.map((r) =>
      toOrgRepoOptionDto(repoRow(r.owner, r.name), 'motir-projects'),
    )
      .filter((dto) => !dto.hostedByMotir)
      .map((dto) => dto.fullName);
    const meter = FIXTURE.filter((r) => !isMotirOwnedRepo(r.owner)).map(
      (r) => `${r.owner}/${r.name}`,
    );

    expect(inventory).toEqual(meter);
    expect(meter).toEqual(['moooon/motir-core', 'moooon/motir-gateway']);
  });
});
