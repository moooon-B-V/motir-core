// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import type { MonitorIssueCandidateDto, MonitorIssueLinkDto } from '@/lib/dto/monitorIssueLink';

// LINK an error from the work-item page (Story MOTIR-4932 · Subtask MOTIR-5744),
// design `design/monitoring` §14 panels 5b–5c, 6 and 7: the header door, the
// picker's states, the move confirmation, the refusal banners and the ⋯-menu
// door for a work item with no link — driven through the REAL components with
// only the server actions and the router stubbed.

const searchMonitorIssuesAction = vi.fn();
const linkMonitorIssueAction = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(authed)/items/[key]/actions', () => ({
  searchMonitorIssuesAction: (...args: unknown[]) => searchMonitorIssuesAction(...args),
  linkMonitorIssueAction: (...args: unknown[]) => linkMonitorIssueAction(...args),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

const { MonitorErrorsCard } =
  await import('@/app/(authed)/items/[key]/_components/MonitorErrorsCard');
const { MonitorErrorsDoorProvider } =
  await import('@/app/(authed)/items/[key]/_components/MonitorErrorsLinkControl');
const { WorkItemDetailActions } =
  await import('@/app/(authed)/items/[key]/_components/WorkItemDetailActions');

const m = en.monitorErrors;
const NOW = new Date('2026-09-19T12:00:00.000Z');

beforeEach(() => {
  searchMonitorIssuesAction.mockReset();
  linkMonitorIssueAction.mockReset();
  refresh.mockReset();
});
afterEach(cleanup);

function candidate(
  externalIssueId: string,
  overrides: Partial<MonitorIssueCandidateDto> = {},
): MonitorIssueCandidateDto {
  return {
    connectionId: 'c-web',
    orgSlug: 'acme',
    projectSlug: 'web',
    externalIssueId,
    title: `Error ${externalIssueId}`,
    level: 'error',
    eventCount: 1284,
    lastSeenAt: '2026-09-19T11:48:00.000Z',
    permalink: null,
    linkedTo: null,
    ...overrides,
  };
}

const LINK: MonitorIssueLinkDto = {
  id: 'mi-1',
  title: 'Already here',
  level: 'error',
  culprit: null,
  permalink: 'https://acme.sentry.io/issues/9/',
  eventCount: 4,
  firstSeenAt: '2026-09-01T00:00:00.000Z',
  lastSeenAt: '2026-09-19T11:00:00.000Z',
  environment: null,
  release: null,
  connection: { id: 'c-web', orgSlug: 'acme', projectSlug: 'web' },
  resolve: { state: null, attemptedAt: null, resolvedAt: null, error: null },
  assigneeNote: null,
};

function searchResult(candidates: MonitorIssueCandidateDto[], failures: unknown[] = []) {
  return { ok: true, result: { candidates, failures, noConnection: false, truncated: false } };
}

function renderCard(props: {
  links?: MonitorIssueLinkDto[] | null;
  hasConnection?: boolean;
  canEdit?: boolean;
}) {
  return render(
    <MonitorErrorsDoorProvider>
      <MonitorErrorsCard
        links={props.links === undefined ? [LINK] : props.links}
        hasConnection={props.hasConnection ?? true}
        canEdit={props.canEdit ?? true}
        workItemId="wi-1"
        identifier="ACME-1"
        unlinkAction={vi.fn()}
      />
    </MonitorErrorsDoorProvider>,
    { now: NOW },
  );
}

async function openPicker() {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(m.link) }));
  fireEvent.click(await screen.findByRole('combobox', { name: m.field }));
}

describe('the header door (§14 Decision 5)', () => {
  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ])('canEdit=%s, hasConnection=%s → door shown: %s', (canEdit, hasConnection, shown) => {
    renderCard({ canEdit, hasConnection });
    expect(screen.queryByRole('button', { name: new RegExp(m.link) }) !== null).toBe(shown);
    // The rows show either way.
    expect(screen.getAllByTestId('error-row')).toHaveLength(1);
  });
});

