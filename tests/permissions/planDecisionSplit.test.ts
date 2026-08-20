import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import type { MemberRole, ProjectAccessLevel } from '@/generated/prisma/client';
import { hasPermission, resolvePermissions } from '@/lib/permissions/resolve';
import type { ProjectPermissionInputs } from '@/lib/permissions/resolve';
import {
  BUILTIN_ROLE_PERMISSIONS,
  IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS,
  ROLE_GATED_PERMISSIONS,
} from '@/lib/permissions/builtinRoles';
import {
  PERMISSIONS,
  PERMISSION_CATALOG,
  PLANNED_PERMISSIONS,
  permissionsByDomain,
} from '@/lib/permissions/catalog';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import {
  DEFAULT_TOKEN_GRANT,
  GRANTABLE_PERMISSIONS,
  IRREVERSIBLE_PERMISSIONS,
  UNGRANTABLE_PERMISSIONS,
  V1_ONLY_PERMISSIONS,
} from '@/lib/tokens/grant';

// THE AUTHOR/DECIDE SPLIT (Bug MOTIR-3188) — `ai:view_plan` gated no view, and
// held two authorities: authoring a plan, and deciding one. `approvePlan` is the
// only path from a proposal to real rows and it asserted the key whose name says
// *can look at a plan*, with nothing else beside it.
//
// The split is only safe because it is BEHAVIOUR-NEUTRAL on the built-in roles,
// and that is a claim about a policy function rather than about a diff — so it is
// the thing this file proves. Everything else here is a guard against the split
// being half-applied: an author gate that silently moved, a decide gate that
// silently did not, a key that reached a token surface it has no operation on.
//
// ⚠️ THE `BEFORE` COLUMN IS TRANSCRIBED, NOT COMPUTED — the same discipline
// `tests/permissions/accessParity.test.ts` states in its own header. Every
// expectation below is the verdict `ai:view_plan` returned BEFORE this change,
// written down by hand; asserting the new key against a table derived from the
// new code would prove only that the code agrees with itself.

const ROOT = join(__dirname, '..', '..');

const AUTHOR_KEY: PermissionKey = 'ai:view_plan';
const DECIDE_KEY: PermissionKey = 'ai:decide_plan';

// ── The catalog half ──────────────────────────────────────────────────────────

describe('the catalog carries `ai:decide_plan` as an enforced `ai` key', () => {
  it('is in PERMISSIONS exactly once, in the `ai` domain, `enforced`', () => {
    expect(PERMISSIONS.filter((k) => k === DECIDE_KEY)).toHaveLength(1);
    expect(PERMISSION_CATALOG[DECIDE_KEY].domain).toBe('ai');
    expect(PERMISSION_CATALOG[DECIDE_KEY].enforcement).toBe('enforced');
  });

  it('leaves PLANNED_PERMISSIONS empty — the gate lands in the same change as the key', () => {
    expect([...PLANNED_PERMISSIONS]).toEqual([]);
  });

  it('renders in the `ai` domain group, beside the key it was split from', () => {
    // The Roles & permissions grid walks `permissionsByDomain`, so "the grid
    // renders it under AI" is a property of this grouping and not of a
    // component — `PermissionGroups.tsx` imports no catalog constant at all.
    const ai = permissionsByDomain({ include: ROLE_GATED_PERMISSIONS }).find(
      (g) => g.domain === 'ai',
    );
    expect(ai, 'the ai domain group is missing').toBeTruthy();
    const keys = ai!.permissions.map((p) => p.key);
    expect(keys).toContain(AUTHOR_KEY);
    expect(keys).toContain(DECIDE_KEY);
    // Adjacent and in that order: the author key first, the decision it was cut
    // out of immediately after, so the grid reads as the pair it is.
    expect(keys.indexOf(DECIDE_KEY)).toBe(keys.indexOf(AUTHOR_KEY) + 1);
  });

  it('names i18n keys, and the shipped copy no longer describes a view', () => {
    const copy = en.permissions as unknown as Record<
      string,
      { label: string; description: string } | undefined
    >;
    const author = copy.ai_view_plan;
    const decide = copy.ai_decide_plan;
    expect(decide?.label).toBeTruthy();
    expect(decide?.description).toBeTruthy();
    // The whole escalation MOTIR-3188 closes is an admin reading a name off a
    // grid. A label that still says "View" would ship the split with the screen
    // still telling them the old lie. (Catalog totality over BOTH locales is
    // `tests/permissions/catalog.test.ts`'s; what is asserted here is the CONTENT
    // this card is responsible for.)
    expect(`${author?.label} ${author?.description}`).not.toMatch(/\bView AI plans\b/);
  });
});

// ── AC5 · the parity table ────────────────────────────────────────────────────

