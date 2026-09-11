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
    targetRepos: [],
    planningSource: null,
    planningHarness: null,
    planningModel: null,
    implementationSource: null,
    implementationHarness: null,
    implementationModel: null,
    subject: null,
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

  it('renders "—" for the unknown state (both triples null, and no subject)', () => {
    render(<ProvenanceSection item={makeItem()} />);
    fireEvent.click(screen.getByRole('button', { name: /provenance/i }));
    // ⚠️ 2 → 3 (Story MOTIR-5062 · MOTIR-5074). This counts em-dashes across the
    // WHOLE section rather than within the two triples, so the SUBJECT group's own
    // unknown state lands in it. Re-pinned rather than loosened: the number is what
    // makes this a detector, and an empty subject rendering `—` exactly as its
    // neighbours do is the design's requirement, not an accident to tolerate.
    expect(screen.getAllByText('—')).toHaveLength(3);
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
    // Implementation is the unknown state — and so is Subject (1 → 2, MOTIR-5074).
    expect(screen.getAllByText('—')).toHaveLength(2);
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

    // Exactly TWO em-dashes: the Implementation triple and the Subject group,
    // both genuinely null here (1 → 2, MOTIR-5074). A THIRD would mean the
    // Planning triple fell through to unknown because the renderer had no entry
    // for this source — which is the drift this sweep exists to catch, and it is
    // still caught: the expected count is fixed, so a fall-through still fails.
    expect(
      screen.getAllByText('—'),
      `planningSource='${source}' fell through to the unknown state — add it to PLANNING_SOURCE_META`,
    ).toHaveLength(2);
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

// ─────────────────────────────────────────────────────────────────────────────
// THE THIRD GROUP — `Subject` (Story MOTIR-5062 · MOTIR-5074)
// ─────────────────────────────────────────────────────────────────────────────
//
// Compared against `design/work-items/provenance.mock.html` panels 5–7 at
// `origin/main` 564c50a0e (the merge of MOTIR-5073's design pull request).
//
// The design's central question is a SHAPE one: a single value sitting beside two
// triples can read as a triple whose other two rows failed to load. Its answer is
// three properties — no chip, mono at `--el-text`, no per-member tint — and the
// third of those is the one a later reader is most likely to "fix" by copying the
// `Record`-based chip beside it. These assert the answer, not just the presence.

describe('ProvenanceSection — the SUBJECT group', () => {
  const open = () => fireEvent.click(screen.getByRole('button', { name: /provenance/i }));

  it('is COLLAPSED with the rest — the subject is not in the DOM until opened', () => {
    render(<ProvenanceSection item={makeItem({ subject: 'jobs' })} />);
    expect(screen.queryByText('Subject')).toBeNull();
    expect(screen.queryByText('jobs')).toBeNull();
  });

  // The populated and empty cases are asserted as a PAIR, which is what the card
  // asks for: the empty state is the COMMON case and stays common (the corpus
  // ships four members), so "renders when present" alone would leave the state
  // most cards are actually in untested.
  it('renders the member when present, and `—` when absent — the pair', () => {
    const { unmount } = render(<ProvenanceSection item={makeItem({ subject: 'jobs' })} />);
    open();
    expect(screen.getByText('Subject')).toBeTruthy();
    expect(screen.getByText('jobs')).toBeTruthy();
    // Populated: only the two triples are unknown, the subject is not.
    expect(screen.getAllByText('—')).toHaveLength(2);
    unmount();

    render(<ProvenanceSection item={makeItem({ subject: null })} />);
    open();
    expect(screen.getByText('Subject')).toBeTruthy();
    expect(screen.getAllByText('—')).toHaveLength(3);
  });

  it('draws the value MONO at --el-text, the design’s identifier treatment', () => {
    render(<ProvenanceSection item={makeItem({ subject: 'data' })} />);
    open();
    const value = screen.getByText('data');
    // Mono because a subject is an IDENTIFIER — it names `subject-<name>.md`.
    expect(value.className).toMatch(/font-mono/);
    // `--el-text`, not `--el-text-muted`: it is the card's PRIMARY content. The
    // model line one card up is the muted one, and conflating the two is the
    // easiest way to render this as an annotation beneath nothing.
    expect(value.className).toMatch(/text-\(--el-text\)/);
    expect(value.className).not.toMatch(/text-\(--el-text-muted\)/);
  });

  // ⚠️ THE CARD'S SHARPEST REQUIREMENT, and the one that runs OPPOSITE to the code
  // beside it. `PLANNING_SOURCE_META` is a `Record` over a CLOSED union so a new
  // member is a compile error rather than a blank chip. Subject members are
  // corpus-owned and OPEN — a member exists iff a pack file exists in motir-meta —
  // so motir-core will legitimately meet members this build has never heard of,
  // and the rail is where a person would first notice one. It must render as its
  // own text: not blank, not `—`, not a crash.
  it.each(['data', 'jobs', 'llm', 'mcp', 'quantum-telepathy', 'a-pack-nobody-has-written-yet'])(
    'renders an unrecognised member as its own text: %s',
    (member) => {
      render(<ProvenanceSection item={makeItem({ subject: member })} />);
      open();
      expect(screen.getByText(member)).toBeTruthy();
      // Two em-dashes = the triples only. A THIRD would mean the subject fell
      // through to the unknown state because the renderer failed to place it.
      expect(
        screen.getAllByText('—'),
        `subject='${member}' fell through to the unknown state — it must render verbatim`,
      ).toHaveLength(2);
    },
  );

  // The reason `subject` is in this disclosure AT ALL rather than beside `type`:
  // everything here is read-only by construction. A chevron or an input on this
  // group would undo the argument that placed it here.
  it('introduces NO editable control — no chevron and no input in the section', () => {
    const { container } = render(<ProvenanceSection item={makeItem({ subject: 'llm' })} />);
    open();
    // Exactly one button: the disclosure toggle itself.
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(container.querySelectorAll('input, textarea, select')).toHaveLength(0);
    // No per-card edit affordance anywhere in the opened section.
    expect(screen.queryByRole('button', { name: /edit|subject/i })).toBeNull();
  });

  // No per-member TINT: the design refuses a colour vocabulary this repository
  // cannot enumerate. Asserting the absence keeps a later "consistency" pass from
  // rebuilding the blank-chip failure `PLANNING_SOURCE_META`'s note memorialises.
  it('gives the member NO tint and NO chip — it is not a shorter triple', () => {
    render(<ProvenanceSection item={makeItem({ subject: 'jobs' })} />);
    open();
    const value = screen.getByText('jobs');
    expect(value.className).not.toMatch(/el-tint-/);
    expect(value.className).not.toMatch(/rounded-\(--radius-badge\)/);
    // A chip carries an icon; the subject value must not.
    expect(value.querySelector('svg')).toBeNull();
  });

  it('has its label in BOTH catalogs (parity is a gate)', () => {
    const root = process.cwd();
    const read = (locale: string) =>
      JSON.parse(readFileSync(join(root, 'messages', `${locale}.json`), 'utf8')) as {
        issueViews: Record<string, unknown>;
      };
    expect(
      typeof read('en').issueViews['provenanceSubject'],
      'messages/en.json is missing issueViews.provenanceSubject',
    ).toBe('string');
    expect(
      typeof read('zh').issueViews['provenanceSubject'],
      'messages/zh.json is missing issueViews.provenanceSubject',
    ).toBe('string');
  });
});
