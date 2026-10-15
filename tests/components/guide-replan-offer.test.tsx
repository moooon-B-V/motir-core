// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { GuideRail } from '@/components/planning/GuideRail';
import { deriveGuideView } from '@/lib/planning/guideView';
import type { GuideReplanOffer, GuideTurnRecord } from '@/lib/ai/guideWorkItem';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import type { WorkItemTodoDto } from '@/lib/dto/workItemTodos';

// THE RE-PLAN OFFER in the guide rail (Story MOTIR-8684 · MOTIR-8694; design
// `guide-replan-offer.mock.html`). Every state renders from the STORED offer alone.

let seq = 0;
function assistant(offer: GuideReplanOffer | null): PlanChangeTurnDto {
  seq += 1;
  const guide: GuideTurnRecord = {
    actions: [],
    outcomes: [],
    temporary: false,
    ...(offer ? { replanOffer: offer } : {}),
  };
  return {
    id: `t${seq}`,
    seq,
    role: 'assistant',
    body: 'PAY-212 is wrong.',
    jobId: null,
    question: null,
    isAnswer: false,
    intent: 'guide',
    intentCorrected: false,
    citations: [],
    authorId: null,
    createdAt: '2026-10-15T10:00:00.000Z',
    guide,
  };
}

const offer = (over: Partial<GuideReplanOffer> = {}): GuideReplanOffer => ({
  reason: 'The key was already rotated.',
  requestMd: 'Re-plan **PAY-212**: the rotation already happened.',
  requestedTargetKey: null,
  targetKey: 'PAY-212',
  targetResolution: 'guided_card',
  declinedAt: null,
  declinedById: null,
  confirmedAt: null,
  confirmedById: null,
  confirmedSessionId: null,
  ...over,
});

const CARD = { id: 'w9', identifier: 'PAY-212', title: 'Rotate the key', kind: 'task' as const };
const ROWS = [
  { id: 'r1', text: 'One', position: 'a', done: true },
  { id: 'r2', text: 'Two', position: 'b', done: false },
] as WorkItemTodoDto[];

function renderRail(
  turns: PlanChangeTurnDto[],
  props: Partial<React.ComponentProps<typeof GuideRail>> = {},
  workItemRefs: WorkItemRefMap = {},
) {
  const onOpenOffer = vi.fn();
  const onDeclineOffer = vi.fn();
  const view = deriveGuideView(turns, ROWS, { idle: true });
  renderWithIntl(
    <GuideRail
      card={CARD}
      session={
        {
          id: 's1',
          projectId: 'p',
          targetKeys: [CARD.identifier],
          turnCount: turns.length,
          lastJobId: null,
          lastSubmittedAt: null,
          lastActivityAt: '2026-10-15T10:00:00.000Z',
          origin: 'guide',
          createdAt: '2026-10-15T10:00:00.000Z',
          updatedAt: '2026-10-15T10:00:00.000Z',
          turns,
          workItemRefs,
        } as PlanChangeSessionDto
      }
      view={view}
      phase="idle"
      errorCode={null}
      outOfCredits={false}
      markers={[]}
      onSend={vi.fn()}
      onRetry={vi.fn()}
      onReload={vi.fn()}
      onOpenOffer={onOpenOffer}
      onDeclineOffer={onDeclineOffer}
      {...props}
    />,
  );
  return { onOpenOffer, onDeclineOffer, view };
}

afterEach(() => {
  cleanup();
  seq = 0;
});