/**
 * The four actor kinds AC5 names, as `resolvePermissions` inputs.
 *
 * `implicitWorkspaceMember` is the one that is not a role: a workspace member
 * holding NO project membership, whose base set is
 * `IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS`. It is in the table because it is the
 * actor a widening would reach first and the one no role screen would show.
 */
const ACTORS: Record<string, Omit<ProjectPermissionInputs, 'accessLevel'>> = {
  admin: { workspaceRole: 'member' as MemberRole, projectRole: 'admin' as MemberRole },
  member: { workspaceRole: 'member' as MemberRole, projectRole: 'member' as MemberRole },
  viewer: { workspaceRole: 'member' as MemberRole, projectRole: 'viewer' as MemberRole },
  implicitWorkspaceMember: { workspaceRole: 'member' as MemberRole, projectRole: null },
};

/** The four operations, and the key each is gated on AFTER the split. */
const OPERATIONS = {
  // A plan READ is `canBrowse` and always was — `planReviewService.getPlanReview`
  // says so in its own doc comment, and the v1 plan routes and the `get_plan` /
  // `get_plan_status` MCP rows declare `project:browse`. It is in the table
  // because "the key gates no view" is the premise the whole card rests on.
  read: 'project:browse',
  author: AUTHOR_KEY,
  approve: DECIDE_KEY,
  decline: DECIDE_KEY,
} as const satisfies Record<string, PermissionKey>;

type OperationName = keyof typeof OPERATIONS;

/**
 * The verdicts BEFORE the split, transcribed.
 *
 * Read `approve` / `decline` as *"what `hasPermission(inputs, 'ai:view_plan')`
 * answered on `origin/main` at `a1f8aaad`"*, because that is the key both
 * asserted then. `read` is `project:browse`, which this card does not touch and
 * which is included so a future widening of the READ shows up here too.
 *
 * The rows are the four actors × the four access levels. `private` is the row
 * that separates the implicit workspace member from the rest: the level denies a
 * non-member before any key is consulted.
 */
const BEFORE: Record<ProjectAccessLevel, Record<string, Record<OperationName, boolean>>> = {
  open: {
    admin: { read: true, author: true, approve: true, decline: true },
    member: { read: true, author: true, approve: true, decline: true },
    viewer: { read: true, author: false, approve: false, decline: false },
    implicitWorkspaceMember: { read: true, author: false, approve: false, decline: false },
  },
  limited: {
    admin: { read: true, author: true, approve: true, decline: true },
    member: { read: true, author: true, approve: true, decline: true },
    viewer: { read: true, author: false, approve: false, decline: false },
    implicitWorkspaceMember: { read: true, author: false, approve: false, decline: false },
  },
  private: {
    admin: { read: true, author: true, approve: true, decline: true },
    member: { read: true, author: true, approve: true, decline: true },
    viewer: { read: true, author: false, approve: false, decline: false },
    // No project membership on a private project: invisible before any key is read.
    implicitWorkspaceMember: { read: false, author: false, approve: false, decline: false },
  },
  public: {
    admin: { read: true, author: true, approve: true, decline: true },
    member: { read: true, author: true, approve: true, decline: true },
    viewer: { read: true, author: false, approve: false, decline: false },
    implicitWorkspaceMember: { read: true, author: false, approve: false, decline: false },
  },
};

