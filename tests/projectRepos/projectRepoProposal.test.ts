import { describe, expect, it } from 'vitest';

import {
  deriveRepoSetProposal,
  platformToRepoRole,
  proposedRepoName,
  seedSourceForRole,
  type ProposedRepoRow,
} from '@/lib/projectRepos/proposal';
import {
  PROJECT_REPO_PROPOSAL_SIGNALS,
  PROJECT_REPO_ROLES,
  SEED_SOURCE_INITIALISED,
  SEED_SOURCE_PLATFORM_STARTER,
} from '@/lib/projectRepos/vocabulary';

// The repo-set DERIVATION (Story MOTIR-1775 · MOTIR-1881) — pure, so this whole
// file runs with no plan, no DB, no GitHub and no network, which is the point:
// the derivation is the part that decides HOW MANY repositories a project has, and
// it must be arguable from a signal fixture alone.
//
// What is pinned here is each way the answer could quietly be wrong:
//
//   1. The thin-signal DEFAULT is exactly one `web` row (ADR §0.1.4) — the honest
//      floor. A silently-guessed larger set would create repositories the user
//      never asked for in an account they own.
//   2. A separated frontend/backend yields TWO rows, from signals supplied
//      EXPLICITLY — never inferred from card prose (the card's own prohibition).
//   3. The §1.4 naming rule: no role suffix at one row, suffixes at two or more.
//   4. §2's seeding table, including that a non-web row starts near-empty.
//   5. Every row carries the §0.1 signal that justified it. A row with no
//      nameable reason must not exist, so that is asserted as an invariant over
//      every case rather than case by case.

/** The signal-bundle shorthand every case here builds from. */
const SLUG = 'acme';

describe('platformToRepoRole — ADR §0.1.2 / §1.1', () => {
  it('maps each pre-plan platform to the role that fixes the primary row', () => {
    expect(platformToRepoRole('web')).toBe('web');
    expect(platformToRepoRole('mobile')).toBe('mobile');
  });

  it('maps desktop AND other to the `other` escape hatch (§1.1: a CLI, a desktop app, a docs site)', () => {
    expect(platformToRepoRole('desktop')).toBe('other');
    expect(platformToRepoRole('other')).toBe('other');
  });

  it('returns null for an absent or UNRECOGNISED platform rather than guessing a role', () => {
    expect(platformToRepoRole(null)).toBeNull();
    expect(platformToRepoRole(undefined)).toBeNull();
    // motir-ai owns the vocabulary; a value core has never heard of falls to the
    // default rung, it does not get force-fitted into a role.
    expect(platformToRepoRole('embedded')).toBeNull();
  });
});

describe('seedSourceForRole — ADR §2', () => {
  it('seeds a web row from the ONE default platform starter', () => {
    expect(seedSourceForRole('web')).toBe(SEED_SOURCE_PLATFORM_STARTER);
  });

  it('seeds every non-web role from an INITIALISED repo — near-empty, no scaffold pretence', () => {
    for (const role of PROJECT_REPO_ROLES.filter((r) => r !== 'web')) {
      expect(seedSourceForRole(role)).toBe(SEED_SOURCE_INITIALISED);
    }
  });

  it('is unchanged by either designStarter value — there is one starter (§2, the correction)', () => {
    // `aiPreplanService` writes 'bare' on a design pick and 'with-design' on a
    // skip, describing two starters; the `-with-design` sibling is retired and
    // archived, so both resolve to the same one. This asserts the flag is NOT a
    // repo selector — which is what MOTIR-709's registry will change.
    expect(seedSourceForRole('web', 'bare')).toBe(SEED_SOURCE_PLATFORM_STARTER);
    expect(seedSourceForRole('web', 'with-design')).toBe(SEED_SOURCE_PLATFORM_STARTER);
    expect(seedSourceForRole('web', null)).toBe(SEED_SOURCE_PLATFORM_STARTER);
    expect(seedSourceForRole('api', 'bare')).toBe(SEED_SOURCE_INITIALISED);
  });
});

