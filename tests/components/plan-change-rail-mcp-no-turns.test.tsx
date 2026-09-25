// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';

// THE ZERO-TURN MCP RAIL (Subtask MOTIR-6298; design Part XXIII §23.11 · sheet 10 B).
// An MCP agent's conversation happened in its own harness, so the rail says so —
// one notice under the reopened line and above the opener — and the composer and
// the starter chips stay live. The rail only DRAWS it; when it is set (and that it
// stays once a turn is sent) is the host's, and `planning-workspace-host.test.tsx`
// covers that derivation.

const LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'project', planSession: 's1' });

const BASE: PlanChangeConversationState = {
  phase: 'idle',
  session: {
    id: 's1',
    projectId: 'p1',
    targetKeys: [],
    turnCount: 0,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-07-27T09:00:00.000Z',
    updatedAt: '2026-07-27T10:00:00.000Z',
    turns: [],
    workItemRefs: {},
  },
  progress: null,
  review: null,
  liveReview: null,
  liveVersion: 0,
  liveFailing: false,
  discardedReview: null,
  decided: null,
  jobId: null,
  planId: null,
  approved: null,
  errorCode: null,
  outOfCredits: false,
  stopping: false,
  stopped: false,
  queued: [],
  earlier: null,
  reopened: {
    startedBy: { id: 'u1', name: 'Ada' },
    mine: true,
    lastActivityAt: '2026-01-01T00:00:00.000Z',
  },
  readOnly: false,
  acts: [],
};

const onSend = vi.fn();

function renderRail(conversationElsewhere?: { harness: string } | null) {
  return renderWithIntl(
    <PlanChangeRail
      launch={LAUNCH}
      projectName="PayFlow"
      state={BASE}
      index={indexPlanReview(null)}
      targets={[]}
      onAddTarget={vi.fn()}
      onRemoveTarget={vi.fn()}
      onSend={onSend}
      onRetry={vi.fn()}
      onCorrectTurn={vi.fn()}
      onApprove={vi.fn()}
      onDiscard={vi.fn()}
      {...(conversationElsewhere !== undefined ? { conversationElsewhere } : {})}
    />,
  );
}

beforeEach(() => {
  // The paywall self-reads the AI entitlement; keep it from hitting the network.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  onSend.mockReset();
});

describe('PlanChangeRail — the conversation happened ELSEWHERE (MOTIR-6298)', () => {
  it('names the harness, AS GIVEN, in the design’s words', () => {
    renderRail({ harness: 'Claude Code' });

    const note = screen.getByTestId('planning-mcp-no-turns');
    expect(note.textContent).toBe(
      'The conversation behind this plan happened in Claude Code, so it isn’t shown here. Ask below to change the plan.',
    );
    // Led by the `bot` glyph the plan page uses for `writtenByHarness`.
    expect(note.querySelector('svg.lucide-bot')).not.toBeNull();
  });

  it('renders an unknown harness verbatim — it is data, not a closed set', () => {
    renderRail({ harness: 'Some New Agent 3' });
    expect(screen.getByTestId('planning-mcp-no-turns').textContent).toContain(
      'happened in Some New Agent 3,',
    );
  });

  it('sits UNDER the reopened line and ABOVE the opener (§23.11)', () => {
    renderRail({ harness: 'Claude Code' });

    const reopened = screen.getByTestId('planning-reopened-session');
    const note = screen.getByTestId('planning-mcp-no-turns');
    const opener = screen.getByText('What should change — or what would you like to know?');
    // DOCUMENT_POSITION_FOLLOWING = 4
    expect(reopened.compareDocumentPosition(note) & 4).toBe(4);
    expect(note.compareDocumentPosition(opener) & 4).toBe(4);
  });

  it('keeps the COMPOSER and the starter chips live — asking here changes the plan', () => {
    renderRail({ harness: 'Claude Code' });

    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Add work to an epic' }));
    expect(box.value).toBe('Add work to an epic');

    fireEvent.change(box, { target: { value: 'Split the billing story.' } });
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledWith('Split the billing story.');
  });

  it('renders NOTHING extra when unset — the rail is exactly as before', () => {
    renderRail(null);
    expect(screen.queryByTestId('planning-mcp-no-turns')).toBeNull();
    expect(screen.getByText('What should change — or what would you like to know?')).toBeTruthy();

    cleanup();
    renderRail();
    expect(screen.queryByTestId('planning-mcp-no-turns')).toBeNull();
  });
});
