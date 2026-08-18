// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import messages from '@/messages/en.json';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import type { LinkedPullRequestDto } from '@/lib/dto/github';
import type { RepoDelivery } from '@/lib/workItems/repoDelivery';

// The Development section's ONE new element (Story MOTIR-2725 · MOTIR-2415,
// design `repository-set.mock.html` panel 1): a row for a repository the item
// CARRIES that has no pull request to show.
//
// It exists because the shipped section lists the pull requests that EXIST, and
// the whole point of the repository set is that a repository whose PR was never
// opened is invisible to anything counting rows — which is the state the
// completion gate holds an item for.
//
// The second property here is the boundary: the prop DEFAULTS to empty, so the
// quick view (which does not pass it until MOTIR-2416) renders byte-identically.

const t = messages.github.development;

afterEach(cleanup);

const merged: LinkedPullRequestDto = {
  title: 'feat(work-items): the repository SET',
  repo: 'moooon/motir-core',
  number: 2118,
  state: 'merged',
  ci: 'passing',
  url: 'https://github.com/moooon/motir-core/pull/2118',
  linkedManually: false,
};

const awaiting = (repo: string, state: RepoDelivery['state'] = 'awaiting'): RepoDelivery => ({
  repo,
  state,
  primary: false,
});

describe('a repository with no pull request yet', () => {
  it('renders a row AFTER the real pull requests, naming the repository', () => {
    render(
      <DevelopmentSectionBody
        pullRequests={[merged]}
        itemIdentifier="MOTIR-2725"
        awaitingRepos={[awaiting('moooon/motir-ai')]}
      />,
    );
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // The real PR first, the placeholder after — the same order the rail reads.
    expect(within(rows[0]!).getByText(merged.title)).toBeTruthy();
    expect(within(rows[1]!).getByText(t.noPullRequestYet)).toBeTruthy();
    expect(within(rows[1]!).getByText('moooon/motir-ai')).toBeTruthy();
    expect(within(rows[1]!).getByText(t.repoState.awaiting)).toBeTruthy();
  });

  it('says the branch is UNRECORDED for a merged PR whose base Motir never stored', () => {
    render(
      <DevelopmentSectionBody
        pullRequests={[merged]}
        itemIdentifier="MOTIR-2725"
        awaitingRepos={[awaiting('moooon/motir-ai', 'unknown')]}
      />,
    );
    expect(screen.getByText(t.mergedBranchUnknown)).toBeTruthy();
    expect(screen.getByText(t.repoState.unknown)).toBeTruthy();
    // It must not claim the repository is simply outstanding — that is a
    // different, and false, statement about a merge that may have landed.
    expect(screen.queryByText(t.noPullRequestYet)).toBeNull();
  });

  it('replaces the big EmptyState when the item carries repositories but has NO pull requests', () => {
    render(
      <DevelopmentSectionBody
        pullRequests={[]}
        itemIdentifier="MOTIR-2725"
        awaitingRepos={[awaiting('moooon/motir-core'), awaiting('moooon/motir-ai')]}
      />,
    );
    // Two placeholder rows say more than "no linked pull request" — they say
    // WHICH repositories are owed one.
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText(t.emptyTitle)).toBeNull();
  });

  it('still shows the EmptyState when the item carries NOTHING and has no pull requests', () => {
    render(<DevelopmentSectionBody pullRequests={[]} itemIdentifier="MOTIR-2725" />);
    expect(screen.getByText(t.emptyTitle)).toBeTruthy();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });
});

describe('the prop is OPT-IN — the quick view is unchanged until MOTIR-2416', () => {
  it('renders byte-identically with the prop omitted and with it empty', () => {
    // MOTIR-2415's scope is the detail page. This component is mounted on BOTH
    // surfaces, so the new behaviour ships as a prop with an empty default and
    // the peek's output cannot move by accident.
    const withoutProp = render(
      <DevelopmentSectionBody pullRequests={[merged]} itemIdentifier="MOTIR-2725" />,
    ).container.innerHTML;
    cleanup();
    const withEmptyProp = render(
      <DevelopmentSectionBody
        pullRequests={[merged]}
        itemIdentifier="MOTIR-2725"
        awaitingRepos={[]}
      />,
    ).container.innerHTML;
    expect(withEmptyProp).toBe(withoutProp);
  });
});
