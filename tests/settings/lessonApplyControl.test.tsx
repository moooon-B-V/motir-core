// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import enMessages from '@/messages/en.json';
import type { ProjectLessonDTO } from '@/lib/dto/projectLessons';

// THE APPLY CONTROL (Subtask MOTIR-3346 · Story MOTIR-3330) — the one decision
// the lesson surface offers, against design-notes.md §§L6, L9, L11.
//
// What is asserted here is the DECISIONS, not the markup:
//
//   * The PAGE-STATE CONTRACT's two halves, which want opposite treatments and
//     are the recurring bug on this shape: the acted-on row's own state comes
//     from the RESPONSE and is never re-read, while the server-rendered count
//     elsewhere is reached by `router.refresh()` and nothing else. Both are
//     asserted, because doing either one for both is wrong.
//   * `Apply again` sends NO override value — the server decides what it means
//     from the row (§L6 draws it on both not-applied rows, meaning opposite
//     writes on them).
//   * Every typed refusal renders as its OWN sentence, and a failed write
//     changes nothing on screen.
//   * The accessible name is unambiguous out of context (§L11).

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const { LessonApplyControl } =
  await import('@/app/(authed)/settings/project/ai-planning/_components/LessonApplyControl');
const { lessonApplyCopy } =
  await import('@/app/(authed)/settings/project/ai-planning/_components/lessonCopy');

const t = (key: string, values?: Record<string, string | number>): string => {
  const raw = key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      enMessages.settings,
    );
  let out = String(raw ?? key);
  for (const [k, v] of Object.entries(values ?? {})) out = out.replace(`{${k}}`, String(v));
  return out;
};

interface Catalog {
  settings: { aiPlanning: { lessons: Record<string, unknown> } };
}

function lesson(over: Partial<ProjectLessonDTO> = {}): ProjectLessonDTO {
  return {
    id: 'les_1',
    title: 'Name a sibling by its work-item key',
    body: 'What happened',
    why: 'Why it matters',
    howToApply: 'How to apply it',
    kinds: [],
    types: [],
    phases: [],
    sourceRef: 'MOTIR-2848',
    createdAt: '2026-05-14T00:00:00.000Z',
    lastOccurredAt: '2026-08-21T00:00:00.000Z',
    recurrenceCount: 4,
    injected: true,
    injectionBlock: null,
    humanOverride: null,
    humanOverrideAt: null,
    humanOverrideBy: null,
    retentionDays: 90,
    ...over,
  };
}

const RETIRED = lesson({
  injected: false,
  injectionBlock: 'disabled',
  humanOverride: 'retired',
  humanOverrideAt: '2026-08-23T12:00:00.000Z',
  humanOverrideBy: 'user_yue',
});

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function fail(status: number, code?: string) {
  return { ok: false, status, json: async () => ({ code }) } as unknown as Response;
}

/**
 * Click and let the resulting async work settle.
 *
 * The act environment (`IS_REACT_ACT_ENVIRONMENT`) flushes effects at the end of
 * every act scope, but the fetch this handler awaits resolves on a later
 * microtask — so the click is followed by an async act that yields to it. This is
 * the repo's rule about awaiting the authoritative signal rather than sleeping.
 */
async function click(el: HTMLElement): Promise<void> {
  fireEvent.click(el);
  await act(async () => {});
}

/**
 * ⚠️ The copy is resolved PER LESSON, exactly as the server pages do it — every
 * field is a STRING. A function on this prop throws *"Functions cannot be passed
 * directly to Client Components"* at the RSC boundary, which no test at this
 * level can see (there is no boundary here) and which 500s the route.
 */
const copyFor = (l: ProjectLessonDTO) => lessonApplyCopy(t, l);

function render(over: Partial<ProjectLessonDTO> = {}) {
  const l = lesson(over);
  return renderWithIntl(<LessonApplyControl lesson={l} projectKey="MOTIR" copy={copyFor(l)} />);
}

