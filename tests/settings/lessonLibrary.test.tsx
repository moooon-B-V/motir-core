// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import {
  AxisChip,
  EveryCardChip,
  LessonRow,
  NotAppliedBadge,
} from '@/app/(authed)/settings/project/ai-planning/_components/LessonRow';
import {
  LessonLibraryCard,
  LESSON_PREVIEW_COUNT,
} from '@/app/(authed)/settings/project/ai-planning/_components/LessonLibraryCard';
import { lessonRowCopy } from '@/app/(authed)/settings/project/ai-planning/_components/lessonCopy';
import type { ProjectLessonDTO } from '@/lib/dto/projectLessons';

// THE LESSON LIBRARY's components (Subtask MOTIR-3338), against
// `design/ai-settings/ai-planning-lessons.mock.html` + design-notes.md
// §§L4, L6, L8, L11.
//
// What is asserted here is the DESIGN's decisions, not the markup: an empty axis
// is not drawn, the two not-applied reasons stay distinguishable, and every
// state's meaning is carried in WORDS rather than in a fill.

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

const copy = lessonRowCopy(t, () => '2 days ago');

function lesson(over: Partial<ProjectLessonDTO> = {}): ProjectLessonDTO {
  return {
    id: 'les_1',
    title: 'Name a sibling by its work-item key, never by description',
    body: 'What happened',
    why: 'Why it matters',
    howToApply: 'How to apply it',
    kinds: ['story'],
    types: ['code'],
    phases: [],
    sourceRef: 'MOTIR-2848',
    createdAt: '2026-05-14T00:00:00.000Z',
    lastOccurredAt: '2026-08-21T00:00:00.000Z',
    recurrenceCount: 4,
    injected: true,
    injectionBlock: null,
    retentionDays: 90,
    ...over,
  };
}

afterEach(cleanup);

describe('the axes — an empty one is NOT drawn', () => {
  it('renders one chip per axis VALUE, each carrying its axis name', () => {
    renderWithIntl(<LessonRow lesson={lesson()} href="/x" copy={copy} />);
    // `story` alone reads as a status — the axis name travels with it (§L4).
    expect(screen.getByText('kind')).toBeTruthy();
    expect(screen.getByText('story')).toBeTruthy();
    expect(screen.getByText('type')).toBeTruthy();
    expect(screen.getByText('code')).toBeTruthy();
    // `phases` is empty, so no phase chip exists at all.
    expect(screen.queryByText('phase')).toBeNull();
  });

  it('a lesson constrained on NO axis shows one "applies everywhere" chip, not three empty ones', () => {
    renderWithIntl(
      <LessonRow lesson={lesson({ kinds: [], types: [], phases: [] })} href="/x" copy={copy} />,
    );
    expect(screen.getByText('Applies to every card')).toBeTruthy();
    expect(screen.queryByText('kind')).toBeNull();
    expect(screen.queryByText('type')).toBeNull();
  });

  it('AxisChip and EveryCardChip render as chips in isolation', () => {
    const { container } = renderWithIntl(
      <>
        <AxisChip axis="kind" value="story" />
        <EveryCardChip label="Applies to every card" />
      </>,
    );
    expect(container.textContent).toContain('kindstory');
    expect(container.textContent).toContain('Applies to every card');
  });
});

describe('the two numbers, and how they are worded', () => {
  it('says "seen once" and "seen twice" rather than "seen 1 times"', () => {
    renderWithIntl(<LessonRow lesson={lesson({ recurrenceCount: 1 })} href="/x" copy={copy} />);
    expect(screen.getByText(/seen once/)).toBeTruthy();
    cleanup();
    renderWithIntl(<LessonRow lesson={lesson({ recurrenceCount: 2 })} href="/x" copy={copy} />);
    expect(screen.getByText(/seen twice/)).toBeTruthy();
    cleanup();
    renderWithIntl(<LessonRow lesson={lesson({ recurrenceCount: 4 })} href="/x" copy={copy} />);
    expect(screen.getByText(/seen 4 times/)).toBeTruthy();
  });

  it('renders both clocks — last seen AND how often', () => {
    renderWithIntl(<LessonRow lesson={lesson()} href="/x" copy={copy} />);
    expect(screen.getByText(/Last seen 2 days ago/)).toBeTruthy();
    expect(screen.getByText(/seen 4 times/)).toBeTruthy();
  });
});

