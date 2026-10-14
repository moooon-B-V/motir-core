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

describe('a full-screen element INSIDE the surface (MOTIR-8560)', () => {
  // The approval overlay is a Modal hosting a `<video controls>`. Its native
  // full-screen button makes the VIDEO the full-screen element. Following it would
  // re-portal the dialog into its own descendant: React unmounts the subtree to
  // move it, the video leaves the document, and the browser drops out of full
  // screen. The dialog stays where it is instead.
  function Player() {
    return (
      <Modal open onOpenChange={() => {}} title="Acceptance">
        <video data-testid="player" />
      </Modal>
    );
  }

  it('keeps the dialog — and the same video node — in place', () => {
    render(<Player />);
    const video = screen.getByTestId('player');
    enterFullScreen(video);
    expect(screen.getByTestId('player')).toBe(video);
    expect(video.isConnected).toBe(true);
    expect(document.fullscreenElement).toBe(video);
    expect(stage.contains(screen.getByRole('dialog'))).toBe(false);
    // Leaving full screen returns to the dialog, still open, same node.
    enterFullScreen(null);
    expect(screen.getByTestId('player')).toBe(video);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('a dialog already inside a full-screen canvas stays there while its video is full screen', () => {
    enterFullScreen(stage);
    render(<Player />);
    const video = screen.getByTestId('player');
    expect(stage.contains(video)).toBe(true);
    enterFullScreen(video);
    expect(screen.getByTestId('player')).toBe(video);
    expect(video.isConnected).toBe(true);
    expect(stage.contains(video)).toBe(true);
    // Leaving the video's full screen hands it back to the canvas.
    enterFullScreen(stage);
    expect(screen.getByTestId('player')).toBe(video);
    expect(stage.contains(video)).toBe(true);
  });

  it('a popover keeps its own full-screen descendant in place', () => {
    render(
      <Popover open>
        <Popover.Trigger>Open</Popover.Trigger>
        <Popover.Content data-testid="panel">
          <video data-testid="clip" />
        </Popover.Content>
      </Popover>,
    );
    const clip = screen.getByTestId('clip');
    enterFullScreen(clip);
    expect(screen.getByTestId('clip')).toBe(clip);
    expect(clip.isConnected).toBe(true);
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
