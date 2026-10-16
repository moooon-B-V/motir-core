// The type of the inventory manifest, so the checker never parses its JSON
// (MOTIR-8405's sidecar pattern; `tsconfig.base.json` explains why).
import type { FleetJobInventory } from './fleetJobInventoryTypes';

declare const inventory: FleetJobInventory;
export default inventory;
