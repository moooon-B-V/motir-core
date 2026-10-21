// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { CodeUnsearchableBanner } from '@/components/planning/CodeUnsearchableBanner';
import type {
  CodeUnsearchableRepoDto,
  PlanChangeRunPauseDto,
  PlanChangeTurnDto,
} from '@/lib/dto/planChange';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import type { PlanChangeDiffIndex } from '@/lib/planning/planChangeDiff';
import type { PlanningLaunch } from '@/lib/planning/launcher';

// THE "CODE CAN'T BE SEARCHED" BANNER, drawn (Story MOTIR-9165 · MOTIR-9170; design
// `plan-change-run-live--code-unsearchable.mock.html`). Hand-built state, like the run
// pause's own file: the pause door and the conversation job are tested where they live;
// this file holds how the rail DRAWS the stop in every state the design names.

const INDEX = {
  isEmpty: true,
  counts: { added: 0, changed: 0, removed: 0 },
} as unknown as PlanChangeDiffIndex;

function codePause(over: Partial<PlanChangeRunPauseDto> = {}): PlanChangeRunPauseDto {
  return {
    id: 'pause-c1',
    jobId: 'run-1',
    kind: 'code_unsearchable',
    changeTurnIds: [],
    reason: null,
    question: null,
    repos: [{ repoRef: 'motir-co/motir-core', state: 'never_indexed' }],
    createdAt: '2026-10-21T09:00:00.000Z',
    answer: null,
    answeredAt: null,
    replyText: null,
    delivery: 'pending',
    refusedCode: null,
    mailboxEntryId: null,
    ...over,
  };
}

const userTurn = {
  id: 'u1',
  seq: 1,
  role: 'user',
  body: 'Plan the export feature.',
  jobId: 'ask-u1',
  runJobId: null,
  forwarded: null,
  question: null,
  isAnswer: false,
  intent: null,
  intentCorrected: false,
  citations: [],
  createdAt: '2026-10-21T09:00:00.000Z',
  authorId: 'u1',
} as unknown as PlanChangeTurnDto;

function stateOf(
  runPause: PlanChangeRunPauseDto | null,
  over: Partial<PlanChangeConversationState> = {},
  turns: PlanChangeTurnDto[] = [userTurn],
): PlanChangeConversationState {
  return {
    phase: 'streaming',
    session: {
      id: 's1',
      projectId: 'p1',
      turnCount: turns.length,
      targetKeys: [],
      lastJobId: 'run-1',
      lastSubmittedAt: '2026-10-21T09:00:00.000Z',
      turns,
      refs: {},
    } as unknown as PlanChangeConversationState['session'],
    progress: { kind: 'reading' },
    review: null,
    liveReview: null,
    liveVersion: 0,
    liveFailing: false,
    discardedReview: null,
    decided: null,
    jobId: 'run-1',
    planId: 'plan-1',
    approved: null,
    errorCode: null,
    outOfCredits: false,
    stopping: false,
    stopped: false,
    queued: [],
    earlier: null,
    reopened: null,
    readOnly: false,
    acts: [{ kind: 'reading' }],
    runPause,
    ...over,
  } as PlanChangeConversationState;
}

function rail(
  state: PlanChangeConversationState,
  onAnswerRunPause = vi.fn(),
  index: PlanChangeDiffIndex = INDEX,
) {
  return (
    <PlanChangeRail
      launch={{ mode: 'project' } as PlanningLaunch}
      projectName="Motir"
      state={state}
      index={index}
      targets={[]}
      onAddTarget={() => {}}
      onRemoveTarget={() => {}}
      onSend={() => {}}
      onRetry={() => {}}
      onCorrectTurn={() => {}}
      onApprove={() => {}}
      onDiscard={() => {}}
      onStop={() => {}}
      onAnswerRunPause={onAnswerRunPause}
    />
  );
}

afterEach(() => cleanup());

const STATES: Array<[CodeUnsearchableRepoDto['state'], string, string]> = [
  ['never_indexed', 'Never indexed', 'Nothing has been indexed for it yet.'],
  [
    'indexing',
    'Indexing in progress',
    'The first index is still running, so there is no code to search yet.',
  ],
  ['refresh_failing', 'Indexing keeps failing', 'The last attempts to index it failed.'],
  ['paused', 'Indexing is paused', 'Indexing is paused for this project.'],
  ['provider_unsupported', 'Host not supported', 'Motir can’t index repositories on this host.'],
  ['unavailable', 'Code search unavailable', 'The code couldn’t be read just now.'],
];

