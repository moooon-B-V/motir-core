import { describe, expect, it } from 'vitest';
import {
  LESSON_PHASES,
  LESSON_PHASE_INPUT_VALUES,
  LESSON_PHASE_REFUSAL,
  RETIRED_LESSON_PHASE_ALIASES,
  canonicalizeLessonPhases,
  lessonPhaseLabelKey,
  preprocessLessonPhases,
} from '@/lib/lessons/phaseAxis';

// The LESSON store's phase axis (Bug MOTIR-4775) — the module every consumer
// reads instead of retyping the vocabulary.
//
// What is asserted here is the CONTRACT the four consumers depend on, not the
// literals: that the published set is the two current values, that the retired
// pair maps INTO that set (and not merely alongside it), and that the label
// lookup has a miss arm. The rename this module exists for moved the values
// underneath four independent declarations; a test that only restated them
// would be the fifth.

describe('the vocabulary', () => {
  it('is the two current values, in the planner’s own words', () => {
    expect(LESSON_PHASES).toEqual(['lay', 'author']);
  });

  it('accepts four spellings and names all four in the refusal', () => {
    expect([...LESSON_PHASE_INPUT_VALUES].sort()).toEqual(
      ['author', 'deepen', 'lay', 'skeleton'].sort(),
    );
    for (const spelling of LESSON_PHASE_INPUT_VALUES) {
      expect(LESSON_PHASE_REFUSAL, `the refusal omits "${spelling}"`).toContain(spelling);
    }
  });

  it('maps every retired spelling ONTO a current value — never beside it', () => {
    // The alias map's whole job. A retired value pointing at something outside
    // `LESSON_PHASES` would pass the enum and then be persisted as a third
    // vocabulary, which is the failure the one-release grace is meant to avoid.
    for (const [retired, current] of Object.entries(RETIRED_LESSON_PHASE_ALIASES)) {
      expect(LESSON_PHASES as readonly string[], `${retired} → ${current}`).toContain(current);
      expect(LESSON_PHASES as readonly string[]).not.toContain(retired);
    }
  });
});

describe('preprocessLessonPhases — the compatibility, before validation', () => {
  it('rewrites the retired spellings and leaves current ones alone', () => {
    expect(preprocessLessonPhases(['skeleton'])).toEqual(['lay']);
    expect(preprocessLessonPhases(['deepen'])).toEqual(['author']);
    expect(preprocessLessonPhases(['lay', 'author'])).toEqual(['lay', 'author']);
    expect(preprocessLessonPhases(['skeleton', 'author'])).toEqual(['lay', 'author']);
  });

  it('passes an UNKNOWN value through untouched, so the enum is what refuses it', () => {
    // It must not silently drop or "correct" a value it does not know — the
    // refusal is the schema's job, and swallowing the member here would turn a
    // typo into a search over an axis the caller never asked for.
    expect(preprocessLessonPhases(['sketch'])).toEqual(['sketch']);
  });

  it('hands back anything that is not an array of strings, unchanged', () => {
    // zod still owes the type error; this function never invents one.
    for (const raw of [undefined, null, 'lay', 42, { phases: ['lay'] }]) {
      expect(preprocessLessonPhases(raw)).toBe(raw);
    }
    expect(preprocessLessonPhases([1, 'skeleton'])).toEqual([1, 'lay']);
  });
});

describe('canonicalizeLessonPhases', () => {
  it('is idempotent, which is what makes it safe behind the preprocess', () => {
    const once = canonicalizeLessonPhases(['skeleton', 'deepen']);
    expect(once).toEqual(['lay', 'author']);
    expect(canonicalizeLessonPhases(once)).toEqual(once);
  });

  it('leaves an empty list empty — an absent axis must not become a present one', () => {
    expect(canonicalizeLessonPhases([])).toEqual([]);
  });
});

describe('lessonPhaseLabelKey', () => {
  it('keys each current value into the message catalogue', () => {
    expect(lessonPhaseLabelKey('lay')).toBe('aiPlanning.lessons.phase.lay');
    expect(lessonPhaseLabelKey('author')).toBe('aiPlanning.lessons.phase.author');
  });

  it('returns null for anything else — INCLUDING a retired spelling', () => {
    // A retired spelling is canonicalised on the way IN, so nothing that
    // reaches the renderer should still carry one; if one does, it is a drift to
    // see rather than a word to quietly translate.
    expect(lessonPhaseLabelKey('skeleton')).toBeNull();
    expect(lessonPhaseLabelKey('deepen')).toBeNull();
    expect(lessonPhaseLabelKey('reticulating')).toBeNull();
    expect(lessonPhaseLabelKey('')).toBeNull();
  });

  it('every key it returns EXISTS in both shipped catalogues', async () => {
    // The one assertion that catches the real mistake: a label key added to the
    // code and to `en.json` while `zh.json` is left behind renders a raw i18n
    // key to a Chinese reader — the parity failure, caught here rather than by
    // a reader.
    const [{ default: en }, { default: zh }] = await Promise.all([
      import('@/messages/en.json'),
      import('@/messages/zh.json'),
    ]);
    const read = (catalog: unknown, key: string): unknown =>
      key
        .split('.')
        .reduce<unknown>(
          (node, part) =>
            node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
          (catalog as { settings: unknown }).settings,
        );
    for (const phase of LESSON_PHASES) {
      const key = lessonPhaseLabelKey(phase)!;
      for (const [name, catalog] of [
        ['en', en],
        ['zh', zh],
      ] as const) {
        const value = read(catalog, key);
        expect(typeof value, `${name} is missing ${key}`).toBe('string');
        expect(String(value).trim(), `${name}.${key} is blank`).not.toBe('');
      }
    }
    // And the two labels must not be the SAME string — a copy-paste that
    // labels both phases identically passes every existence check above.
    expect(read(en, lessonPhaseLabelKey('lay')!)).not.toBe(
      read(en, lessonPhaseLabelKey('author')!),
    );
    expect(read(zh, lessonPhaseLabelKey('lay')!)).not.toBe(
      read(zh, lessonPhaseLabelKey('author')!),
    );
  });
});