describe('proposedRepoName — ADR §1.4', () => {
  it('uses the bare project slug when the set has ONE row (no suffix noise)', () => {
    expect(proposedRepoName('acme', 'web', 1)).toBe('acme');
    // A one-row MOBILE project is still the bare slug: the suffix marks
    // "one of several", not "not web".
    expect(proposedRepoName('acme', 'mobile', 1)).toBe('acme');
  });

  it('suffixes with the role once there are two or more rows', () => {
    expect(proposedRepoName('acme', 'web', 2)).toBe('acme-web');
    expect(proposedRepoName('acme', 'api', 3)).toBe('acme-api');
  });

  it('normalises the stem so a derived name can never fail the set service’s own validation', () => {
    // The project slug is already `[a-z0-9-]+` in practice; this is belt, not a
    // second policy — a name this module derives must always be creatable.
    expect(proposedRepoName('Acme Corp!', 'web', 1)).toBe('acme-corp');
    expect(proposedRepoName('--acme--', 'api', 2)).toBe('acme-api');
    expect(proposedRepoName('', 'web', 1)).toBe('project');
    expect(proposedRepoName('!!!', 'web', 1)).toBe('project');
    expect(proposedRepoName('a'.repeat(200), 'web', 1)).toHaveLength(60);
  });
});

