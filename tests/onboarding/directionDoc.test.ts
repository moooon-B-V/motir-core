import { describe, expect, it } from 'vitest';
import {
  stripLeadingTitle,
  splitOpenQuestions,
  phaseLabel,
  statusPillVariant,
  TIER_META,
  DIRECTION_DOC_ORDER,
} from '@/lib/onboarding/directionDoc';

describe('stripLeadingTitle', () => {
  it('drops a single leading top-level # title line', () => {
    const md = '# Motir — Vision (Tier 2)\n\n## 1. Pitch\n\nA focused tool.';
    expect(stripLeadingTitle(md)).toBe('## 1. Pitch\n\nA focused tool.');
  });

  it('leaves deeper headings untouched and is a no-op without a leading title', () => {
    const md = '## 1. Pitch\n\n# A mid-doc h1 stays';
    expect(stripLeadingTitle(md)).toBe(md);
  });
});

describe('splitOpenQuestions', () => {
  it('extracts the Open questions section (heading removed) and removes it from the body', () => {
    const md = [
      '## 1. Pitch',
      '',
      'The pitch.',
      '',
      '## 12. Open questions',
      '',
      '- Will Stripe coverage gate launch markets?',
      '',
      '## 13. Non-goals',
      '',
      'Not an accounting suite.',
    ].join('\n');
    const { body, openQuestionsMd } = splitOpenQuestions(md);
    expect(openQuestionsMd).toBe('- Will Stripe coverage gate launch markets?');
    expect(body).toContain('## 1. Pitch');
    expect(body).toContain('## 13. Non-goals');
    expect(body).not.toContain('Open questions');
    expect(body).not.toContain('gate launch markets');
  });

  it('matches case-insensitively and runs the section to the end of the doc', () => {
    const md = '## Pitch\n\nx\n\n## OPEN QUESTIONS\n\nq1\n\nq2';
    const { body, openQuestionsMd } = splitOpenQuestions(md);
    expect(openQuestionsMd).toBe('q1\n\nq2');
    expect(body).toBe('## Pitch\n\nx');
  });

  it('returns the whole doc as body when there is no Open questions section', () => {
    const md = '## Pitch\n\njust a pitch';
    expect(splitOpenQuestions(md)).toEqual({ body: md, openQuestionsMd: null });
  });

  it('treats an empty Open questions section as none', () => {
    const md = '## Pitch\n\nx\n\n## Open questions\n\n## Non-goals\n\ny';
    expect(splitOpenQuestions(md).openQuestionsMd).toBeNull();
  });
});

describe('catalog label maps', () => {
  it('labels every phase', () => {
    expect(phaseLabel('mvp')).toBe('MVP');
    expect(phaseLabel('v1')).toBe('v1');
    expect(phaseLabel('v2')).toBe('v2');
    expect(phaseLabel('ai')).toBe('AI');
  });

  it('maps every status onto a Pill variant', () => {
    expect(statusPillVariant('todo')).toBe('planned');
    expect(statusPillVariant('in_progress')).toBe('in-progress');
    expect(statusPillVariant('done')).toBe('done');
  });
});

describe('tier metadata', () => {
  it('has plain-language labels and an --el-* accent for every tier in journey order', () => {
    for (const kind of DIRECTION_DOC_ORDER) {
      const meta = TIER_META[kind];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.accentVar.startsWith('--el-')).toBe(true);
    }
    // the optional tiers are exactly feasibility + validation
    expect(TIER_META.discovery.optional).toBe(false);
    expect(TIER_META.vision.optional).toBe(false);
    expect(TIER_META.feasibility.optional).toBe(true);
    expect(TIER_META.validation.optional).toBe(true);
  });
});
