import { describe, expect, it } from 'vitest';
import {
  PROJECT_NAME_ADJECTIVES,
  PROJECT_NAME_NOUNS,
  generateProjectName,
} from '@/lib/projects/projectNameGenerator';

// The generated default-project name (Story MOTIR-8239 · Subtask MOTIR-8526).
// Pure: no database. The lists are asserted over the EXPORTED arrays, so a
// word-list edit that breaks the shape fails here rather than at seeding.

const PAIR_SHAPE = /^[A-Z][a-z]+ [A-Z][a-z]+$/;

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

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

  it('renders every pair as two Title-Cased words joined by one space', () => {
    const malformed: string[] = [];
    for (const adjective of PROJECT_NAME_ADJECTIVES) {
      for (const noun of PROJECT_NAME_NOUNS) {
        const name = `${titleCase(adjective)} ${titleCase(noun)}`;
        if (!PAIR_SHAPE.test(name)) malformed.push(name);
      }
    }
    expect(malformed).toEqual([]);
  });
});

describe('generateProjectName', () => {
  it('draws the first adjective and first noun when the source returns 0', () => {
    expect(generateProjectName(() => 0)).toBe(
      `${titleCase(PROJECT_NAME_ADJECTIVES[0]!)} ${titleCase(PROJECT_NAME_NOUNS[0]!)}`,
    );
  });

  it('clamps a source returning 1 to the last adjective and last noun', () => {
    expect(generateProjectName(() => 1)).toBe(
      `${titleCase(PROJECT_NAME_ADJECTIVES.at(-1)!)} ${titleCase(PROJECT_NAME_NOUNS.at(-1)!)}`,
    );
  });

  it('returns the same name for the same sequence', () => {
    const sequence = () => {
      const values = [0.42, 0.17];
      let i = 0;
      return () => values[i++ % values.length]!;
    };
    expect(generateProjectName(sequence())).toBe(generateProjectName(sequence()));
  });

  it('reads the source exactly twice, adjective first', () => {
    const reads: number[] = [];
    // First read lands on the last adjective, second on the first noun: the
    // name proves which read picked which word.
    const values = [0.999999, 0];
    const name = generateProjectName(() => {
      const value = values[reads.length]!;
      reads.push(value);
      return value;
    });
    expect(reads).toHaveLength(2);
    expect(name).toBe(
      `${titleCase(PROJECT_NAME_ADJECTIVES.at(-1)!)} ${titleCase(PROJECT_NAME_NOUNS[0]!)}`,
    );
  });

  it('returns a well-formed pair from the default source', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateProjectName()).toMatch(PAIR_SHAPE);
    }
  });

  it('takes no locale argument', () => {
    expect(generateProjectName.length).toBe(0);
  });
});