describe('the banner — one row per blocked repository, in words', () => {
  it.each(STATES)('words %s for the reader, never as the wire value', (state, chip, line) => {
    renderWithIntl(
      <CodeUnsearchableBanner repos={[{ repoRef: 'motir-co/motir-core', state }]} where="walk" />,
    );
    const row = screen.getByTestId('code-unsearchable-row');
    expect(within(row).getByText('motir-co/motir-core')).toBeTruthy();
    expect(within(row).getByText(chip)).toBeTruthy();
    expect(within(row).getByText(line)).toBeTruthy();
    expect(row.textContent).not.toContain('_');
  });

  it('lists several repositories ordered by name, labelled for a screen reader', () => {
    renderWithIntl(
      <CodeUnsearchableBanner
        repos={[
          { repoRef: 'motir-co/motir-web', state: 'indexing' },
          { repoRef: 'motir-co/motir-ai', state: 'paused' },
        ]}
        where="walk"
      />,
    );
    const list = screen.getByRole('list', { name: 'Repositories that can’t be searched' });
    const rows = within(list).getAllByTestId('code-unsearchable-row');
    expect(rows.map((r) => r.getAttribute('data-repo'))).toEqual([
      'motir-co/motir-ai',
      'motir-co/motir-web',
    ]);
  });

  it('is a labelled region whose label is its title', () => {
    renderWithIntl(<CodeUnsearchableBanner repos={codePause().repos ?? []} where="walk" />);
    expect(
      screen.getByRole('region', {
        name: 'Planning is on hold: Motir can’t search your code yet',
      }),
    ).toBeTruthy();
  });

  it('always links to the Codebase page, with the shipped string', () => {
    renderWithIntl(<CodeUnsearchableBanner repos={codePause().repos ?? []} where="conversation" />);
    const link = screen.getByTestId('code-unsearchable-codebase');
    expect(link.getAttribute('href')).toBe('/code');
    expect(link.textContent).toBe('Go to Codebase');
  });

  it('says what stopped, in the wording of where it stopped', () => {
    renderWithIntl(<CodeUnsearchableBanner repos={codePause().repos ?? []} where="walk" />);
    expect(screen.getByTestId('code-unsearchable-banner').textContent).toContain(
      'so Motir stopped here',
    );
    cleanup();
    renderWithIntl(<CodeUnsearchableBanner repos={codePause().repos ?? []} where="conversation" />);
    expect(screen.getByTestId('code-unsearchable-banner').textContent).toContain(
      'so nothing was planned',
    );
  });
});

