// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { useTranslations } from 'next-intl';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { buildIssueColumns } from '@/app/(authed)/items/_components/issueColumns';
import type { IssueRowData } from '@/app/(authed)/items/_components/issueRows';
import { WorkItemNode } from '@/components/planning/WorkItemNode';
import { toItem } from '@/lib/planning/roadmapClient';

// A Visitor's PRIVATE epic wears "Not public" on the list and tree rows and on
// the roadmap node (Story MOTIR-6170 · MOTIR-6648; design MOTIR-6641,
// `epic-privacy.md` §4). The mark rides only a Visitor's read (`childrenHidden`),
// so a row or node without it — every member read — shows nothing new.

afterEach(() => cleanup());

function TitleCell({ row }: { row: Partial<IssueRowData> }) {
  const t = useTranslations();
  const title = buildIssueColumns(t).find((c) => c.key === 'title')!;
  return (
    <div>
      {title.cell({ identifier: 'P-1', title: 'Epic', kind: 'epic', ...row } as IssueRowData)}
    </div>
  );
}

describe('the list and tree title cell', () => {
  it('shows the pill for a marked row and not otherwise', () => {
    render(<TitleCell row={{ childrenHidden: true }} />);
    expect(screen.getByTestId('epic-not-public-pill')).toBeTruthy();
    cleanup();
    render(<TitleCell row={{}} />);
    expect(screen.queryByTestId('epic-not-public-pill')).toBeNull();
  });
});

describe('the roadmap', () => {
  it('carries the wire mark through toItem, and the node shows the pill', () => {
    const marked = toItem({
      id: 'e',
      parentId: null,
      kind: 'epic',
      identifier: 'P-1',
      title: 'Epic',
      status: 'todo',
      isDone: false,
      hasChildren: false,
      childrenHidden: true,
    });
    expect(marked.childrenHidden).toBe(true);
    const plain = toItem({
      id: 'e',
      parentId: null,
      kind: 'epic',
      identifier: 'P-1',
      title: 'Epic',
      status: 'todo',
      isDone: false,
      hasChildren: true,
    });
    expect('childrenHidden' in plain).toBe(false);

    render(
      <WorkItemNode
        item={{ id: 'e', identifier: 'P-1', title: 'Epic', kind: 'epic', status: 'todo' }}
        notPublic
      />,
    );
    expect(screen.getByTestId('epic-not-public-pill')).toBeTruthy();
    cleanup();
    render(
      <WorkItemNode
        item={{ id: 'e', identifier: 'P-1', title: 'Epic', kind: 'epic', status: 'todo' }}
      />,
    );
    expect(screen.queryByTestId('epic-not-public-pill')).toBeNull();
  });
});
