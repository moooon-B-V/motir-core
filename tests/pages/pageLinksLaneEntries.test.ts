import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// Story MOTIR-7567's lane-integrity guard (MOTIR-9201). The pages coverage lane
// gates a file only when a `STORY_FILES` pattern reaches it AND a suite in
// `test.include` runs it; an entry that matches no file passes vacuously
// (MOTIR-2449). This pins the hand link's files and suites against both.

const requireFromVitest = createRequire(createRequire(import.meta.url).resolve('vitest'));
const pm = requireFromVitest('picomatch') as (glob: string | string[]) => (s: string) => boolean;

// The config is read as TEXT, not imported: it sits outside `tsconfig.tests.json`'s file list.
const source = readFileSync('vitest.coverage.pages.config.ts', 'utf8');
const storyFiles = [
  ...source
    .slice(source.indexOf('const STORY_FILES'), source.indexOf('const SHARED_FILES'))
    .matchAll(/^\s+'([^']+)',$/gm),
].map((m) => m[1]!);
const includes = [
  ...source
    .slice(source.indexOf('include: ['), source.indexOf('coverage: {'))
    .matchAll(/^\s+'([^']+)',$/gm),
].map((m) => m[1]!);

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
    // Every STORY_FILES entry is both an include and a threshold key in the config.
    expect(
      storyFiles.some((glob) => pm(glob)(file)),
      `no STORY_FILES entry gates ${file}`,
    ).toBe(true);
  });

  it.each(SUITES)('%s exists and is run by the lane', (suite) => {
    expect(existsSync(suite), `${suite} is gone`).toBe(true);
    expect(
      includes.some((glob) => pm(glob)(suite)),
      `the lane does not run ${suite}`,
    ).toBe(true);
  });
});
