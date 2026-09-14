'use client';

import { ParentBreadcrumb } from './ParentBreadcrumb';
import { usePlacement } from './PlacementProvider';

// The page eyebrow's breadcrumb, fed by the placement channel (Story MOTIR-5309 ·
// MOTIR-5381) so it repaints in place after the rail moves the item. The drawing
// itself stays `ParentBreadcrumb`, which renders exactly as before for an unfiled
// item.
export function PlacementBreadcrumb() {
  const placement = usePlacement();
  if (!placement) return null;
  return (
    <ParentBreadcrumb ancestors={placement.ancestors} placementFolder={placement.placementFolder} />
  );
}
