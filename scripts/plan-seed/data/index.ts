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
import { story_2_7 } from './story-2.7';
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
import { story_5_2 } from './story-5.2';
import { story_5_3 } from './story-5.3';
import { story_5_4 } from './story-5.4';
import { story_5_5 } from './story-5.5';
import { story_5_6 } from './story-5.6';
import { story_5_7 } from './story-5.7';
import { story_6_1 } from './story-6.1';
import { story_6_2 } from './story-6.2';
import { story_6_3 } from './story-6.3';
import { story_6_4 } from './story-6.4';
import { story_6_5 } from './story-6.5';
import { story_6_6 } from './story-6.6';
import { story_6_7 } from './story-6.7';
import { story_6_8 } from './story-6.8';
import { story_6_9 } from './story-6.9';
import { story_6_10 } from './story-6.10';
import { story_6_11 } from './story-6.11';
import { story_6_12 } from './story-6.12';
import { story_6_13 } from './story-6.13';
import { story_6_14 } from './story-6.14';
import { story_6_15 } from './story-6.15';
import { story_7_0 } from './story-7.0';
import { story_7_1 } from './story-7.1';
import { story_7_2 } from './story-7.2';
import { story_7_3 } from './story-7.3';
import { story_7_4 } from './story-7.4';
import { story_7_5 } from './story-7.5';
import { story_7_6 } from './story-7.6';
import { story_7_7 } from './story-7.7';
import { story_7_8 } from './story-7.8';
import { story_7_9 } from './story-7.9';
import { story_7_10 } from './story-7.10';
import { story_7_11 } from './story-7.11';
import { story_7_12 } from './story-7.12';
import { story_7_13 } from './story-7.13';
import { story_7_14 } from './story-7.14';
import { story_7_15 } from './story-7.15';
import { story_7_16 } from './story-7.16';
import { story_7_17 } from './story-7.17';
import { story_7_18 } from './story-7.18';
import { story_7_19 } from './story-7.19';
import { story_8_7 } from './story-8.7';
import { story_9_0 } from './story-9.0';
import { story_9_1 } from './story-9.1';
import { story_9_2 } from './story-9.2';
import { story_9_3 } from './story-9.3';
import { story_9_4 } from './story-9.4';
import { story_9_5 } from './story-9.5';
import { story_9_6 } from './story-9.6';
import { story_10_1 } from './story-10.1';
import { story_10_2 } from './story-10.2';
import { story_10_3 } from './story-10.3';
import { story_10_4 } from './story-10.4';

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
  story_2_7,
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
  story_5_2,
  story_5_3,
  story_5_4,
  story_5_5,
  story_5_6,
  story_5_7,
  story_6_1,
  story_6_2,
  story_6_3,
  story_6_4,
  story_6_5,
  story_6_6,
  story_6_7,
  story_6_8,
  story_6_9,
  story_6_10,
  story_6_11,
  story_6_12,
  story_6_13,
  story_6_14,
  story_6_15,
  story_7_0,
  story_7_1,
  story_7_2,
  story_7_3,
  story_7_4,
  story_7_5,
  story_7_6,
  story_7_7,
  story_7_8,
  story_7_9,
  story_7_10,
  story_7_11,
  story_7_12,
  story_7_13,
  story_7_14,
  story_7_15,
  story_7_16,
  story_7_17,
  story_7_18,
  story_7_19,
  story_8_7,
  story_9_0,
  story_9_1,
  story_9_2,
  story_9_3,
  story_9_4,
  story_9_5,
  story_9_6,
  story_10_1,
  story_10_2,
  story_10_3,
  story_10_4,
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
 * The full Motir v1 plan tree — the source of truth `pnpm db:seed` loads.
 * Each epic's stories are gathered by id prefix and ordered naturally.
 */
export const PLAN: PlanEpic[] = EPICS.map((epic) => ({
  ...epic,
  stories: ALL_STORIES.filter((s) => epicIdOf(s.id) === epic.id).sort((a, b) =>
    cmpDotted(a.id, b.id),
  ),
}));
