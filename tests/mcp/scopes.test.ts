import { describe, expect, it } from 'vitest';
import { MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { CLI_TOKEN_GRANT, TOOL_PERMISSIONS, toolPermission } from '@/lib/mcp/toolPermissions';
import {
  LEGACY_SCOPE_PERMISSIONS,
  LEGACY_TOKEN_SCOPES,
  isLegacyTokenScope,
  TOOL_SCOPES,
  toolScope,
} from '@/lib/mcp/scopes';
import { GRANTABLE_PERMISSIONS, isGrantable } from '@/lib/tokens/grant';
import { isPermissionKey } from '@/lib/permissions/catalog';

// The tool→PERMISSION model guard (Story MOTIR-2572 · Subtask MOTIR-2574) —
// the 7.7.16 scope-map guard RE-POINTED onto the new vocabulary, not duplicated
// beside it. `TOOL_PERMISSIONS` is typed `Record<McpToolName, PermissionKey>`,
// so a tool added without a permission is a COMPILE error; this suite re-asserts
// the totality at runtime so the guarantee survives a type-erasure refactor, and
// pins the legacy forward map that keeps every already-minted token working.
// No DB, no I/O — a pure model check.

describe('TOOL_PERMISSIONS totality over MCP_TOOL_NAMES', () => {
  it('maps every registered tool to exactly one real catalog permission', () => {
    for (const name of MCP_TOOL_NAMES) {
      const permission = TOOL_PERMISSIONS[name];
      expect(permission, `tool "${name}" has no permission`).toBeDefined();
      expect(
        isPermissionKey(permission),
        `tool "${name}" maps to unknown permission "${permission}"`,
      ).toBe(true);
    }
  });

  it('maps every tool to a GRANTABLE permission — a tool nobody can be granted is undispatchable', () => {
    for (const name of MCP_TOOL_NAMES) {
      expect(
        isGrantable(TOOL_PERMISSIONS[name]),
        `tool "${name}" requires "${TOOL_PERMISSIONS[name]}", which no token can be granted`,
      ).toBe(true);
    }
  });

  it('has no entries for tools that are not in the registry', () => {
    const registry = new Set<string>(MCP_TOOL_NAMES);
    for (const mapped of Object.keys(TOOL_PERMISSIONS)) {
      expect(registry.has(mapped), `permission map has stale tool "${mapped}"`).toBe(true);
    }
  });

  it('covers the registry exactly (same cardinality, no gaps or extras)', () => {
    expect(Object.keys(TOOL_PERMISSIONS).length).toBe(MCP_TOOL_NAMES.length);
  });

  it('toolPermission() returns the same permission as the map for every tool', () => {
    for (const name of MCP_TOOL_NAMES) {
      expect(toolPermission(name)).toBe(TOOL_PERMISSIONS[name]);
    }
  });
});

describe('the permission split the six scopes could not express', () => {
  // Each of these was `work_items:write` (or `read`) under 7.7.16 because
  // nothing narrower existed. Naming the real gate is the point of the story, so
  // the split is pinned rather than left to a reviewer's eye.
  it('separates the billable planning submits onto ai:plan', () => {
    for (const name of [
      'expand_item',
      'open_plan_session',
      'append_plan_turn',
      'submit_plan_session',
    ] as const) {
      expect(TOOL_PERMISSIONS[name], `${name} must be withholdable on its own`).toBe('ai:plan');
    }
  });

  it('separates commenting onto comment:add', () => {
    expect(TOOL_PERMISSIONS.add_comment).toBe('comment:add');
  });

  it('puts archive on the same key as delete, because the shipped gates do', () => {
    for (const name of ['archive_work_item', 'unarchive_work_item', 'delete_work_item'] as const) {
      expect(TOOL_PERMISSIONS[name]).toBe('work_item:delete');
    }
  });

  it('keeps the two integration writes on the work-item edit gate they actually reach', () => {
    expect(TOOL_PERMISSIONS.mark_integrated).toBe('work_item:edit');
    expect(TOOL_PERMISSIONS.complete_session).toBe('work_item:edit');
    // The merge ADR §5 records: the same key `transition_status` asks for.
    expect(TOOL_PERMISSIONS.transition_status).toBe('work_item:edit');
  });
});

describe('CLI_TOKEN_GRANT (the device-approval fixed grant)', () => {
  it('is every permission the CLI needs and nothing else', () => {
    expect([...CLI_TOKEN_GRANT].sort()).toEqual(
      ['ai:plan', 'comment:add', 'project:browse', 'work_item:edit'].sort(),
    );
  });

  it('withholds the two a remote unattended credential must not hold', () => {
    expect(CLI_TOKEN_GRANT).not.toContain('work_item:delete');
    expect(CLI_TOKEN_GRANT).not.toContain('sprint:manage');
  });

  it('is entirely grantable', () => {
    for (const key of CLI_TOKEN_GRANT) expect(isGrantable(key)).toBe(true);
  });
});

describe('LEGACY_SCOPE_PERMISSIONS (the forward map)', () => {
  it('covers all six stored scope strings', () => {
    for (const scope of LEGACY_TOKEN_SCOPES) {
      expect(LEGACY_SCOPE_PERMISSIONS[scope], `no forward mapping for "${scope}"`).toBeDefined();
      expect(LEGACY_SCOPE_PERMISSIONS[scope].length).toBeGreaterThan(0);
    }
  });

  it('expands only to grantable catalog permissions', () => {
    for (const scope of LEGACY_TOKEN_SCOPES) {
      for (const key of LEGACY_SCOPE_PERMISSIONS[scope]) {
        expect(isGrantable(key), `"${scope}" expands to ungrantable "${key}"`).toBe(true);
      }
    }
  });

  it('the union of the six is the WHOLE grantable set — the compatibility promise', () => {
    // A token holding all six scopes could reach every token-reachable
    // operation. It still can. This is the property that makes "no already-minted
    // token loses authority" checkable rather than asserted.
    const union = new Set(LEGACY_TOKEN_SCOPES.flatMap((s) => [...LEGACY_SCOPE_PERMISSIONS[s]]));
    expect([...union].sort()).toEqual([...GRANTABLE_PERMISSIONS].sort());
  });

  it('maps every operation the six scopes gated, tool by tool, with ONE named loss', () => {
    // The exhaustive direction, and the one that makes "a stored row keeps
    // working" true per-operation rather than in aggregate: for each tool, the
    // scope that USED to gate it must forward-map to the permission that gates
    // it now.
    //
    // `open_plan_session` is the single measured exception (ADR §5). It declared
    // `read` while its service asserts `ai:plan`, so the OLD SCOPE was
    // over-permissive relative to its own gate. Widening `read` to cover it
    // would hand every legacy read-only token `expand_item` and
    // `submit_plan_session` — billable operations it never had. Asserting the
    // loss by name is what keeps this check exhaustive: a SECOND loss appears
    // here as a failure instead of quietly joining an allowance.
    const KNOWN_LOSSES: Partial<Record<(typeof MCP_TOOL_NAMES)[number], true>> = {
      open_plan_session: true,
    };
    const losses: string[] = [];
    for (const name of MCP_TOOL_NAMES) {
      const wasGatedBy = TOOL_SCOPES[name];
      if (!LEGACY_SCOPE_PERMISSIONS[wasGatedBy].includes(TOOL_PERMISSIONS[name])) {
        losses.push(`${name}: '${wasGatedBy}' -> '${TOOL_PERMISSIONS[name]}'`);
      }
    }
    expect(losses).toEqual(
      Object.keys(KNOWN_LOSSES).map(
        (n) =>
          `${n}: '${TOOL_SCOPES[n as keyof typeof TOOL_SCOPES]}' -> '${TOOL_PERMISSIONS[n as keyof typeof TOOL_PERMISSIONS]}'`,
      ),
    );
  });

  it('records the integration ↔ work_items:write merge rather than hiding it', () => {
    // ADR §5. Asserted so the merge is a checked, visible property: if a future
    // change separates them again, this test says so out loud.
    expect(LEGACY_SCOPE_PERMISSIONS.integration).toContain('work_item:edit');
    expect(LEGACY_SCOPE_PERMISSIONS['work_items:write']).toContain('work_item:edit');
  });
});

describe('isLegacyTokenScope', () => {
  it('accepts every stored scope string', () => {
    for (const scope of LEGACY_TOKEN_SCOPES) expect(isLegacyTokenScope(scope)).toBe(true);
  });

  it('rejects anything else, including a permission key', () => {
    expect(isLegacyTokenScope('work_items:nuke')).toBe(false);
    expect(isLegacyTokenScope('')).toBe(false);
    expect(isLegacyTokenScope('READ')).toBe(false);
    expect(isLegacyTokenScope('work_item:edit')).toBe(false);
    expect(isLegacyTokenScope(undefined)).toBe(false);
  });
});

describe('the deprecated 7.7.16 exports (scaffolding — see the file header)', () => {
  // They survive only until the cards that read them re-point (MOTIR-2575 /
  // -2579 / -2580 / -2581). Covered so the shim cannot rot silently while it is
  // still load-bearing for the published /docs MCP page.
  it('toolScope() still answers for every tool', () => {
    for (const name of MCP_TOOL_NAMES) expect(toolScope(name)).toBe(TOOL_SCOPES[name]);
  });

  it('deliberately DISAGREES with TOOL_PERMISSIONS where the vocabulary changed', () => {
    // Not a shim over the new map — see its @deprecated note. If these ever
    // agreed, the docs page would render the new split under the old names.
    expect(toolScope('add_comment')).toBe('work_items:write');
    expect(TOOL_PERMISSIONS.add_comment).toBe('comment:add');
  });
});
