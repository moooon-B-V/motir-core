// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import { relativeLabel } from '@/components/github/RepairFixPart';
import type { WorkItemRepairViewDto } from '@/lib/dto/workItemRepair';
import { CORE_PR, GATEWAY_PR } from '../helpers/howToTestFixtures';
import messages from '@/messages/en.json';

// THE FIX PART of the Development block (Story MOTIR-5460 · MOTIR-5466, design
// `design/github` § 21 · Panels F1–F4). The state is decided server-side by the
// repair claim's own evaluation (asserted in `tests/ready/claimWorkItemRepair.test.ts`);
// what is asserted here is what each state DRAWS.

// ⚠️ THE CODE BLOCK IS THE SHARED ONE — asserted by IMPORT. The module is wrapped so
// every render through it is recorded; a hand-drawn block would record nothing.
const codeBlocks = vi.hoisted(() => [] as { language: string | null; code: string }[]);
vi.mock('@/components/markdown/CopyableCodeBlock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/markdown/CopyableCodeBlock')>();
  return {
    CopyableCodeBlock: (props: Parameters<typeof actual.CopyableCodeBlock>[0]) => {
      codeBlocks.push({ language: props.language, code: props.code });
      return actual.CopyableCodeBlock(props);
    },
  };
});

afterEach(() => {
  cleanup();
  codeBlocks.length = 0;
  vi.restoreAllMocks();
});

const fix = messages.github.development.fix;
const copyAria = messages.github.development.howToTest.code.copyAria;
const NOW = Date.parse('2026-09-16T14:06:00Z');
const CORE = {
  repo: CORE_PR.repo,
  number: CORE_PR.number,
  ci: 'failing' as const,
  queueExit: null,
  conflict: null,
};
const GATEWAY = {
  repo: GATEWAY_PR.repo,
  number: GATEWAY_PR.number,
  ci: 'failing' as const,
  queueExit: null,
  conflict: null,
};

function renderPart(repair: WorkItemRepairViewDto | null) {
  return render(
    <DevelopmentSectionBody
      pullRequests={[
        { ...CORE_PR, ci: 'failing' },
        { ...GATEWAY_PR, ci: 'failing' },
      ]}
      itemIdentifier="ACME-12"
      repair={repair}
    />,
  );
}

const part = () => screen.getByRole('group', { name: fix.aria.part });

describe('F1 — red, nobody fixing it', () => {
  it('names each failing pull request and offers `motir fix <KEY>` in the shared code block', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderPart({ state: 'offer', failing: [CORE, GATEWAY], lastGaveUp: null });

    const p = part();
    expect(p.textContent).toContain(
      `Checks are failing on ${CORE.repo} · #${CORE.number} and ${GATEWAY.repo} · #${GATEWAY.number}.`,
    );
    expect(within(p).getAllByText(/ · #/, { selector: 'b' })).toHaveLength(2);
    expect(within(p).getByText(fix.howMany)).toBeTruthy();
    expect(codeBlocks).toEqual([{ language: 'shell', code: 'motir fix ACME-12' }]);

    fireEvent.click(within(p).getByRole('button', { name: copyAria }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('motir fix ACME-12'));
    expect(within(p).queryByText(fix.gaveUp.pill)).toBeNull();
  });

  it('one failing pull request reads in the singular', () => {
    renderPart({ state: 'offer', failing: [CORE], lastGaveUp: null });
    expect(within(part()).getByText(fix.how)).toBeTruthy();
  });
});

describe('F2 — a fix in progress', () => {
  it('names the holder and the start, and shows NO command and no copy control', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    renderPart({
      state: 'in_progress',
      failing: [CORE],
      holder: { id: 'u-mara', name: 'Mara S.' },
      byViewer: false,
      startedAt: '2026-09-16T14:02:00Z',
    });

    const p = part();
    expect(p.textContent).toContain('Being fixed by Mara S. · started 4 min. ago');
    expect(within(p).getByText(fix.fixing.pill)).toBeTruthy();
    const time = p.querySelector('time')!;
    expect(time.getAttribute('datetime')).toBe('2026-09-16T14:02:00Z');
    expect(time.getAttribute('title')).toBeTruthy();
    expect(within(p).queryByRole('button', { name: copyAria })).toBeNull();
    expect(codeBlocks).toEqual([]);
    expect(p.textContent).not.toContain('motir fix');
  });

  it('says "you" to the holder, and "someone" when the holder account is gone', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const base = {
      state: 'in_progress' as const,
      failing: [CORE],
      startedAt: '2026-09-16T11:06:00Z',
    };
    renderPart({ ...base, holder: { id: 'u-me', name: 'Me' }, byViewer: true });
    expect(part().textContent).toContain('Being fixed by you · started 3 hr. ago');
    cleanup();
    renderPart({ ...base, holder: null, byViewer: false });
    expect(part().textContent).toContain('Being fixed by someone');
  });
});

