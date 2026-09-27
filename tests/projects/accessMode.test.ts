import { describe, expect, it } from 'vitest';
import {
  PROJECT_ACCESS_MODES,
  WORKSPACE_ACCESS_SCOPES,
  asAccessMode,
  asAccessScope,
  levelForMode,
} from '@/lib/projects/accessMode';
import { PROJECT_ACCESS_LEVELS } from '@/lib/projects/roles';

// The pure mappers of the access storage (Story MOTIR-6169 · MOTIR-6541): the
// level written beside a mode while both columns are written, and the narrowing
// guards. The mode itself is stored, never derived (MOTIR-6686).

describe('levelForMode', () => {
  it('writes open / private / public beside workspace / members / public', () => {
    expect(levelForMode('workspace')).toBe('open');
    expect(levelForMode('members')).toBe('private');
    expect(levelForMode('public')).toBe('public');
  });

  it('is total over the modes, and never writes the retired `limited`', () => {
    for (const mode of PROJECT_ACCESS_MODES) {
      expect(PROJECT_ACCESS_LEVELS).toContain(levelForMode(mode));
      expect(levelForMode(mode)).not.toBe('limited');
    }
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
