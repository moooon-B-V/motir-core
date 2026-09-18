// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { HowToTestBlock } from '@/components/howToTest/HowToTestBlock';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import type { HowToTestDto } from '@/lib/dto/howToTest';
import { CORE_PR, GATEWAY_PR, coreStale, recordDto } from '../helpers/howToTestFixtures';
import messages from '@/messages/en.json';

// HOW TO TEST, every design state (Story MOTIR-4906 · Subtask MOTIR-5336, built
// to design/github §20 · Panels 12a–12m, as amended by § 25 · MOTIR-5694). The
// part is the INSTRUCTIONS: the head, the author line, the author's rich-text
// body and Earlier versions. § 25 RETIRED the per-repository sub-block (In the
// preview · Locally · What CI proved, and 12k's "no section" box); MOTIR-5691
// deleted it, and the one fact it carried that lives nowhere else — STALE — is a
// single line under the author line.

const t = messages.github.development.howToTest;
const writeText = vi.fn<(text: string) => Promise<void>>();

/**
 * The retired sub-block's copy, spelled out: its catalog keys are gone, so these
 * strings are what a regression would bring back. A block that draws any of them
 * again fails here.
 */
const RETIRED_COPY = [
  'In the preview',
  'Locally',
  'What CI proved',
  "Not in this run's record",
  'No section',
  'wrote no section for this repository',
  'No preview reported',
  'No checks reported',
  'No branch to fetch',
  'The preview and CI follow the new head',
  'git fetch',
];

function expectNoRetiredCopy(root: HTMLElement = document.body) {
  for (const copy of RETIRED_COPY) expect(root.textContent).not.toContain(copy);
}

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(cleanup);

function renderBlock(dto: HowToTestDto) {
  return render(<HowToTestBlock howToTest={dto} />);
}

/** A person's saved record (§ 24 Panel 13f): a body, no sections, never stale. */
function personRecord(): HowToTestDto {
  const dto = recordDto();
  return {
    ...dto,
    record: { ...dto.record!, author: { kind: 'person', userId: 'user-ada', label: 'Ada' } },
    stale: [],
  };
}