describe('F3 — the last fix gave up', () => {
  it('says so with the attempt count FROM DATA, and offers the command again', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    renderPart({
      state: 'offer',
      failing: [CORE],
      lastGaveUp: { attempts: 3, endedAt: '2026-09-16T13:46:00Z' },
    });

    const p = part();
    const callout = within(p).getByRole('status');
    // 3, not the CLI's 5 — the count is the run's own report.
    expect(callout.textContent).toContain('The last fix gave up after 3 attempts · 20 min. ago.');
    expect(callout.textContent).toContain(fix.gaveUp.body);
    expect(within(p).getByText(fix.gaveUp.pill)).toBeTruthy();
    expect(codeBlocks).toEqual([{ language: 'shell', code: 'motir fix ACME-12' }]);
  });

  it('a give-up that reported no count still says it gave up', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    renderPart({
      state: 'offer',
      failing: [CORE],
      lastGaveUp: { attempts: null, endedAt: '2026-09-14T14:06:00Z' },
    });
    expect(within(part()).getByRole('status').textContent).toContain(
      'The last fix gave up · 2 days ago.',
    );
  });
});

describe('F4 — a child of a container run', () => {
  it('points at the run target by key, with no command', () => {
    renderPart({ state: 'pointer', failing: [CORE], runTargetKey: 'ACME-10' });

    const p = part();
    expect(p.textContent).toContain('Run the fix from ACME-10');
    expect(within(p).getByRole('link', { name: 'ACME-10' }).getAttribute('href')).toBe(
      '/items/ACME-10',
    );
    expect(codeBlocks).toEqual([]);
    expect(p.textContent).not.toContain('motir fix');
  });
});

describe('state 5 — not shown', () => {
  // The server answers `hidden` for running / passing / no CI / not implemented
  // (each asserted on the evaluation); the peek passes nothing at all.
  it.each([
    ['hidden', { state: 'hidden' } as const],
    ['omitted', null],
  ])('%s renders the block with no fix part', (_label, repair) => {
    const { container } = renderPart(repair);
    expect(screen.queryByRole('group', { name: fix.aria.part })).toBeNull();
    expect(container.textContent).toContain(CORE_PR.title);
    expect(codeBlocks).toEqual([]);
  });
});

describe('relativeLabel', () => {
  it('reads minutes, then hours, then days, and never the future', () => {
    const at = (min: number) => new Date(NOW - min * 60_000).toISOString();
    expect(relativeLabel(at(0), 'en', NOW)).toBe('this minute');
    expect(relativeLabel(at(59), 'en', NOW)).toBe('59 min. ago');
    expect(relativeLabel(at(120), 'en', NOW)).toBe('2 hr. ago');
    expect(relativeLabel(at(60 * 72), 'en', NOW)).toBe('3 days ago');
    expect(relativeLabel(new Date(NOW + 600_000).toISOString(), 'en', NOW)).toBe('this minute');
    expect(relativeLabel(at(4), 'zh', NOW)).toBe('4分钟前');
  });
});