describe('the undecided offer', () => {
  it('shows the request, the target chip, Confirm and Decline, and what each does', () => {
    renderRail([assistant(offer())]);
    const block = screen.getByTestId('guide-offer');
    expect(block.getAttribute('data-offer-state')).toBe('undecided');
    expect(within(block).getByTestId('guide-offer-request').textContent).toContain('PAY-212');
    expect(within(block).getByTestId('guide-offer-confirm')).toBeTruthy();
    expect(within(block).getByTestId('guide-offer-decline')).toBeTruthy();
    expect(block.textContent).toContain('It spends credits.');
    expect(block.textContent).toContain('Nothing is planned.');
  });

  it('Confirm opens the planner from the OFFER TURN ID, and Decline declines that turn', () => {
    const turns = [assistant(offer())];
    const { onOpenOffer, onDeclineOffer } = renderRail(turns);
    fireEvent.click(screen.getByTestId('guide-offer-confirm'));
    expect(onOpenOffer).toHaveBeenCalledWith(turns[0]!.id);
    cleanup();
    const second = renderRail(turns);
    fireEvent.click(screen.getByTestId('guide-offer-decline'));
    expect(second.onDeclineOffer).toHaveBeenCalledWith(turns[0]!.id);
    expect(onDeclineOffer).not.toHaveBeenCalled();
  });

  it('stops the walk: no current step, and the progress line says so', () => {
    const { view } = renderRail([assistant(offer())]);
    expect(view.walkStopped).toBe(true);
    expect(view.currentId).toBeNull();
    expect(view.resumeStep).toBe(2);
  });

  it('names a target that is not the guided card, and a done target resolved forward', () => {
    renderRail([assistant(offer({ targetKey: 'PAY-100' }))]);
    expect(screen.getByTestId('guide-offer-target').textContent).toContain('PAY-100');
    expect(screen.getByTestId('guide-offer-target').textContent).toContain('not on this work item');
    cleanup();
    renderRail([
      assistant(
        offer({
          targetKey: 'PAY-100',
          requestedTargetKey: 'PAY-9',
          targetResolution: 'nearest_open_ancestor',
        }),
      ),
    ]);
    expect(screen.getByTestId('guide-offer-target').textContent).toContain(
      'PAY-9 is done, so the re-plan starts on PAY-100.',
    );
  });

  it('with no target: the request and the line, NO Confirm, Decline stays', () => {
    renderRail([assistant(offer({ targetKey: null, targetResolution: 'none' }))]);
    expect(screen.getByTestId('guide-offer-no-target')).toBeTruthy();
    expect(screen.queryByTestId('guide-offer-confirm')).toBeNull();
    expect(screen.getByTestId('guide-offer-decline')).toBeTruthy();
  });

  it('without ai:plan: the reason line, NO Confirm, Decline stays', () => {
    renderRail([assistant(offer())], { canPlan: false });
    expect(screen.getByTestId('guide-offer-cannot-plan')).toBeTruthy();
    expect(screen.queryByTestId('guide-offer-confirm')).toBeNull();
    expect(screen.getByTestId('guide-offer-decline')).toBeTruthy();
  });

  it('presses nothing while a turn runs or a decline is in flight', () => {
    renderRail([assistant(offer())], { phase: 'running' });
    expect((screen.getByTestId('guide-offer-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('guide-offer-decline') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const turns = [assistant(offer())];
    renderRail(turns, { decliningTurnId: turns[0]!.id });
    expect((screen.getByTestId('guide-offer-confirm') as HTMLButtonElement).disabled).toBe(true);
  });

  it('clamps a long request until Show all, and Show less clamps it again', () => {
    renderRail([assistant(offer({ requestMd: 'word '.repeat(300) }))]);
    const request = screen.getByTestId('guide-offer-request');
    expect(request.className).toContain('max-h-32');
    fireEvent.click(screen.getByTestId('guide-offer-show-all'));
    expect(request.className).not.toContain('max-h-32');
    expect(screen.getByTestId('guide-offer-show-all').textContent).toBe('Show less');
    fireEvent.click(screen.getByTestId('guide-offer-show-all'));
    expect(request.className).toContain('max-h-32');
  });

  it('draws the target as the live chip when the thread resolved it, the bare key when not', () => {
    const refs: WorkItemRefMap = {
      w100: {
        accessible: true,
        id: 'w100',
        identifier: 'PAY-100',
        title: 'Signing keys',
        kind: 'story',
        archived: false,
        status: null,
      },
      w5: { accessible: false, id: 'w5' },
    };
    renderRail([assistant(offer({ targetKey: 'pay-100' }))], {}, refs);
    const target = screen.getByTestId('guide-offer-target');
    expect(target.textContent).toContain('Signing keys');
    cleanup();
    renderRail([assistant(offer({ targetKey: 'PAY-7' }))], {}, refs);
    const bare = screen.getByTestId('guide-offer-target');
    expect(bare.textContent).toContain('PAY-7');
    expect(bare.textContent).not.toContain('Signing keys');
  });

  it('without Motir AI set up: its own line, NO Confirm', () => {
    renderRail([assistant(offer())], { canPlan: false, cannotPlanReason: 'ai_not_configured' });
    expect(screen.getByTestId('guide-offer-cannot-plan').textContent).toContain(
      'Motir AI isn’t set up here',
    );
    expect(screen.queryByTestId('guide-offer-confirm')).toBeNull();
  });

  it('a Confirm refused where it is pressed (out of credits) can be pressed again', () => {
    const turns = [assistant(offer())];
    const onOpenOffer = vi.fn(() => false);
    renderRail(turns, { onOpenOffer });
    const confirm = screen.getByTestId('guide-offer-confirm') as HTMLButtonElement;
    fireEvent.click(confirm);
    expect(onOpenOffer).toHaveBeenCalledWith(turns[0]!.id);
    expect(confirm.disabled).toBe(false);
    expect(confirm.textContent).toBe('Confirm');
  });

  it('a Confirm that opens the planner shows it starting and presses nothing more', () => {
    const turns = [assistant(offer())];
    renderRail(turns);
    fireEvent.click(screen.getByTestId('guide-offer-confirm'));
    const confirm = screen.getByTestId('guide-offer-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect((screen.getByTestId('guide-offer-decline') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the decided states, from the record alone', () => {
  it('declined: no buttons, the recorded line, and where Guide me through resumes', () => {
    renderRail([assistant(offer({ declinedAt: '2026-10-15T11:00:00.000Z', declinedById: 'u1' }))]);
    const block = screen.getByTestId('guide-offer');
    expect(block.getAttribute('data-offer-state')).toBe('declined');
    expect(screen.queryByTestId('guide-offer-confirm')).toBeNull();
    expect(screen.queryByTestId('guide-offer-decline')).toBeNull();
    expect(block.textContent).toContain('Recorded on the work item');
    expect(screen.getByTestId('guide-offer-resume').textContent).toContain('step 2');
  });

  it('confirmed: Re-plan started, and a link back to the session that sends nothing new', () => {
    const turns = [
      assistant(
        offer({
          confirmedAt: '2026-10-15T11:00:00.000Z',
          confirmedById: 'u1',
          confirmedSessionId: 'ps1',
        }),
      ),
    ];
    const { onOpenOffer } = renderRail(turns);
    const block = screen.getByTestId('guide-offer');
    expect(block.getAttribute('data-offer-state')).toBe('confirmed');
    expect(block.textContent).toContain('Re-plan started');
    expect(screen.queryByTestId('guide-offer-confirm')).toBeNull();
    fireEvent.click(screen.getByTestId('guide-offer-open'));
    expect(onOpenOffer).toHaveBeenCalledWith(turns[0]!.id);
  });

  it('a revised offer collapses the earlier one to one line with no buttons', () => {
    renderRail([assistant(offer()), assistant(offer({ targetKey: 'PAY-100' }))]);
    const blocks = screen.getAllByTestId('guide-offer');
    expect(blocks.map((b) => b.getAttribute('data-offer-state'))).toEqual([
      'superseded',
      'undecided',
    ]);
    expect(blocks[0]!.textContent).toBe('Replaced by a newer offer');
    expect(screen.getAllByTestId('guide-offer-confirm')).toHaveLength(1);
  });

  it('a reply with no offer draws none (a stale step is corrected in place)', () => {
    renderRail([assistant(null)]);
    expect(screen.queryByTestId('guide-offer')).toBeNull();
  });
});

describe('a refused decline', () => {
  it('speaks in the offer-closed words with no Try again', () => {
    renderRail([assistant(offer())], { errorCode: 'GUIDE_REPLAN_OFFER_NOT_OPEN' });
    expect(screen.getByTestId('guide-error').textContent).toContain('already decided');
    expect(screen.queryByText('Try again')).toBeNull();
  });
});
