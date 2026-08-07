// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { $Enums } from '@/generated/prisma/client';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { WorkItemDto, WorkItemPlanningSourceDto } from '@/lib/dto/workItems';
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
    targetRepo: null,
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

  // ── The `api` planning source (Subtask 11.2.5 — MOTIR-2044) ───────────────
  it('renders a DISTINCT label for an API-planned item, with its self-reported harness', () => {
    render(
      <ProvenanceSection
        item={makeItem({
          planningSource: 'api',
          planningHarness: 'acme-sync',
          planningModel: null,
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /provenance/i }));

    expect(screen.getByText('API')).toBeTruthy();
    expect(screen.getByText('acme-sync')).toBeTruthy();
    // Distinct from MCP — the whole reason `api` is its own enum member rather
    // than a reuse of the agent-tool surface's value.
    expect(screen.queryByText('MCP')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TOTALITY — a planning source the renderer does not know must be impossible
// ─────────────────────────────────────────────────────────────────────────────
//
// `PLANNING_SOURCE_META` is a `Record` over the DTO union, so a member added to
// that union is a COMPILE error in the component. But the union is hand-written
// and the Prisma enum is generated, so the two can drift WITHOUT a compile
// error — a value added to `schema.prisma` and not to the DTO would reach this
// component as an unknown key and silently render the em-dash "unknown" state,
// which is exactly the false-attribution failure MOTIR-2044 exists to prevent.
//
// These sweep the generated enum itself, so that drift fails here.

describe('ProvenanceSection — planning-source totality over the Prisma enum', () => {
  const PLANNING_SOURCES = Object.values($Enums.WorkItemPlanningSource);

  it('sweeps every generated enum member (a sweep over zero values proves nothing)', () => {
    expect(PLANNING_SOURCES.length).toBeGreaterThanOrEqual(4);
    expect([...PLANNING_SOURCES].sort()).toEqual(['api', 'manual', 'mcp', 'native']);
  });

  it.each(PLANNING_SOURCES)('renders a real chip for planningSource=%s, never "—"', (source) => {
    render(
      <ProvenanceSection
        item={makeItem({ planningSource: source as WorkItemPlanningSourceDto })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /provenance/i }));

    // Exactly ONE em-dash: the Implementation triple, which is genuinely null
    // here. A second would mean the Planning triple fell through to unknown
    // because the renderer had no entry for this source.
    expect(
      screen.getAllByText('—'),
      `planningSource='${source}' fell through to the unknown state — add it to PLANNING_SOURCE_META`,
    ).toHaveLength(1);
  });

  it('every planning source has a label key in BOTH catalogs (parity is a gate)', () => {
    // A key present in `en.json` and absent from `zh.json` fails the i18n
    // parity gate in CI; asserting it here names the missing key instead.
    const root = process.cwd();
    const read = (locale: string) =>
      JSON.parse(readFileSync(join(root, 'messages', `${locale}.json`), 'utf8')) as {
        issueViews: Record<string, unknown>;
      };
    const en = read('en').issueViews;
    const zh = read('zh').issueViews;

    for (const source of PLANNING_SOURCES) {
      const key = `provenanceSource${source.charAt(0).toUpperCase()}${source.slice(1)}`;
      expect(typeof en[key], `messages/en.json is missing issueViews.${key}`).toBe('string');
      expect(typeof zh[key], `messages/zh.json is missing issueViews.${key}`).toBe('string');
    }
  });
});
