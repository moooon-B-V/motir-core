// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { WorkItemEmbedCard } from '@/components/pages/WorkItemEmbedCard';
import { pageWorkItemHref } from '@/components/pages/PageEditorHost';

// The app's embedded work-item card (MOTIR-9182): the five facts, the archived
// treatment, and the stated words for an unassigned item and a missing status.

// Derived from the component: `@motir/pages` is imported only from its composition root.
type AvailableWorkItemRefView = ComponentProps<typeof WorkItemEmbedCard>['view'];

const VIEW: AvailableWorkItemRefView = {
  accessible: true,
  id: 'ckLive',
  identifier: 'MOTIR-1188',
  title: 'Page export to Markdown',
  kind: 'task',
  archived: false,
  status: { key: 'in_review', label: 'In Review', category: 'in_progress' },
  type: 'code',
  assignee: { id: 'u1', name: 'Dana Whitfield', image: null },
};

afterEach(cleanup);

describe('WorkItemEmbedCard', () => {
  it('draws type, key, title, status and assignee', () => {
    renderWithIntl(<WorkItemEmbedCard view={VIEW} />);
    expect(screen.getByRole('img', { name: 'Type: Code' })).toBeTruthy();
    expect(screen.getByText('MOTIR-1188')).toBeTruthy();
    expect(screen.getByText('Page export to Markdown')).toBeTruthy();
    expect(screen.getByText('In Review')).toBeTruthy();
    expect(screen.getByText('Dana Whitfield')).toBeTruthy();
  });

  it('states Unassigned and No status instead of leaving a slot blank', () => {
    renderWithIntl(<WorkItemEmbedCard view={{ ...VIEW, assignee: null, status: null }} />);
    expect(screen.getByText('Unassigned')).toBeTruthy();
    expect(screen.getByText('No status')).toBeTruthy();
  });

  it('keeps every fact on an archived item and adds the Archived pill', () => {
    renderWithIntl(<WorkItemEmbedCard view={{ ...VIEW, archived: true }} />);
    expect(screen.getByText('Archived')).toBeTruthy();
    expect(screen.getByText('MOTIR-1188')).toBeTruthy();
    expect(screen.getByText('Dana Whitfield')).toBeTruthy();
  });

  it('omits the type glyph for an item with no type, without a placeholder', () => {
    renderWithIntl(<WorkItemEmbedCard view={{ ...VIEW, type: null }} />);
    expect(screen.queryByRole('img', { name: /^Type:/ })).toBeNull();
  });

  it('holds no link or button of its own, and points the anchor at the item page', () => {
    const { container } = renderWithIntl(<WorkItemEmbedCard view={VIEW} />);
    expect(container.querySelector('a, button')).toBeNull();
    expect(pageWorkItemHref(VIEW)).toBe('/items/MOTIR-1188');
  });

  it('draws initials for a single-word name and for an assignee with no name', () => {
    const { container } = renderWithIntl(
      <WorkItemEmbedCard view={{ ...VIEW, assignee: { id: 'u2', name: 'Prince', image: null } }} />,
    );
    expect(container.textContent).toContain('P');
    expect(screen.getByText('Prince')).toBeTruthy();
    cleanup();
    const unnamed = renderWithIntl(
      <WorkItemEmbedCard view={{ ...VIEW, assignee: { id: 'u3', name: '', image: null } }} />,
    );
    expect(unnamed.container.querySelector('[data-testid="work-item-embed-card"]')).toBeTruthy();
    expect(screen.queryByText('Unassigned')).toBeNull();
  });

  it('tones the status pill for to-do and done items', () => {
    renderWithIntl(
      <WorkItemEmbedCard
        view={{ ...VIEW, status: { key: 'todo', label: 'To Do', category: 'todo' } }}
      />,
    );
    expect(screen.getByText('To Do')).toBeTruthy();
    cleanup();
    renderWithIntl(
      <WorkItemEmbedCard
        view={{ ...VIEW, status: { key: 'done', label: 'Done', category: 'done' } }}
      />,
    );
    expect(screen.getByText('Done')).toBeTruthy();
  });
});
