import { describe, expect, it } from 'vitest';
import { MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import {
  DEFAULT_TOKEN_SCOPES,
  TOKEN_SCOPES,
  TOOL_SCOPES,
  isTokenScope,
  toolScope,
} from '@/lib/mcp/scopes';

// The token-scope MODEL guard (Story 7.7 · Subtask 7.7.16). The scope map must
// hold a disposition for EVERY tool the MCP registry exposes — `TOOL_SCOPES` is
// typed `Record<McpToolName, TokenScope>`, so a tool added without a scope is a
// COMPILE error; this suite re-asserts the totality at runtime so the guarantee
// survives a type-erasure refactor, and pins the default grant set + the
// scope-string membership test. No DB, no I/O — a pure model check.

describe('TOOL_SCOPES totality over MCP_TOOL_NAMES', () => {
  it('maps every registered tool to exactly one known scope', () => {
    for (const name of MCP_TOOL_NAMES) {
      const scope = TOOL_SCOPES[name];
      expect(scope, `tool "${name}" has no scope`).toBeDefined();
      expect(isTokenScope(scope), `tool "${name}" maps to unknown scope "${scope}"`).toBe(true);
    }
  });

  it('has no scope entries for tools that are not in the registry', () => {
    const registry = new Set<string>(MCP_TOOL_NAMES);
    for (const mapped of Object.keys(TOOL_SCOPES)) {
      expect(registry.has(mapped), `scope map has stale tool "${mapped}"`).toBe(true);
    }
  });

  it('covers the registry exactly (same cardinality, no gaps or extras)', () => {
    expect(Object.keys(TOOL_SCOPES).length).toBe(MCP_TOOL_NAMES.length);
  });

  it('toolScope() returns the same scope as the map for every tool', () => {
    for (const name of MCP_TOOL_NAMES) {
      expect(toolScope(name)).toBe(TOOL_SCOPES[name]);
    }
  });
});

describe('DEFAULT_TOKEN_SCOPES', () => {
  it('is every scope EXCEPT work_items:delete', () => {
    expect([...DEFAULT_TOKEN_SCOPES].sort()).toEqual(
      [...TOKEN_SCOPES].filter((s) => s !== 'work_items:delete').sort(),
    );
  });

  it('excludes the irreversible delete scope', () => {
    expect(DEFAULT_TOKEN_SCOPES).not.toContain('work_items:delete');
  });

  it('includes the recoverable archive scope (archive is on by default)', () => {
    expect(DEFAULT_TOKEN_SCOPES).toContain('work_items:archive');
  });
});

describe('isTokenScope', () => {
  it('accepts every known scope', () => {
    for (const scope of TOKEN_SCOPES) expect(isTokenScope(scope)).toBe(true);
  });

  it('rejects an unknown string', () => {
    expect(isTokenScope('work_items:nuke')).toBe(false);
    expect(isTokenScope('')).toBe(false);
    expect(isTokenScope('READ')).toBe(false);
  });
});