beforeEach(() => {
  refresh.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the label and the accessible name (§L9, §L11)', () => {
  it('an APPLIED lesson offers “Stop applying”, named with its takeaway', () => {
    render();

    const button = screen.getByRole('button');
    expect(button.textContent).toContain('Stop applying');
    // Unambiguous out of context — "Stop applying" alone tells a screen-reader
    // user nothing about WHICH lesson they are on.
    expect(button.getAttribute('aria-label')).toBe(
      'Stop applying Name a sibling by its work-item key',
    );
  });

  it('a NOT-APPLIED lesson offers “Apply again”, on either reason', () => {
    for (const block of ['disabled', 'not_recurred'] as const) {
      cleanup();
      render({ injectionBlock: block, injected: false });
      // §L6 gives BOTH not-applied rows the same action. The control does not
      // branch on which badge it sits under — the server decides what `apply`
      // means from the row.
      expect(screen.getByRole('button').textContent).toContain('Apply again');
    }
  });

  it('renders the row’s badge beside it, in words rather than a fill (§L11)', () => {
    render({ injectionBlock: 'not_recurred', injected: false });

    expect(screen.getByText('Not seen in 90 days')).toBeTruthy();
  });
});

describe('the page-state contract — both halves, and they differ', () => {
  it('takes the row’s new state from the RESPONSE, and does not re-read it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(RETIRED));
    vi.stubGlobal('fetch', fetchMock);
    render();

    await click(screen.getByRole('button'));

    // The response IS the confirmation. Re-reading it here is what produces the
    // visible revert this rule exists to prevent.
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('Apply again'));
    expect(screen.getByText('Not applied')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('REFRESHES for the server-rendered count elsewhere on the surface', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok(RETIRED)));
    render();

    await click(screen.getByRole('button'));

    // `{total} lessons · {applied} applied` is a Server Component read. Nothing
    // but `router.refresh()` reaches it, and without one it sits stale saying a
    // retired lesson is still applied.
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('does NOT refresh when the write failed — there is nothing new to read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fail(503, 'AI_UNAVAILABLE')));
    render();

    await click(screen.getByRole('button'));

    await screen.findByRole('alert');
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('what the control sends', () => {
  it('PUTs the boolean and NOTHING ELSE — the override value is the server’s to choose', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(RETIRED));
    vi.stubGlobal('fetch', fetchMock);
    render();

    await click(screen.getByRole('button'));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/projects/MOTIR/lessons/les_1/applied');
    expect(init.method).toBe('PUT');
    // `Apply again` means "clear the retirement" on one row and "exempt from the
    // clock" on another; only motir-ai can read the row that decides which.
    expect(JSON.parse(init.body)).toEqual({ applied: false });
  });

  it('sends `applied: true` from a not-applied row', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(lesson()));
    vi.stubGlobal('fetch', fetchMock);
    render({ injectionBlock: 'not_recurred', injected: false });

    await click(screen.getByRole('button'));

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ applied: true });
  });

  it('percent-encodes the project key and the lesson id into the path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(RETIRED));
    vi.stubGlobal('fetch', fetchMock);
    const l = lesson({ id: 'a/b' });
    renderWithIntl(<LessonApplyControl lesson={l} projectKey="A B" copy={copyFor(l)} />);

    await click(screen.getByRole('button'));

    expect(fetchMock.mock.calls[0]![0]).toBe('/api/projects/A%20B/lessons/a%2Fb/applied');
  });
});

describe('every refusal is its own sentence, and nothing changes on screen', () => {
  const cases: [number, string | undefined, string][] = [
    [404, 'NOT_FOUND', 'That lesson is no longer here.'],
    [403, undefined, 'You do not have permission'],
    [503, 'AI_UNAVAILABLE', 'Motir AI could not be reached'],
    [500, undefined, 'That did not go through'],
  ];

  for (const [status, code, fragment] of cases) {
    it(`a ${status} renders its own message`, async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fail(status, code)));
      render();

      await click(screen.getByRole('button'));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(fragment);
      // ⚠️ Nothing changed server-side, so the control must not have flipped.
      // A button reading "Apply again" over a lesson still being applied is a
      // worse failure than the refusal it is reporting.
      expect(screen.getByRole('button').textContent).toContain('Stop applying');
    });
  }

  it('a transport failure is reported too, not swallowed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    render();

    await click(screen.getByRole('button'));

    expect((await screen.findByRole('alert')).textContent).toContain('That did not go through');
    expect(screen.getByRole('button').textContent).toContain('Stop applying');
  });

  it('clears a stale message when the next attempt succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fail(503, 'AI_UNAVAILABLE'))
      .mockResolvedValueOnce(ok(RETIRED));
    vi.stubGlobal('fetch', fetchMock);
    render();

    await click(screen.getByRole('button'));
    await screen.findByRole('alert');
    await click(screen.getByRole('button'));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByRole('button').textContent).toContain('Apply again');
  });
});

