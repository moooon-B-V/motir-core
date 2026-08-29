// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderToString } from 'react-dom/server';
import {
  DEPENDENCY_LEGEND_COLLAPSED_STORAGE_KEY,
  resetDependencyLegendCollapsedForTests,
  useDependencyLegendCollapsed,
} from '@/lib/hooks/useDependencyLegendCollapsed';

// The canvas dependency-legend preference (MOTIR-3838), driven directly rather
// than through the canvas — the arms that matter here are the ones a component
// test cannot reach: the SSR snapshot, a throwing `localStorage`, and the
// cross-tab `storage` event.

function Probe() {
  const [collapsed, toggle] = useDependencyLegendCollapsed();
  return (
    <button type="button" onClick={toggle} data-state={collapsed ? 'collapsed' : 'expanded'}>
      {collapsed ? 'collapsed' : 'expanded'}
    </button>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  resetDependencyLegendCollapsedForTests();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useDependencyLegendCollapsed', () => {
  it('defaults to EXPANDED — the shipped state — and toggles to collapsed', () => {
    render(<Probe />);
    const btn = screen.getByRole('button');
    expect(btn.dataset['state']).toBe('expanded');
    fireEvent.click(btn);
    expect(btn.dataset['state']).toBe('collapsed');
    expect(window.localStorage.getItem(DEPENDENCY_LEGEND_COLLAPSED_STORAGE_KEY)).toBe('true');
    fireEvent.click(btn);
    expect(btn.dataset['state']).toBe('expanded');
    expect(window.localStorage.getItem(DEPENDENCY_LEGEND_COLLAPSED_STORAGE_KEY)).toBe('false');
  });

  it('reads the stored value LAZILY, on the first snapshot', () => {
    window.localStorage.setItem(DEPENDENCY_LEGEND_COLLAPSED_STORAGE_KEY, 'true');
    render(<Probe />);
    expect(screen.getByRole('button').dataset['state']).toBe('collapsed');
  });

  it('treats any value other than "true" as expanded', () => {
    window.localStorage.setItem(DEPENDENCY_LEGEND_COLLAPSED_STORAGE_KEY, 'yes');
    render(<Probe />);
    expect(screen.getByRole('button').dataset['state']).toBe('expanded');
  });

  it('degrades to EXPANDED when READING localStorage throws (private mode)', () => {
    // happy-dom's `localStorage` is a Proxy, so an instance spy is NOT undone by
    // `restoreAllMocks` — restore it here or every later test inherits the throw.
    const getItem = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      render(<Probe />);
      expect(getItem).toHaveBeenCalledWith(DEPENDENCY_LEGEND_COLLAPSED_STORAGE_KEY);
      expect(screen.getByRole('button').dataset['state']).toBe('expanded');
    } finally {
      getItem.mockRestore();
    }
  });

  it('keeps the in-session value when WRITING localStorage throws (quota)', () => {
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      render(<Probe />);
      const btn = screen.getByRole('button');
      fireEvent.click(btn);
      expect(setItem).toHaveBeenCalled();
      // The choice does not persist, but it applies — and nothing throws.
      expect(btn.dataset['state']).toBe('collapsed');
    } finally {
      setItem.mockRestore();
    }
  });

  it('SYNCS ACROSS TABS — a `storage` event for this key updates every subscriber', () => {
    render(<Probe />);
    const btn = screen.getByRole('button');
    expect(btn.dataset['state']).toBe('expanded');

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: DEPENDENCY_LEGEND_COLLAPSED_STORAGE_KEY,
          newValue: 'true',
        }),
      );
    });
    expect(btn.dataset['state']).toBe('collapsed');

    // A `storage` event for a DIFFERENT key is ignored.
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'motir.shell.sidebar.collapsed', newValue: 'false' }),
      );
    });
    expect(btn.dataset['state']).toBe('collapsed');
  });

  it('renders EXPANDED under renderToString, without touching localStorage', () => {
    // The SERVER snapshot — the arm that makes SSR and the first client render
    // agree, and the invariant that makes `readInitial`'s `typeof window` guard
    // unreachable: React calls `getServerSnapshot` on the server and `getSnapshot`
    // only on the client, so the stored value is never read off-DOM.
    window.localStorage.setItem(DEPENDENCY_LEGEND_COLLAPSED_STORAGE_KEY, 'true');
    resetDependencyLegendCollapsedForTests();
    const getItem = vi.spyOn(window.localStorage, 'getItem');
    try {
      const html = renderToString(<Probe />);
      expect(html).toContain('expanded');
      expect(getItem).not.toHaveBeenCalled();
    } finally {
      getItem.mockRestore();
    }
  });

  it('unsubscribes on unmount — a later `storage` event does not update a dead subscriber', () => {
    const { unmount } = render(<Probe />);
    unmount();
    // No listener remains, so this must not throw and must not re-render anything.
    expect(() =>
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: DEPENDENCY_LEGEND_COLLAPSED_STORAGE_KEY,
          newValue: 'true',
        }),
      ),
    ).not.toThrow();
  });
});
