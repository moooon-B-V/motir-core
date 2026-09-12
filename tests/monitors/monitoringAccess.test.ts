import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLE_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import {
  PROJECT_SETTINGS_NAV,
  toSettingsNavPermissions,
  visibleSettingsNav,
} from '@/lib/settings/projectSettingsNav';
import { resolveSettingsRefusal, settingsEntryKeys } from '@/app/(authed)/settings/project/_guard';

// The Monitoring room's DOOR and its LOCK are two checks (Story MOTIR-4928 ·
// MOTIR-5262): the rail filter hides the row, and the page guard refuses the
// route. A rail that hides a page anyone can still open is not a gate, so both
// are asserted for the same actor.

const ON_CLOUD = { publicProjectsAvailable: true };

describe('the monitoring room is gated on integration:manage', () => {
  it('reads its keys off the registry entry', () => {
    expect(settingsEntryKeys('monitoring')).toEqual({
      view: 'integration:manage',
      write: 'integration:manage',
    });
  });

  it('an actor WITHOUT the key is offered no rail entry AND is refused the route', () => {
    // A custom role that can configure boards but not integrations — so the
    // refusal is about this key, not about holding nothing at all.
    const held = toSettingsNavPermissions(['project:browse', 'board:configure']);
    const ids = visibleSettingsNav(held, PROJECT_SETTINGS_NAV, ON_CLOUD).map((e) => e.id);
    expect(ids).not.toContain('monitoring');
    expect(ids).toContain('board');

    const refusal = resolveSettingsRefusal('monitoring', held);
    expect(refusal).not.toBeNull();
    expect(refusal!.descriptionKey).toBe('noAccess.section.monitoring');
    // Back lands on a room the actor CAN open, not on a second refusal.
    expect(refusal!.backHref).toBe('/settings/project/board');
  });

  it('a built-in MEMBER holds no integration:manage, so both checks refuse', () => {
    const member = BUILTIN_ROLE_PERMISSIONS.member;
    expect(member.has('integration:manage')).toBe(false);
    expect(
      visibleSettingsNav(member, PROJECT_SETTINGS_NAV, ON_CLOUD).map((e) => e.id),
    ).not.toContain('monitoring');
    expect(resolveSettingsRefusal('monitoring', member)).not.toBeNull();
  });

  it('an actor WITH the key sees the entry, under Repositories, and is let in', () => {
    const held = toSettingsNavPermissions([
      'project:browse',
      'repository:manage',
      'integration:manage',
    ]);
    const ids = visibleSettingsNav(held, PROJECT_SETTINGS_NAV, ON_CLOUD).map((e) => e.id);
    expect(ids.slice(ids.indexOf('repositories'), ids.indexOf('repositories') + 2)).toEqual([
      'repositories',
      'monitoring',
    ]);
    expect(resolveSettingsRefusal('monitoring', held)).toBeNull();
  });
});
