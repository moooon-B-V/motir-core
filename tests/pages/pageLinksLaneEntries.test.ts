import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import pagesLane from '../../vitest.coverage.pages.config';

// Story MOTIR-7567's lane-integrity guard (MOTIR-9201). The pages coverage lane
// gates a file only when a `STORY_FILES` pattern reaches it AND a suite in
// `test.include` runs it; an entry that matches no file passes vacuously
// (MOTIR-2449). This pins the hand link's files and suites against both.

const requireFromVitest = createRequire(createRequire(import.meta.url).resolve('vitest'));
const pm = requireFromVitest('picomatch') as (glob: string | string[]) => (s: string) => boolean;

const coverage = pagesLane.test?.coverage as {
  include: string[];
  thresholds: Record<string, unknown>;
};
const includes = pagesLane.test?.include as string[];

const GATED_FILES = [
  'app/(authed)/items/[key]/_components/PagesSection.tsx',
  'app/(authed)/items/[key]/_components/LinkPageForm.tsx',
  'app/(authed)/items/[key]/_components/PagePlace.tsx',
  'app/(authed)/pages/[pageId]/_components/LinkedWorkItemsStrip.tsx',
  'app/(authed)/pages/[pageId]/_components/LinkWorkItemControl.tsx',
  'lib/workItems/pageLinksClient.ts',
  'lib/pages/pageLinkedWorkItemsClient.ts',
  'lib/services/pageLinksService.ts',
  'lib/pages/pageWorkItemsCursor.ts',
  'app/api/work-items/[id]/pages/[pageId]/route.ts',
  'app/api/pages/[pageId]/work-items/route.ts',
];

const SUITES = [
  'tests/pages/pageWorkItemHandLinks.story.integration.test.ts',
  'tests/pages/pageLinksClient.test.ts',
  'tests/components/linkPageForm.test.tsx',
  'tests/components/linkedWorkItemsStrip.test.tsx',
  'tests/components/pagesSection.test.tsx',
  'tests/services/pageLinksService.write.test.ts',
  'tests/api/workItemsPagesWrite.test.ts',
  'tests/api/pageWorkItemsRoute.test.ts',
];

describe('the pages coverage lane carries the hand link', () => {
  it.each(GATED_FILES)('%s exists, is included and carries the floor', (file) => {
    expect(existsSync(file), `${file} is gone`).toBe(true);
    expect(
      coverage.include.some((glob) => pm(glob)(file)),
      `no include reaches ${file}`,
    ).toBe(true);
    const keys = Object.keys(coverage.thresholds).filter((key) => pm(key)(file));
    expect(keys.length, `no threshold key gates ${file}`).toBeGreaterThan(0);
  });

  it.each(SUITES)('%s exists and is run by the lane', (suite) => {
    expect(existsSync(suite), `${suite} is gone`).toBe(true);
    expect(
      includes.some((glob) => pm(glob)(suite)),
      `the lane does not run ${suite}`,
    ).toBe(true);
  });
});
