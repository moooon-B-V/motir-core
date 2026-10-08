import { describe, expect, it } from 'vitest';
import { REDACTED_PAGE_LABEL, redactPageRefLabels } from '@/lib/visitor/readScope';

// A Visitor's body carries no page title (Story MOTIR-7694 · MOTIR-7697).

describe('redactPageRefLabels', () => {
  it('replaces every page-chip label and keeps the id', () => {
    const md = 'See [Roadmap Q4](motir-page:p1) and [Roadmap Q4](motir-page:p2).';
    const out = redactPageRefLabels(md);
    expect(out).toBe(
      `See [${REDACTED_PAGE_LABEL}](motir-page:p1) and [${REDACTED_PAGE_LABEL}](motir-page:p2).`,
    );
    expect(out).not.toContain('Roadmap Q4');
  });

  it('leaves work-item and mention tokens and plain text alone', () => {
    const md = '[MOTIR-1](motir:w1) [@Mo](mention:u1) plain [x](https://e.x)';
    expect(redactPageRefLabels(md)).toBe(md);
  });

  it('keeps null as null', () => {
    expect(redactPageRefLabels(null)).toBeNull();
  });
});