describe('the zh catalog carries every string this control renders', () => {
  it('has no en-only key under aiPlanning.lessons', async () => {
    const zh = (await import('@/messages/zh.json')).default as unknown as Catalog;
    const en = enMessages as unknown as Catalog;
    const enKeys = Object.keys(en.settings.aiPlanning.lessons);
    const zhKeys = Object.keys(zh.settings.aiPlanning.lessons);
    // The catalog-parity gate in one assertion: a control shipping an
    // untranslated string renders the KEY to a zh reader, which is worse than
    // English would have been.
    expect(enKeys.filter((k) => !zhKeys.includes(k))).toEqual([]);
  });
});

describe('the row keeps the button OUT of the link (§L11, a11y)', () => {
  it('renders the action as a SIBLING of the row link, never nested inside it', async () => {
    const { LessonRow } =
      await import('@/app/(authed)/settings/project/ai-planning/_components/LessonRow');
    const { lessonRowCopy } =
      await import('@/app/(authed)/settings/project/ai-planning/_components/lessonCopy');
    renderWithIntl(
      <LessonRow
        lesson={lesson()}
        href="/x"
        copy={lessonRowCopy(t, () => '2 days ago')}
        action={
          <LessonApplyControl lesson={lesson()} projectKey="MOTIR" copy={copyFor(lesson())} />
        }
      />,
    );

    const link = screen.getByRole('link');
    const button = screen.getByRole('button');
    // ⚠️ A `<button>` inside an `<a>` is invalid HTML, and axe flags it twice
    // (`nested-interactive`, serious). §L11 asks for both a row link and a real
    // row button, which is only satisfiable as siblings.
    expect(link.contains(button)).toBe(false);
    // The link still takes the takeaway as its accessible name, and the button
    // has its own — so neither is ambiguous out of context.
    expect(link.textContent).toContain('Name a sibling by its work-item key');
    expect(button.getAttribute('aria-label')).toContain('Stop applying');
  });

  it('renders no action at all for a reader who may not act', async () => {
    const { LessonRow } =
      await import('@/app/(authed)/settings/project/ai-planning/_components/LessonRow');
    const { lessonRowCopy } =
      await import('@/app/(authed)/settings/project/ai-planning/_components/lessonCopy');
    renderWithIntl(
      <LessonRow
        lesson={lesson({ injectionBlock: 'disabled', injected: false })}
        href="/x"
        copy={lessonRowCopy(t, () => '2 days ago')}
      />,
    );

    expect(screen.queryByRole('button')).toBeNull();
    // …and the badge is still rendered, by the row itself. It states what the
    // planner is being told, which is not a permission-dependent fact.
    expect(screen.getByText('Not applied')).toBeTruthy();
  });
});

describe('the copy handed across the client boundary', () => {
  it('is ALL STRINGS — a function prop 500s the route, and nothing at this level can see it', () => {
    // ⚠️ The regression guard for a defect no component test can reach. React
    // refuses a function prop from a Server Component to a Client one
    // ("Functions cannot be passed directly to Client Components"), and the
    // failure is a 500 on the ROUTE — invisible here, because this test renders
    // the client component with no boundary in front of it.
    //
    // It is easy to reintroduce: the sibling `lessonRowCopy` DOES return
    // functions and is correct, because its consumer is a Server Component. The
    // two look interchangeable and are not, so the difference is asserted.
    const resolved = lessonApplyCopy(t, lesson());

    for (const [key, value] of Object.entries(resolved)) {
      expect(typeof value, `${key} must be a string, not a ${typeof value}`).toBe('string');
    }
    // And the per-lesson interpolations really happened server-side.
    expect(resolved.stopApplyingNamed).toContain('Name a sibling by its work-item key');
    expect(resolved.notRecurred).toContain('90');
  });
});
