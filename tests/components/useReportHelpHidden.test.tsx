// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import {
  REPORT_HELP_HIDDEN_STORAGE_KEY,
  resetReportHelpHiddenForTests,
  useReportHelpHidden,
} from '@/lib/hooks/useReportHelpHidden';

// One preference, every report: shown by default, persisted under
// `motir.reports.help.hidden`, in sync across hook instances and tabs.

function Probe() {
  const [hidden] = useReportHelpHidden();
  return <span>{String(hidden)}</span>;
}

beforeEach(() => {
  window.localStorage.clear();
  resetReportHelpHiddenForTests();
});
afterEach(() => cleanup());

describe('useReportHelpHidden', () => {
  it('defaults to shown and the server render agrees', () => {
    expect(renderToString(<Probe />)).toContain('false');
    const { result } = renderHook(() => useReportHelpHidden());
    expect(result.current[0]).toBe(false);
  });

  it('toggling persists to localStorage and survives a fresh read', () => {
    const { result } = renderHook(() => useReportHelpHidden());
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    expect(window.localStorage.getItem(REPORT_HELP_HIDDEN_STORAGE_KEY)).toBe('true');

    resetReportHelpHiddenForTests();
    const again = renderHook(() => useReportHelpHidden());
    expect(again.result.current[0]).toBe(true);

    act(() => again.result.current[1]());
    expect(window.localStorage.getItem(REPORT_HELP_HIDDEN_STORAGE_KEY)).toBe('false');
  });

  it('two instances share the one value', () => {
    const a = renderHook(() => useReportHelpHidden());
    const b = renderHook(() => useReportHelpHidden());
    act(() => a.result.current[1]());
    expect(b.result.current[0]).toBe(true);
  });

  it('follows a change made in another tab', () => {
    const { result } = renderHook(() => useReportHelpHidden());
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: REPORT_HELP_HIDDEN_STORAGE_KEY, newValue: 'true' }),
      );
    });
    expect(result.current[0]).toBe(true);
  });

  it('reads shown when storage is unavailable', () => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error('denied');
    };
    try {
      resetReportHelpHiddenForTests();
      const { result } = renderHook(() => useReportHelpHidden());
      expect(result.current[0]).toBe(false);
    } finally {
      Storage.prototype.getItem = orig;
    }
  });
});
