// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { renderMarkdown } from '@/lib/markdown/render';
import { WorkItemTitle } from '@/components/markdown/WorkItemTitle';
import type { WorkItemRefMap } from '@/lib/dto/workItems';

// The work-item internal-link chip render (Story 5.8 · Subtask 5.8.6). A
// `[KEY](motir:<id>)` token resolves against the threaded `workItemRefs` map and
// renders as the live chip (type icon · current key · title · status dot),
// opening the quick-view peek on click; the archived / deleted / no-access
// states degrade per design and never break the body. The chip reuses
// RelationshipPeekLink (usePeekOpen → usePathname / useSearchParams), so the
// App Router hooks are stubbed — the same shape relationships-panel.test.tsx uses.
let searchParamsString = '';
vi.mock('next/navigation', () => ({
  usePathname: () => '/items/MOTIR-1',
  useSearchParams: () => new URLSearchParams(searchParamsString),
}));

const historyPush = vi.spyOn(window.history, 'pushState').mockImplementation(() => {});

afterEach(() => {
  historyPush.mockClear();
  searchParamsString = '';
  cleanup();
});

function live(overrides: Partial<Record<string, unknown>> = {}): WorkItemRefMap {
  const summary = {
    accessible: true as const,
    id: 'cmwi805',
    identifier: 'MOTIR-805',
    title: 'Issue-tree generation',
    kind: 'story' as const,
    archived: false,
    status: { key: 'in_progress', label: 'In Progress', category: 'in_progress' as const },
    ...overrides,
  };
  return { [summary.id]: summary, [summary.identifier]: summary };
}

describe('renderMarkdown — work-item reference chip', () => {
  it('renders a resolved motir: token as the live chip (current key · title · status dot)', () => {
    const { container } = renderWithIntl(
      <>
        {renderMarkdown('See [MOTIR-805](motir:cmwi805) for context.', { workItemRefs: live() })}
      </>,
    );
    const chip = container.querySelector('a.wi-chip') as HTMLAnchorElement;
    expect(chip).toBeTruthy();
    // The CURRENT key + title (from the resolved map), not the authored label.
    expect(within(chip).getByText('MOTIR-805')).toBeTruthy();
    expect(within(chip).getByText('Issue-tree generation')).toBeTruthy();
    // The status dot reflects the resolved category (in_progress).
    expect(chip.querySelector('.wi-dot.s-inprogress')).toBeTruthy();
    // It's a navigable anchor to the item (peek-on-click handled by the link).
    expect(chip.getAttribute('href')).toBe('/items/MOTIR-805');
  });

  it('renders an archived target muted/dashed with the archive glyph, still navigable', () => {
    const { container } = renderWithIntl(
      <>
        {renderMarkdown('Superseded by [MOTIR-805](motir:cmwi805).', {
          workItemRefs: live({ archived: true }),
        })}
      </>,
    );
    const chip = container.querySelector('a.wi-chip.is-archived') as HTMLAnchorElement;
    expect(chip).toBeTruthy();
    expect(chip.querySelector('.wi-archive-glyph')).toBeTruthy();
    expect(chip.getAttribute('href')).toBe('/items/MOTIR-805');
    // Archived shows no live status dot.
    expect(chip.querySelector('.wi-dot')).toBeNull();
  });

  it('renders a missing id (deleted) as a struck-through bare key — NOT a link', () => {
    const { container } = renderWithIntl(
      <>{renderMarkdown('Gone: [MOTIR-742](motir:cmgone).', { workItemRefs: {} })}</>,
    );
    const chip = container.querySelector('.wi-chip.is-deleted') as HTMLElement;
    expect(chip).toBeTruthy();
    expect(chip.tagName).toBe('SPAN'); // not an anchor
    expect(chip.textContent).toBe('MOTIR-742'); // the bare authored key
    expect(container.querySelector('a.wi-chip')).toBeNull();
  });

  it('renders a no-access target as a bare key only — no title/status leak', () => {
    const refs: WorkItemRefMap = { cmsecret: { accessible: false, id: 'cmsecret' } };
    const { container } = renderWithIntl(
      <>{renderMarkdown('Locked: [SECRET-12](motir:cmsecret).', { workItemRefs: refs })}</>,
    );
    const chip = container.querySelector('.wi-chip.is-noaccess') as HTMLElement;
    expect(chip).toBeTruthy();
    expect(chip.tagName).toBe('SPAN');
    expect(chip.textContent).toBe('SECRET-12');
    expect(chip.querySelector('.wi-title')).toBeNull();
    expect(chip.querySelector('.wi-dot')).toBeNull();
  });

  it('a malformed motir: href degrades to plain text — never a broken link', () => {
    const { container } = renderWithIntl(
      <>{renderMarkdown('ghost [MOTIR-1](motir:) here', { workItemRefs: {} })}</>,
    );
    expect(container.querySelector('.wi-chip')).toBeNull();
    expect(container.querySelector('a[href^="motir:"]')).toBeNull();
    expect(container.textContent).toContain('MOTIR-1');
  });

  it('still renders the user mention chip unchanged (no regression)', () => {
    const { container } = renderWithIntl(
      <>
        {renderMarkdown('[@Bo Philips](mention:cm9zabc123) and [MOTIR-805](motir:cmwi805)', {
          workItemRefs: live(),
        })}
      </>,
    );
    const mention = container.querySelector('span.mention-chip');
    expect(mention?.textContent).toBe('@Bo Philips');
    expect(container.querySelector('a.wi-chip')).toBeTruthy();
  });
});

describe('WorkItemTitle — bare-key linkify', () => {
  it('linkifies a live bare MOTIR-N into a peek link', () => {
    renderWithIntl(
      <WorkItemTitle
        title="Wire MOTIR-805 into onboarding"
        projectIdentifier="MOTIR"
        workItemRefs={live()}
      />,
    );
    const link = screen.getByRole('link', { name: 'MOTIR-805' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/items/MOTIR-805');
  });

  it('leaves a deleted/unresolved bare key as plain text (no broken link)', () => {
    const { container } = renderWithIntl(
      <WorkItemTitle
        title="Wire MOTIR-742 into onboarding"
        projectIdentifier="MOTIR"
        workItemRefs={{}}
      />,
    );
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('Wire MOTIR-742 into onboarding');
  });
});
