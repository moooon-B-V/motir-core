import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-3559 — allocation rows 6–10: the ai-planning and roles subtree.
//
// TWO pages change and THREE do not, and the three are the point of the card
// rather than a shortfall in it. Their deciding read IS the read that fills the
// page — `getLesson` and `getRoleCatalog` each decide a `notFound()` — so once
// either returns, the body has everything it renders and there is no window
// between "the status is settled" and "the content is here" for a frame to fill.
// A sweep reaching for consistency would put a boundary on all five and wrap
// values already in hand.
//
// So the zero-diff rows get an ASSERTION rather than a note. An absent boundary
// and a considered one look identical in a diff; only a test tells them apart.

const ROOT = resolve(__dirname, '..', '..');
/** Source with comments stripped — a claim in prose is not a claim in code. */
const code = (rel: string) =>
  readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const DIR = 'app/(authed)/settings/project';
const CHANGED = [
  { row: 6, rel: `${DIR}/ai-planning/page.tsx`, width: '42rem' },
  { row: 7, rel: `${DIR}/ai-planning/lessons/page.tsx`, width: '52rem' },
] as const;
const UNCHANGED = [
  { row: 8, rel: `${DIR}/ai-planning/lessons/[lessonId]/page.tsx`, decider: 'getLesson' },
  { row: 9, rel: `${DIR}/roles/[roleKey]/page.tsx`, decider: 'getRoleCatalog' },
  { row: 10, rel: `${DIR}/roles/[roleKey]/edit/page.tsx`, decider: 'getRoleCatalog' },
] as const;

describe('rows 6–7 mount the shared frame below their gate (MOTIR-3559)', () => {
  it.each(CHANGED)('row $row · $rel mounts SettingsPaneFrame, below the gate', ({ rel }) => {
    const src = code(rel);
    expect(src).toMatch(/from '@\/components\/settings\/SettingsPaneFrame'/);
    expect(src).toMatch(/fallback=\{<SettingsPaneFrame\s*\/>\}/);
    expect(src).not.toMatch(/animate-pulse/);
    const gate = src.indexOf('guardSettingsPage');
    expect(gate).toBeGreaterThan(-1);
    expect(src.indexOf('<Suspense')).toBeGreaterThan(gate);
  });

  it.each(CHANGED)(
    'row $row · the page keeps its own centred column at $width',
    ({ rel, width }) => {
      expect(code(rel)).toContain(`max-w-[${width}]`);
    },
  );

  it('row 7 · the boundary sits below BOTH gates, not just the area’s', () => {
    // `guardLessonLibrary` refuses an actor without `lesson:view`, so it decides
    // what this route answers exactly as the area guard does.
    const src = code(`${DIR}/ai-planning/lessons/page.tsx`);
    const second = src.indexOf('guardLessonLibrary');
    expect(second).toBeGreaterThan(-1);
    expect(src.indexOf('<Suspense')).toBeGreaterThan(second);
  });
});

describe('row 6 is the family’s ONLY second boundary (MOTIR-3559)', () => {
  const src = code(`${DIR}/ai-planning/page.tsx`);

  it('the lesson-library preview sits behind a boundary of its own', () => {
    // It cannot start until `canViewLessons` comes back out of the tier-2 wave,
    // so it is genuinely LATER than the pane around it rather than merely
    // further down it — which is what earns a third tier.
    expect((src.match(/<Suspense/g) ?? []).length).toBe(2);
    expect(src).toMatch(/<LessonLibraryPreview/);
  });

  it('the preview is still SKIPPED, not merely un-rendered, without the key', () => {
    // MOTIR-3337/3338: asking for a payload we would discard is the
    // fetch-then-hide shape those cards rule out. The boundary must not turn a
    // skipped read into an issued one.
    expect(src).toMatch(/\{canViewLessons \? \(/);
    expect((src.match(/projectLessonsService\.listLessons\(/g) ?? []).length).toBe(1);
  });

  it('and no OTHER page in this card gains a second boundary', () => {
    expect((code(`${DIR}/ai-planning/lessons/page.tsx`).match(/<Suspense/g) ?? []).length).toBe(1);
  });
});

describe('rows 8–10 get NOTHING, and that is the deliverable (MOTIR-3559)', () => {
  it.each(UNCHANGED)('row $row · $rel adds no boundary and no frame', ({ rel }) => {
    const src = code(rel);
    expect(src).not.toMatch(/<Suspense/);
    expect(src).not.toMatch(/SettingsPaneFrame/);
  });

  it.each(UNCHANGED)(
    'row $row · its deciding read $decider is a GATE, which is WHY',
    ({ rel, decider }) => {
      // The read that decides the notFound() is the read that fills the page, so
      // nothing is left to put behind a boundary. Pinning the pairing means a later
      // sweep that adds one has to argue with this test rather than with a comment.
      const src = code(rel);
      expect(src).toContain(decider);
      expect(src).toMatch(/notFound\(\)/);
    },
  );

  it.each(UNCHANGED)('row $row · and no route-level loading.tsx appears beside it', ({ rel }) => {
    // These are among the eleven authed routes that decide existence: a
    // route-level fallback above one flushes a 200 head before the page has
    // decided the thing exists.
    expect(code(rel)).not.toMatch(/loading\.tsx/);
  });
});
