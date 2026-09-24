// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Textarea } from '@motir/design-system';

// The shared `Textarea`'s OPT-IN auto-grow (MOTIR-6237; design MOTIR-6236,
// `design/ai-chat/planning-workspace--multiline-composer.mock.html`).
//
// `scrollHeight` is the ONE thing stubbed. jsdom/happy-dom lay nothing out, so
// it is 0 for every element — which would make every clamp read "empty" and
// every assertion below pass for the wrong reason. Stubbing it is what lets the
// measurement be exercised at all; everything else here is the real component,
// the real computed style and the real DOM.

const LINE = 20; // --text-sm's line-height, the number the composer is drawn on
const PAD = 22; // 11px top + 11px bottom
const BORDER = 2; // 1px each side

/** Drive `scrollHeight` as the browser would for `n` wrapped lines. */
function stubScrollHeight(el: HTMLTextAreaElement, lines: number) {
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => lines * LINE + PAD,
  });
}

/**
 * The computed style a textarea has under the design system's tokens.
 *
 * Stubbed on the GLOBAL rather than with `vi.spyOn(window, …)`: the component
 * calls the bare `getComputedStyle`, which resolves to the global binding, and
 * a spy on the `window` property is not guaranteed to be the same function
 * object. Getting this wrong makes every measurement `NaN`, which the browser
 * rejects — so the height is never written and every assertion reads `''`.
 */
function stubComputedStyle() {
  const real = globalThis.getComputedStyle.bind(globalThis);
  vi.stubGlobal('getComputedStyle', (el: Element, pseudo?: string | null) => {
    if ((el as HTMLElement).tagName !== 'TEXTAREA') return real(el, pseudo ?? undefined);
    return {
      lineHeight: `${LINE}px`,
      fontSize: '14px',
      paddingTop: '11px',
      paddingBottom: '11px',
      boxSizing: 'border-box',
      borderTopWidth: '1px',
      borderBottomWidth: '1px',
    } as CSSStyleDeclaration;
  });
}

beforeEach(() => {
  stubComputedStyle();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  cleanup();
});

describe('Textarea — the default is untouched', () => {
  it('renders a fixed field with no inline height and the manual resize handle', () => {
    render(<Textarea label="Description" rows={3} />);
    const el = screen.getByLabelText('Description') as HTMLTextAreaElement;
    expect(Number(el.rows)).toBe(3);
    expect(el.className).toContain('resize-y');
    expect(el.className).not.toContain('resize-none');
    // The whole promise of an OPT-IN: nothing measured, nothing written.
    expect(el.style.height).toBe('');
    expect(el.style.overflowY).toBe('');
  });

  it('does not measure a fixed field when its value changes', () => {
    render(<Textarea label="Description" rows={3} />);
    const el = screen.getByLabelText('Description') as HTMLTextAreaElement;
    stubScrollHeight(el, 9);
    fireEvent.input(el, { target: { value: 'a\nb\nc\nd\ne\nf\ng\nh\ni' } });
    expect(el.style.height).toBe('');
  });
});