describe('the picker (§14 panels 6a–6b)', () => {
  it('lists the EMPTY-query results before typing, each with connection, count, last seen and level', async () => {
    searchMonitorIssuesAction.mockResolvedValue(searchResult([candidate('a')]));
    renderCard({});
    await openPicker();

    const option = await screen.findByRole('option', { name: /Error a/ });
    expect(searchMonitorIssuesAction).toHaveBeenCalledWith({ workItemId: 'wi-1', query: '' });
    expect(option.textContent).toContain('acme / web · Seen 1,284 times · 12 minutes ago');
    expect(within(option).getByText('error')).toBeTruthy();
  });

  it('searches as the person types', async () => {
    searchMonitorIssuesAction.mockResolvedValue(searchResult([]));
    renderCard({});
    await openPicker();
    fireEvent.change(await screen.findByRole('combobox', { name: /Search errors/ }), {
      target: { value: 'WEB-1A' },
    });
    await vi.waitFor(() =>
      expect(searchMonitorIssuesAction).toHaveBeenLastCalledWith({
        workItemId: 'wi-1',
        query: 'WEB-1A',
      }),
    );
    expect(await screen.findByText(m.noMatches)).toBeTruthy();
    expect(screen.getByText(m.noMatchesHint)).toBeTruthy();
  });

  it('a failed connection shows its reason INSIDE the results while the other still lists', async () => {
    searchMonitorIssuesAction.mockResolvedValue(
      searchResult(
        [candidate('a')],
        [{ connectionId: 'c-worker', orgSlug: 'acme', projectSlug: 'worker', reason: 'busy' }],
      ),
    );
    renderCard({});
    await openPicker();

    expect(await screen.findByRole('option', { name: /Error a/ })).toBeTruthy();
    const failure = await screen.findByTestId('search-failure');
    expect(failure.textContent).toBe("Couldn't search acme / worker: busy");
  });

  it('a candidate linked HERE says so and cannot be picked; one linked ELSEWHERE names its key as text', async () => {
    searchMonitorIssuesAction.mockResolvedValue(
      searchResult([
        candidate('mine', { linkedTo: 'this' }),
        candidate('theirs', { linkedTo: { identifier: 'ACME-9' } }),
      ]),
    );
    renderCard({});
    await openPicker();

    const mine = await screen.findByRole('option', { name: /Error mine/ });
    expect(mine.getAttribute('aria-disabled')).toBe('true');
    expect(within(mine).getByText(m.linkedHere)).toBeTruthy();
    const theirs = screen.getByRole('option', { name: /Error theirs/ });
    expect(within(theirs).getByText('Linked to ACME-9')).toBeTruthy();
    expect(within(theirs).queryByRole('link')).toBeNull();
  });
});

async function pickAndLink(title: RegExp) {
  fireEvent.click(await screen.findByRole('option', { name: title }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: m.linkAction }));
  });
}