describe('deriveRepoSetProposal — the ADR §0.1 ladder', () => {
  it('THIN SIGNALS → exactly one `web` row, named for the project, seeded from the starter', () => {
    const rows = deriveRepoSetProposal({ projectSlug: SLUG });

    expect(rows).toEqual([
      {
        role: 'web',
        name: 'acme',
        seedSource: SEED_SOURCE_PLATFORM_STARTER,
        signal: 'default-web',
        reason: expect.stringContaining('no repository'),
      },
    ]);
  });

  it('degrades to that default for a project that never ran a pre-plan (session: null → platform null)', () => {
    // The ADR's own consequence for this card: a migrated or seeded project reads
    // `session: null`, and the derivation must degrade rather than fail.
    const rows = deriveRepoSetProposal({ projectSlug: SLUG, platform: null, designStarter: null });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('web');
    expect(rows[0]!.signal).toBe('default-web');
  });

  it('PLATFORM (§0.1.2) fixes the single row’s role, and says so', () => {
    const web = deriveRepoSetProposal({ projectSlug: SLUG, platform: 'web' });
    expect(web).toHaveLength(1);
    expect(web[0]!.role).toBe('web');
    // Distinct from the thin-signal default: the platform was RECORDED, so the
    // row's justification is the platform, not "we had nothing".
    expect(web[0]!.signal).toBe('preplan-platform');

    const mobile = deriveRepoSetProposal({ projectSlug: SLUG, platform: 'mobile' });
    expect(mobile).toEqual([
      {
        role: 'mobile',
        // One row → no suffix, even though the role is not `web`.
        name: 'acme',
        // §2: no starter fits a mobile app, so it starts near-empty and says so.
        seedSource: SEED_SOURCE_INITIALISED,
        signal: 'preplan-platform',
        reason: expect.stringContaining('mobile'),
      },
    ]);
  });

  it('an unrecognised platform falls through to the default rather than inventing a role', () => {
    const rows = deriveRepoSetProposal({ projectSlug: SLUG, platform: 'embedded' });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('web');
    expect(rows[0]!.signal).toBe('default-web');
  });

  it('SEPARATED FRONTEND + BACKEND (§0.1.1) → TWO rows, `web` + `api`, with the ADR’s names and seeds', () => {
    // The signals are supplied EXPLICITLY — this is the seam MOTIR-1885 (the
    // generator emits the role) and MOTIR-1884 (materialize carries it) fill. It
    // is deliberately NOT inferred from card prose: a confident three-repo
    // proposal derived from prose is a guess wearing the authority of a decision.
    const rows = deriveRepoSetProposal({
      projectSlug: SLUG,
      itemRoles: ['web', 'api'],
      platform: 'web',
    });

    expect(rows).toEqual([
      {
        role: 'web',
        name: 'acme-web',
        seedSource: SEED_SOURCE_PLATFORM_STARTER,
        signal: 'plan-item-role',
        reason: expect.stringContaining('web'),
      },
      {
        role: 'api',
        name: 'acme-api',
        seedSource: SEED_SOURCE_INITIALISED,
        signal: 'plan-item-role',
        reason: expect.stringContaining('api'),
      },
    ]);
  });

  it('de-duplicates repeated roles and is INDEPENDENT of the order they arrive in', () => {
    // Many cards pin `api`; that is one repository. §1.2 permits a role to repeat
    // in a SET, but only as a user's edit (two services, distinguished by label) —
    // the derivation never invents a second row for the same role.
    const a = deriveRepoSetProposal({ projectSlug: SLUG, itemRoles: ['api', 'web', 'api', 'web'] });
    const b = deriveRepoSetProposal({ projectSlug: SLUG, itemRoles: ['web', 'api'] });

    expect(a.map((r) => r.name)).toEqual(['acme-web', 'acme-api']);
    expect(a).toEqual(b);
  });

  it('orders the set PRIMARY-first (§1.3): the platform’s role leads when the tree names it', () => {
    const rows = deriveRepoSetProposal({
      projectSlug: SLUG,
      itemRoles: ['api', 'web', 'mobile'],
      platform: 'mobile',
    });

    // The mobile app is what this project IS, so its repo is the primary row; the
    // rest follow in the §1.1 vocabulary order, which makes the set deterministic.
    expect(rows.map((r) => r.role)).toEqual(['mobile', 'web', 'api']);
  });

  it('falls back to the §1.1 vocabulary order when the platform’s role is not in the tree', () => {
    const rows = deriveRepoSetProposal({
      projectSlug: SLUG,
      itemRoles: ['infra', 'shared', 'api'],
      platform: 'mobile',
    });

    expect(rows.map((r) => r.role)).toEqual(['api', 'shared', 'infra']);
    // A platform whose role no card claims does NOT add a row of its own — the
    // tree is the primary signal, and a row nobody asked for is exactly what the
    // proposal must not manufacture.
    expect(rows.map((r) => r.role)).not.toContain('mobile');
  });

  it('a one-role tree still reads as a single-repo project (§6 — the degenerate case)', () => {
    const rows = deriveRepoSetProposal({ projectSlug: SLUG, itemRoles: ['web'], platform: 'web' });

    expect(rows).toHaveLength(1);
    // One row → the bare slug, so nothing about it reads like "one of several".
    expect(rows[0]!.name).toBe('acme');
    expect(rows[0]!.signal).toBe('plan-item-role');
  });

  it('an EMPTY role list is not a signal — it falls through to the next rung', () => {
    const rows = deriveRepoSetProposal({ projectSlug: SLUG, itemRoles: [], platform: 'mobile' });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.signal).toBe('preplan-platform');
  });

  it('INVARIANT — never empty, and no row exists without a nameable signal', () => {
    const cases: Parameters<typeof deriveRepoSetProposal>[0][] = [
      { projectSlug: SLUG },
      { projectSlug: SLUG, platform: 'web' },
      { projectSlug: SLUG, platform: 'desktop' },
      { projectSlug: SLUG, platform: 'nonsense' },
      { projectSlug: SLUG, itemRoles: ['web', 'api', 'shared', 'infra', 'mobile', 'other'] },
      { projectSlug: '', itemRoles: ['api'] },
    ];

    for (const signals of cases) {
      const rows: ProposedRepoRow[] = deriveRepoSetProposal(signals);
      // A project always needs somewhere for its code to live.
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        // Against the PERSISTED vocabulary, not a literal list (MOTIR-1892): the
        // signal is now a column the set service validates, so a rung this module
        // could emit but that list does not admit would be rejected at the write.
        expect(PROJECT_REPO_PROPOSAL_SIGNALS).toContain(row.signal);
        expect(row.reason.trim().length).toBeGreaterThan(0);
        // Creatable as-is: the set service's own name validation must never be
        // the thing that discovers a derived name is malformed.
        expect(row.name).toMatch(/^[A-Za-z0-9._-]+$/);
        expect(row.name.length).toBeLessThanOrEqual(100);
        expect(row.seedSource.trim().length).toBeGreaterThan(0);
      }
      // Names are unique within the set — otherwise the second write would hit
      // the `(project_id, name)` unique index instead of persisting.
      expect(new Set(rows.map((r) => r.name)).size).toBe(rows.length);
    }
  });
});
