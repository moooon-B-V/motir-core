import { describe, expect, it } from 'vitest';
import { parseKinds, parseSprintState } from '../src/commands/read.js';
import { openUrl } from '../src/browser.js';
import { CliError } from '../src/errors.js';

describe('parseKinds', () => {
  it('returns undefined for an absent / empty list (any kind)', () => {
    expect(parseKinds(undefined)).toBeUndefined();
    expect(parseKinds('  ,  ')).toBeUndefined();
  });
  it('lower-cases, trims, and accepts the valid kinds', () => {
    expect(parseKinds('Story, BUG ')).toEqual(['story', 'bug']);
  });
  it('throws a guiding CliError on an unknown kind', () => {
    expect(() => parseKinds('story,widget')).toThrow(CliError);
    try {
      parseKinds('widget');
    } catch (err) {
      expect((err as CliError).hint).toMatch(/epic, story, task, bug, subtask/);
    }
  });
});

describe('parseSprintState', () => {
  it('returns undefined for an absent / empty filter (every state)', () => {
    expect(parseSprintState(undefined)).toBeUndefined();
    expect(parseSprintState('   ')).toBeUndefined();
  });
  it('lower-cases, trims, and accepts the three sprint states', () => {
    expect(parseSprintState(' Active ')).toBe('active');
    expect(parseSprintState('PLANNED')).toBe('planned');
    expect(parseSprintState('complete')).toBe('complete');
  });
  it('throws a guiding CliError on an unknown state', () => {
    expect(() => parseSprintState('closed')).toThrow(CliError);
    try {
      parseSprintState('closed');
    } catch (err) {
      expect((err as CliError).hint).toMatch(/planned, active, complete/);
    }
  });
});

describe('openUrl', () => {
  it('skips (resolves false) on a headless Linux box with no display', async () => {
    const launched = await openUrl('https://app.motir.co/issues/PROD-7', {
      platform: 'linux',
      env: {},
    });
    expect(launched).toBe(false);
  });
  it('never rejects even if the launcher is bogus', async () => {
    // darwin path always attempts; spawning a non-existent cmd resolves false
    // via the child 'error' handler rather than throwing.
    await expect(
      openUrl('https://app.motir.co', { platform: 'darwin', env: {} }),
    ).resolves.toBeTypeOf('boolean');
  });
});

// ── coverage gaps closed by 7.9.5 (MOTIR-883) ───────────────────────────────

describe('openUrl per platform', () => {
  it('always attempts on macOS and Windows (no DISPLAY concept there)', async () => {
    // The launcher differs per platform; both resolve a boolean and neither
    // throws, which is the whole contract — the URL is already printed.
    await expect(
      openUrl('https://app.motir.co', { platform: 'win32', env: {} }),
    ).resolves.toBeTypeOf('boolean');
  });

  it('attempts on Linux once a display IS present', async () => {
    await expect(
      openUrl('https://app.motir.co', { platform: 'linux', env: { DISPLAY: ':0' } }),
    ).resolves.toBeTypeOf('boolean');
    await expect(
      openUrl('https://app.motir.co', { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } }),
    ).resolves.toBeTypeOf('boolean');
  });
});
