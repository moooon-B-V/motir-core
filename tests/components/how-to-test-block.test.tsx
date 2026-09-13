// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { HowToTestBlock, type HowToTestRowRef } from '@/components/howToTest/HowToTestBlock';
import type { HowToTestDto, HowToTestPreviewDto } from '@/lib/dto/howToTest';
import {
  CORE_FETCH,
  CORE_PR,
  GATEWAY_FETCH,
  GATEWAY_PR,
  coreRepo,
  gatewayRepo,
  recordDto,
} from '../helpers/howToTestFixtures';
import messages from '@/messages/en.json';

// HOW TO TEST, every design state (Story MOTIR-4906 · Subtask MOTIR-5336,
// design/github §20 · Panels 12a–12m). The block is the approve-to-merge gate's
// EVIDENCE: the agent's rich-text body, then what Motir derives per repository.

const t = messages.github.development.howToTest;
const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(cleanup);

const ROW_CORE: HowToTestRowRef = { id: CORE_PR.id, repo: CORE_PR.repo, number: CORE_PR.number };
const ROW_GATEWAY: HowToTestRowRef = {
  id: GATEWAY_PR.id,
  repo: GATEWAY_PR.repo,
  number: GATEWAY_PR.number,
};

function renderBlock(dto: HowToTestDto, rows: HowToTestRowRef[] = [ROW_CORE]) {
  return render(<HowToTestBlock howToTest={dto} pullRequestRows={rows} />);
}

describe('a single-repository record (Panel 12a)', () => {
  it('heads the part, renders the sectioned body, and draws the sub-block with NO repository heading', () => {
    renderBlock(recordDto());
    const part = screen.getByRole('group', { name: t.title });
    expect(within(part).getByRole('heading', { level: 4, name: t.title })).toBeTruthy();
    expect(part.textContent).toContain('Written by Parent run #318 · 13 Sept, 14:05 UTC');
    // The agent's `##` sections render as headings through the ONE pipeline.
    for (const name of ['Precondition', 'Set up', 'Click-path']) {
      expect(within(part).getByRole('heading', { level: 2, name })).toBeTruthy();
    }
    expect(part.querySelector('ol')?.children).toHaveLength(2);
    // One repository ⇒ no sub-heading naming it.
    expect(screen.queryByText('moooon/motir-core · #131')).toBeNull();
    expect(screen.getByText(t.preview.title)).toBeTruthy();
    expect(screen.getByText(t.local.title)).toBeTruthy();
    expect(screen.getByText(t.ci.title)).toBeTruthy();
  });

  it('two fenced commands in the body are two copy controls; the fetch block copies fetchCommand exactly', async () => {
    renderBlock(recordDto());
    const controls = screen.getAllByRole('button', { name: t.code.copyAria });
    // bash + sh in the body, then the Locally fetch block.
    expect(controls).toHaveLength(3);
    await act(async () => {
      fireEvent.click(controls[0]!);
    });
    expect(writeText).toHaveBeenLastCalledWith('pnpm install --frozen-lockfile && pnpm db:seed');
    await act(async () => {
      fireEvent.click(controls[1]!);
    });
    expect(writeText).toHaveBeenLastCalledWith('pnpm dev');
    await act(async () => {
      fireEvent.click(controls[2]!);
    });
    expect(writeText).toHaveBeenLastCalledWith(CORE_FETCH);
  });

  it('draws no anchor to a pull request, and no verb', () => {
    const { container } = renderBlock(recordDto());
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).not.toContain(CORE_PR.url);
    expect(hrefs.every((h) => !h?.includes('github.com'))).toBe(true);
    expect(screen.queryByRole('button', { name: /approve|merge|request changes/i })).toBeNull();
  });

  it('a body with no click-path renders what it has and nothing says missing (12f)', () => {
    renderBlock(
      recordDto({ record: { ...recordDto().record!, bodyMd: '## Set up\n\nJust run it.' } }),
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Set up' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2, name: 'Click-path' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/missing/i);
  });
});

describe('a two-repository record (Panel 12b)', () => {
  it('heads each sub-block with the SAME string its row meta line carries', () => {
    renderBlock(recordDto({ repos: [coreRepo(), gatewayRepo()] }), [ROW_CORE, ROW_GATEWAY]);
    const core = screen.getByRole('group', { name: 'moooon/motir-core · #131' });
    const gateway = screen.getByRole('group', { name: 'moooon/motir-gateway · #57' });
    expect(within(core).getByText('moooon/motir-core · #131')).toBeTruthy();
    expect(within(gateway).getByText('moooon/motir-gateway · #57')).toBeTruthy();
    // Still ONE How to test for both.
    expect(screen.getAllByRole('heading', { level: 4, name: t.title })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { level: 2, name: 'Precondition' })).toHaveLength(1);
  });

  it('each fetch block copies its own repository command', async () => {
    renderBlock(recordDto({ repos: [coreRepo(), gatewayRepo()] }), [ROW_CORE, ROW_GATEWAY]);
    const gateway = screen.getByRole('group', { name: 'moooon/motir-gateway · #57' });
    await act(async () => {
      fireEvent.click(within(gateway).getByRole('button', { name: t.code.copyAria }));
    });
    expect(writeText).toHaveBeenLastCalledWith(GATEWAY_FETCH);
  });
});

