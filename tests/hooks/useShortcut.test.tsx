// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { useShortcut } from '@/lib/hooks/useShortcut';

// MOTIR-7033: production threw `Cannot read properties of undefined (reading
// 'toLowerCase')` from `onKeyDown` on /settings/account/tokens (Chrome, Mac).
// Not every `keydown` the window receives is a KeyboardEvent carrying a `key`:
// Chrome's autofill and password manager dispatch a plain `Event('keydown')`
// when they fill a form field, and its `key` is undefined. The tokens page is a
// form, so filling it reached every mounted shortcut listener.
//
// The listener is captured and called directly, rather than through
// `dispatchEvent`, because a browser reports a throwing listener to the error
// monitor instead of to the dispatcher — calling it is what makes the throw
// observable here.

type KeydownListener = (event: Event) => void;

let listeners: KeydownListener[];

beforeEach(() => {
  listeners = [];
  const original = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === 'keydown') listeners.push(listener as KeydownListener);
    original(type, listener, options);
  }) as typeof window.addEventListener);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function keydownListener(): KeydownListener {
  expect(listeners).toHaveLength(1);
  return listeners[0]!;
}

describe('useShortcut — a keydown with no key', () => {
  it('ignores the key-less Event an autofill dispatches, without throwing (bare combo)', () => {
    const handler = vi.fn();
    renderHook(() => useShortcut('?', handler));

    const autofill = new Event('keydown');
    expect((autofill as Partial<KeyboardEvent>).key).toBeUndefined();

    expect(() => keydownListener()(autofill)).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores a key-less event for an escape combo that fires while typing', () => {
    const handler = vi.fn();
    renderHook(() => useShortcut('esc', handler, { whenInputFocused: true }));

    expect(() => keydownListener()(new Event('keydown'))).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores a key-less event that carries the Mod modifier', () => {
    const handler = vi.fn();
    renderHook(() => useShortcut('Mod+K', handler));

    const event = Object.assign(new Event('keydown'), { metaKey: true, ctrlKey: true });
    expect(() => keydownListener()(event)).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('useShortcut — a real key still fires', () => {
  it('fires a bare combo case-insensitively and prevents the default', () => {
    const handler = vi.fn();
    renderHook(() => useShortcut('c', handler));

    const event = new KeyboardEvent('keydown', { key: 'C', cancelable: true });
    keydownListener()(event);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not fire a different key', () => {
    const handler = vi.fn();
    renderHook(() => useShortcut('c', handler));

    keydownListener()(new KeyboardEvent('keydown', { key: 'x' }));
    expect(handler).not.toHaveBeenCalled();
  });
});