describe("a run's record (Panel 12a)", () => {
  it('is the head, the author line and the sectioned body — and NOTHING else', () => {
    renderBlock(recordDto());
    const part = screen.getByRole('group', { name: t.title });
    expect(within(part).getByRole('heading', { level: 4, name: t.title })).toBeTruthy();
    expect(part.textContent).toContain('Written by Parent run #318 · 13 Sept, 14:05 UTC');
    // The agent's `##` sections render as headings through the ONE pipeline.
    for (const name of ['Precondition', 'Set up', 'Click-path']) {
      expect(within(part).getByRole('heading', { level: 2, name })).toBeTruthy();
    }
    expect(part.querySelector('ol')?.children).toHaveLength(2);
    // No sub-block: the part is the ONLY group, and no repository is named in it.
    expect(screen.getAllByRole('group')).toEqual([part]);
    expect(part.textContent).not.toContain('moooon/motir-core');
    expectNoRetiredCopy(part);
  });

  it('the two fenced commands in the body are the ONLY copy controls', async () => {
    renderBlock(recordDto());
    const controls = screen.getAllByRole('button', { name: t.code.copyAria });
    // bash + sh in the body. The Locally fetch block that made this three is gone.
    expect(controls).toHaveLength(2);
    await act(async () => {
      fireEvent.click(controls[0]!);
    });
    expect(writeText).toHaveBeenLastCalledWith('pnpm install --frozen-lockfile && pnpm db:seed');
    await act(async () => {
      fireEvent.click(controls[1]!);
    });
    expect(writeText).toHaveBeenLastCalledWith('pnpm dev');
  });

  it("draws no anchor of its own — every link is the author's, and none is a pull request or a preview", () => {
    const { container } = renderBlock(recordDto());
    const anchors = [...container.querySelectorAll('a')];
    // The body autolinks the author's own text (the seed's e-mail address); the
    // part itself draws none since the preview link was retired with the sub-block.
    const body = container.querySelector('.motir-how-to-test')!;
    expect(anchors.every((a) => body.contains(a))).toBe(true);
    // Parsed, not substring-matched: no anchor's HOST is GitHub's or a preview's.
    const hosts = anchors.map(
      (a) => new URL(a.getAttribute('href')!, 'https://motir.test').hostname,
    );
    expect(hosts.some((host) => host === 'github.com' || host.endsWith('.github.com'))).toBe(false);
    expect(hosts.some((host) => host.includes('preview'))).toBe(false);
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

describe("a person's record (Panel 13f)", () => {
  it('names the person, renders the body, and draws no box and no stale line', () => {
    renderBlock(personRecord());
    const part = screen.getByRole('group', { name: t.title });
    expect(part.textContent).toContain('Written by Ada · 13 Sept, 14:05 UTC');
    expect(within(part).getByRole('heading', { level: 2, name: 'Precondition' })).toBeTruthy();
    expect(screen.getAllByRole('group')).toEqual([part]);
    expect(screen.queryByRole('status')).toBeNull();
    expectNoRetiredCopy(part);
  });
});

// ⚠️ THE REPRODUCTION MOTIR-5691 CLOSES. On a work item with pull requests linked,
// a PERSON's record drew § 20 Panel 12k per row — "Not in this run's record [No
// section]" and " wrote no section for this repository", the leading space being
// where a run's name goes on a record no run wrote — a box with no facts in it,
// and, with one row, no heading naming the repository either. Rendered through the
// WHOLE Development section, because the rows are what used to produce the boxes.
// Every assertion below failed against the block before the deletion.
describe('the defect this deletion closes (§ 20 Panel 12k, retired by § 25)', () => {
  function renderSection(howToTest: HowToTestDto, pullRequests = [CORE_PR, GATEWAY_PR]) {
    return render(
      <DevelopmentSectionBody
        pullRequests={pullRequests}
        itemIdentifier="ACME-12"
        manualLinkable
        howToTest={howToTest}
      />,
    );
  }

  it("a person's record under two linked pull requests: no sentence about a run, no box, no repository named", () => {
    renderSection(personRecord());
    const part = screen.getByRole('group', { name: t.title });
    expect(part.textContent).not.toContain('wrote no section');
    expect(part.textContent).not.toMatch(/\brun\b/i);
    // No factless box: nothing inside the part is a group of its own.
    expect(within(part).queryAllByRole('group')).toHaveLength(0);
    // No repository is named INSIDE the instructions — the rows above name them.
    expect(part.textContent).not.toContain('moooon/motir-core');
    expect(part.textContent).not.toContain('moooon/motir-gateway');
    expectNoRetiredCopy(part);
  });

  it('with ONE linked pull request — the case whose box drew no heading — there is still no box', () => {
    renderSection(personRecord(), [CORE_PR]);
    const part = screen.getByRole('group', { name: t.title });
    expect(within(part).queryAllByRole('group')).toHaveLength(0);
    expectNoRetiredCopy(part);
  });

  it("a run's record that covers one of two pull requests adds nothing for the other (12k retired)", () => {
    renderSection(recordDto());
    const part = screen.getByRole('group', { name: t.title });
    expect(within(part).queryAllByRole('group')).toHaveLength(0);
    expect(part.textContent).not.toContain('moooon/motir-gateway');
    expectNoRetiredCopy(part);
    // The rows themselves are untouched — they still carry each pull request.
    expect(screen.getByText(CORE_PR.title)).toBeTruthy();
    expect(screen.getByText(GATEWAY_PR.title)).toBeTruthy();
  });
});

describe('stale (Panel 12g)', () => {
  it('is ONE line per moved repository, under the author line and ABOVE the body', () => {
    renderBlock(
      recordDto({
        stale: [
          coreStale({ recordSha: '3f2a91cdeadbeef', headSha: '8b04e7dcafef00d' }),
          coreStale({ repoName: 'moooon/motir-gateway' }),
        ],
      }),
    );
    const lines = screen.getAllByRole('status');
    expect(lines).toHaveLength(2);
    expect(lines[0]!.textContent).toContain(t.stale.pill);
    expect(lines[0]!.textContent).toContain(
      'Written for 3f2a91c — moooon/motir-core is now at 8b04e7d.',
    );
    expect(lines[1]!.textContent).toContain(
      'Written for a1b2c3d — moooon/motir-gateway is now at e4f5a6b.',
    );
    // Read BEFORE the steps it qualifies (§ 25): the line precedes the body.
    const firstHeading = screen.getByRole('heading', { level: 2, name: 'Precondition' });
    expect(
      lines[1]!.compareDocumentPosition(firstHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('replaces the callout: no "preview and CI" sentence, and no box carrying the pill', () => {
    renderBlock(recordDto({ stale: [coreStale()] }));
    expectNoRetiredCopy();
    const part = screen.getByRole('group', { name: t.title });
    expect(within(part).queryAllByRole('group')).toHaveLength(0);
    expect(screen.getAllByText(t.stale.pill)).toHaveLength(1);
  });

  it('an empty list draws nothing — the line has no empty state', () => {
    renderBlock(recordDto({ stale: [] }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(t.stale.pill)).toBeNull();
  });
});

describe('record missing (Panel 12i)', () => {
  it('a callout naming the run that owes it, and nothing derived', () => {
    renderBlock({
      state: 'record_missing',
      runTarget: null,
      owedBy: { runId: 'run-318', label: 'motir run · 2026-09-13 14:05 UTC' },
      record: null,
      stale: [],
      history: [],
    });
    const callout = screen.getByRole('status');
    expect(callout.textContent).toContain(t.missing.title);
    expect(callout.textContent).toContain('Owed by motir run · 2026-09-13 14:05 UTC.');
    expectNoRetiredCopy();
  });

  it('with no run at all, says so', () => {
    renderBlock({
      state: 'record_missing',
      runTarget: null,
      owedBy: null,
      record: null,
      stale: [],
      history: [],
    });
    expect(screen.getByRole('status').textContent).toContain(t.missing.noRun);
  });
});

// ⚠️ *Earlier RUNS* became *Earlier VERSIONS* in MOTIR-5455 (§24, decision 9),
// and the string was REPLACED rather than paralleled: once a person can write
// one, *runs* is the wrong noun for a list that holds both kinds. The disclosure
// below carries one of each, which is why the noun had to change.
describe('earlier versions (Panel 12j · 13f)', () => {
  it('is a collapsed disclosure that opens to the earlier records, of BOTH author kinds', () => {
    renderBlock(
      recordDto({
        history: [
          {
            recordId: 'rec-0',
            author: { kind: 'run', runId: 'run-301', label: 'Run #301' },
            createdAt: '2026-09-11T09:00:00.000Z',
          },
          {
            recordId: 'rec-00',
            // A record with no dispatch run is a PERSON's, under §9's
            // 2026-09-17 amendment — which is exactly the row `run: null`
            // could not describe.
            author: { kind: 'person', userId: 'user-ada', label: 'Ada' },
            createdAt: '2026-09-10T09:00:00.000Z',
          },
        ],
      }),
    );
    const toggle = screen.getByRole('button', { name: 'Earlier versions (2)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/Run #301/)).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.body.textContent).toContain('Written by Run #301 · 11 Sept, 09:00 UTC');
    // A person's row is drawn the SAME way — one record with two author kinds,
    // never two features.
    expect(document.body.textContent).toContain('Written by Ada · 10 Sept, 09:00 UTC');
  });

  it('is absent when there are none', () => {
    renderBlock(recordDto());
    expect(screen.queryByRole('button', { name: /Earlier versions/ })).toBeNull();
  });
});

describe('tested via an ancestor (Panel 12m)', () => {
  it('is ONE line linking the run target BY KEY', () => {
    renderBlock({
      state: 'tested_via_ancestor',
      runTarget: { key: 'ACME-12' },
      owedBy: null,
      record: null,
      stale: [],
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
      stale: [],
      history: [],
    });
    expect(document.body.textContent).toContain('archived_somehow');
  });
});

describe('the defensive arms the story gate measured (MOTIR-5337)', () => {
  const bare: HowToTestDto = {
    state: 'record',
    runTarget: null,
    owedBy: null,
    record: null,
    stale: [],
    history: [],
  };

  it('state record with NO record renders the missing callout, not a crash', () => {
    renderBlock(bare);
    expect(screen.getByRole('status').textContent).toContain(t.missing.noRun);
  });

  it('tested_via_ancestor with no run target names nothing and links nowhere', () => {
    renderBlock({ ...bare, state: 'tested_via_ancestor' });
    expect(document.body.textContent).toContain('Tested as part of');
    expect(screen.queryByRole('link')).toBeNull();
  });

  // ⚠️ THIS CASE CHANGED VERDICT IN MOTIR-5455, and it is the change worth
  // stating. It used to assert `run: null` ⇒ NO author line, because `run` could
  // name a dispatch run and nothing else. `author` is always present and never
  // blank — a deleted publisher reads as the product's standing string — so the
  // line is always drawn, and there is no empty-author state left to draw.
  it('a record whose publisher was deleted still names one, with a blank body', () => {
    const dto = recordDto({ history: [] });
    renderBlock({
      ...dto,
      record: {
        ...dto.record!,
        author: { kind: 'person', userId: null, label: 'Former member' },
        bodyMd: '   ',
      },
    });
    const part = screen.getByRole('group', { name: t.title });
    expect(part.textContent).toContain('Written by Former member');
    expect(within(part).queryByRole('heading', { level: 2 })).toBeNull();
    expectNoRetiredCopy(part);
  });
});
