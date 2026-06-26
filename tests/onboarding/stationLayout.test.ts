import { describe, expect, it } from 'vitest';
import {
  CANVAS_NODE_KEYS,
  ROW_DESIGN_Y,
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

  it('design/plan row clears a TALL produced tier card so they never overlap (MOTIR-1364)', () => {
    // The tier row and the design/plan row share the same left column (discovery is
    // directly above design at ORIGIN_X), so the vertical gap must exceed the height
    // of the tallest PRODUCED tier card (which grows with its captured-findings
    // rows). A bare card is ~220px; a full one runs ~340px. Require >= 340 clearance.
    const tierY = STATION_AUTO_LAYOUT.discovery.y;
    const designY = STATION_AUTO_LAYOUT.design.y;
    expect(designY).toBe(ROW_DESIGN_Y);
    expect(designY - tierY).toBeGreaterThanOrEqual(340);
    // the four tiers share one row; design + plan share the row below it
    expect(STATION_AUTO_LAYOUT.validation.y).toBe(tierY);
    expect(STATION_AUTO_LAYOUT.plan.y).toBe(designY);
  });
});