describe('NOT APPLIED — the two reasons stay distinguishable', () => {
  it('a switched-off lesson says so IN WORDS', () => {
    renderWithIntl(
      <LessonRow
        lesson={lesson({ injected: false, injectionBlock: 'disabled' })}
        href="/x"
        copy={copy}
      />,
    );
    expect(screen.getByText('Not applied')).toBeTruthy();
    expect(screen.queryByText(/Not seen in/)).toBeNull();
  });

  it('an aged-out lesson quotes the window IT was judged against', () => {
    renderWithIntl(
      <LessonRow
        lesson={lesson({ injected: false, injectionBlock: 'not_recurred', retentionDays: 60 })}
        href="/x"
        copy={copy}
      />,
    );
    // 60, not the 90 default — the row carries its own number, which is why the
    // field rides each lesson rather than the page.
    expect(screen.getByText('Not seen in 60 days')).toBeTruthy();
  });

  it('the two produce DIFFERENT text — neither can be mistaken for the other', () => {
    const off = renderWithIntl(<NotAppliedBadge block="disabled" label={copy.notApplied} />)
      .container.textContent;
    cleanup();
    const aged = renderWithIntl(
      <NotAppliedBadge block="not_recurred" label={copy.notRecurred(90)} />,
    ).container.textContent;
    expect(off).not.toEqual(aged);
    expect(off).toContain('Not applied');
    expect(aged).toContain('Not seen in 90 days');
  });

  it('marks the row so the state is readable without parsing its copy', () => {
    renderWithIntl(
      <LessonRow
        lesson={lesson({ injected: false, injectionBlock: 'disabled' })}
        href="/x"
        copy={copy}
      />,
    );
    expect(screen.getByTestId('lesson-row').getAttribute('data-not-applied')).toBe('true');
    cleanup();
    renderWithIntl(<LessonRow lesson={lesson()} href="/x" copy={copy} />);
    expect(screen.getByTestId('lesson-row').getAttribute('data-not-applied')).toBeNull();
  });

  it('renders NO retire control — the action belongs to the sibling story', () => {
    renderWithIntl(
      <LessonRow
        lesson={lesson({ injected: false, injectionBlock: 'disabled' })}
        href="/x"
        copy={copy}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/Stop applying|Apply again/)).toBeNull();
  });
});

describe('the row is a link, and its name is the takeaway', () => {
  it('links to the detail with the lesson as its accessible name', () => {
    renderWithIntl(
      <LessonRow
        lesson={lesson()}
        href="/settings/project/ai-planning/lessons/les_1"
        copy={copy}
      />,
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/settings/project/ai-planning/lessons/les_1');
    expect(link.textContent).toContain('Name a sibling by its work-item key');
  });
});

describe('THE DOOR card', () => {
  const cardCopy = {
    title: 'What Motir has learned',
    subtitle: 'Corrections this project taught its planner.',
    viewAll: 'View all 12 lessons',
    unavailableTitle: 'Motir AI is unavailable right now',
    unavailableBody: 'The rest of this page still works.',
  };

  it('quotes the LIBRARY total in its link, never the preview length', () => {
    // The preview is three rows and the library is twelve. "View all 3 lessons"
    // reads perfectly and is wrong, which is why the string is interpolated by
    // the caller from `total` and asserted here rather than left to the eye.
    const many = Array.from({ length: 6 }, (_, i) => lesson({ id: `l${i}`, title: `lesson ${i}` }));
    renderWithIntl(
      <LessonLibraryCard
        lessons={many}
        available
        href="/x"
        copy={cardCopy}
        formatWhen={() => '2 days ago'}
      />,
    );
    expect(screen.getByTestId('lesson-library-link').textContent).toContain('View all 12 lessons');
    expect(screen.getAllByTestId('lesson-preview-row').length).toBeLessThan(12);
  });

  it('previews at most three takeaways and links to the library', () => {
    const many = Array.from({ length: 6 }, (_, i) => lesson({ id: `l${i}`, title: `lesson ${i}` }));
    renderWithIntl(
      <LessonLibraryCard
        lessons={many}
        available
        href="/settings/project/ai-planning/lessons"
        copy={cardCopy}
        formatWhen={() => '2 days ago'}
      />,
    );
    expect(screen.getAllByTestId('lesson-preview-row')).toHaveLength(LESSON_PREVIEW_COUNT);
    expect(screen.getByTestId('lesson-library-link').getAttribute('href')).toBe(
      '/settings/project/ai-planning/lessons',
    );
  });

  it('still shows the door when the project has no lessons — the link is how you learn what this is', () => {
    renderWithIntl(
      <LessonLibraryCard lessons={[]} available href="/x" copy={cardCopy} formatWhen={() => ''} />,
    );
    expect(screen.queryAllByTestId('lesson-preview-row')).toHaveLength(0);
    expect(screen.getByTestId('lesson-library-link')).toBeTruthy();
  });

  it('goes QUIET on an upstream outage — no rows, no link, and it says why', () => {
    renderWithIntl(
      <LessonLibraryCard
        lessons={[]}
        available={false}
        href="/x"
        copy={cardCopy}
        formatWhen={() => ''}
      />,
    );
    expect(screen.getByText('Motir AI is unavailable right now')).toBeTruthy();
    expect(screen.queryByTestId('lesson-library-link')).toBeNull();
    // The card is still THERE — the section going quiet is not the page going
    // down (MOTIR-3337's degradation contract, rendered).
    expect(screen.getByTestId('lesson-library-card')).toBeTruthy();
  });
});

describe('i18n — every key the surface reads exists in BOTH catalogs', () => {
  it('en and zh carry the same lesson keys, none blank', () => {
    const en = enMessages.settings.aiPlanning.lessons as Record<string, string>;
    const zh = zhMessages.settings.aiPlanning.lessons as Record<string, string>;
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    for (const [key, value] of Object.entries(zh)) {
      expect(String(value).trim(), `zh.${key} is blank`).not.toBe('');
    }
  });

  it('keeps the placeholders the surface interpolates', () => {
    const en = enMessages.settings.aiPlanning.lessons as Record<string, string>;
    const zh = zhMessages.settings.aiPlanning.lessons as Record<string, string>;
    for (const key of ['viewAll', 'count', 'lastSeen', 'seenTimes', 'notRecurred']) {
      const placeholders = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort();
      expect(placeholders(zh[key]!), `zh.${key}`).toEqual(placeholders(en[key]!));
    }
  });
});
