import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_PUBLISH_PERMISSION,
  DEFAULT_TOKEN_GRANT,
  GRANTABLE_PERMISSIONS,
  IRREVERSIBLE_PERMISSIONS,
  UNGRANTABLE_PERMISSIONS,
  V1_ONLY_PERMISSIONS,
  expandStoredGrant,
  grantAllows,
  grantsIrreversible,
  isGrantable,
} from '@/lib/tokens/grant';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { PERMISSIONS, isPermissionKey, type PermissionKey } from '@/lib/permissions/catalog';
import { V1_OPERATIONS } from '@/lib/api/v1/openapi/registry';

// The GRANT model guard (Story MOTIR-2572 · Subtask MOTIR-2574), decided in
// `docs/decisions/token-permissions.md`. Pure model: no DB, no I/O.
//
// The load-bearing test in this file is the DERIVATION, in both directions. The
// catalog opens by forbidding a permission with no operation behind it, and a
// picker switch that gates nothing is the same lie one level up — so "grantable"
// has to be a computed consequence of the operation maps, and this is what says
// it still is.

describe('GRANTABLE_PERMISSIONS is DERIVED, in both directions', () => {
  it('offers no key that no token-reachable operation asserts', () => {
    const asserted = new Set<PermissionKey>([
      ...Object.values(TOOL_PERMISSIONS),
      ...V1_ONLY_PERMISSIONS,
      ACCEPTANCE_PUBLISH_PERMISSION,
    ]);
    for (const key of GRANTABLE_PERMISSIONS) {
      expect(asserted.has(key), `"${key}" is grantable but no operation asserts it`).toBe(true);
    }
  });

  it('omits no key that a token-reachable operation asserts', () => {
    for (const [tool, key] of Object.entries(TOOL_PERMISSIONS)) {
      expect(GRANTABLE_PERMISSIONS, `tool "${tool}" needs ungrantable "${key}"`).toContain(key);
    }
    expect(GRANTABLE_PERMISSIONS).toContain(ACCEPTANCE_PUBLISH_PERMISSION);
  });

  it('covers every /api/v1 declaration — the seam grant.ts cannot import', () => {
    // `lib/api/v1/**` pulls in Zod and every schema, and `grant.ts` is consumed
    // by the create-token modal in the browser, so the derivation deliberately
    // stops at the MCP map + the publish route (see V1_ONLY_PERMISSIONS). THIS
    // is what closes the v1 half — at test time, where the import is free.
    //
    for (const operation of V1_OPERATIONS) {
      expect(
        GRANTABLE_PERMISSIONS,
        `${operation.method} ${operation.path} requires "${operation.permission}", which no token can be granted`,
      ).toContain(operation.permission);
    }
  });

  it('keeps V1_ONLY_PERMISSIONS honest — every entry is a v1 need no MCP tool asserts', () => {
    const mcp = new Set<PermissionKey>(Object.values(TOOL_PERMISSIONS));
    const v1 = new Set<PermissionKey>(V1_OPERATIONS.map((o) => o.permission));
    for (const key of V1_ONLY_PERMISSIONS) {
      expect(v1.has(key), `"${key}" is listed v1-only but no v1 operation asserts it`).toBe(true);
      expect(mcp.has(key), `"${key}" is listed v1-only but an MCP tool asserts it too`).toBe(false);
    }
  });

  it('is a real subset of the catalog, in catalog order, with no duplicates', () => {
    for (const key of GRANTABLE_PERMISSIONS) expect(isPermissionKey(key)).toBe(true);
    expect(new Set(GRANTABLE_PERMISSIONS).size).toBe(GRANTABLE_PERMISSIONS.length);
    const order = PERMISSIONS.filter((k) => GRANTABLE_PERMISSIONS.includes(k));
    expect([...GRANTABLE_PERMISSIONS]).toEqual(order);
  });

  it('partitions the catalog with UNGRANTABLE_PERMISSIONS', () => {
    expect(GRANTABLE_PERMISSIONS.length + UNGRANTABLE_PERMISSIONS.length).toBe(PERMISSIONS.length);
    for (const key of UNGRANTABLE_PERMISSIONS) expect(isGrantable(key)).toBe(false);
  });

  it('does not offer a key whose only home is a UI-administration surface', () => {
    // A spot-check with teeth: these are exactly the switches a reader would be
    // confused to find on a token screen, because no API caller can exercise them.
    for (const key of ['board:configure', 'workflow:manage', 'member:manage'] as const) {
      expect(GRANTABLE_PERMISSIONS, `"${key}" gates nothing a token can call`).not.toContain(key);
    }
  });
});

describe('isGrantable', () => {
  it('accepts a grantable key', () => {
    expect(isGrantable('project:browse')).toBe(true);
  });

  it('rejects a catalog key nothing token-reachable asserts', () => {
    expect(isGrantable('board:configure')).toBe(false);
  });

  it('rejects a non-key, including a legacy scope string', () => {
    expect(isGrantable('work_items:write')).toBe(false);
    expect(isGrantable('')).toBe(false);
    expect(isGrantable(undefined)).toBe(false);
    expect(isGrantable(7)).toBe(false);
  });
});

