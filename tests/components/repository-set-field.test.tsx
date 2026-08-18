// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { afterEach } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import messages from '@/messages/en.json';
import { RepositorySetField } from '@/components/workItems/RepositorySetField';
import type { RepoDelivery } from '@/lib/workItems/repoDelivery';

// The rail's REPOSITORY SET (Story MOTIR-2725 · MOTIR-2415), per
// design/work-items/repository-set.mock.html and its quick-view compression.
//
// ONE component, TWO surfaces — so the compression is asserted as a PROP over
// the same input, and the strings are read from the SAME catalog the component
// reads, never re-typed here. A test that hard-codes "Repositories" would pass
// while the two surfaces drifted, which is the failure this story is about.

const t = messages.issueViews;

function d(repo: string, state: RepoDelivery['state'], primary = false): RepoDelivery {
  return { repo, state, primary };
}

afterEach(cleanup);

function renderField(props: { delivery: RepoDelivery[]; compact?: boolean }) {
  return render(<RepositorySetField {...props} />);
}

describe('the repository SET on the detail rail', () => {
  it('renders every repository IN ORDER, with the primary distinguished', () => {
    renderField({ delivery: [d('motir-ai', 'delivered', true), d('motir-core', 'awaiting')] });

    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // Order is meaningful — element 0 is what dispatch routes to.
    expect(within(rows[0]!).getByText('motir-ai')).toBeTruthy();
    expect(within(rows[1]!).getByText('motir-core')).toBeTruthy();
    // The chip rides the FIRST row and only the first.
    expect(within(rows[0]!).getByText(t.repositoryPrimary)).toBeTruthy();
    expect(within(rows[1]!).queryByText(t.repositoryPrimary)).toBeNull();
  });

  it('does NOT draw the primary chip above ONE repository — it would be noise', () => {
    renderField({ delivery: [d('motir-core', 'awaiting', true)] });
    expect(screen.queryByText(t.repositoryPrimary)).toBeNull();
  });

  it('names each delivery state in TEXT, so it never rides colour alone', () => {
    renderField({
      delivery: [d('motir-core', 'delivered', true), d('motir-ai', 'awaiting'), d('gw', 'unknown')],
    });
    // Each state word is present for a screen reader (the glyph is aria-hidden),
    // which is the non-colour cue the AA rule requires.
    expect(screen.getAllByText(t.repositoryDelivery.delivered).length).toBeGreaterThan(0);
    expect(screen.getAllByText(t.repositoryDelivery.awaiting).length).toBeGreaterThan(0);
    expect(screen.getAllByText(t.repositoryDelivery.unknown).length).toBeGreaterThan(0);
  });

  it('counts the set, and NAMES the outstanding repository on the detail page', () => {
    renderField({ delivery: [d('motir-core', 'delivered', true), d('motir-ai', 'awaiting')] });
    expect(screen.getByText('1 of 2 delivered. motir-ai is outstanding.')).toBeTruthy();
  });

  it('collapses the caption when every repository has landed', () => {
    renderField({ delivery: [d('motir-core', 'delivered', true), d('motir-ai', 'delivered')] });
    expect(screen.getByText(t.repositoriesAllDelivered)).toBeTruthy();
  });

  it('says which branch is UNRECORDED rather than asserting one Motir does not know', () => {
    renderField({ delivery: [d('motir-core', 'delivered', true), d('motir-ai', 'unknown')] });
    expect(
      screen.getByText('motir-ai merged, but Motir has no record of which branch.'),
    ).toBeTruthy();
  });

  it('drops the count entirely at size one — the row already says everything', () => {
    renderField({ delivery: [d('motir-core', 'delivered', true)] });
    expect(screen.queryByText(/delivered\./)).toBeNull();
  });
});

describe('the EMPTY set — a deliberate state, not a hole', () => {
  it('reads the shipped word for nothing, plus one line saying it was allowed', () => {
    renderField({ delivery: [] });
    expect(screen.getByText(t.none)).toBeTruthy();
    expect(screen.getByText(t.repositoriesOptional)).toBeTruthy();
  });

  it('renders NO error, NO warning and NO required affordance', () => {
    const { container } = renderField({ delivery: [] });
    expect(screen.queryByRole('alert')).toBeNull();
    // The optionality is structural, not incidental: nothing anywhere asks the
    // user to fill this in, and no danger/warning token is spent on an absence.
    expect(container.textContent).not.toMatch(/\*|required|add repository/i);
    expect(container.querySelector('[class*="--el-danger"], [class*="--el-warning"]')).toBeNull();
  });
});

describe('the quick-view COMPRESSION is a prop over the same input (MOTIR-2414)', () => {
  const four = [
    d('motir-core', 'delivered', true),
    d('motir-ai', 'delivered'),
    d('motir-gateway', 'awaiting'),
    d('platform-starter', 'awaiting'),
  ];

  it('caps the rows at three and says how many more there are', () => {
    renderField({ delivery: four, compact: true });
    const rows = screen.getAllByRole('listitem');
    // Three repository rows + the overflow line.
    expect(rows).toHaveLength(4);
    expect(screen.getByText('+1 more')).toBeTruthy();
    expect(screen.queryByText('platform-starter')).toBeNull();
  });

  it('still communicates the TOTAL — no size renders as if the card carried fewer', () => {
    renderField({ delivery: four, compact: true });
    // The card's hard rule. The count carries it even though a name is hidden.
    expect(screen.getByText('2 of 4 delivered.')).toBeTruthy();
  });

  it('does NOT cap the detail page — the same input renders every row', () => {
    renderField({ delivery: four });
    expect(screen.getByText('platform-starter')).toBeTruthy();
    expect(screen.queryByText('+1 more')).toBeNull();
  });

  it('drops the outstanding NAME and the empty-state caption, and NOTHING else', () => {
    renderField({
      delivery: [d('motir-core', 'delivered', true), d('motir-ai', 'awaiting')],
      compact: true,
    });
    expect(screen.getByText('1 of 2 delivered.')).toBeTruthy();
    expect(screen.queryByText(/is outstanding/)).toBeNull();

    renderField({ delivery: [], compact: true });
    expect(screen.getAllByText(t.none).length).toBeGreaterThan(0);
    expect(screen.queryByText(t.repositoriesOptional)).toBeNull();
  });

  it('uses the SAME words on both surfaces — asserted against one source', () => {
    // The story's own failure mode, one level down: two surfaces teaching two
    // vocabularies. Both renders read the same catalog keys, so a divergence
    // has to be a deliberate edit to the shared component, not a drift.
    const delivery = [d('motir-core', 'delivered', true), d('motir-ai', 'awaiting')];
    const detail = renderField({ delivery }).container.textContent ?? '';
    const peek = renderField({ delivery, compact: true }).container.textContent ?? '';
    for (const word of [
      t.repositoryPrimary,
      t.repositoryDelivery.delivered,
      t.repositoryDelivery.awaiting,
    ]) {
      expect(detail).toContain(word);
      expect(peek).toContain(word);
    }
  });
});
