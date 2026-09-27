import { describe, expect, it } from 'vitest';
import {
  PROJECT_ACCESS_MODES,
  WORKSPACE_ACCESS_SCOPES,
  accessModeOf,
  asAccessMode,
  asAccessScope,
  levelForMode,
} from '@/lib/projects/accessMode';
import { PROJECT_ACCESS_LEVELS } from '@/lib/projects/roles';

// The pure mappers of the access storage (Story MOTIR-6169 · MOTIR-6541): the
// DECISION's level → mode mapping (`role-model.md` Q1), its inverse used when
// both columns are written, and the narrowing guards.
//
// legacy-access-level: the legacy level is an INPUT here on purpose — the
// level → mode mapping is what these cases test (MOTIR-6685's guard allows this file).

describe('accessModeOf', () => {
  it('derives the mode from the legacy level while accessMode is NULL', () => {
    expect(accessModeOf({ accessMode: null, accessLevel: 'open' })).toBe('workspace');
    expect(accessModeOf({ accessMode: null, accessLevel: 'limited' })).toBe('members');
    expect(accessModeOf({ accessMode: null, accessLevel: 'private' })).toBe('members');
    expect(accessModeOf({ accessMode: null, accessLevel: 'public' })).toBe('public');
  });

  it('is total over every legacy level', () => {
    for (const accessLevel of PROJECT_ACCESS_LEVELS) {
      expect(PROJECT_ACCESS_MODES).toContain(accessModeOf({ accessMode: null, accessLevel }));
    }
  });

  it('returns the stored mode whenever accessMode is set, whatever the legacy level says', () => {
    for (const accessMode of PROJECT_ACCESS_MODES) {
      for (const accessLevel of PROJECT_ACCESS_LEVELS) {
        expect(accessModeOf({ accessMode, accessLevel })).toBe(accessMode);
      }
    }
  });
});

describe('levelForMode', () => {
  it('writes open / private / public beside workspace / members / public', () => {
    expect(levelForMode('workspace')).toBe('open');
    expect(levelForMode('members')).toBe('private');
    expect(levelForMode('public')).toBe('public');
  });

  it('round-trips the three stable levels', () => {
    for (const accessLevel of ['open', 'private', 'public'] as const) {
      expect(levelForMode(accessModeOf({ accessMode: null, accessLevel }))).toBe(accessLevel);
    }
  });

  it('maps the retired `limited` level to the narrow `private` on a write', () => {
    expect(levelForMode(accessModeOf({ accessMode: null, accessLevel: 'limited' }))).toBe(
      'private',
    );
  });
});

describe('narrowing guards', () => {
  it('accepts exactly the enum values', () => {
    for (const m of PROJECT_ACCESS_MODES) expect(asAccessMode(m)).toBe(m);
    for (const s of WORKSPACE_ACCESS_SCOPES) expect(asAccessScope(s)).toBe(s);
    for (const bad of ['open', 'private', '', 'WORKSPACE', null, undefined, 1, {}]) {
      expect(asAccessMode(bad)).toBeNull();
      expect(asAccessScope(bad)).toBeNull();
    }
  });
});