describe('link, move and refusals (§14 panels 6b, 7)', () => {
  it('picking an unlinked candidate links it and refreshes the section', async () => {
    searchMonitorIssuesAction.mockResolvedValue(searchResult([candidate('a')]));
    linkMonitorIssueAction.mockResolvedValue({ ok: true, outcome: 'linked' });
    renderCard({});
    await openPicker();
    await pickAndLink(/Error a/);

    expect(linkMonitorIssueAction).toHaveBeenCalledWith({
      workItemId: 'wi-1',
      identifier: 'ACME-1',
      connectionId: 'c-web',
      externalIssueId: 'a',
      move: false,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('already_linked opens the move confirmation naming the holder AS A LINK; Cancel changes nothing', async () => {
    searchMonitorIssuesAction.mockResolvedValue(
      searchResult([candidate('t', { linkedTo: { identifier: 'ACME-9' } })]),
    );
    linkMonitorIssueAction.mockResolvedValue({
      ok: false,
      code: 'already_linked',
      holderIdentifier: 'ACME-9',
    });
    renderCard({});
    await openPicker();
    await pickAndLink(/Error t/);

    const confirm = await screen.findByTestId('move-confirm');
    expect(confirm.textContent).toContain("Move this error's link from ACME-9 to this work item?");
    expect(confirm.textContent).toContain('ACME-9 keeps its other links and its history.');
    expect(within(confirm).getByRole('link', { name: 'ACME-9' }).getAttribute('href')).toBe(
      '/items/ACME-9',
    );
    fireEvent.click(within(confirm).getByRole('button', { name: en.common.cancel }));
    expect(screen.queryByTestId('move-confirm')).toBeNull();
    expect(linkMonitorIssueAction).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('Move link re-sends with move: true', async () => {
    searchMonitorIssuesAction.mockResolvedValue(
      searchResult([candidate('t', { linkedTo: { identifier: 'ACME-9' } })]),
    );
    linkMonitorIssueAction
      .mockResolvedValueOnce({ ok: false, code: 'already_linked', holderIdentifier: 'ACME-9' })
      .mockResolvedValueOnce({ ok: true, outcome: 'moved' });
    renderCard({});
    await openPicker();
    await pickAndLink(/Error t/);
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: m.move.action }));
    });

    expect(linkMonitorIssueAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ externalIssueId: 't', move: true }),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ ok: false, code: 'issue_gone' }, m.error.issueGone],
    [{ ok: false, code: 'not_found' }, m.error.notFound],
    [{ ok: false, code: 'forbidden' }, m.error.forbidden],
    [{ ok: false, code: 'provider_failed', reason: 'Sentry answered 502' }, 'Sentry answered 502'],
  ] as const)('%o renders its banner line', async (result, copy) => {
    searchMonitorIssuesAction.mockResolvedValue(searchResult([candidate('a')]));
    linkMonitorIssueAction.mockResolvedValue(result);
    renderCard({});
    await openPicker();
    await pickAndLink(/Error a/);
    expect((await screen.findByRole('alert')).textContent).toBe(copy);
  });
});

describe('the ⋯-menu door on a work item with NO link (§14 Decision 1)', () => {
  function renderPage(props: {
    links?: MonitorIssueLinkDto[] | null;
    hasConnection?: boolean;
    canEdit?: boolean;
  }) {
    const canEdit = props.canEdit ?? true;
    return render(
      <MonitorErrorsDoorProvider>
        <WorkItemDetailActions
          itemId="wi-1"
          identifier="ACME-1"
          title="Customer checkout bug"
          canEdit={canEdit}
          canArchive={false}
          canDelete={false}
        />
        <MonitorErrorsCard
          links={props.links === undefined ? [] : props.links}
          hasConnection={props.hasConnection ?? true}
          canEdit={canEdit}
          workItemId="wi-1"
          identifier="ACME-1"
          unlinkAction={vi.fn()}
        />
      </MonitorErrorsDoorProvider>,
      { now: NOW },
    );
  }
  const openMenu = () =>
    fireEvent.click(
      screen.getByRole('button', { name: en.workItemActions.menuLabel.replace('{key}', 'ACME-1') }),
    );
  const menuRow = () => screen.queryByRole('menuitem', { name: en.workItemActions.linkError });

  it('an editor, in a monitored project, with no link: the row mounts the section with the picker open; Cancel removes it', async () => {
    searchMonitorIssuesAction.mockResolvedValue(searchResult([]));
    renderPage({});
    expect(screen.queryByRole('heading', { name: m.title })).toBeNull();

    openMenu();
    fireEvent.click(await vi.waitFor(() => menuRow()!));

    expect(await screen.findByRole('heading', { name: m.title })).toBeTruthy();
    expect(screen.getByText(m.empty)).toBeTruthy();
    expect(screen.getByRole('combobox', { name: m.field })).toBeTruthy();
    expect(screen.queryByRole('button', { name: new RegExp(`^\\s*${m.link}`) })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: en.common.cancel }));
    expect(screen.queryByRole('heading', { name: m.title })).toBeNull();
  });

  it.each([
    ['a viewer without work_item:edit', { canEdit: false }],
    ['a project with no monitor', { hasConnection: false }],
    ['a work item that already has a link', { links: [LINK] }],
    ['a failed read', { links: null }],
  ] as const)('is ABSENT for %s', (_label, props) => {
    renderPage(props as Parameters<typeof renderPage>[0]);
    openMenu();
    expect(menuRow()).toBeNull();
  });

  it('is absent from the shared menu when no page provider is mounted (other surfaces)', () => {
    render(
      <WorkItemDetailActions
        itemId="wi-1"
        identifier="ACME-1"
        title="t"
        canEdit
        canArchive={false}
        canDelete={false}
      />,
    );
    openMenu();
    expect(menuRow()).toBeNull();
  });
});