describe('In the preview — every state (Panel 12e)', () => {
  const cases: [string, HowToTestPreviewDto, string, string][] = [
    [
      'queued',
      { status: 'deployment_not_ready', state: 'queued', rawState: null, environment: 'preview' },
      'Queued',
      'The preview deployment for this head is queued. Its link appears here when it succeeds.',
    ],
    [
      'pending',
      { status: 'deployment_not_ready', state: 'pending', rawState: null, environment: 'preview' },
      'Pending',
      'The preview deployment for this head is pending.',
    ],
    [
      'in_progress',
      {
        status: 'deployment_not_ready',
        state: 'in_progress',
        rawState: null,
        environment: 'preview',
      },
      'Deploying',
      'The preview deployment for this head is deploying.',
    ],
    [
      'failure',
      { status: 'deployment_not_ready', state: 'failure', rawState: null, environment: 'preview' },
      'Deploy failed',
      'did not succeed, so there is no preview to open.',
    ],
    [
      'error',
      { status: 'deployment_not_ready', state: 'error', rawState: null, environment: 'preview' },
      'Deploy errored',
      'did not succeed, so there is no preview to open.',
    ],
    [
      'inactive',
      { status: 'deployment_not_ready', state: 'inactive', rawState: null, environment: 'preview' },
      'Inactive',
      'is no longer active — a newer deployment replaced it.',
    ],
    [
      'canceled',
      { status: 'deployment_not_ready', state: 'canceled', rawState: null, environment: 'preview' },
      'Canceled',
      'was canceled before it finished.',
    ],
    [
      'unknown',
      {
        status: 'deployment_not_ready',
        state: 'unknown',
        rawState: 'waiting_for_approval',
        environment: 'staging',
      },
      'waiting_for_approval',
      'The staging deployment for this head is waiting_for_approval.',
    ],
    ['no deployment', { status: 'no_deployment_reported' }, t.preview.none, t.preview.noneBody],
  ];

  it.each(cases)('%s', (_name, preview, pill, sentence) => {
    const { container } = renderBlock(recordDto({ repos: [coreRepo({ preview })] }));
    expect(screen.getByText(pill)).toBeTruthy();
    expect(container.textContent).toContain(sentence);
    // No link unless the deployment succeeded.
    expect(container.querySelector('a[target="_blank"]')).toBeNull();
  });

  it('available — Ready, and the URL opens the APP in a new tab', () => {
    renderBlock(recordDto());
    expect(screen.getByText(t.preview.state.success)).toBeTruthy();
    const link = screen.getByRole('link', {
      name: 'https://pr-131.motir-core.preview.moooon.dev/settings/api-keys',
    });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('an unknown preview STATUS renders its raw value', () => {
    renderBlock(
      recordDto({
        repos: [coreRepo({ preview: { status: 'teleported' } as unknown as HowToTestPreviewDto })],
      }),
    );
    expect(screen.getByText('teleported')).toBeTruthy();
  });
});

describe('What CI proved — every state (Panel 12h)', () => {
  it('passed: counts passing over counted checks', () => {
    renderBlock(recordDto());
    expect(screen.getByText('2 of 2 checks passed')).toBeTruthy();
    expect(screen.getAllByText(t.ci.conclusion.success)).toHaveLength(2);
  });

  it('failing, running, neutral (listed, not counted) and unknown (raw value)', () => {
    renderBlock(
      recordDto({
        repos: [
          coreRepo({
            ci: {
              status: 'available',
              checks: [
                { name: 'build', conclusion: 'success', rawConclusion: null },
                { name: 'typecheck', conclusion: 'failure', rawConclusion: null },
                { name: 'e2e (chromium)', conclusion: 'pending', rawConclusion: null },
                { name: 'label-bot', conclusion: 'neutral', rawConclusion: null },
                { name: 'legacy', conclusion: 'unknown', rawConclusion: 'stale' },
              ],
            },
          }),
        ],
      }),
    );
    expect(screen.getByText('1 of 4 checks passed')).toBeTruthy();
    expect(screen.getByText(t.ci.conclusion.failure)).toBeTruthy();
    expect(screen.getByText(t.ci.conclusion.pending)).toBeTruthy();
    expect(screen.getByText(t.ci.conclusion.neutral)).toBeTruthy();
    expect(screen.getByText('stale')).toBeTruthy();
    expect(screen.getByText('label-bot')).toBeTruthy();
  });

  it('no checks reported', () => {
    renderBlock(recordDto({ repos: [coreRepo({ ci: { status: 'no_checks_reported' } })] }));
    expect(screen.getByText(t.ci.none)).toBeTruthy();
    expect(screen.getByText(t.ci.noneBody)).toBeTruthy();
  });
});

describe('stale (Panel 12g)', () => {
  it('a peach callout names the repository and both commits, the body stays, the sub-block carries Stale', () => {
    renderBlock(
      recordDto({
        repos: [
          coreRepo({
            stale: true,
            commitSha: '3f2a91cdeadbeef',
            pullRequest: { ...coreRepo().pullRequest!, headSha: '8b04e7dcafef00d' },
          }),
          gatewayRepo(),
        ],
      }),
      [ROW_CORE, ROW_GATEWAY],
    );
    const callout = screen.getAllByRole('status')[0]!;
    expect(callout.textContent).toContain(
      'Written for 3f2a91c — moooon/motir-core is now at 8b04e7d.',
    );
    expect(callout.textContent).toContain(t.stale.body);
    expect(screen.getByRole('heading', { level: 2, name: 'Precondition' })).toBeTruthy();
    const core = screen.getByRole('group', { name: 'moooon/motir-core · #131' });
    expect(within(core).getByText(t.stale.pill)).toBeTruthy();
    const gateway = screen.getByRole('group', { name: 'moooon/motir-gateway · #57' });
    expect(within(gateway).queryByText(t.stale.pill)).toBeNull();
  });
});

describe('record missing (Panel 12i)', () => {
  it('a callout naming the run that owes it, and no sub-blocks', () => {
    renderBlock({
      state: 'record_missing',
      runTarget: null,
      owedBy: { runId: 'run-318', label: 'motir run · 2026-09-13 14:05 UTC' },
      record: null,
      repos: [],
      history: [],
    });
    const callout = screen.getByRole('status');
    expect(callout.textContent).toContain(t.missing.title);
    expect(callout.textContent).toContain('Owed by motir run · 2026-09-13 14:05 UTC.');
    expect(screen.queryByText(t.preview.title)).toBeNull();
    expect(screen.queryByText(t.preview.none)).toBeNull();
  });

  it('with no run at all, says so', () => {
    renderBlock({
      state: 'record_missing',
      runTarget: null,
      owedBy: null,
      record: null,
      repos: [],
      history: [],
    });
    expect(screen.getByRole('status').textContent).toContain(t.missing.noRun);
  });
});

describe('earlier runs (Panel 12j)', () => {
  it('is a collapsed disclosure that opens to the earlier records', () => {
    renderBlock(
      recordDto({
        history: [
          {
            recordId: 'rec-0',
            run: { runId: 'run-301', label: 'Run #301' },
            createdAt: '2026-09-11T09:00:00.000Z',
          },
          { recordId: 'rec-00', run: null, createdAt: '2026-09-10T09:00:00.000Z' },
        ],
      }),
    );
    const toggle = screen.getByRole('button', { name: 'Earlier runs (2)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/Run #301/)).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.body.textContent).toContain('Written by Run #301 · 11 Sept, 09:00 UTC');
  });

  it('is absent when there are none', () => {
    renderBlock(recordDto());
    expect(screen.queryByRole('button', { name: /Earlier runs/ })).toBeNull();
  });
});

describe('a repository with a pull request but no section (Panel 12k)', () => {
  it('says so, headed by the row meta, instead of being silently absent', () => {
    renderBlock(recordDto({ repos: [coreRepo()] }), [ROW_CORE, ROW_GATEWAY]);
    const gateway = screen.getByRole('group', { name: 'moooon/motir-gateway · #57' });
    expect(within(gateway).getByText(t.noSection.title)).toBeTruthy();
    expect(within(gateway).getByText(t.noSection.pill)).toBeTruthy();
    expect(gateway.textContent).toContain('Parent run #318 wrote no section for this repository');
    // Two sub-blocks ⇒ both headed.
    expect(screen.getByRole('group', { name: 'moooon/motir-core · #131' })).toBeTruthy();
  });

  it('a section whose pull request has no branch says No branch to fetch (12l)', () => {
    renderBlock(recordDto({ repos: [coreRepo({ fetchCommand: null, pullRequest: null })] }), []);
    expect(screen.getByText(t.local.noBranch)).toBeTruthy();
    expect(screen.getByText(t.local.noBranchBody)).toBeTruthy();
  });
});

describe('tested via an ancestor (Panel 12m)', () => {
  it('is ONE line linking the run target BY KEY', () => {
    renderBlock({
      state: 'tested_via_ancestor',
      runTarget: { key: 'ACME-12' },
      owedBy: null,
      record: null,
      repos: [],
      history: [],
    });
    expect(document.body.textContent).toContain('Tested as part of ACME-12');
    const link = screen.getByRole('link', { name: 'ACME-12' });
    expect(link.getAttribute('href')).toBe('/items/ACME-12');
    expect(screen.queryByRole('heading', { level: 4 })).toBeNull();
  });
});

describe('an unknown state', () => {
  it('renders its raw value, never a blank', () => {
    renderBlock({
      state: 'archived_somehow' as unknown as HowToTestDto['state'],
      runTarget: null,
      owedBy: null,
      record: null,
      repos: [],
      history: [],
    });
    expect(document.body.textContent).toContain('archived_somehow');
  });
});
