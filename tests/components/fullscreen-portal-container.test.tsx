// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Modal, Popover } from '@motir/design-system';

// MOTIR-7658 — the design system's portalling primitives mount into the element in
// NATIVE full screen while there is one, because the browser paints nothing outside
// it. Outside full screen they keep portalling to <body>.
//
// happy-dom has no Fullscreen API: `document.fullscreenElement` is stubbed, and a
// change is announced with `fullscreenchange`, as a browser does.

let fullscreenElement: Element | null = null;
let stage: HTMLDivElement;

function enterFullScreen(el: Element | null) {
  act(() => {
    fullscreenElement = el;
    document.dispatchEvent(new Event('fullscreenchange'));
  });
}

beforeEach(() => {
  fullscreenElement = null;
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => fullscreenElement,
  });
  stage = document.createElement('div');
  stage.setAttribute('data-testid', 'stage');
  document.body.appendChild(stage);
});

afterEach(() => {
  cleanup();
  stage.remove();
  delete (document as unknown as { fullscreenElement?: unknown }).fullscreenElement;
});

describe('Modal portal container', () => {
  it('portals to <body> outside full screen', () => {
    render(<Modal open onOpenChange={() => {}} title="Peek" />);
    const dialog = screen.getByRole('dialog');
    expect(stage.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });

  it('portals into the element in native full screen', () => {
    enterFullScreen(stage);
    render(<Modal open onOpenChange={() => {}} title="Peek" />);
    expect(stage.contains(screen.getByRole('dialog'))).toBe(true);
  });

  it('follows a full-screen change while it is open', () => {
    render(<Modal open onOpenChange={() => {}} title="Peek" />);
    expect(stage.contains(screen.getByRole('dialog'))).toBe(false);
    enterFullScreen(stage);
    expect(stage.contains(screen.getByRole('dialog'))).toBe(true);
    enterFullScreen(null);
    expect(stage.contains(screen.getByRole('dialog'))).toBe(false);
  });

  it('an explicit container wins, and `null` forces <body>', () => {
    const other = document.createElement('div');
    document.body.appendChild(other);
    enterFullScreen(stage);
    const { unmount } = render(
      <Modal open onOpenChange={() => {}} title="Peek" container={other} />,
    );
    expect(other.contains(screen.getByRole('dialog'))).toBe(true);
    unmount();

    render(<Modal open onOpenChange={() => {}} title="Peek" container={null} />);
    expect(stage.contains(screen.getByRole('dialog'))).toBe(false);
    other.remove();
  });
});

describe('Popover portal container', () => {
  it('portals its content into the element in native full screen, else <body>', () => {
    const { unmount } = render(
      <Popover open>
        <Popover.Trigger>Open</Popover.Trigger>
        <Popover.Content data-testid="panel">menu</Popover.Content>
      </Popover>,
    );
    expect(stage.contains(screen.getByTestId('panel'))).toBe(false);
    unmount();

    enterFullScreen(stage);
    render(
      <Popover open>
        <Popover.Trigger>Open</Popover.Trigger>
        <Popover.Content data-testid="panel">menu</Popover.Content>
      </Popover>,
    );
    expect(stage.contains(screen.getByTestId('panel'))).toBe(true);
  });
});
