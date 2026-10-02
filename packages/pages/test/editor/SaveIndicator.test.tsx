// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SaveIndicator } from '../../src/editor/SaveIndicator';
import type { SaveStatus } from '../../src/editor/autosave';
import { MESSAGES } from './fixtures';

// The indicator (MOTIR-7275, design-notes § _State 8_): one rendering per status,
// each label from `messages`, a polite live region.

afterEach(cleanup);

const CASES: Array<[SaveStatus, string]> = [
  ['saved', MESSAGES.status.saved],
  ['saving', MESSAGES.status.saving],
  ['offline', MESSAGES.status.offline],
  ['too_large', MESSAGES.status.tooLarge],
];

describe('SaveIndicator', () => {
  it('renders a distinct label for each of the four statuses', () => {
    const seen = new Set<string>();
    for (const [status, label] of CASES) {
      render(<SaveIndicator status={status} messages={MESSAGES.status} />);
      const chip = screen.getByRole('status');
      expect(chip.textContent).toBe(label);
      expect(chip.getAttribute('aria-live')).toBe('polite');
      expect(chip.getAttribute('data-status')).toBe(status);
      expect(chip.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      seen.add(chip.textContent!);
      cleanup();
    }
    expect(seen.size).toBe(4);
  });

  it('gives only offline its detail, as the tooltip and the description', () => {
    render(<SaveIndicator status="offline" messages={MESSAGES.status} />);
    const chip = screen.getByRole('status');
    expect(chip.getAttribute('title')).toBe(MESSAGES.status.offlineDetail);
    const described = document.getElementById(chip.getAttribute('aria-describedby')!);
    expect(described?.textContent).toBe(MESSAGES.status.offlineDetail);
    cleanup();
    render(<SaveIndicator status="saved" messages={MESSAGES.status} />);
    expect(screen.getByRole('status').hasAttribute('title')).toBe(false);
    expect(screen.getByRole('status').hasAttribute('aria-describedby')).toBe(false);
  });
});
