// The planner-model boundary fixture (Story MOTIR-7220 · MOTIR-7231/7235).
//
// The console's AI planning page is server rendered and writes through a Server
// Action, so `page.route` reaches neither: `lib/test-planner-model-mock.ts`
// answers motir-ai's `/v1/planner-model-settings` from this FILE, re-read on
// every request and rewritten by a save. A spec seeds it, drives the page, and
// reads back what the save wrote — the authoritative signal for "the change
// reached motir-ai".
//
// ⚠️ THE SPEC AND THE SERVER MUST NAME THE SAME FILE. Both lanes that carry the
// seam (`playwright.cloud.config.ts`, `playwright.acceptance.config.ts`) hand
// their webServer `<repo>/out/e2e-planner-model-fixture.json`; the env var is
// honoured first only for a lane that sets it on both sides.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PlannerModelFixture } from '@/lib/test-planner-model-mock';

export const PLANNER_MODEL_FIXTURE =
  process.env['MOTIR_AI_PLANNER_MODEL_FIXTURE_PATH'] ??
  path.join(process.cwd(), 'out', 'e2e-planner-model-fixture.json');

/** Three audiences on Opus 5.5, two Anthropic models offered. */
export function seededPlannerModels(): PlannerModelFixture {
  return {
    settings: (['customer', 'meta', 'internal'] as const).map((audience) => ({
      audience,
      model: 'claude-opus-5-5',
    })),
    offered: [
      { id: 'claude-opus-5-5', provider: 'anthropic' },
      { id: 'claude-sonnet-5-5', provider: 'anthropic' },
    ],
  };
}

export function writePlannerModelFixture(fixture: PlannerModelFixture): void {
  mkdirSync(path.dirname(PLANNER_MODEL_FIXTURE), { recursive: true });
  writeFileSync(PLANNER_MODEL_FIXTURE, JSON.stringify(fixture, null, 2));
}

export function readPlannerModelFixture(): PlannerModelFixture {
  return JSON.parse(readFileSync(PLANNER_MODEL_FIXTURE, 'utf8')) as PlannerModelFixture;
}

/** The model the fixture stores for one audience — what motir-ai would now hold. */
export function storedPlannerModel(audience: string): string | undefined {
  return readPlannerModelFixture().settings.find((s) => s.audience === audience)?.model;
}
