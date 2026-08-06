import { join, relative, sep } from 'node:path';
import type { ZodObject, ZodType } from 'zod/v4';
import { v1PageEnvelopeSchema, v1RankedPageEnvelopeSchema } from '@/lib/api/v1/openapi/envelopes';
import { operationKey, type V1Operation } from '@/lib/api/v1/openapi/operation';
import { declaredScopeByMethod } from './v1RouteAudit';

// The route↔spec CONFORMANCE rules (Story 11.4 · Subtask 11.4.6 — MOTIR-2187).
//
// The rules live in a helper, not inline in the suite, for the reason
// `tests/helpers/v1RouteAudit.ts` gives about its own: each must be run against
// TWO inputs — the real tree and the real registry (does the product hold?) and
// a deliberately-violating synthetic pair (does the rule actually catch it?).
// A guard that has never been shown to fail is not a guard.
//
// Drift 3 — a real response that no longer matches its declared schema — is NOT
// here: it needs a real request, a real token and a real database, so it lives
// in the suite where the shipped fixtures are. What IS here is the bookkeeping
// that keeps drift 3 honest: `unexercisedOperations` fails when an operation is
// neither driven nor listed as undrivable WITH A REASON, so a quietly-skipped
// operation cannot read like a covered one.

/** One route↔spec disagreement. */
export interface SpecDrift {
  rule: 'route-without-operation' | 'operation-without-route' | 'scope-mismatch';
  /** The `METHOD /path` the drift is about. */
  subject: string;
  detail: string;
}

/** A route method as discovered by walking the tree. */
export interface ShippedRouteMethod {
  method: string;
  /** The OpenAPI path template — `/api/v1/work-items/{key}`. */
  path: string;
  /** The repo-relative route file it came from. */
  file: string;
  /** The scope its `withV1Route` call declares, or `undefined` if unreadable. */
  scope: string | undefined;
}

/**
 * Turn a route FILE path into the OpenAPI path template Next.js serves it from.
 *
 * `app/api/v1/work-items/[key]/route.ts` → `/api/v1/work-items/{key}`.
 */
export function pathTemplateForRouteFile(routeFile: string): string {
  const segments = relative('app', routeFile)
    .split(sep)
    .slice(0, -1)
    .map((segment) => (segment.startsWith('[') ? `{${segment.slice(1, -1)}}` : segment));
  return `/${segments.join('/')}`;
}

/**
 * Every (method, path, scope) the given route sources actually export.
 *
 * Takes the sources rather than reading them, so the caller can pass the real
 * tree OR a synthetic file that does not exist on disk — which is what makes
 * drifts 1 and 2 provable.
 */
export function shippedRouteMethods(sources: ReadonlyMap<string, string>): ShippedRouteMethod[] {
  const found: ShippedRouteMethod[] = [];
  for (const [file, source] of sources) {
    for (const [method, scope] of declaredScopeByMethod(source)) {
      found.push({ method, path: pathTemplateForRouteFile(file), file, scope });
    }
  }
  return found;
}

/**
 * Compare the shipped route tree against the declared operations.
 *
 * Returns every disagreement, in a stable order, so a failure names WHAT is
 * wrong rather than only that something is.
 */
export function findSpecDrift(
  routes: readonly ShippedRouteMethod[],
  operations: readonly V1Operation[],
): SpecDrift[] {
  const drifts: SpecDrift[] = [];
  const declared = new Map(operations.map((operation) => [operationKey(operation), operation]));
  const shipped = new Set(routes.map((route) => `${route.method} ${route.path}`));

  // ── Drift 1: a route the document does not describe ──────────────────────
  // The drift that turns a "complete" reference into a partial one, and the one
  // a reader cannot detect from the document alone.
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    const operation = declared.get(key);
    if (!operation) {
      drifts.push({
        rule: 'route-without-operation',
        subject: key,
        detail: `${route.file} exports ${route.method} but no operation declares it`,
      });
      continue;
    }
    // ── Scope mismatch: the document lies about a permission ───────────────
    // Not one of the card's three named drifts, but the same class and free to
    // check here: ADR Amendment 4 Q2 keeps the registry as an independent
    // second opinion on the scope the route enforces, and an opinion nothing
    // compares is not one.
    if (operation.scope !== route.scope) {
      drifts.push({
        rule: 'scope-mismatch',
        subject: key,
        detail: `route declares scope "${route.scope ?? '(unreadable)'}", the document says "${operation.scope}"`,
      });
    }
  }

  // ── Drift 2: an operation the routes do not serve ────────────────────────
  // Worse than an omission: a client builds against it and gets a 404.
  for (const operation of operations) {
    const key = operationKey(operation);
    if (!shipped.has(key)) {
      drifts.push({
        rule: 'operation-without-route',
        subject: key,
        detail: `operation "${operation.operationId}" names a route no file serves`,
      });
    }
  }

  return drifts.sort((a, b) => a.subject.localeCompare(b.subject) || a.rule.localeCompare(b.rule));
}

/**
 * The operations drift 3 neither DROVE nor excused.
 *
 * The card's "no silent caps" rule, mechanised: an operation that is neither
 * exercised against a real response nor listed as undrivable **with a written
 * reason** is reported here, so a quietly-skipped operation cannot read like a
 * covered one. An excuse with an empty reason counts as no excuse.
 */
export function unexercisedOperations(
  operations: readonly V1Operation[],
  exercised: ReadonlySet<string>,
  undrivable: Readonly<Record<string, string>>,
): string[] {
  return operations
    .map((operation) => operation.operationId)
    .filter((id) => !exercised.has(id) && (undrivable[id] ?? '').trim() === '')
    .sort();
}

/** An `undrivable` entry naming an operation the registry does not have. */
export function staleUndrivableEntries(
  operations: readonly V1Operation[],
  undrivable: Readonly<Record<string, string>>,
): string[] {
  const ids = new Set(operations.map((operation) => operation.operationId));
  return Object.keys(undrivable)
    .filter((id) => !ids.has(id))
    .sort();
}

/** Read a route file's repo-relative path into the map `shippedRouteMethods` takes. */
export function routeSourceKey(repoRoot: string, absolute: string): string {
  return relative(repoRoot, absolute);
}

/** Build the `app/…/route.ts` path a synthetic drift-1 fixture needs. */
export function syntheticRouteFile(...segments: string[]): string {
  return join('app', 'api', 'v1', ...segments, 'route.ts');
}

/**
 * The schema a REAL response for this operation must validate against —
 * the resource shape wrapped in whichever envelope the operation declares.
 *
 * Lives here rather than in the suite so drift 3's negative proof can call it
 * with a MUTATED operation and watch it fail, which is the only way to know the
 * check has teeth.
 */
export function responseSchemaFor(operation: V1Operation): ZodType | undefined {
  const body = operation.response.body;
  switch (body.kind) {
    case 'empty':
      return undefined;
    case 'object':
      return body.schema;
    case 'page':
      return v1PageEnvelopeSchema(body.item);
    case 'rankedPage': {
      const envelope = v1RankedPageEnvelopeSchema(body.item);
      // A ranked page may EXTEND the envelope with fields belonging to its own
      // read (ADR Amendment 12). The envelope is `.strict()`, so an extension
      // the emitter publishes but this builder does not know about makes every
      // real response fail here — which is exactly how the drift guard caught
      // `totalComments` / `totalChanges` being added on one side only.
      if (!body.extend) return envelope;
      return envelope.extend((body.extend as unknown as ZodObject).shape);
    }
  }
}
