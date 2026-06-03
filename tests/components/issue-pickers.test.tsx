// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { IssueType } from '@/lib/issues/parentRules';

// The ParentPicker fetches candidates through the create-issue Server Action;
// stub it so the spec drives the component in isolation (no DB).
const { listSpy } = vi.hoisted(() => ({ listSpy: vi.fn() }));
vi.mock('@/app/(authed)/issues/actions', () => ({ listCandidateParentsAction: listSpy }));

import { TypePicker } from '@/components/issues/TypePicker';
import { ParentPicker } from '@/components/issues/ParentPicker';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const cand = (id: string, identifier: string, title: string, kind: string) => ({
  id,
  identifier,
  title,
  kind,
  parentId: null,
  key: 1,
  status: 'todo',
  priority: 'medium',
  assigneeId: null,
  position: 'a0',
  archivedAt: null,
});

describe('TypePicker', () => {
  function Host() {
    const [v, setV] = useState<IssueType>('task');
    return <TypePicker value={v} onChange={setV} />;
  }

  it('lists the five types and selects one', () => {
    render(<Host />);
    const trigger = screen.getByRole('combobox', { name: 'Type' });
    expect(trigger.textContent).toContain('Task');

    fireEvent.click(trigger);
    expect(screen.getAllByRole('option')).toHaveLength(5);

    fireEvent.click(screen.getByRole('option', { name: 'Story' }));
    expect(screen.getByRole('combobox', { name: 'Type' }).textContent).toContain('Story');
  });
});

describe('ParentPicker', () => {
  function Host({ start = 'story' as IssueType }: { start?: IssueType }) {
    const [type, setType] = useState<IssueType>(start);
    const [parent, setParent] = useState<string | null>(null);
    return (
      <>
        <button onClick={() => setType('subtask')}>to-subtask</button>
        <button onClick={() => setType('story')}>to-story</button>
        <span data-testid="parent">{parent ?? 'none'}</span>
        <ParentPicker childType={type} value={parent} onChange={setParent} />
      </>
    );
  }

  it('shows only legal candidates and re-fetches when childType changes', async () => {
    listSpy.mockImplementation(async (childType: string) => {
      if (childType === 'story')
        return { ok: true, candidates: [cand('e1', 'PROD-1', 'Big Epic', 'epic')] };
      if (childType === 'subtask')
        return {
          ok: true,
          candidates: [
            cand('s1', 'PROD-2', 'A Story', 'story'),
            cand('t1', 'PROD-3', 'A Task', 'task'),
            cand('b1', 'PROD-4', 'A Bug', 'bug'),
          ],
        };
      return { ok: true, candidates: [] };
    });

    render(<Host start="story" />);
    await waitFor(() => expect(listSpy).toHaveBeenCalledWith('story'));

    // type=Story → only the Epic candidate (+ "No parent").
    fireEvent.click(screen.getByRole('combobox', { name: 'Parent' }));
    await waitFor(() => expect(screen.getByRole('option', { name: /Big Epic/ })).toBeTruthy());
    expect(screen.getAllByRole('option')).toHaveLength(2);

    // Switch to Subtask → re-fetch → the open list updates live to Story/Task/
    // Bug (+ "No parent"). The popover stays open across the type change.
    fireEvent.click(screen.getByText('to-subtask'));
    await waitFor(() => expect(listSpy).toHaveBeenCalledWith('subtask'));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(4));
    expect(screen.getByRole('option', { name: /A Story/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /A Bug/ })).toBeTruthy();
  });

  it('clears an invalidated parent with an inline notice on a childType change', async () => {
    listSpy.mockImplementation(async (childType: string) => {
      if (childType === 'task')
        return {
          ok: true,
          candidates: [
            cand('s1', 'PROD-2', 'A Story', 'story'),
            cand('e1', 'PROD-1', 'Epic', 'epic'),
          ],
        };
      if (childType === 'story')
        return { ok: true, candidates: [cand('e1', 'PROD-1', 'Epic', 'epic')] };
      return { ok: true, candidates: [] };
    });

    function ClearHost() {
      const [type, setType] = useState<IssueType>('task');
      const [parent, setParent] = useState<string | null>(null);
      return (
        <>
          <button onClick={() => setType('story')}>to-story</button>
          <span data-testid="parent">{parent ?? 'none'}</span>
          <ParentPicker childType={type} value={parent} onChange={setParent} />
        </>
      );
    }

    render(<ClearHost />);
    await waitFor(() => expect(listSpy).toHaveBeenCalledWith('task'));

    // Pick the Story as parent (legal for a task child).
    fireEvent.click(screen.getByRole('combobox', { name: 'Parent' }));
    await waitFor(() => screen.getByRole('option', { name: /A Story/ }));
    fireEvent.click(screen.getByRole('option', { name: /A Story/ }));
    expect(screen.getByTestId('parent').textContent).toBe('s1');

    // Change child→Story: a Story can't parent a Story → cleared + notice.
    fireEvent.click(screen.getByText('to-story'));
    await waitFor(() => expect(screen.getByTestId('parent').textContent).toBe('none'));
    expect(screen.getByText(/Parent cleared/)).toBeTruthy();
  });
});
