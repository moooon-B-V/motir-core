// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ProjectVisitorsCard } from '@/app/(authed)/settings/project/members/_components/ProjectVisitorsCard';
import type { ProjectVisitorDTO, ProjectVisitorsPageDTO } from '@/lib/dto/visitors';

// The project's Visitors, for its Managers (Story MOTIR-6170 · MOTIR-6667; design
// MOTIR-6641 panels V1–V2): the populated list with names and emails, the neutral
// label for a person with no name (their email still shown), the empty state, and
// Show more appending the next page after its response lands.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const visitor = (name: string, email: string, hoursAgo = 3): ProjectVisitorDTO => {
  const at = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  return { name, email, firstVisitAt: at, lastVisitAt: at, consentedAt: at };
};

const page = (
  visitors: ProjectVisitorDTO[],
  total: number,
  nextCursor: string | null = null,
): ProjectVisitorsPageDTO => ({ visitors, total, nextCursor });

describe('ProjectVisitorsCard', () => {
  it('lists each visitor by name and email, and shows the neutral label with the email for a nameless one', () => {
    renderWithIntl(
      <ProjectVisitorsCard
        projectKey="PROD"
        workspaceName="moooon"
        initialPage={page(
          [visitor('Riya Sen', 'riya@example.com'), visitor('', 'k@example.org', 30)],
          2,
        )}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Visitors' })).toBeTruthy();
    expect(screen.getByLabelText('2 visitors')).toBeTruthy();
    const list = screen.getByTestId('project-visitors');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Riya Sen')).toBeTruthy();
    expect(within(rows[0]!).getByText('riya@example.com')).toBeTruthy();
    expect(within(rows[1]!).getByText('Project member')).toBeTruthy();
    expect(within(rows[1]!).getByText('k@example.org')).toBeTruthy();
    expect(within(rows[0]!).getByText('First visit')).toBeTruthy();
    expect(within(rows[0]!).getByText('Latest visit')).toBeTruthy();
    expect(within(rows[0]!).getByText('Agreed')).toBeTruthy();
    // Every time carries its full date on hover.
    for (const time of rows[0]!.querySelectorAll('time'))
      expect(time.getAttribute('title')).toBeTruthy();
    // The last page: no Show more.
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('shows the empty state, naming the workspace, when nobody has visited', () => {
    renderWithIntl(
      <ProjectVisitorsCard projectKey="PROD" workspaceName="moooon" initialPage={page([], 0)} />,
    );
    expect(screen.getByText('No one has visited yet')).toBeTruthy();
    expect(screen.getByText(/When someone outside moooon opens/)).toBeTruthy();
    expect(screen.queryByTestId('project-visitors')).toBeNull();
    expect(screen.getByLabelText('0 visitors')).toBeTruthy();
  });

  it('Show more appends the next page once its response lands, then disappears on the last page', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(page([visitor('Tomás Ortega', 'tomas@ortega.dev', 50)], 2)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderWithIntl(
      <ProjectVisitorsCard
        projectKey="PROD"
        workspaceName="moooon"
        initialPage={page([visitor('Riya Sen', 'riya@example.com')], 2, 'CURSOR-1')}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(screen.getByText('tomas@ortega.dev')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/PROD/visitors?cursor=CURSOR-1');
    expect(within(screen.getByTestId('project-visitors')).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('says so when the next page fails, and keeps Show more to try again', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    );
    renderWithIntl(
      <ProjectVisitorsCard
        projectKey="PROD"
        workspaceName="moooon"
        initialPage={page([visitor('Riya Sen', 'riya@example.com')], 2, 'CURSOR-1')}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy();
  });
});
