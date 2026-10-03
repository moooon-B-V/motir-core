// The planning-lessons console's boundary fixture (Story MOTIR-1408 · MOTIR-1413).
//
// The console's pages are server rendered and curate through Server Actions, so
// `page.route` reaches none of it: `lib/test-platform-lessons-mock.ts` answers
// motir-ai's `/v1/admin/lessons…` and `/v1/admin/lesson-retention…` from this
// FILE, re-read on every request and rewritten by a write. A spec seeds it,
// drives the page, and reads back what the write stored.
//
// ⚠️ THE SPEC AND THE SERVER MUST NAME THE SAME FILE. The acceptance lane hands
// its webServer `<repo>/out/e2e-platform-lessons-fixture.json`; the env var is
// honoured first only for a lane that sets it on both sides.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  PlatformLessonsFixture,
  PlatformLessonsFixtureLesson,
} from '@/lib/test-platform-lessons-mock';

export const PLATFORM_LESSONS_FIXTURE =
  process.env['MOTIR_AI_PLATFORM_LESSONS_FIXTURE_PATH'] ??
  path.join(process.cwd(), 'out', 'e2e-platform-lessons-fixture.json');

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

/** A lesson the planner captured `recurredDaysAgo` days ago, injected unless switched off. */
export function fixtureLesson(
  over: Partial<PlatformLessonsFixtureLesson> & Pick<PlatformLessonsFixtureLesson, 'id' | 'title'>,
): PlatformLessonsFixtureLesson {
  return {
    mistakeType: 'regular_planning',
    why: `${over.title} — why it matters.`,
    howToApply: `${over.title} — how to apply it.`,
    body: `${over.title} — what the planner got wrong.`,
    categories: ['decomposition'],
    enabled: true,
    recurrenceCount: 3,
    lastOccurredAt: daysAgo(2),
    createdAt: daysAgo(30),
    sourceRef: 'MOTIR-1',
    tenant: null,
    ...over,
  };
}

export function writePlatformLessonsFixture(fixture: PlatformLessonsFixture): void {
  mkdirSync(path.dirname(PLATFORM_LESSONS_FIXTURE), { recursive: true });
  writeFileSync(PLATFORM_LESSONS_FIXTURE, JSON.stringify(fixture, null, 2));
}

export function readPlatformLessonsFixture(): PlatformLessonsFixture {
  return JSON.parse(readFileSync(PLATFORM_LESSONS_FIXTURE, 'utf8')) as PlatformLessonsFixture;
}

/** The lesson as the fixture stores it — what motir-ai would now hold. */
export function storedLesson(id: string): PlatformLessonsFixtureLesson | undefined {
  return readPlatformLessonsFixture().lessons.find((l) => l.id === id);
}