describe('grantAllows', () => {
  it('admits a permission the grant holds and refuses one it does not', () => {
    const grant: PermissionKey[] = ['project:browse', 'work_item:edit'];
    expect(grantAllows(grant, 'work_item:edit')).toBe(true);
    expect(grantAllows(grant, 'work_item:delete')).toBe(false);
  });

  it('refuses everything on an empty grant', () => {
    for (const key of GRANTABLE_PERMISSIONS) expect(grantAllows([], key)).toBe(false);
  });
});

describe('DEFAULT_TOKEN_GRANT', () => {
  it('is every grantable permission except the irreversible ones', () => {
    expect([...DEFAULT_TOKEN_GRANT].sort()).toEqual(
      GRANTABLE_PERMISSIONS.filter((k) => !IRREVERSIBLE_PERMISSIONS.includes(k)).sort(),
    );
  });

  it('withholds work_item:delete', () => {
    expect(DEFAULT_TOKEN_GRANT).not.toContain('work_item:delete');
    expect(grantsIrreversible(DEFAULT_TOKEN_GRANT)).toBe(false);
  });

  it('therefore also withholds ARCHIVE, which is the narrowing ADR §8 records', () => {
    // Under the six scopes, archive was ON by default (recoverable) and delete
    // OFF. Both assert `work_item:delete` in shipped code, so one key cannot
    // hold them apart — and the safe direction is the one that withholds. A
    // NEW default-minted token cannot archive; this test is where that is
    // stated rather than discovered.
    expect(TOOL_PERMISSIONS.archive_work_item).toBe('work_item:delete');
    expect(grantAllows(DEFAULT_TOKEN_GRANT, TOOL_PERMISSIONS.archive_work_item)).toBe(false);
  });

  it('still admits the everyday work: read, edit, comment, plan, sprints', () => {
    for (const key of [
      'project:browse',
      'work_item:edit',
      'comment:add',
      'ai:plan',
      'sprint:manage',
    ] as const) {
      expect(DEFAULT_TOKEN_GRANT).toContain(key);
    }
  });
});

describe('grantsIrreversible', () => {
  it('flags a grant holding the irreversible key', () => {
    expect(grantsIrreversible(['project:browse', 'work_item:delete'])).toBe(true);
  });

  it('does not flag one that does not', () => {
    expect(grantsIrreversible(['project:browse'])).toBe(false);
    expect(grantsIrreversible([])).toBe(false);
  });
});

describe('expandStoredGrant — reading a row written before this story', () => {
  it('passes a permission key straight through', () => {
    const { grant, unrecognised } = expandStoredGrant(['project:browse', 'work_item:edit']);
    expect(grant).toEqual(['work_item:edit', 'project:browse'].sort((a, b) => a.localeCompare(b)));
    expect(unrecognised).toEqual([]);
  });

  it('expands the six legacy strings', () => {
    const { grant, unrecognised } = expandStoredGrant(['read', 'work_items:write']);
    // `ai:view_plan` joined `work_items:write` on 2026-08-18 (MOTIR-2988):
    // `add_plan_items` is the first MCP tool to assert that key, and the forward
    // map must confer whatever `TOOL_SCOPES` files under a scope or a legacy row
    // silently loses a tool — which `tests/tokens/story-gate.test.ts` asserts
    // directly, tool by tool.
    expect([...grant].sort()).toEqual(
      ['project:browse', 'work_item:edit', 'comment:add', 'ai:plan', 'ai:view_plan'].sort(),
    );
    expect(unrecognised).toEqual([]);
  });

  it('de-duplicates across a mixed row', () => {
    const { grant } = expandStoredGrant([
      'read',
      'project:browse',
      'work_items:archive',
      'work_items:delete',
    ]);
    expect([...grant].sort()).toEqual(['project:browse', 'work_item:delete'].sort());
  });

  it('DROPS an unrecognised value rather than throwing or defaulting', () => {
    // The two failure directions are not symmetric. A row we cannot interpret
    // must degrade to LESS access; yielding a default grant would hand out
    // access nobody chose.
    const { grant, unrecognised } = expandStoredGrant(['read', 'work_items:nuke', '']);
    expect(grant).toEqual(['project:browse']);
    expect(unrecognised).toEqual([{ value: 'work_items:nuke' }, { value: '' }]);
  });

  it('yields nothing at all for a wholly unreadable row', () => {
    const { grant, unrecognised } = expandStoredGrant(['garbage']);
    expect(grant).toEqual([]);
    expect(unrecognised).toHaveLength(1);
  });

  it('returns an empty grant for an empty row', () => {
    expect(expandStoredGrant([])).toEqual({ grant: [], unrecognised: [] });
  });

  it('never returns an ungrantable key', () => {
    const { grant } = expandStoredGrant([
      'read',
      'work_items:write',
      'work_items:archive',
      'work_items:delete',
      'sprints:write',
      'integration',
    ]);
    for (const key of grant) expect(isGrantable(key)).toBe(true);
    // All six together still reach everything — the compatibility promise.
    expect([...grant].sort()).toEqual([...GRANTABLE_PERMISSIONS].sort());
  });
});
