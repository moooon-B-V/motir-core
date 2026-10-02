import { describe, expect, it } from 'vitest';
import * as pages from '../src';

// The numbers `docs/decisions/pages.md` fixes. Changing one is a decision, so
// it changes here and in the record together.
describe('the record’s constants', () => {
  it('match docs/decisions/pages.md', () => {
    expect(pages.PAGE_DEPTH_LIMIT).toBe(10);
    expect(pages.PAGE_BODY_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(pages.PAGE_SAVE_MAX_BYTES).toBe(1024 * 1024);
    expect(pages.PAGE_VERSION_WINDOW_MS).toBe(10 * 60 * 1000);
    expect(pages.PAGE_VERSION_CAP).toBe(100);
    expect(pages.PAGE_LEVEL_PAGE_SIZE).toBe(50);
    expect(pages.PAGE_LEVEL_PAGE_SIZE_MAX).toBe(100);
  });
});
