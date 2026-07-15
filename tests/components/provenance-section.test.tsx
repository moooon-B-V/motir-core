// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { WorkItemDto } from '@/lib/dto/workItems';
import { ProvenanceSection } from '@/app/(authed)/items/[key]/_components/ProvenanceSection';

// ProvenanceSection (Story MOTIR-1685 · MOTIR-1693) — the collapsed provenance
// disclosure on the work-item detail rail: it renders both triples (populated +
// unknown), strips the native model per the DTO, and defaults collapsed.

afterEach(cleanup);

function makeItem(overrides: Partial<WorkItemDto> = {}): WorkItemDto {
  return {
    id: 'wi_1',
    projectId: 'p1',
    parentId: null,
    kind: 'task',
    key: 7,
    identifier: 'PROD-7',
    title: 'X',
    descriptionMd: null,
    explanationMd: null,
    explanationSource: 'user_authored',
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    reporterId: 'u1',
    dueDate: null,
    estimateMinutes: null,
    type: null,
    executor: null,
    storyPoints: null,
    position: 'a0',
    sprintId: null,
    backlogRank: 'a0',
    publicChildrenHidden: false,
    sessionBranch: null,
    planningSource: null,
    planningHarness: null,
    planningModel: null,
    implementationSource: null,
    implementationHarness: null,
    implementationModel: null,
    archivedAt: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ProvenanceSection', () => {
  it('is COLLAPSED by default — the triples are hidden until the disclosure is opened', () => {
    render(<ProvenanceSection item={makeItem({ planningSource: 'mcp' })} />);
    const toggle = screen.getByRole('button', { name: /provenance/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // The Planning/Implementation cards are not in the DOM while collapsed.
    expect(screen.queryByText('Planning')).toBeNull();
    expect(screen.queryByText('Implementation')).toBeNull();
  });

  it('expands to show both triples populated, with MCP + BYOK models shown', () => {
    render(
      <ProvenanceSection
        item={makeItem({
          planningSource: 'mcp',
          planningHarness: 'Claude Code',
          planningModel: 'claude-opus-4-8',
          implementationSource: 'byok',
          implementationHarness: 'opencode',
          implementationModel: 'deepseek',
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /provenance/i }));
    expect(screen.getByText('Planning')).toBeTruthy();
    expect(screen.getByText('Implementation')).toBeTruthy();
    expect(screen.getByText('MCP')).toBeTruthy();
    expect(screen.getByText('Claude Code')).toBeTruthy();
    expect(screen.getByText('claude-opus-4-8')).toBeTruthy();
    expect(screen.getByText('BYOK')).toBeTruthy();
    expect(screen.getByText('opencode')).toBeTruthy();
    expect(screen.getByText('deepseek')).toBeTruthy();
  });

  it('renders "—" for the unknown state (both triples null)', () => {
    render(<ProvenanceSection item={makeItem()} />);
    fireEvent.click(screen.getByRole('button', { name: /provenance/i }));
    // Two em-dashes — one per triple.
    expect(screen.getAllByText('—')).toHaveLength(2);
  });

  it('native planning shows only "Native" + harness, NO model (the DTO stripped it)', () => {
    render(
      <ProvenanceSection
        item={makeItem({
          planningSource: 'native',
          planningHarness: 'Motir',
          planningModel: null, // the read DTO strips the native model
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /provenance/i }));
    expect(screen.getByText('Native')).toBeTruthy();
    expect(screen.getByText('Motir')).toBeTruthy();
    // No model line for native.
    expect(screen.queryByText(/deepseek|claude|gpt|glm/i)).toBeNull();
    // Implementation is the unknown state.
    expect(screen.getAllByText('—')).toHaveLength(1);
  });
});