describe('Textarea — autoGrow', () => {
  it('drops the manual resize handle', () => {
    render(<Textarea label="Message" autoGrow rows={1} maxRows={8} />);
    const el = screen.getByLabelText('Message') as HTMLTextAreaElement;
    expect(el.className).toContain('resize-none');
    expect(el.className).not.toContain('resize-y');
  });

  it('holds the MINIMUM at one row even when the content is shorter', () => {
    render(<Textarea label="Message" autoGrow rows={1} maxRows={8} />);
    const el = screen.getByLabelText('Message') as HTMLTextAreaElement;
    stubScrollHeight(el, 1);
    fireEvent.input(el, { target: { value: 'one line' } });
    // 1 x 20 + 22 + 2 — the same 44px `--height-input` the shipped input carries,
    // which is what makes the at-rest composer pixel-identical to today's.
    expect(el.style.height).toBe(`${1 * LINE + PAD + BORDER}px`);
    expect(el.style.overflowY).toBe('hidden');
  });

  it('tracks the content between the minimum and the cap', () => {
    render(<Textarea label="Message" autoGrow rows={1} maxRows={8} />);
    const el = screen.getByLabelText('Message') as HTMLTextAreaElement;
    stubScrollHeight(el, 3);
    fireEvent.input(el, { target: { value: 'a\nb\nc' } });
    expect(el.style.height).toBe(`${3 * LINE + PAD + BORDER}px`);
    expect(el.style.overflowY).toBe('hidden');
  });

  it('stops at the cap and flips overflow-y to auto', () => {
    render(<Textarea label="Message" autoGrow rows={1} maxRows={8} />);
    const el = screen.getByLabelText('Message') as HTMLTextAreaElement;
    stubScrollHeight(el, 12);
    fireEvent.input(el, { target: { value: Array.from({ length: 12 }, (_, i) => i).join('\n') } });
    expect(el.style.height).toBe(`${8 * LINE + PAD + BORDER}px`);
    // Below the cap there is nothing to scroll; at it there is.
    expect(el.style.overflowY).toBe('auto');
  });

  it('SHRINKS back when the content shortens', () => {
    // The reset-then-measure step is what makes this work: `scrollHeight`
    // reports the current box while the content fits, so a field that had grown
    // would otherwise be stuck at its high-water mark.
    render(<Textarea label="Message" autoGrow rows={1} maxRows={8} />);
    const el = screen.getByLabelText('Message') as HTMLTextAreaElement;
    stubScrollHeight(el, 5);
    fireEvent.input(el, { target: { value: 'a\nb\nc\nd\ne' } });
    expect(el.style.height).toBe(`${5 * LINE + PAD + BORDER}px`);
    stubScrollHeight(el, 2);
    fireEvent.input(el, { target: { value: 'a\nb' } });
    expect(el.style.height).toBe(`${2 * LINE + PAD + BORDER}px`);
  });

  it('grows without a cap when maxRows is omitted', () => {
    render(<Textarea label="Message" autoGrow rows={1} />);
    const el = screen.getByLabelText('Message') as HTMLTextAreaElement;
    stubScrollHeight(el, 40);
    fireEvent.input(el, { target: { value: 'x' } });
    expect(el.style.height).toBe(`${40 * LINE + PAD + BORDER}px`);
    expect(el.style.overflowY).toBe('hidden');
  });

  it('measures an INITIAL value on mount, so a prefilled field never flashes one line', () => {
    // The layout-effect path. `scrollHeight` has to be stubbed before the effect
    // runs, so the stub goes on the prototype for this one render.
    const proto = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 4 * LINE + PAD,
    });
    try {
      render(<Textarea label="Seeded" autoGrow rows={1} maxRows={8} defaultValue={'a\nb\nc\nd'} />);
      const el = screen.getByLabelText('Seeded') as HTMLTextAreaElement;
      expect(el.style.height).toBe(`${4 * LINE + PAD + BORDER}px`);
    } finally {
      if (proto) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', proto);
    }
  });

  it('re-measures a CONTROLLED value set from outside, including a clear to empty', () => {
    // The composer's own case: the parent clears the draft to '' after send, and
    // an input event never fires for it.
    function Host() {
      const [value, setValue] = useState('a\nb\nc');
      return (
        <>
          <Textarea
            label="Controlled"
            autoGrow
            rows={1}
            maxRows={8}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button type="button" onClick={() => setValue('a\nb\nc\nd\ne')}>
            grow
          </button>
          <button type="button" onClick={() => setValue('')}>
            send
          </button>
        </>
      );
    }
    const proto = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    let lines = 3;
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => lines * LINE + PAD,
    });
    try {
      render(<Host />);
      const el = screen.getByLabelText('Controlled') as HTMLTextAreaElement;
      expect(el.style.height).toBe(`${3 * LINE + PAD + BORDER}px`);
      // GROWS on a parent-set value — the seeded-draft direction…
      lines = 5;
      act(() => {
        screen.getByRole('button', { name: 'grow' }).click();
      });
      expect(el.style.height).toBe(`${5 * LINE + PAD + BORDER}px`);
      // …and SHRINKS back to `rows` when the parent clears it after send.
      lines = 1;
      act(() => {
        screen.getByRole('button', { name: 'send' }).click();
      });
      expect(el.style.height).toBe(`${1 * LINE + PAD + BORDER}px`);
    } finally {
      if (proto) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', proto);
    }
  });

  it('re-measures when the element WIDTH changes, which no value change reports', () => {
    // Wrapping changes with width, so a field that is two lines at 22rem can be
    // three at 16rem with the same text. Nothing fires an input event for that,
    // which is why the primitive observes its own box.
    let trigger: (() => void) | undefined;
    class FakeResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        trigger = () => cb([], this as unknown as ResizeObserver);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);

    const proto = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    let lines = 2;
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => lines * LINE + PAD,
    });
    try {
      render(
        <Textarea label="Message" autoGrow rows={1} maxRows={8} defaultValue="a wrapping line" />,
      );
      const el = screen.getByLabelText('Message') as HTMLTextAreaElement;
      expect(el.style.height).toBe(`${2 * LINE + PAD + BORDER}px`);
      // The box narrows; the same text now wraps to three lines.
      lines = 3;
      act(() => {
        trigger?.();
      });
      expect(el.style.height).toBe(`${3 * LINE + PAD + BORDER}px`);
    } finally {
      if (proto) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', proto);
    }
  });

  it('does not throw where ResizeObserver does not exist', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    expect(() => render(<Textarea label="Message" autoGrow rows={1} maxRows={8} />)).not.toThrow();
  });

  it('falls back to the font size when line-height computes to `normal`', () => {
    // `normal` has no pixel value to clamp against. Left as NaN it poisons the
    // whole clamp and the browser rejects the height, so the field silently
    // stops growing — the failure this branch exists to prevent.
    const real = globalThis.getComputedStyle.bind(globalThis);
    vi.stubGlobal('getComputedStyle', (el: Element, p?: string | null) => {
      if ((el as HTMLElement).tagName !== 'TEXTAREA') return real(el, p ?? undefined);
      return {
        lineHeight: 'normal',
        fontSize: '10px',
        paddingTop: '11px',
        paddingBottom: '11px',
        boxSizing: 'border-box',
        borderTopWidth: '1px',
        borderBottomWidth: '1px',
      } as CSSStyleDeclaration;
    });
    render(<Textarea label="Message" autoGrow rows={2} />);
    const el = screen.getByLabelText('Message') as HTMLTextAreaElement;
    stubScrollHeight(el, 0);
    fireEvent.input(el, { target: { value: '' } });
    // rows(2) x (10px x 1.2) + 22 + 2 — a real number, not NaN.
    expect(el.style.height).toBe(`${2 * 12 + PAD + BORDER}px`);
  });

  it('adds no border back when the box is CONTENT-box', () => {
    const real = globalThis.getComputedStyle.bind(globalThis);
    vi.stubGlobal('getComputedStyle', (el: Element, p?: string | null) => {
      if ((el as HTMLElement).tagName !== 'TEXTAREA') return real(el, p ?? undefined);
      return {
        lineHeight: `${LINE}px`,
        fontSize: '14px',
        paddingTop: '11px',
        paddingBottom: '11px',
        boxSizing: 'content-box',
        borderTopWidth: '1px',
        borderBottomWidth: '1px',
      } as CSSStyleDeclaration;
    });
    render(<Textarea label="Message" autoGrow rows={1} maxRows={8} />);
    const el = screen.getByLabelText('Message') as HTMLTextAreaElement;
    stubScrollHeight(el, 3);
    fireEvent.input(el, { target: { value: 'a\nb\nc' } });
    // A content-box height excludes the border, so it is NOT added back.
    expect(el.style.height).toBe(`${3 * LINE + PAD}px`);
  });

  it('forwards the ref to the <textarea> itself', () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<Textarea ref={ref} label="Message" autoGrow rows={1} maxRows={8} />);
    expect(ref.current).toBe(screen.getByLabelText('Message'));
    expect(ref.current?.tagName).toBe('TEXTAREA');
  });

  it('forwards a CALLBACK ref too, and clears it on unmount', () => {
    const seen: (HTMLTextAreaElement | null)[] = [];
    const { unmount } = render(
      <Textarea ref={(node) => seen.push(node)} label="Message" autoGrow rows={1} maxRows={8} />,
    );
    expect(seen[0]).toBe(screen.getByLabelText('Message'));
    unmount();
    expect(seen.at(-1)).toBeNull();
  });

  it('still passes through the handlers the composer builds its keys on', () => {
    const onKeyDown = vi.fn();
    const onCompositionStart = vi.fn();
    const onInput = vi.fn();
    render(
      <Textarea
        label="Message"
        autoGrow
        rows={1}
        maxRows={8}
        onKeyDown={onKeyDown}
        onCompositionStart={onCompositionStart}
        onInput={onInput}
      />,
    );
    const el = screen.getByLabelText('Message') as HTMLTextAreaElement;
    stubScrollHeight(el, 2);
    fireEvent.keyDown(el, { key: 'Enter' });
    fireEvent.compositionStart(el);
    fireEvent.input(el, { target: { value: 'a\nb' } });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(onCompositionStart).toHaveBeenCalledTimes(1);
    // A caller's own onInput is CALLED THROUGH, not dropped by the primitive's.
    expect(onInput).toHaveBeenCalledTimes(1);
    // …and the measurement still happened.
    expect(el.style.height).toBe(`${2 * LINE + PAD + BORDER}px`);
  });
});