describe('the remaining picker arms', () => {
  it('a refused SEARCH shows its code’s line in the banner', async () => {
    searchMonitorIssuesAction.mockResolvedValueOnce({ ok: false, code: 'forbidden' });
    renderCard({});
    await openPicker();
    expect((await screen.findByRole('alert')).textContent).toBe(m.error.forbidden);
  });

  it('a search refused for any other reason reads as not-found', async () => {
    searchMonitorIssuesAction.mockResolvedValueOnce({ ok: false, code: 'not_found' });
    renderCard({});
    await openPicker();
    expect((await screen.findByRole('alert')).textContent).toBe(m.error.notFound);
  });

  it('a candidate with no organisation and no level: the project alone, and no pill', async () => {
    searchMonitorIssuesAction.mockResolvedValue(
      searchResult([candidate('bare', { orgSlug: null, level: null })]),
    );
    renderCard({});
    await openPicker();
    const option = await screen.findByRole('option', { name: /Error bare/ });
    expect(option.textContent).toContain('web · Seen 1,284 times');
    expect(option.textContent).not.toContain('acme');
    expect(within(option).queryByText('error')).toBeNull();
  });

  it('Escape closes the move confirmation without moving', async () => {
    searchMonitorIssuesAction.mockResolvedValue(
      searchResult([candidate('t', { linkedTo: { identifier: 'ACME-9' } })]),
    );
    linkMonitorIssueAction.mockResolvedValue({
      ok: false,
      code: 'already_linked',
      holderIdentifier: 'ACME-9',
    });
    renderCard({});
    await openPicker();
    await pickAndLink(/Error t/);
    fireEvent.keyDown(await screen.findByTestId('move-confirm'), { key: 'Escape' });
    await vi.waitFor(() => expect(screen.queryByTestId('move-confirm')).toBeNull());
    expect(linkMonitorIssueAction).toHaveBeenCalledTimes(1);
  });

  it('the door outside its provider is a programming error, named', async () => {
    const { LinkErrorDoor } =
      await import('@/app/(authed)/items/[key]/_components/MonitorErrorsLinkControl');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<LinkErrorDoor />)).toThrow(/MonitorErrorsLinkProvider/);
  });
});

describe('opening the page asks the monitor nothing (MOTIR-5734 regression)', () => {
  it('an editor’s card with links makes NO search until the picker is opened — past the debounce', async () => {
    searchMonitorIssuesAction.mockResolvedValue(searchResult([]));
    renderCard({});
    // Longer than the hook's 250 ms debounce: a search mounted with the closed
    // picker would have fired by now.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(searchMonitorIssuesAction).not.toHaveBeenCalled();

    await openPicker();
    await vi.waitFor(() => expect(searchMonitorIssuesAction).toHaveBeenCalledTimes(1));
  });
});
