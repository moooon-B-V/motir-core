import { describe, expect, it } from 'vitest';
import {
  PROJECT_NAME_ADJECTIVES,
  PROJECT_NAME_NOUNS,
  PROJECT_NAME_NUMBER_MAX,
  PROJECT_NAME_NUMBER_MIN,
  generateProjectName,
} from '@/lib/projects/projectNameGenerator';

// The generated default-project name (Story MOTIR-8239 · Subtask MOTIR-8526).
// Pure: no database. The lists are asserted over the EXPORTED arrays, so a
// word-list edit that breaks the shape fails here rather than at seeding.

// Deliberately random-looking: lowercase, hyphenated, four digits on the end.
const NAME_SHAPE = /^[a-z]+-[a-z]+-[1-9][0-9]{3}$/;

describe.each([
  ['adjectives', PROJECT_NAME_ADJECTIVES],
  ['nouns', PROJECT_NAME_NOUNS],
] as const)('the %s list', (_label, list) => {
  it('holds only lowercase ASCII words of three letters or more', () => {
    const malformed = list.filter((word) => !/^[a-z]{3,}$/.test(word));
    expect(malformed).toEqual([]);
  });

  it('has no case-insensitive duplicates', () => {
    const seen = new Set<string>();
    const duplicates = list.filter((word) => {
      const key = word.toLowerCase();
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    });
    expect(duplicates).toEqual([]);
  });

  it('has at least 100 entries', () => {
    expect(list.length).toBeGreaterThanOrEqual(100);
  });
});

describe('the pair space', () => {
  it('offers at least 10,000 distinct pairs', () => {
    expect(PROJECT_NAME_ADJECTIVES.length * PROJECT_NAME_NOUNS.length).toBeGreaterThanOrEqual(
      10_000,
    );
  });

  it('renders every pair as a lowercase hyphenated name with a four-digit tail', () => {
    const malformed: string[] = [];
    for (const adjective of PROJECT_NAME_ADJECTIVES) {
      for (const noun of PROJECT_NAME_NOUNS) {
        const name = `${adjective}-${noun}-${PROJECT_NAME_NUMBER_MIN}`;
        if (!NAME_SHAPE.test(name)) malformed.push(name);
      }
    }
    expect(malformed).toEqual([]);
  });
});

describe('generateProjectName', () => {
  it('draws the first adjective, first noun and lowest number when the source returns 0', () => {
    expect(generateProjectName(() => 0)).toBe(
      `${PROJECT_NAME_ADJECTIVES[0]!}-${PROJECT_NAME_NOUNS[0]!}-${PROJECT_NAME_NUMBER_MIN}`,
    );
  });

  it('clamps a source returning 1 to the last adjective, last noun and highest number', () => {
    expect(generateProjectName(() => 1)).toBe(
      `${PROJECT_NAME_ADJECTIVES.at(-1)!}-${PROJECT_NAME_NOUNS.at(-1)!}-${PROJECT_NAME_NUMBER_MAX}`,
    );
  });

  it('keeps the number to four digits', () => {
    expect(PROJECT_NAME_NUMBER_MIN).toBe(1000);
    expect(PROJECT_NAME_NUMBER_MAX).toBe(9999);
  });

  it('returns the same name for the same sequence', () => {
    const sequence = () => {
      const values = [0.42, 0.17, 0.5];
      let i = 0;
      return () => values[i++ % values.length]!;
    };
    expect(generateProjectName(sequence())).toBe(generateProjectName(sequence()));
  });

  it('reads the source exactly three times: adjective, noun, number', () => {
    const reads: number[] = [];
    // The reads land on the last adjective, the first noun and the lowest
    // number: the name proves which read picked which part.
    const values = [0.999999, 0, 0];
    const name = generateProjectName(() => {
      const value = values[reads.length]!;
      reads.push(value);
      return value;
    });
    expect(reads).toHaveLength(3);
    expect(name).toBe(
      `${PROJECT_NAME_ADJECTIVES.at(-1)!}-${PROJECT_NAME_NOUNS[0]!}-${PROJECT_NAME_NUMBER_MIN}`,
    );
  });

  it('returns a well-formed name from the default source', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateProjectName()).toMatch(NAME_SHAPE);
    }
  });

  it('takes no locale argument', () => {
    expect(generateProjectName.length).toBe(0);
  });
});
