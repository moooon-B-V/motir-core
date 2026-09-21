import { describe, expect, it } from 'vitest';
import {
  choiceOptionId,
  parseChoiceOptions,
  type ChoiceParse,
  type ParsedChoice,
} from '@/lib/approvalGates/choiceOptions';

// THE CHOICE BODY PARSER (Story MOTIR-4914 · Subtask MOTIR-5891; ADR
// `approval-gates.md` §1's MOTIR-5887 amendment, points 1–2). Pure, so every
// shape is a string in and a verdict out — no fixtures.

function body(parts: {
  question?: string | null;
  why?: string | null;
  options?: string | null;
  gates?: string | null;
  prelude?: string;
}): string {
  const out: string[] = [];
  if (parts.prelude) out.push(parts.prelude);
  if (parts.question !== null) out.push('## Question', parts.question ?? 'Where do reports live?');
  if (parts.why !== null)
    out.push(
      '## Why this is a choice',
      parts.why ??
        '**Situation:** better than your decision\n**You said:** "Keep them in Postgres."\nResearch found a cheaper store.',
    );
  if (parts.options !== null)
    out.push(
      '## Options',
      parts.options ??
        [
          '### Managed object storage',
          '**Best if you want:** less to operate',
          'The provider runs it.',
          '',
          '### Our own Postgres',
          '**Best if you want:** more cost-effective',
          'No new vendor.',
        ].join('\n'),
    );
  if (parts.gates !== null)
    out.push('## What this choice gates', parts.gates ?? 'The export story.');
  return out.join('\n');
}

function ok(parse: ChoiceParse): ParsedChoice {
  if (!parse.ok) throw new Error(`expected a parse, got ${JSON.stringify(parse.defects)}`);
  return parse;
}

function reasons(parse: ChoiceParse): string[] {
  return parse.ok ? [] : parse.defects.map((d) => d.reason);
}

const FOUR = [
  '### Managed object storage',
  '**Best if you want:** less to operate',
  'A.',
  '### Our own Postgres',
  '**Best if you want:** more cost-effective',
  'B.',
  "### The customer's own bucket",
  '**Best if you want:** more customisable later',
  'C.',
  '### Email the file, keep nothing',
  '**Best if you want:** faster to the goal',
  'D.',
].join('\n');

describe('parseChoiceOptions — a complete body', () => {
  it('reads two options with their ids, best-for lines and WHY', () => {
    const parsed = ok(parseChoiceOptions(body({})));
    expect(parsed.question).toBe('Where do reports live?');
    expect(parsed.options).toEqual([
      {
        id: 'managed-object-storage',
        label: 'Managed object storage',
        bestFor: 'less to operate',
        whyMd: 'The provider runs it.',
      },
      {
        id: 'our-own-postgres',
        label: 'Our own Postgres',
        bestFor: 'more cost-effective',
        whyMd: 'No new vendor.',
      },
    ]);
    expect(parsed.followUpMd).toBe('The export story.');
    expect(parsed.subjectVersion).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads four options', () => {
    const parsed = ok(parseChoiceOptions(body({ options: FOUR })));
    expect(parsed.options.map((o) => o.id)).toEqual([
      'managed-object-storage',
      'our-own-postgres',
      'the-customer-s-own-bucket',
      'email-the-file-keep-nothing',
    ]);
  });

  it('reads the WHY section: the situation, the quoted decision and the evidence', () => {
    const parsed = ok(parseChoiceOptions(body({})));
    expect(parsed.why).toEqual({
      situation: 'better_than_your_decision',
      youSaid: 'Keep them in Postgres.',
      evidenceMd: 'Research found a cheaper store.',
    });
  });

  it('accepts `two workflows` with nothing quoted, and drops a quote it does not use', () => {
    const parsed = ok(
      parseChoiceOptions(
        body({
          why: '**Situation:** two workflows\n**You said:** "irrelevant"\nThe requirement forks.',
        }),
      ),
    );
    expect(parsed.why).toEqual({
      situation: 'two_workflows',
      youSaid: null,
      evidenceMd: 'The requirement forks.',
    });
  });

  it('tolerates prose between and before sections, CRLF, and trailing spaces on headings', () => {
    const messy = body({ prelude: 'Some intro the planner wrote.\n' })
      .replace('## Options', '## Options   ')
      .replace('### Our own Postgres', '### Our own Postgres  ')
      .replace(/\n/g, '\r\n');
    const parsed = ok(parseChoiceOptions(messy));
    expect(parsed.options.map((o) => o.label)).toEqual([
      'Managed object storage',
      'Our own Postgres',
    ]);
    // CRLF and trailing spaces do not move the stamp.
    expect(parsed.subjectVersion).toBe(ok(parseChoiceOptions(body({}))).subjectVersion);
  });

  it('keeps letters of any script in an id', () => {
    expect(choiceOptionId('托管对象存储')).toBe('托管对象存储');
    expect(choiceOptionId('  A/B — test!  ')).toBe('a-b-test');
  });
});

