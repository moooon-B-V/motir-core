import { epicIdOf, type PlanEpic, type PlanStory } from '../types';
import { EPICS } from './epics';
import { STUB_STORIES } from './stubs';
import { story_1_0 } from './story-1.0';
import { story_1_0_5 } from './story-1.0.5';
import { story_1_1 } from './story-1.1';
import { story_1_2 } from './story-1.2';
import { story_1_3 } from './story-1.3';
import { story_1_4 } from './story-1.4';
import { story_1_5 } from './story-1.5';
import { story_1_6 } from './story-1.6';
import { story_2_1 } from './story-2.1';
import { story_2_2 } from './story-2.2';
import { story_2_3 } from './story-2.3';
import { story_2_4 } from './story-2.4';
import { story_2_5 } from './story-2.5';
import { story_2_6 } from './story-2.6';
import { story_3_1 } from './story-3.1';
import { story_3_2 } from './story-3.2';
import { story_3_3 } from './story-3.3';
import { story_3_5 } from './story-3.5';
import { story_3_6 } from './story-3.6';
import { story_3_7 } from './story-3.7';
import { story_3_8 } from './story-3.8';
import { story_4_1 } from './story-4.1';
import { story_4_2 } from './story-4.2';
import { story_4_3 } from './story-4.3';
import { story_4_4 } from './story-4.4';
import { story_4_5 } from './story-4.5';
import { story_4_6 } from './story-4.6';
import { story_4_7 } from './story-4.7';
import { story_5_1 } from './story-5.1';
import { story_6_4 } from './story-6.4';
import { story_7_0 } from './story-7.0';

/** Every fully-expanded story module (canonical subtask depth). */
const EXPANDED_STORIES: PlanStory[] = [
  story_1_0,
  story_1_0_5,
  story_1_1,
  story_1_2,
  story_1_3,
  story_1_4,
  story_1_5,
  story_1_6,
  story_2_1,
  story_2_2,
  story_2_3,
  story_2_4,
  story_2_5,
  story_2_6,
  story_3_1,
  story_3_2,
  story_3_3,
  story_3_5,
  story_3_6,
  story_3_7,
  story_3_8,
  story_4_1,
  story_4_2,
  story_4_3,
  story_4_4,
  story_4_5,
  story_4_6,
  story_4_7,
  story_5_1,
  story_6_4,
  story_7_0,
];

const ALL_STORIES: PlanStory[] = [...EXPANDED_STORIES, ...STUB_STORIES];

/** Natural sort over dotted ids: "1.0" < "1.0.5" < "1.1" < "1.10". */
function cmpDotted(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? -1;
    const y = pb[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * The full Prodect v1 plan tree — the source of truth `pnpm db:seed` loads.
 * Each epic's stories are gathered by id prefix and ordered naturally.
 */
export const PLAN: PlanEpic[] = EPICS.map((epic) => ({
  ...epic,
  stories: ALL_STORIES.filter((s) => epicIdOf(s.id) === epic.id).sort((a, b) =>
    cmpDotted(a.id, b.id),
  ),
}));
