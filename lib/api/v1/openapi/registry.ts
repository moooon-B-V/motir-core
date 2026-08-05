import type { z } from 'zod/v4';
import { operationKey, type V1Operation } from '@/lib/api/v1/openapi/operation';
import { WORK_ITEM_COMPONENTS, WORK_ITEM_OPERATIONS } from '@/lib/api/v1/workItems/operations';

// The v1 OPERATION REGISTRY (Story 11.4 · Subtask 11.4.4 — MOTIR-2185).
//
// One assembly point over the per-resource `operations.ts` modules — the shape
// ADR Amendment 4 Q2 pins, and the same one `lib/mcp/registry.ts` uses for MCP
// tools: the declarations live with the thing they describe, and exactly one
// value knows the whole set.
//
// ⚠️ INCOMPLETE BY DESIGN, for now. Subtask 11.4.4 declares the work-item
// resource as the proving resource; projects, sprints, the backlog, the ready
// set, workspaces and `/me` are Subtask 11.4.5's, and the route↔spec totality
// guard that would FAIL on the gap is Subtask 11.4.6's — deliberately after
// them, because a guard added before the set it guards is complete is a guard
// that ships red. The gap is named here rather than left to be noticed.

/** What one per-resource `operations.ts` module contributes. */
export interface V1ResourceModule {
  operations: readonly V1Operation[];
  components: Readonly<Record<string, z.ZodType>>;
}

/** Every resource module contributing to the document. */
const RESOURCE_MODULES: readonly V1ResourceModule[] = [
  { operations: WORK_ITEM_OPERATIONS, components: WORK_ITEM_COMPONENTS },
];

/**
 * Key the operations by `` `${METHOD} ${path}` ``, REFUSING a duplicate.
 *
 * Exported and pure so the refusal can be driven with a duplicate, the way
 * `tests/helpers/v1RouteAudit.ts`'s rules are driven with a violating source:
 * two modules claiming one operation is a real mistake (a resource moved and
 * its old declaration stayed), and a silent last-wins `Map.set` would hide it
 * behind a document that still looks complete.
 */
export function buildOperationRegistry(
  operations: readonly V1Operation[],
): ReadonlyMap<string, V1Operation> {
  const registry = new Map<string, V1Operation>();
  for (const operation of operations) {
    const key = operationKey(operation);
    if (registry.has(key)) {
      throw new Error(`duplicate v1 operation declared: ${key}`);
    }
    registry.set(key, operation);
  }
  return registry;
}

/**
 * Merge the modules' component schemas, REFUSING a duplicate NAME.
 *
 * Same discipline, sharper reason: two resources declaring different shapes
 * under one component name would emit a document in which one of them is
 * silently wrong — and `$ref` makes that wrongness invisible at every use site.
 */
export function mergeResourceComponents(
  modules: readonly V1ResourceModule[],
): Readonly<Record<string, z.ZodType>> {
  const components: Record<string, z.ZodType> = {};
  for (const resource of modules) {
    for (const [name, schema] of Object.entries(resource.components)) {
      if (name in components) {
        throw new Error(`duplicate v1 component schema declared: ${name}`);
      }
      components[name] = schema;
    }
  }
  return components;
}

/** Every declared operation, in resource order. */
export const V1_OPERATIONS: readonly V1Operation[] = RESOURCE_MODULES.flatMap(
  (resource) => resource.operations,
);

/** Every declared operation, keyed by `` `${METHOD} ${path}` ``. */
export const V1_OPERATION_REGISTRY: ReadonlyMap<string, V1Operation> =
  buildOperationRegistry(V1_OPERATIONS);

/** Every named component schema, merged across the resource modules. */
export const V1_RESOURCE_COMPONENTS: Readonly<Record<string, z.ZodType>> =
  mergeResourceComponents(RESOURCE_MODULES);

/** Look one operation up by verb and path. */
export function findV1Operation(method: string, path: string): V1Operation | undefined {
  return V1_OPERATION_REGISTRY.get(`${method} ${path}`);
}

/** The operationIds, for the uniqueness a code generator depends on. */
export function v1OperationIds(): string[] {
  return V1_OPERATIONS.map((operation) => operation.operationId);
}
