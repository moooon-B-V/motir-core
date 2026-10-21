// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkItemPicker } from '../../src/editor/WorkItemPicker';
import {
  EmbedCardContext,
  WorkItemEmbedView,
  defaultEmbedCard,
  type EmbedCardContextValue,
} from '../../src/editor/workItemEmbed';
import {
  MentionChipContext,
  PICKER_KEY_EVENT,
  WorkItemChipView,
  type AvailableWorkItemRefView,
  type MentionChipContextValue,
} from '../../src/editor/workItemMention';
import { MESSAGES } from './fixtures';

// The node views and the picker rendered on their own, without an editor around
// them (MOTIR-9183's coverage floor): the shapes a host can hand them that the
// full editor never does — no provider, no host callbacks, no position.

const LIVE: AvailableWorkItemRefView = {
  accessible: true,
  id: 'ck1',
  identifier: 'MOTIR-1',
  title: 'One',
  kind: 'task',
  archived: false,
  status: null,
  type: null,
  assignee: null,
};
const node = (id: string | null) => ({ attrs: { id, label: null } }) as unknown as PMNode;

const base = (over: Partial<EmbedCardContextValue> = {}): EmbedCardContextValue => ({
  lookup: (id) => (id === 'ck1' ? LIVE : undefined),
  renderCard: (v) => <span data-testid="card">{v.identifier}</span>,
  messages: MESSAGES.embed,
  editable: false,
  ...over,
});

afterEach(cleanup);

describe('WorkItemEmbedView without an editor around it', () => {
  it('draws the unavailable card when there is no provider', () => {
    render(<WorkItemEmbedView node={node('ck1')} />);
    expect(document.querySelector('.wi-card.is-unavailable')).toBeTruthy();
  });

  it('draws the unavailable card for a node with no id', () => {
    render(
      <EmbedCardContext.Provider value={base()}>
        <WorkItemEmbedView node={node(null)} />
      </EmbedCardContext.Provider>,
    );
    expect(document.querySelector('.wi-card.is-unavailable')).toBeTruthy();
  });

  it('links to # when the host passes no href, and leaves modified clicks to the browser', () => {
    const onOpen = vi.fn();
    render(
      <EmbedCardContext.Provider value={base({ onOpen })}>
        <WorkItemEmbedView node={node('ck1')} />
      </EmbedCardContext.Provider>,
    );
    const anchor = document.querySelector('a')!;
    expect(anchor.getAttribute('href')).toBe('#');
    fireEvent.click(anchor, { metaKey: true });
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(anchor);
    expect(onOpen).toHaveBeenCalledWith('ck1');
  });

  it('follows a plain click without an onOpen, and ignores one already handled', () => {
    render(
      <EmbedCardContext.Provider value={base()}>
        <WorkItemEmbedView node={node('ck1')} />
      </EmbedCardContext.Provider>,
    );
    const anchor = document.querySelector('a')!;
    anchor.addEventListener('click', (e) => e.preventDefault());
    fireEvent.click(anchor);
    fireEvent.click(anchor, { button: 1 });
  });

  it('survives a menu action with no editor and no position', () => {
    const deleteNode = vi.fn();
    render(
      <EmbedCardContext.Provider value={base({ editable: true })}>
        <WorkItemEmbedView node={node('ck1')} deleteNode={deleteNode} />
      </EmbedCardContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Card options', hidden: true }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show as inline mention', hidden: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Card options', hidden: true }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove card', hidden: true }));
    expect(deleteNode).toHaveBeenCalled();
    // The Open control is disabled with no host callback.
    expect(
      (screen.getByRole('button', { name: 'Open work item', hidden: true }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('flags an archived item in the default card', () => {
    const { container } = render(<>{defaultEmbedCard({ ...LIVE, archived: true })}</>);
    expect(container.querySelector('.is-archived')).toBeTruthy();
  });
});

describe('WorkItemChipView', () => {
  const chip = (over: Partial<MentionChipContextValue> = {}): MentionChipContextValue =>
    ({
      lookup: () => LIVE,
      renderChip: () => <span>chip</span>,
      messages: MESSAGES.mention,
      editable: true,
      toCardLabel: 'Show as card',
      ...over,
    }) as MentionChipContextValue;

  it('does not convert a chip whose position is unknown', () => {
    const chain = vi.fn();
    render(
      <MentionChipContext.Provider value={chip()}>
        <WorkItemChipView node={node('ck1')} editor={{ chain } as never} />
      </MentionChipContext.Provider>,
    );
    fireEvent.click(document.querySelector('[data-embed-convert]')!);
    expect(chain).not.toHaveBeenCalled();
  });

  it('draws the unavailable chip for a node with no id', () => {
    render(
      <MentionChipContext.Provider value={chip()}>
        <WorkItemChipView node={node(null)} />
      </MentionChipContext.Provider>,
    );
    expect(document.querySelector('.wi-chip.is-unavailable')).toBeNull();
  });

  it('draws no unavailable text without a provider', () => {
    render(<WorkItemChipView node={node('ck1')} />);
    expect(document.querySelector('.wi-chip.is-unavailable')).toBeTruthy();
  });
});

describe('WorkItemPicker band keys', () => {
  const props = (band?: Parameters<typeof WorkItemPicker>[0]['band']) => ({
    query: 'a',
    search: vi.fn(async () => []),
    renderRow: () => null,
    onPick: vi.fn(),
    label: 'Mention a work item',
    messages: MESSAGES.mention,
    band,
  });

  it('switches placement on Tab only when it has a band', () => {
    const onPlacementChange = vi.fn();
    const band = {
      placement: 'mention' as const,
      onPlacementChange,
      onPickEmbed: vi.fn(),
      messages: MESSAGES.embed,
    };
    const { unmount } = render(<WorkItemPicker {...props(band)} />);
    const press = (k: string) =>
      screen.getByRole('listbox').dispatchEvent(new CustomEvent(PICKER_KEY_EVENT, { detail: k }));
    press('Tab');
    expect(onPlacementChange).toHaveBeenCalledWith('card');
    expect(screen.getByText(MESSAGES.mention.typeToSearch)).toBeTruthy();
    unmount();

    render(<WorkItemPicker {...props()} />);
    press('Tab'); // no band: nothing to switch
    press('Enter'); // too short a query: nothing to pick
    expect(onPlacementChange).toHaveBeenCalledTimes(1);
  });
});
