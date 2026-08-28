// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, fireEvent } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// MOTIR-3756 — the picker's DELIVERY CHIP, over the three arms of the delivery
// set (`design/github/design-notes.md` Panel 5b, as amended;
// `docs/decisions/delivery-reader-migration.md` §3).
//
// The renderer branches on `linkedTo.LENGTH`, and each arm is a different piece
// of copy under a different key, so a test that renders only one of them passes
// against an implementation that has collapsed the other two. All three are
// asserted here, plus the negative that matters most: the ≥ 2 arm must NOT be
// the "Linked to" copy, which is what a naive `linkedTo[0]` would render.

const linkPullRequestAction = vi.fn();
const listPullRequestCandidatesAction = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(authed)/items/[key]/actions', () => ({
  linkPullRequestAction: (...args: unknown[]) => linkPullRequestAction(...args),
  listPullRequestCandidatesAction: (...args: unknown[]) => listPullRequestCandidatesAction(...args),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import {
  DevelopmentLinkProvider,
  LinkPullRequestDoor,
  LinkPullRequestForm,
} from '@/app/(authed)/items/[key]/_components/DevelopmentLinkControl';

/** A candidate row, varying only in what it already delivers. */
function candidate(id: string, number: number, linkedTo: string[]) {
  return {
    id,
    title: `Session run ${number}`,
    repo: 'moooon/motir-core',
    number,
    state: 'open' as const,
    linkedTo,
  };
}

beforeEach(() => {
  linkPullRequestAction.mockReset();
  listPullRequestCandidatesAction.mockReset();
  refresh.mockReset();
});
afterEach(cleanup);

/** Open the picker and type, so the query-driven candidate read fires. */
async function openAndSearch() {
  render(
    <DevelopmentLinkProvider currentItemId="wi-1" identifier="MOTIR-1">
      <LinkPullRequestDoor />
      <LinkPullRequestForm />
    </DevelopmentLinkProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Link pull request/ }));
  fireEvent.click(await screen.findByRole('combobox', { name: 'Pull request to link' }));
  fireEvent.change(await screen.findByRole('combobox', { name: /Search pull requests/ }), {
    target: { value: 'Session' },
  });
}

describe('the picker chip reads the LENGTH of the delivery set (MOTIR-3756)', () => {
  it('renders the PR-state pill at zero, the unchanged copy at one, and the COUNT at two or more', async () => {
    listPullRequestCandidatesAction.mockResolvedValue({
      ok: true,
      candidates: [
        candidate('pr-0', 10, []),
        candidate('pr-1', 11, ['MOTIR-77']),
        candidate('pr-2', 12, ['MOTIR-88', 'MOTIR-89', 'MOTIR-90']),
      ],
    });
    await openAndSearch();

    // 0 → the PR-state pill, unchanged. (Every row is `state: 'open'`, so the
    // one occurrence of this copy IS the zero-delivery row.)
    expect(await screen.findByText('Open')).toBeTruthy();

    // 1 → the unchanged copy, under the unchanged `development.linkedTo` key.
    expect(await screen.findByText('Linked to MOTIR-77')).toBeTruthy();

    // ≥ 2 → the COUNT, under the one new key. Not a list, not a cap.
    expect(await screen.findByText('Delivers 3 work items')).toBeTruthy();

    // …and the negative that a `linkedTo[0]` implementation would fail: the
    // multi-delivery row must not render as a single takeover.
    expect(screen.queryByText('Linked to MOTIR-88')).toBeNull();
  });

  it('renders the count at exactly two — the boundary between the two chip arms', async () => {
    listPullRequestCandidatesAction.mockResolvedValue({
      ok: true,
      candidates: [candidate('pr-3', 13, ['MOTIR-91', 'MOTIR-92'])],
    });
    await openAndSearch();

    expect(await screen.findByText('Delivers 2 work items')).toBeTruthy();
    expect(screen.queryByText(/^Linked to/)).toBeNull();
  });
});
