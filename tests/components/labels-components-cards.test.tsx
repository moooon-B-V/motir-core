// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { LabelDto } from '@/lib/dto/labels';
import type { ComponentDto } from '@/lib/dto/components';
import { labelTint } from '@/lib/labels/labelTint';
import { LABELS_PER_ISSUE_LIMIT } from '@/lib/labels/constants';

// The Labels / Components rail cards (Subtask 5.4.8), against
// design/work-items/labels-components-watch.mock.html panels 2–3. The Server
// Actions are stubbed (their service behaviour is covered by the 5.4.2/5.4.3
// suites); the cards must confirm from the ACTION RESPONSE — chips re-render
// from the returned set with NO router.refresh on success (the inline-edit
// rule: the refresh fan-out caused the status-revert bug).
const { addLabelSpy, removeLabelSpy, addComponentSpy, removeComponentSpy } = vi.hoisted(() => ({
  addLabelSpy: vi.fn(),
  removeLabelSpy: vi.fn(),
  addComponentSpy: vi.fn(),
  removeComponentSpy: vi.fn(),
}));
vi.mock('@/app/(authed)/issues/[key]/labelComponentActions', () => ({
  addLabelAction: addLabelSpy,
  removeLabelAction: removeLabelSpy,
  addComponentAction: addComponentSpy,
  removeComponentAction: removeComponentSpy,
}));

import { LabelsCard } from '@/app/(authed)/issues/[key]/_components/LabelsCard';
import { ComponentsCard } from '@/app/(authed)/issues/[key]/_components/ComponentsCard';
import { ProjectAccessProvider } from '@/app/(authed)/_components/ProjectAccessProvider';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const apiLabel: LabelDto = { id: 'l_api', name: 'api' };
const perfLabel: LabelDto = { id: 'l_perf', name: 'perf-q3' };

const apiComponent: ComponentDto = {
  id: 'c_api',
  name: 'API',
  description: null,
  defaultAssigneeId: null,
};
const webComponent: ComponentDto = {
  id: 'c_web',
  name: 'Web',
  description: 'The Next.js app',
  defaultAssigneeId: 'u_bo',
};

/** Stub the bounded autocomplete read (the card debounces a GET per query). */
function stubLabelSearch(labels: LabelDto[]) {
  const fetchSpy = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ labels }),
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