describe('AC5 — built-in behaviour is unchanged: the same verdicts before and after', () => {
  const LEVELS: ProjectAccessLevel[] = ['open', 'limited', 'private', 'public'];

  it.each(LEVELS)('%s — every actor × (read, author, approve, decline)', (accessLevel) => {
    for (const [actor, base] of Object.entries(ACTORS)) {
      const inputs: ProjectPermissionInputs = { accessLevel, ...base };
      for (const [operation, key] of Object.entries(OPERATIONS) as [
        OperationName,
        PermissionKey,
      ][]) {
        const before = BEFORE[accessLevel]?.[actor]?.[operation];
        expect(before, `no transcribed verdict for ${actor}/${operation}/${accessLevel}`).not.toBe(
          undefined,
        );
        expect(
          hasPermission(inputs, key),
          `${operation} (${key}) for ${actor} on a ${accessLevel} project`,
        ).toBe(before);
      }
    }
  });

  it('the two keys are INDISTINGUISHABLE under every built-in input — 4 levels × 4 ws roles × 4 project roles', () => {
    // The strongest statement of neutrality available: approve used to resolve
    // through the author key and now resolves through the decide key, so if the
    // two agree on every input a built-in role can produce, nobody's access
    // moved. A single divergent cell here IS the behaviour change.
    const ROLES: (MemberRole | null)[] = ['owner', 'admin', 'member', 'viewer'];
    for (const accessLevel of ['open', 'limited', 'private', 'public'] as ProjectAccessLevel[]) {
      for (const workspaceRole of [...ROLES, null]) {
        for (const projectRole of [...ROLES, null]) {
          const inputs: ProjectPermissionInputs = { accessLevel, workspaceRole, projectRole };
          expect(
            hasPermission(inputs, DECIDE_KEY),
            `${DECIDE_KEY} diverges from ${AUTHOR_KEY} on { ${accessLevel}, ws=${workspaceRole}, proj=${projectRole} }`,
          ).toBe(hasPermission(inputs, AUTHOR_KEY));
        }
      }
    }
  });

  it('a CUSTOM role can hold one without the other — the point of the split', () => {
    // The property no built-in role can express, and the one MOTIR-2257 made
    // reachable from the Roles & permissions screen: a set an admin enumerated
    // by hand grants exactly what it lists, on every access level.
    const inputs = (permissions: PermissionKey[]): ProjectPermissionInputs => ({
      accessLevel: 'open',
      workspaceRole: 'member',
      projectRole: 'member',
      customRolePermissions: permissions,
    });
    const authorOnly = inputs(['project:browse', AUTHOR_KEY]);
    expect(hasPermission(authorOnly, AUTHOR_KEY)).toBe(true);
    expect(hasPermission(authorOnly, DECIDE_KEY)).toBe(false);
    // …and the mirror, so this is a SEPARATION rather than one key being inert.
    const decideOnly = inputs(['project:browse', DECIDE_KEY]);
    expect(hasPermission(decideOnly, DECIDE_KEY)).toBe(true);
    expect(hasPermission(decideOnly, AUTHOR_KEY)).toBe(false);
  });

  it('the role SETS place the key exactly where the author key already sat', () => {
    expect(ROLE_GATED_PERMISSIONS.includes(DECIDE_KEY)).toBe(true);
    expect(BUILTIN_ROLE_PERMISSIONS.admin.has(DECIDE_KEY)).toBe(true);
    expect(BUILTIN_ROLE_PERMISSIONS.member.has(DECIDE_KEY)).toBe(true);
    expect(BUILTIN_ROLE_PERMISSIONS.viewer.has(DECIDE_KEY)).toBe(false);
    expect(IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS.has(DECIDE_KEY)).toBe(false);
    // Stated as an exact SET rather than four booleans, so a key added to the
    // implicit grant later fails loudly instead of widening what a bare
    // workspace membership means.
    expect([...IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS].sort()).toEqual(
      [
        'attachment:create',
        'comment:add',
        'project:browse',
        'report:view',
        'work_item:edit',
      ].sort(),
    );
  });

  it('the workspace-manager rail resolves to it on every access level', () => {
    for (const accessLevel of ['public', 'open', 'limited', 'private'] as ProjectAccessLevel[]) {
      for (const workspaceRole of ['owner', 'admin'] as MemberRole[]) {
        const held = resolvePermissions({ accessLevel, workspaceRole, projectRole: null });
        expect(held.has(DECIDE_KEY), `${workspaceRole} on ${accessLevel} lacks ${DECIDE_KEY}`).toBe(
          true,
        );
      }
    }
  });
});

// ── AC2 / AC3 · the gates actually moved, and only the two that should ─────────