describe('stopped mid-walk — a run paused on a code_unsearchable pause', () => {
  it('draws the banner with the resume control, and sends `resume`', () => {
    const onAnswer = vi.fn();
    renderWithIntl(rail(stateOf(codePause()), onAnswer));
    expect(screen.getByTestId('code-unsearchable-banner').getAttribute('data-where')).toBe('walk');
    fireEvent.click(screen.getByTestId('code-unsearchable-resume'));
    expect(onAnswer).toHaveBeenCalledWith('resume');
  });

  it('never draws the re-plan pair or the planner question beside it', () => {
    renderWithIntl(rail(stateOf(codePause())));
    expect(screen.queryByTestId('planner-start-over-offer')).toBeNull();
    expect(screen.queryByTestId('plan-change-question')).toBeNull();
  });

  it('draws the paused bar, not the spinner bar, with its own waiting line', () => {
    renderWithIntl(rail(stateOf(codePause())));
    const bar = screen.getByTestId('plan-change-running-bar');
    expect(bar.getAttribute('data-paused')).toBe('true');
    expect(screen.getByTestId('plan-change-paused-line').textContent).toBe(
      'Waiting for you to check the code and continue.',
    );
  });

  it('disables the resume control while the answer is being sent', () => {
    renderWithIntl(rail(stateOf(codePause(), { answeringPause: true })));
    expect((screen.getByTestId('code-unsearchable-resume') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('keeps what was proposed so far in a quiet record line', () => {
    const index = {
      isEmpty: false,
      counts: { added: 4, changed: 0, removed: 0 },
    } as unknown as PlanChangeDiffIndex;
    renderWithIntl(rail(stateOf(codePause()), vi.fn(), index));
    expect(screen.getByTestId('code-unsearchable-record').textContent).toBe(
      'Kept as proposed so far — 4 work items. Nothing more is added until planning continues.',
    );
  });

  it('draws no record line when nothing was proposed yet', () => {
    renderWithIntl(rail(stateOf(codePause())));
    expect(screen.queryByTestId('code-unsearchable-record')).toBeNull();
  });
});

describe('resume outcomes', () => {
  it('removes the banner once the run goes on, leaving the resumed marker', () => {
    const { rerender } = renderWithIntl(rail(stateOf(codePause())));
    expect(screen.getByTestId('code-unsearchable-banner')).toBeTruthy();
    rerender(rail(stateOf(codePause({ answer: 'resumed' }))));
    expect(screen.queryByTestId('code-unsearchable-banner')).toBeNull();
    expect(screen.getByTestId('code-unsearchable-resumed').textContent).toBe(
      'Answered — planning resumed',
    );
  });

  it('keeps the banner, updated and with a status line, when the re-check is still blocked', () => {
    const { rerender } = renderWithIntl(rail(stateOf(codePause())));
    expect(screen.queryByTestId('code-unsearchable-checked')).toBeNull();
    rerender(rail(stateOf(codePause({ answer: 'resumed' }))));
    rerender(
      rail(
        stateOf(
          codePause({
            id: 'pause-c2',
            repos: [{ repoRef: 'motir-co/motir-core', state: 'indexing' }],
          }),
        ),
      ),
    );
    const status = screen.getByTestId('code-unsearchable-checked');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toBe(
      'Checked just now: motir-co/motir-core still can’t be searched. It now shows Indexing in progress.',
    );
    const row = screen.getByTestId('code-unsearchable-row');
    expect(within(row).getByText('Indexing in progress')).toBeTruthy();
    expect(screen.getByTestId('code-unsearchable-resume')).toBeTruthy();
  });
});

describe('stopped in the conversation — before any job opened', () => {
  const stoppedTurn = {
    id: 'a1',
    seq: 2,
    role: 'assistant',
    body: 'Planning is on hold: the code cannot be searched.',
    jobId: 'ask-u1',
    runJobId: null,
    forwarded: null,
    question: null,
    isAnswer: false,
    intent: null,
    intentCorrected: false,
    citations: [],
    codeUnsearchable: [
      { repoRef: 'motir-co/motir-core', state: 'never_indexed' },
      { repoRef: 'motir-co/motir-ai', state: 'refresh_failing' },
    ],
    createdAt: '2026-10-21T09:00:05.000Z',
    authorId: null,
  } as unknown as PlanChangeTurnDto;

  it('draws the same banner after the turn, with no resume control', () => {
    renderWithIntl(
      rail(
        stateOf(null, { phase: 'idle', jobId: null, planId: null, acts: [] }, [
          userTurn,
          stoppedTurn,
        ]),
      ),
    );
    const banner = screen.getByTestId('code-unsearchable-banner');
    expect(banner.getAttribute('data-where')).toBe('conversation');
    expect(within(banner).getAllByTestId('code-unsearchable-row')).toHaveLength(2);
    expect(screen.queryByTestId('code-unsearchable-resume')).toBeNull();
    expect(screen.getByTestId('code-unsearchable-codebase')).toBeTruthy();
  });

  it('draws no banner on a turn that carries no blocked list', () => {
    renderWithIntl(rail(stateOf(null, { phase: 'idle', jobId: null, planId: null, acts: [] })));
    expect(screen.queryByTestId('code-unsearchable-banner')).toBeNull();
  });
});

describe('the other pause kinds render exactly as before', () => {
  it('a replan pause still offers start over and keep going, and no banner', () => {
    renderWithIntl(
      rail(
        stateOf(
          codePause({ kind: 'replan', repos: null, reason: 'That changes what the plan is for.' }),
        ),
      ),
    );
    expect(screen.getByTestId('planner-start-over-offer')).toBeTruthy();
    expect(screen.queryByTestId('code-unsearchable-banner')).toBeNull();
  });

  it('an unclear pause still asks its question, and no banner', () => {
    renderWithIntl(
      rail(
        stateOf(codePause({ kind: 'unclear', repos: null, question: 'Which app do you mean?' })),
      ),
    );
    expect(screen.getByTestId('plan-change-question').textContent).toContain(
      'Which app do you mean?',
    );
    expect(screen.queryByTestId('code-unsearchable-banner')).toBeNull();
  });
});