describe('LabelsCard', () => {
  it('renders display-mode chips with the deterministic name-hash tint', () => {
    stubLabelSearch([]);
    const { container } = render(
      <LabelsCard workItemId="wi_1" projectKey="PROD" initialLabels={[apiLabel, perfLabel]} />,
    );
    expect(screen.getByText('api')).toBeTruthy();
    expect(container.innerHTML).toContain(`bg-(--el-tint-${labelTint('api')})`);
    expect(container.innerHTML).toContain(`bg-(--el-tint-${labelTint('perf-q3')})`);
    // Display mode: chips only, no remove ×.
    expect(screen.queryByRole('button', { name: 'Remove api' })).toBeNull();
  });

  it('creates a label from the create-row and re-renders chips from the action RESPONSE (no refresh)', async () => {
    stubLabelSearch([]);
    addLabelSpy.mockResolvedValue({ ok: true, labels: [apiLabel, perfLabel] });
    render(<LabelsCard workItemId="wi_1" projectKey="PROD" initialLabels={[apiLabel]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Labels' }));
    const input = screen.getByRole('combobox', { name: 'Labels' });
    fireEvent.change(input, { target: { value: 'perf-q3' } });
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Create ‘perf-q3’' })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('option', { name: 'Create ‘perf-q3’' }));

    await waitFor(() =>
      expect(addLabelSpy).toHaveBeenCalledWith({ workItemId: 'wi_1', name: 'perf-q3' }),
    );
    // The new chip comes from the response; the query clears on success.
    await waitFor(() => expect(screen.getByText('perf-q3')).toBeTruthy());
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('keeps the rejected text and shows the inline 422 (the no-spaces error)', async () => {
    stubLabelSearch([]);
    addLabelSpy.mockResolvedValue({
      ok: false,
      error: 'Labels can’t contain spaces — use a hyphen: perf-q3',
    });
    render(<LabelsCard workItemId="wi_1" projectKey="PROD" initialLabels={[]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Labels' }));
    const input = screen.getByRole('combobox', { name: 'Labels' });
    fireEvent.change(input, { target: { value: 'perf q3' } });
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Create ‘perf q3’' })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('option', { name: 'Create ‘perf q3’' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('use a hyphen: perf-q3'),
    );
    // The rejected text stays in the input for correction (mock panel 2).
    expect((input as HTMLInputElement).value).toBe('perf q3');
  });

  it('debounces the bounded autocomplete against the project route', async () => {
    const fetchSpy = stubLabelSearch([perfLabel]);
    render(<LabelsCard workItemId="wi_1" projectKey="PROD" initialLabels={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Labels' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Labels' }), {
      target: { value: 'pe' },
    });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/projects/PROD/labels?q=pe'));
    await waitFor(() => expect(screen.getByRole('option', { name: 'perf-q3' })).toBeTruthy());
  });

  it('disables the input + shows the limit hint at the per-issue cap', () => {
    stubLabelSearch([]);
    const many = Array.from({ length: LABELS_PER_ISSUE_LIMIT }, (_, i) => ({
      id: `l_${i}`,
      name: `tag-${i}`,
    }));
    render(<LabelsCard workItemId="wi_1" projectKey="PROD" initialLabels={many} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Labels' }));
    expect((screen.getByRole('combobox', { name: 'Labels' }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(
      screen.getByText(
        `Label limit reached (${LABELS_PER_ISSUE_LIMIT}) — remove one to add another.`,
      ),
    ).toBeTruthy();
  });

  it('read-only (viewer): chips only, NO chevron — affordances absent', () => {
    stubLabelSearch([]);
    render(
      <ProjectAccessProvider canEdit={false}>
        <LabelsCard workItemId="wi_1" projectKey="PROD" initialLabels={[apiLabel]} />
      </ProjectAccessProvider>,
    );
    expect(screen.getByText('api')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit Labels' })).toBeNull();
  });

  it('shows the muted empty placeholder with no labels', () => {
    stubLabelSearch([]);
    render(<LabelsCard workItemId="wi_1" projectKey="PROD" initialLabels={[]} />);
    expect(screen.getByText('No labels')).toBeTruthy();
  });
});

describe('ComponentsCard', () => {
  it('assigns from the project taxonomy and re-renders chips from the response', async () => {
    addComponentSpy.mockResolvedValue({ ok: true, components: [apiComponent, webComponent] });
    render(
      <ComponentsCard
        workItemId="wi_1"
        initialComponents={[apiComponent]}
        projectComponents={[apiComponent, webComponent]}
        canManageProject={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit Components' }));
    fireEvent.focus(screen.getByRole('combobox', { name: 'Components' }));
    // No create-row in an admin-managed taxonomy — only the project's options.
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['API', 'Web']);
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');

    fireEvent.click(screen.getByRole('option', { name: 'Web' }));
    await waitFor(() =>
      expect(addComponentSpy).toHaveBeenCalledWith({ workItemId: 'wi_1', componentId: 'c_web' }),
    );
    await waitFor(() => expect(screen.getAllByText('Web').length).toBeGreaterThan(1));
  });

  it('toggling an attached component removes it', async () => {
    removeComponentSpy.mockResolvedValue({ ok: true, components: [] });
    render(
      <ComponentsCard
        workItemId="wi_1"
        initialComponents={[apiComponent]}
        projectComponents={[apiComponent]}
        canManageProject={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit Components' }));
    fireEvent.focus(screen.getByRole('combobox', { name: 'Components' }));
    fireEvent.click(screen.getByRole('option', { name: 'API' }));
    await waitFor(() =>
      expect(removeComponentSpy).toHaveBeenCalledWith({
        workItemId: 'wi_1',
        componentId: 'c_api',
      }),
    );
  });

  it('empty project: "No components defined" + the quiet admin link for project admins only', () => {
    const { rerender } = render(
      <ComponentsCard
        workItemId="wi_1"
        initialComponents={[]}
        projectComponents={[]}
        canManageProject
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit Components' }));
    fireEvent.focus(screen.getByRole('combobox', { name: 'Components' }));
    expect(screen.getByText('No components defined')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Manage components in Project settings →' }),
    ).toBeTruthy();

    rerender(
      <ComponentsCard
        workItemId="wi_1"
        initialComponents={[]}
        projectComponents={[]}
        canManageProject={false}
      />,
    );
    expect(
      screen.queryByRole('link', { name: 'Manage components in Project settings →' }),
    ).toBeNull();
  });

  it('read-only (viewer): neutral glyph chips, no chevron', () => {
    render(
      <ProjectAccessProvider canEdit={false}>
        <ComponentsCard
          workItemId="wi_1"
          initialComponents={[apiComponent]}
          projectComponents={[apiComponent]}
          canManageProject={false}
        />
      </ProjectAccessProvider>,
    );
    expect(screen.getByText('API')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit Components' })).toBeNull();
  });
});
