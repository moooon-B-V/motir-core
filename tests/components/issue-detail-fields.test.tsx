// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  CoreFieldsPanel,
  type PersonRef,
} from '@/app/(authed)/issues/[key]/_components/CoreFieldsPanel';
import { IssueExplanation } from '@/app/(authed)/issues/[key]/_components/IssueExplanation';
import type { WorkItemDto } from '@/lib/dto/workItems';

afterEach(cleanup);

// A fully-populated work item; per-test overrides exercise the empty states.
function makeItem(overrides: Partial<WorkItemDto> = {}): WorkItemDto {
  return {
    id: 'wi_1',
    projectId: 'proj_1',
    parentId: null,
    kind: 'story',
    key: 7,
    identifier: 'PROD-7',
    title: 'Ship the detail page',
    descriptionMd: '# Hello',
    explanationMd: null,
    explanationSource: 'user_authored',
    status: 'todo',
    priority: 'high',
    assigneeId: 'u_assignee',
    reporterId: 'u_reporter',
    dueDate: '2026-06-10T00:00:00.000Z',
    estimateMinutes: 90,
    position: 'a0',
    archivedAt: null,
    createdAt: '2026-06-01T14:45:00.000Z',
    updatedAt: '2026-06-03T09:30:00.000Z',
    ...overrides,
  };
}

const assignee: PersonRef = { name: 'Ada Lovelace', email: 'ada@example.com' };
const reporter: PersonRef = { name: 'Grace Hopper', email: 'grace@example.com' };

describe('CoreFieldsPanel', () => {
  it('renders every field with its value', () => {
    render(<CoreFieldsPanel item={makeItem()} assignee={assignee} reporter={reporter} />);

    // Type label, priority label
    expect(screen.getByText('Story')).toBeTruthy();
    expect(screen.getByText('High')).toBeTruthy();

    // Assignee + reporter names
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('Grace Hopper')).toBeTruthy();

    // Due date (date-only, en-US/UTC) and estimate (minutes → human duration)
    expect(screen.getByText('Jun 10, 2026')).toBeTruthy();
    expect(screen.getByText('1h 30m')).toBeTruthy();

    // Created / updated render through the deterministic en-US/UTC formatter
    // (the same string on server + client — no hydration mismatch).
    expect(screen.getByText('Jun 1, 02:45 PM UTC')).toBeTruthy();
    expect(screen.getByText('Jun 3, 09:30 AM UTC')).toBeTruthy();

    // The field labels themselves are present.
    expect(screen.getByText('Assignee')).toBeTruthy();
    expect(screen.getByText('Reporter')).toBeTruthy();
  });

  it('shows the documented empty states for null assignee / due date / estimate', () => {
    render(
      <CoreFieldsPanel
        item={makeItem({ assigneeId: null, dueDate: null, estimateMinutes: null })}
        assignee={null}
        reporter={reporter}
      />,
    );

    expect(screen.getByText('Unassigned')).toBeTruthy();
    expect(screen.getByText('No due date')).toBeTruthy();
    expect(screen.getByText('No estimate')).toBeTruthy();
    // Reporter is still resolved.
    expect(screen.getByText('Grace Hopper')).toBeTruthy();
  });
});

const EDIT_HREF = '/issues/PROD-7/edit';

describe('IssueExplanation', () => {
  it('renders the AI-drafted badge for an ai_draft explanation', () => {
    render(
      <IssueExplanation
        explanationMd="Because it matters."
        explanationSource="ai_draft"
        editHref={EDIT_HREF}
      />,
    );
    expect(screen.getByText('AI-drafted')).toBeTruthy();
    expect(screen.getByText('Because it matters.')).toBeTruthy();
  });

  it('omits the badge for a user_authored explanation', () => {
    render(
      <IssueExplanation
        explanationMd="Human-written rationale."
        explanationSource="user_authored"
        editHref={EDIT_HREF}
      />,
    );
    expect(screen.queryByText('AI-drafted')).toBeNull();
    expect(screen.getByText('Human-written rationale.')).toBeTruthy();
  });

  it('shows the always-present section with an empty state when there is no explanation', () => {
    render(
      <IssueExplanation
        explanationMd={null}
        explanationSource="user_authored"
        editHref={EDIT_HREF}
      />,
    );
    // The section header is always present; the body is the empty state.
    expect(screen.getByRole('heading', { name: 'Explanation' })).toBeTruthy();
    expect(screen.getByText('No explanation yet.')).toBeTruthy();
  });
});
