// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { TypeInText } from '@/components/planning/TypeInText';
import { TYPEWRITER_CAP_MS } from '@/lib/planning/typeIn';

// One field typing itself in (MOTIR-8595; design Part XXVIII §28.6, §28.7): the
// copy is the field's own markup cut at the cursor, the final element is the same
// node throughout, and the pace comes from the token when it can be read.

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
});

function fakeFrames() {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
}
async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

const RICH = (
  <p>
    one <b id="bold">two</b> three
  </p>
);
const copy = () => document.querySelector('[data-typewriter-copy]');

describe('TypeInText', () => {
  it('cuts nested markup at the cursor, dropping what follows and the ids it copies', async () => {
    fakeFrames();
    const onDone = vi.fn();
    render(
      <TypeInText phase="typing" onDone={onDone} testId="f">
        {RICH}
      </TypeInText>,
    );
    // The first frame, before any time has passed: an empty copy with its caret.
    await advance(16);
    expect(copy()!.querySelector('[data-typewriter-caret]')).not.toBeNull();
    // 'one two three' is 13 characters at 12ms each: inside the bold run by ~70ms.
    await advance(60);
    const p = copy()!.querySelector('p')!;
    expect(p.textContent).toMatch(/^one tw?$/);
    expect(p.querySelector('b')!.hasAttribute('id')).toBe(false);
    expect(p.querySelector('b [data-typewriter-caret]')).not.toBeNull();
    expect(screen.getByTestId('f').getAttribute('data-typewriter')).toBe('typing');
    expect(onDone).not.toHaveBeenCalled();
    await advance(TYPEWRITER_CAP_MS);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(copy()!.childNodes.length).toBe(0);
  });

  it('reads the pace and the cap from the tokens when they are set', async () => {
    // happy-dom resolves no custom property through getComputedStyle, so the
    // tokens' computed values are supplied the way a browser would answer.
    const tokens: Record<string, string> = {
      '--typewriter-char-interval': '100ms',
      '--transition-slow': '1s',
    };
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (name: string) => tokens[name] ?? '',
    } as CSSStyleDeclaration);
    fakeFrames();
    const onDone = vi.fn();
    render(
      <TypeInText phase="typing" onDone={onDone}>
        {RICH}
      </TypeInText>,
    );
    // The first frame lands before one character's 100ms: nothing typed yet, the
    // caret alone inside the field's block.
    await advance(16);
    expect(copy()!.textContent).toBe('');
    expect(copy()!.querySelector('p > [data-typewriter-caret]')).not.toBeNull();
    // At 100ms a character, 13 characters take 1.3s (inside the 3s cap).
    await advance(600);
    expect(copy()!.textContent).toMatch(/^one tw?$/);
    await advance(800);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('an empty field lands on its first frame', async () => {
    fakeFrames();
    const onDone = vi.fn();
    render(
      <TypeInText phase="typing" onDone={onDone}>
        {null}
      </TypeInText>,
    );
    await advance(16);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('queued shows the placeholder beside the hidden final element; final shows it plainly', () => {
    const r = render(
      <TypeInText phase="queued" onDone={() => {}} placeholder="Nothing yet" testId="f">
        {RICH}
      </TypeInText>,
    );
    const box = screen.getByTestId('f');
    expect(box.getAttribute('data-typewriter')).toBe('waiting');
    expect(box.firstElementChild!.className).toBe('sr-only');
    expect(screen.getByText('Nothing yet').getAttribute('aria-hidden')).toBe('true');
    r.rerender(
      <TypeInText phase="final" onDone={() => {}} placeholder="Nothing yet" testId="f">
        {RICH}
      </TypeInText>,
    );
    expect(box.getAttribute('data-typewriter')).toBe('final');
    expect(box.firstElementChild!.className).toBe('');
    expect(screen.queryByText('Nothing yet')).toBeNull();
  });
});
