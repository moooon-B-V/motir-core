// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ProjectAvatar } from '@/app/(authed)/_components/ProjectAvatar';

// ProjectAvatar (Subtask 6.8.4) — the project identity chip. A valid preset
// (icon + colour) renders the lucide glyph over its `--el-avatar-*` tint
// (MOTIR-1274 · 1266.3); null (or an invalid key) falls back to the shipped MONO
// rendering: the key's first two letters on `--el-avatar-fallback`.

afterEach(cleanup);

describe('ProjectAvatar', () => {
  it('renders the preset icon glyph for a valid icon + colour', () => {
    const { container } = render(
      <ProjectAvatar icon="rocket" color="lavender" identifier="PROD" />,
    );
    // The lucide component renders an <svg>; the mono letters must NOT appear.
    expect(container.querySelector('svg')).toBeTruthy();
    expect(screen.queryByText('PR')).toBeNull();
  });

  it('falls back to the mono key-letters chip when there is no avatar', () => {
    const { container } = render(<ProjectAvatar icon={null} color={null} identifier="Apex" />);
    expect(screen.getByText('AP')).toBeTruthy();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('falls back to mono when only one half of the avatar is set, or the key is invalid', () => {
    cleanup();
    render(<ProjectAvatar icon="rocket" color={null} identifier="LABS" />);
    expect(screen.getByText('LA')).toBeTruthy();
    cleanup();
    render(<ProjectAvatar icon="not-real" color="mint" identifier="ZZTOP" />);
    expect(screen.getByText('ZZ')).toBeTruthy();
  });
});