describe('the gates in plansService', () => {
  const SOURCE = readFileSync(join(ROOT, 'lib', 'services', 'plansService.ts'), 'utf8');

  /**
   * The body of a named method on the exported service object, from its
   * signature to the next sibling at the same indentation.
   *
   * A whole-file grep cannot answer AC2 — the file legitimately names both keys —
   * and reading the assertion out of each METHOD is the only way to say WHICH
   * gate a key belongs to without executing the whole matrix against Postgres.
   */
  function methodBody(name: string): string {
    const start = SOURCE.indexOf(`\n  async ${name}(`);
    expect(start, `no \`async ${name}(\` in plansService.ts`).toBeGreaterThan(-1);
    const rest = SOURCE.slice(start + 1);
    const end = rest.indexOf('\n  },\n');
    expect(end, `could not find the end of ${name}`).toBeGreaterThan(-1);
    return rest.slice(0, end);
  }

  it('AC2 — approvePlan and declinePlan assert ai:decide_plan and NOT ai:view_plan', () => {
    for (const name of ['approvePlan', 'declinePlan']) {
      const body = methodBody(name);
      expect(body, `${name} does not assert ${DECIDE_KEY}`).toContain(`'${DECIDE_KEY}'`);
      expect(
        body.includes(`assertPermission(plan.projectId, ctx, '${AUTHOR_KEY}')`),
        `${name} still asserts ${AUTHOR_KEY}`,
      ).toBe(false);
    }
  });

  it('AC3 — the AUTHOR writes still assert ai:view_plan, unchanged', () => {
    for (const name of ['addProposals', 'markPlanned']) {
      expect(methodBody(name), `${name} lost its ${AUTHOR_KEY} gate`).toContain(
        `assertPermission(plan.projectId, ctx, '${AUTHOR_KEY}')`,
      );
    }
    // `editAddProposal` is a module-local helper, not a method on the object, so
    // it is read from the file rather than from a body — both its callers
    // (`updateProposal`, `deepenProposal`) delegate to it and assert nothing of
    // their own, which is exactly why the helper is where the gate has to be.
    const helper = SOURCE.slice(SOURCE.indexOf('async function editAddProposal('));
    expect(helper.slice(0, helper.indexOf('\n}\n'))).toContain(
      `assertPermission(plan.projectId, ctx, '${AUTHOR_KEY}')`,
    );
    for (const caller of ['updateProposal', 'deepenProposal']) {
      expect(methodBody(caller), `${caller} should delegate, not gate`).toContain(
        'editAddProposal(',
      );
    }
  });

  it('AC8 — the comment no longer argues the conflation it used to', () => {
    // A comment that still says the key "governs reading a generated plan AND
    // acting on it" is a failing criterion in the card's own words: the next
    // reader would take it as the current design and put the next decision back
    // on the author key.
    const helper = SOURCE.slice(SOURCE.indexOf('async function editAddProposal('));
    const preamble = helper.slice(0, helper.indexOf(`'${AUTHOR_KEY}'`));
    expect(preamble).not.toMatch(/this key governs reading a generated plan AND acting on it/);
    expect(preamble).toContain('canBrowse');
    expect(preamble).toContain(DECIDE_KEY);
  });

  it('AC3 — the MCP author rows are untouched', () => {
    expect(TOOL_PERMISSIONS.add_plan_items).toBe(AUTHOR_KEY);
    expect(TOOL_PERMISSIONS.update_plan_item).toBe(AUTHOR_KEY);
    // …and the reads stay on browse, which is the fact that proves the old name
    // never described a gate.
    expect(TOOL_PERMISSIONS.get_plan).toBe('project:browse');
    expect(TOOL_PERMISSIONS.get_plan_status).toBe('project:browse');
  });

  it('no MCP tool asserts the decide key — the agent surface cannot approve', () => {
    // The sharpest bound in the design, and it is structural rather than checked:
    // MCP is the AGENT's surface, and the agent is the one party that must never
    // approve its own re-plan. A tool here would put approval in reach of the
    // credential a sandboxed agent holds.
    expect(Object.values(TOOL_PERMISSIONS)).not.toContain(DECIDE_KEY);
  });

  it('is GRANTABLE through exactly one v1 operation, and that is derived not chosen', () => {
    // ⚠️ THIS ASSERTION IS THE INVERSE OF THE ONE IT REPLACED, and the flip is
    // the merge race resolving. Written before MOTIR-3021 merged, it read
    // `expect(GRANTABLE_PERMISSIONS).not.toContain(DECIDE_KEY)` — true while no
    // token-reachable operation asserted the key, and it said in its own comment
    // that 3021's approve entrance was the card that would change it. 3021 landed
    // first (`POST /api/v1/work-items/{key}/plan-approval`), so the key IS
    // token-reachable and the entry in `V1_ONLY_PERMISSIONS` is what keeps the
    // derivation total.
    //
    // `GRANTABLE_PERMISSIONS` is computed, never hand-listed, so this is a
    // statement about the operation existing — not a decision taken here.
    expect(GRANTABLE_PERMISSIONS).toContain(DECIDE_KEY);
    expect(UNGRANTABLE_PERMISSIONS).not.toContain(DECIDE_KEY);
    // It is grantable ONLY through v1: no MCP tool asserts it (above), and the
    // two publish routes assert `work_item:edit`. If that stops being true the
    // entry is redundant, and `tests/tokens/grant.test.ts`'s both-directions
    // derivation is what will say so.
    expect(V1_ONLY_PERMISSIONS).toContain(DECIDE_KEY);
    // …and it is NOT irreversible, so a default-grant token carries it. Approving
    // a plan creates work items, which archive; it does not cascade a delete.
    expect(IRREVERSIBLE_PERMISSIONS).not.toContain(DECIDE_KEY);
    expect(DEFAULT_TOKEN_GRANT).toContain(DECIDE_KEY);
  });
});

describe('the decide key has a production call site', () => {
  it('is consulted by plansService, outside lib/permissions/', () => {
    // The orphan guard at one key's scope: a key nothing calls is a switch in
    // the Roles & permissions grid that controls nothing — the lie
    // `lib/permissions/catalog.ts` opens by forbidding.
    const source = readFileSync(join(ROOT, 'lib', 'services', 'plansService.ts'), 'utf8');
    expect(source.includes(`'${DECIDE_KEY}'`)).toBe(true);
  });
});
