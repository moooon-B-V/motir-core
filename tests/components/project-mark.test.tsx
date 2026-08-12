// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ProjectMark } from '@/app/(authed)/_components/ProjectMark';

// MOTIR-2679 · gated by MOTIR-2681 — the project's mark in the shell.
//
// It REPLACES `ProjectAvatar`, and `tests/components/project-avatar.test.tsx`
// went with that component. This is not that test rewritten: the old one's whole
// subject was WHICH preset tile rendered for WHICH icon/colour pair, and there
// are no presets. What is worth pinning here is much smaller and much more
// load-bearing — the absence, the two box contracts, and the fact that the mark
// is decorative.
//
// The no-fallback assertion below is the one this file exists for.
// `docs/decisions/entity-marks.md` §3 departs from every comparable product by
// rendering NOTHING for a project with no logo, and "nothing" is the state a
// well-meaning later change is most likely to fill in with a monogram. The
// structural guard in `tests/projects/entity-mark-guards.test.ts` catches that
// across the whole app; this catches it in the one component that decides it.

afterEach(cleanup);

const URL = 'https://cdn.example.test/projects/p1/logo.png';

describe('ProjectMark', () => {
  describe('no image — the decision, in code', () => {
    it('renders NOTHING: no element, no box, no glyph', () => {
      const { container } = render(<ProjectMark image={null} size={22} />);
      expect(container.innerHTML).toBe('');
    });

    it('reserves the SLOT in a list row — occupying width, drawing nothing', () => {
      const { container } = render(<ProjectMark image={null} size={24} reserveSlot />);
      const slot = container.firstElementChild as HTMLElement;
      expect(slot).not.toBeNull();
      // The point of the slot is ALIGNMENT, so it takes the box's width...
      expect(slot.style.width).toBe('24px');
      expect(slot.style.height).toBe('24px');
      // ...and nothing else: no fill, no border, no radius, no content. A slot
      // that painted anything would BE a placeholder mark under another name.
      expect(slot.textContent).toBe('');
      expect(slot.querySelector('img')).toBeNull();
      expect(slot.className).not.toMatch(/bg-|border|rounded/);
    });

    it('does NOT reserve the slot by default — the BAR closes the gap instead', () => {
      // A single tier has no column to align to (MOTIR-2675 measured this), so
      // the default must be "render nothing", not "render an empty box".
      const { container } = render(<ProjectMark image={null} size={22} />);
      expect(container.innerHTML).toBe('');
    });
  });

  describe('an image', () => {
    it('renders it at the requested box, cropped to fill, with the control radius', () => {
      const { container } = render(<ProjectMark image={URL} size={30} />);
      const box = container.firstElementChild as HTMLElement;
      expect(box.style.width).toBe('30px');
      expect(box.style.height).toBe('30px');
      expect(box.className).toContain('rounded-(--radius-control)');
      expect(box.className).toContain('overflow-hidden');

      const img = box.querySelector('img')!;
      expect(img.getAttribute('src')).toBe(URL);
      expect(img.className).toContain('object-cover');
    });

    it('is DECORATIVE — no accessible name, because the NAME renders beside it', () => {
      render(<ProjectMark image={URL} size={22} />);
      // An accessible name here would announce the project twice on every row.
      expect(screen.queryByRole('img')).toBeNull();
      expect(document.querySelector('img')!.getAttribute('alt')).toBe('');
      expect(document.querySelector('span[aria-hidden]')).not.toBeNull();
    });

    it('takes each caller’s size verbatim — one component, four boxes', () => {
      // The bar (22), the switcher list (24), the settings rail (30/32). The
      // sizes are the spec's; what this pins is that the component imposes none
      // of its own, so the four surfaces cannot drift into four marks.
      for (const size of [22, 24, 30, 32]) {
        const { container } = render(<ProjectMark image={URL} size={size} />);
        expect((container.firstElementChild as HTMLElement).style.width).toBe(`${size}px`);
        cleanup();
      }
    });

    it('reserveSlot is IRRELEVANT once there is an image — same box either way', () => {
      const { container: a } = render(<ProjectMark image={URL} size={24} />);
      const withoutSlot = a.innerHTML;
      cleanup();
      const { container: b } = render(<ProjectMark image={URL} size={24} reserveSlot />);
      expect(b.innerHTML).toBe(withoutSlot);
    });
  });

  it('appends a caller className without dropping its own box classes', () => {
    const { container } = render(<ProjectMark image={URL} size={22} className="ring-2" />);
    const box = container.firstElementChild as HTMLElement;
    expect(box.className).toContain('ring-2');
    expect(box.className).toContain('flex-none');
  });
});
