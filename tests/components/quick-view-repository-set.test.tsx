// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import messages from '@/messages/en.json';
import { RepositorySetField } from '@/components/workItems/RepositorySetField';
import type { RepoDelivery } from '@/lib/workItems/repoDelivery';

// The repository SET in the QUICK VIEW (Story MOTIR-2725 · MOTIR-2416), per
// design/work-items/repository-set-quick-view.mock.html.
//
// The card's whole subject is that the two surfaces must not teach two
// vocabularies — so the assertions that matter here are AGREEMENT assertions,
// made against ONE source (the shipped catalog and one shared component) rather
// than against two copies of a literal. Two passing per-surface suites are
// exactly the state in which the wordings have already diverged.

const t = messages.issueViews;

afterEach(cleanup);

const d = (repo: string, state: RepoDelivery['state'], primary = false): RepoDelivery => ({
  repo,
  state,
  primary,
});

const textOf = (compact: boolean, delivery: RepoDelivery[]) => {
  const { container } = render(<RepositorySetField delivery={delivery} compact={compact} />);
  const text = container.textContent ?? '';
  cleanup();
  return text;
};

describe('the peek and the detail page say the SAME words', () => {
  const delivery = [d('motir-core', 'delivered', true), d('motir-ai', 'awaiting')];

  it('uses one label, one primary chip and one set of state words on both', () => {
    const detail = textOf(false, delivery);
    const peek = textOf(true, delivery);
    for (const word of [
      t.repositoryPrimary,
      t.repositoryDelivery.delivered,
      t.repositoryDelivery.awaiting,
    ]) {
      expect(detail).toContain(word);
      expect(peek).toContain(word);
    }
  });

  it('renders the empty set with the same word on both', () => {
    expect(textOf(false, [])).toContain(t.none);
    expect(textOf(true, [])).toContain(t.none);
  });

  it('treats a `decision` card identically — the field is type-blind', () => {
    // The rule settled in MOTIR-2413 Q5 is a PLANNING convention, so neither
    // surface branches on type: there is no type input to branch on.
    expect(RepositorySetField.length).toBe(1);
    expect(textOf(true, delivery)).toContain('motir-core');
  });
});

describe('what the peek COMPRESSES — and the one thing it must never lose', () => {
  const four = [
    d('motir-core', 'delivered', true),
    d('motir-ai', 'delivered'),
    d('motir-gateway', 'awaiting'),
    d('platform-starter', 'awaiting'),
  ];

  it('caps rows at three, and STILL reports how many there are', () => {
    render(<RepositorySetField delivery={four} compact />);
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(4); // three repositories + the overflow line
    expect(screen.getByText('+1 more')).toBeTruthy();
    // The card's hard rule: no size renders as if the card carried fewer.
    expect(screen.getByText('2 of 4 delivered.')).toBeTruthy();
  });

  it('shows every row at one, two and three — the cap only bites above three', () => {
    for (const n of [1, 2, 3]) {
      const { container } = render(<RepositorySetField delivery={four.slice(0, n)} compact />);
      expect(within(container).getAllByRole('listitem')).toHaveLength(n);
      expect(container.textContent).not.toContain('more');
      cleanup();
    }
  });

  it('drops the outstanding NAME from the caption but keeps the COUNT', () => {
    const delivery = [d('motir-core', 'delivered', true), d('motir-ai', 'awaiting')];
    const peek = textOf(true, delivery);
    expect(peek).toContain('1 of 2 delivered.');
    expect(peek).not.toContain('is outstanding');
    // The name is not lost — it is on the row, which is why the caption can
    // drop it.
    expect(peek).toContain('motir-ai');
  });

  it('drops the empty-state caption, so the field reads like its optional neighbours', () => {
    expect(textOf(true, [])).not.toContain(t.repositoriesOptional);
    expect(textOf(false, [])).toContain(t.repositoriesOptional);
  });

  it('never compresses a delivery STATE away — the reason the card is not Done', () => {
    const peek = textOf(true, [d('motir-core', 'delivered', true), d('motir-ai', 'unknown')]);
    expect(peek).toContain(t.repositoryDelivery.delivered);
    expect(peek).toContain(t.repositoryDelivery.unknown);
  });
});