describe('parseChoiceOptions — the stamp', () => {
  const base = ok(parseChoiceOptions(body({}))).subjectVersion;

  it('does not move when only the question is reworded', () => {
    expect(
      ok(parseChoiceOptions(body({ question: 'Where should reports live?' }))).subjectVersion,
    ).toBe(base);
  });

  it('moves when an option changes', () => {
    const edited = body({}).replace('No new vendor.', 'No new vendor, no new bill.');
    expect(ok(parseChoiceOptions(edited)).subjectVersion).not.toBe(base);
  });

  it('moves when WHY it is a choice changes', () => {
    const edited = body({}).replace('a cheaper store', 'a much cheaper store');
    expect(ok(parseChoiceOptions(edited)).subjectVersion).not.toBe(base);
  });

  it('moves when what it gates changes', () => {
    expect(ok(parseChoiceOptions(body({ gates: 'Two stories.' }))).subjectVersion).not.toBe(base);
  });
});

describe('parseChoiceOptions — the seven defects', () => {
  it('fewer_than_two_options', () => {
    const one = '### Only one\n**Best if you want:** less to operate\nWhy.';
    expect(reasons(parseChoiceOptions(body({ options: one })))).toEqual(['fewer_than_two_options']);
    expect(reasons(parseChoiceOptions(body({ options: null })))).toEqual([
      'fewer_than_two_options',
    ]);
  });

  it('option_without_best_for — naming the option', () => {
    const parse = parseChoiceOptions(
      body({ options: '### A\n**Best if you want:** x\nWhy.\n### B\nNo line here.' }),
    );
    expect(parse.ok).toBe(false);
    if (!parse.ok)
      expect(parse.defects).toEqual([{ reason: 'option_without_best_for', label: 'B' }]);
  });

  it('duplicate_option — two labels that slug alike', () => {
    const parse = parseChoiceOptions(
      body({
        options:
          '### Managed storage\n**Best if you want:** x\nA.\n### Our DB\n**Best if you want:** y\nB.\n### Managed  Storage\n**Best if you want:** z\nC.',
      }),
    );
    expect(parse.ok).toBe(false);
    if (!parse.ok)
      expect(parse.defects).toEqual([{ reason: 'duplicate_option', label: 'Managed  Storage' }]);
  });

  it('no_follow_up_section — missing, or present and empty', () => {
    expect(reasons(parseChoiceOptions(body({ gates: null })))).toEqual(['no_follow_up_section']);
    expect(reasons(parseChoiceOptions(body({ gates: '' })))).toEqual(['no_follow_up_section']);
  });

  it('no_why_section — missing, or with no Situation line', () => {
    expect(reasons(parseChoiceOptions(body({ why: null })))).toEqual(['no_why_section']);
    expect(reasons(parseChoiceOptions(body({ why: 'Because.' })))).toEqual(['no_why_section']);
  });

  it('unknown_situation — quoting the value it could not read', () => {
    const parse = parseChoiceOptions(body({ why: '**Situation:** the team prefers it\nWhy.' }));
    expect(parse.ok).toBe(false);
    if (!parse.ok)
      expect(parse.defects).toEqual([
        { reason: 'unknown_situation', value: 'the team prefers it' },
      ]);
  });

  it('no_quoted_decision — a situation that debates a decision, with no quote', () => {
    expect(
      reasons(parseChoiceOptions(body({ why: '**Situation:** contradicts your decision\nWhy.' }))),
    ).toEqual(['no_quoted_decision']);
  });

  it('an empty body names every missing part, headline first', () => {
    expect(reasons(parseChoiceOptions(''))).toEqual([
      'fewer_than_two_options',
      'no_why_section',
      'no_follow_up_section',
    ]);
    expect(reasons(parseChoiceOptions(null))).toEqual(reasons(parseChoiceOptions('')));
  });
});

describe('parseChoiceOptions — a defective body still carries its DRAFT (MOTIR-5896)', () => {
  it('the question, why and options as far as they parse, for the defect state to show', () => {
    const parse = parseChoiceOptions(
      body({ options: '### A\n**Best if you want:** x\nWhy A.\n### B\nNo line here.' }),
    );
    expect(parse.ok).toBe(false);
    if (parse.ok) return;
    expect(parse.draft.question).toBe('Where do reports live?');
    expect(parse.draft.why?.situation).toBe('better_than_your_decision');
    expect(parse.draft.options.map((o) => [o.label, o.bestFor])).toEqual([
      ['A', 'x'],
      ['B', ''],
    ]);
    expect(parse.draft.followUpMd).toBe('The export story.');
  });

  it('a missing Why section drafts `why: null` rather than guessing a situation', () => {
    const parse = parseChoiceOptions(body({ why: null }));
    expect(parse.ok).toBe(false);
    if (!parse.ok) expect(parse.draft.why).toBeNull();
  });
});
