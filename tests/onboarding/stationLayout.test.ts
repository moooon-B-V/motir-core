import { describe, expect, it } from 'vitest';
import {
  CANVAS_NODE_KEYS,
  STATION_AUTO_LAYOUT,
  STATION_EDGES,
  positionFor,
} from '@/lib/onboarding/stationLayout';

describe('stationLayout', () => {
  it('has an auto position for every canvas node (idea + the stations)', () => {
    expect(CANVAS_NODE_KEYS).toEqual([
      'idea',
      'discovery',
      'vision',
      'feasibility',
      'validation',
      'design',
      'plan',
    ]);
    for (const key of CANVAS_NODE_KEYS) {
      expect(STATION_AUTO_LAYOUT[key]).toBeDefined();
    }
  });

  it('edges are the read-only pre-plan dependency chain', () => {
    expect(STATION_EDGES).toEqual([
      ['idea', 'discovery'],
      ['discovery', 'vision'],
      ['vision', 'feasibility'],
      ['feasibility', 'validation'],
      ['validation', 'design'],
      ['design', 'plan'],
    ]);
  });

  it('positionFor prefers a saved position over the auto-layout default', () => {
    expect(positionFor('vision', {})).toEqual(STATION_AUTO_LAYOUT.vision);
    expect(positionFor('vision', { vision: { x: 5, y: 9 } })).toEqual({ x: 5, y: 9 });
  });
});
