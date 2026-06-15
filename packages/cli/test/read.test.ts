import { describe, expect, it } from 'vitest';
import { parseKinds } from '../src/commands/read.js';
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
