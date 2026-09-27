// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import {
  ContinuePart,
  ContinuePartSkeleton,
  type ContinuePartView,
} from '@/components/github/ContinuePart';
import { relativeLabel } from '@/components/github/RepairFixPart';
import type { DeadRunDto } from '@/lib/dto/workItemContinue';

// THE CONTINUE PART of the Development block (Story MOTIR-6526 · MOTIR-6534, design
// `design/runs` § Run died · Panels D1–D8). The state is decided server-side by the
// continue claim's own evaluation (asserted in `tests/ready/claimWorkItemContinue.test.ts`);
// what is asserted here is what each state DRAWS — and that `alive`, `none` and a
// card set back from In Progress draw NOTHING.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  refresh.mockReset();
});

const NOW = Date.parse('2026-09-27T14:30:00Z');

const deadRun: DeadRunDto = {
  id: 'run_1',
  command: 'run',
  origin: 'local',
  status: 'timed_out',
  stopReason: 'abandoned',
  startedAt: '2026-09-27T13:30:00.000Z',
  lastHeardAt: '2026-09-27T14:10:00.000Z',
  dispatcher: { id: 'usr_1', name: 'Ana' },
};

function died(over: Partial<Extract<ContinuePartView, { state: 'died' }>> = {}): ContinuePartView {
  return {
    state: 'died',
    deadRun,
    reason: 'lapsed',
    branch: 'motir/ACME-12-export',
    pullRequest: null,
    refusal: null,
    parentKey: null,
    ...over,
  };
}

function mount(view: ContinuePartView) {
  return render(
    <ContinuePart view={view} itemIdentifier="ACME-12" statusLabel="In Progress" now={NOW} />,
  );
}

const ago = (iso: string) => relativeLabel(iso, 'en', NOW);
const part = () => screen.queryByTestId('continue-part');
const text = () => part()?.textContent ?? '';

describe('the not-shown rule', () => {
  it.each([
    ['none', { state: 'none' } as ContinuePartView],
    ['alive', { state: 'alive' } as ContinuePartView],
    ['died, but set back from In Progress', died({ refusal: 'not_in_progress' })],
  ])('%s renders nothing', (_label, view) => {
    mount(view);
    expect(part()).toBeNull();
  });
});

describe('D1 — died, continuable', () => {
  it('says how it died, whose run it was, where the work is, and the one command', () => {
    mount(died());
    expect(screen.getByRole('group', { name: 'Continue the work' })).toBeTruthy();
    expect(screen.getByText('Run died')).toBeTruthy();
    expect(text()).toContain(
      `The run stopped reporting — last heard from ${ago(deadRun.lastHeardAt)}.`,
    );
    expect(text()).toContain(`Run by Ana with motir run · started ${ago(deadRun.startedAt)}`);
    expect(text()).toContain('Its work is on motir/ACME-12-export');
    // ⚠️ It never says the work item moved.
    expect(text()).toContain(
      'Nothing was lost and nothing moved: this work item is still In Progress.',
    );
    expect(text()).toContain('motir continue ACME-12');
    expect(text()).toContain('Start over instead: set ACME-12 to To Do and run it again.');
  });

  it('names the pull request the dead run left open', () => {
    mount(
      died({
        pullRequest: {
          repo: 'acme/core',
          number: 88,
          url: 'https://x',
          headRef: 'motir/ACME-12-export',
        },
      }),
    );
    expect(text()).toContain('and in the pull request acme/core · #88');
  });

  it('reads the reason in words, per how the run ended', () => {
    mount(died({ reason: 'interrupted' }));
    expect(text()).toContain(`The run was stopped from its terminal ${ago(deadRun.lastHeardAt)}.`);
  });
});

describe('D4 — nothing pushed', () => {
  it('offers no command, only start-over', () => {
    mount(died({ refusal: 'no_branch', branch: null }));
    expect(text()).toContain('Its branch was never pushed, so there is nothing to continue.');
    expect(text()).not.toContain('motir continue');
    expect(text()).toContain('Start over instead');
  });
});

describe('D6 — implemented, the PR is open', () => {
  it('points at motir fix, not continue', () => {
    mount(died({ refusal: 'use_fix' }));
    expect(text()).toContain('after it opened its pull request');
    expect(text()).toContain('motir fix ACME-12');
    expect(text()).not.toContain('motir continue');
  });
});

describe('D7 — a child of a parent run', () => {
  it('links the parent and gives the PARENT’s command', () => {
    mount(died({ refusal: 'continue_the_parent', parentKey: 'ACME-10' }));
    expect(screen.getByRole('link', { name: 'ACME-10' }).getAttribute('href')).toBe(
      '/items/ACME-10',
    );
    expect(text()).toContain('motir continue ACME-10');
    expect(text()).not.toContain('motir continue ACME-12');
  });
});

describe('D5 — continuing', () => {
  it('names who is continuing, whose run it took over, and the branch', () => {
    mount({
      state: 'continuing',
      holder: { id: 'usr_2', name: 'Bo' },
      byViewer: false,
      startedAt: '2026-09-27T14:25:00.000Z',
      branch: 'motir/ACME-12-export',
      tookOverFrom: { runId: 'run_1', dispatcher: { id: 'usr_1', name: 'Ana' } },
    });
    expect(screen.getByText('Continuing')).toBeTruthy();
    expect(text()).toContain(`Being continued by Bo · started ${ago('2026-09-27T14:25:00.000Z')}`);
    expect(text()).toContain("It took over from Ana's run");
    expect(text()).toContain('On motir/ACME-12-export');
    expect(text()).not.toContain('Run died');
  });

  it('says “you” to the viewer who is continuing it', () => {
    mount({
      state: 'continuing',
      holder: { id: 'usr_2', name: 'Bo' },
      byViewer: true,
      startedAt: '2026-09-27T14:25:00.000Z',
      branch: null,
      tookOverFrom: null,
    });
    expect(text()).toContain('Being continued by you');
  });
});

describe('D8 — loading and error', () => {
  it('the skeleton is labelled for a screen reader', () => {
    render(<ContinuePartSkeleton />);
    expect(
      screen.getByRole('status', { name: "Checking whether this work item's run is still alive" }),
    ).toBeTruthy();
  });

  it('the error says so in words and retries by refreshing the page', () => {
    mount({ state: 'error' });
    expect(text()).toContain("Couldn't check whether this work item's run is still alive.");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