// ── An EJECTED member (Story MOTIR-5628 · MOTIR-5721; design § 26) ───────────────
describe('a member the merge queue threw out (MOTIR-5721)', () => {
  const EJECTED = {
    repo: GATEWAY_PR.repo,
    number: GATEWAY_PR.number,
    ci: 'passing' as const,
    queueExit: { rawReason: 'CI_FAILURE', failingCheckName: 'CI complete' },
    conflict: null,
  };
  const TAGS = ['<b>', '</b>', '<code>', '</code>'] as const;
  const plain = (text: string) => TAGS.reduce((out, tag) => out.split(tag).join(''), text);

  it('with NO exit the part is exactly the shipped F1 — no left-the-queue line, no sentence', () => {
    renderPart({ state: 'offer', failing: [CORE], lastGaveUp: null });
    const p = part();
    expect(p.textContent).toContain('Checks are failing on');
    expect(p.textContent).not.toContain('left the merge queue');
    expect(within(p).queryByTestId('repair-which')).toBeNull();
  });

  it('an own-failing and an ejected member draw BOTH lines, own-failing first', () => {
    renderPart({ state: 'offer', failing: [CORE, EJECTED], lastGaveUp: null });
    const text = part().textContent!;
    const own = text.indexOf(`Checks are failing on ${CORE.repo} · #${CORE.number}.`);
    const left = text.indexOf(`${EJECTED.repo} · #${EJECTED.number} left the merge queue.`);
    expect(own).toBeGreaterThanOrEqual(0);
    expect(left).toBeGreaterThan(own);
    expect(within(part()).getByTestId('repair-which').textContent).toBe(plain(fix.which.checks));
  });

  it('a member red on its OWN checks that also carries an exit stays on the failing line, and adds no sentence', () => {
    renderPart({
      state: 'offer',
      failing: [{ ...EJECTED, ci: 'failing' }],
      lastGaveUp: null,
    });
    expect(part().textContent).toContain('Checks are failing on');
    expect(within(part()).queryByTestId('repair-which')).toBeNull();
  });

  it('a failure that is neither a check nor a conflict reads the OTHER sentence', () => {
    renderPart({
      state: 'offer',
      failing: [
        { ...EJECTED, queueExit: { rawReason: 'INVALID_MERGE_COMMIT', failingCheckName: null } },
      ],
      lastGaveUp: null,
    });
    expect(within(part()).getByTestId('repair-which').textContent).toBe(plain(fix.which.other));
  });

  it('with several ejected members a CONFLICT wins', () => {
    renderPart({
      state: 'offer',
      failing: [
        { ...EJECTED, repo: CORE.repo, number: CORE.number },
        { ...EJECTED, queueExit: { rawReason: 'MERGE_CONFLICT', failingCheckName: null } },
      ],
      lastGaveUp: null,
    });
    expect(within(part()).getByTestId('repair-which').textContent).toBe(plain(fix.which.conflict));
  });

  it('the pointer state names no command and no sentence', () => {
    renderPart({ state: 'pointer', failing: [EJECTED], runTargetKey: 'ACME-3' });
    expect(within(part()).queryByTestId('repair-which')).toBeNull();
  });
});

// A CONFLICTED member (MOTIR-5916; design/github § 30's fix part): green checks, no queue
// exit, and the host reports it conflicts with its base. It is named on the CONFLICT line —
// never on *Checks are failing*, which would be false — and the notes say the agent rebases
// or resolves and that nothing is asked until a push.
describe('a member failing only because it CONFLICTS (MOTIR-5916)', () => {
  const CONFLICTED = {
    repo: GATEWAY_PR.repo,
    number: GATEWAY_PR.number,
    ci: 'passing' as const,
    queueExit: null,
    conflict: { baseRef: 'main' },
  };

  it('names it on the conflict line with its base, and says how an agent resolves it', () => {
    renderPart({ state: 'offer', failing: [CONFLICTED], lastGaveUp: null });
    const part = screen.getByTestId('repair-fix-part');
    expect(part.textContent).not.toContain('Checks are failing on');
    expect(screen.getByTestId('repair-conflict-line').textContent).toBe(
      fix.conflictOn
        .replace('<prs></prs>', `${GATEWAY_PR.repo} · #${GATEWAY_PR.number}`)
        .replace('{base}', 'main'),
    );
    expect(part.textContent).toContain(fix.howConflict);
    expect(part.textContent).toContain(fix.rearm);
  });

  it('a row with no recorded base reads *its base branch*', () => {
    renderPart({
      state: 'offer',
      failing: [{ ...CONFLICTED, conflict: { baseRef: null } }],
      lastGaveUp: null,
    });
    expect(screen.getByTestId('repair-conflict-line').textContent).toBe(
      fix.conflictOnNoBase.replace('<prs></prs>', `${GATEWAY_PR.repo} · #${GATEWAY_PR.number}`),
    );
  });

  it('a member red on its OWN checks AND conflicted is on both lines', () => {
    renderPart({
      state: 'offer',
      failing: [{ ...CONFLICTED, ci: 'failing' as const }],
      lastGaveUp: null,
    });
    const part = screen.getByTestId('repair-fix-part');
    expect(part.textContent).toContain('Checks are failing on');
    expect(screen.getByTestId('repair-conflict-line')).toBeTruthy();
  });
});
