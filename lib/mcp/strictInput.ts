import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// The UNKNOWN-ARGUMENT GATE at the MCP registration seam (bug MOTIR-3342).
//
// ── What was wrong ─────────────────────────────────────────────────────────
// Every tool declares its arguments as a Zod RAW SHAPE and hands it to
// `server.registerTool(..., { inputSchema }, ...)`. The SDK wraps that shape
// with `z.object(shape)` (`server/zod-compat.ts`'s `objectFromShape`) and
// validates each call against it — and a Zod object's DEFAULT `unknownKeys`
// mode is `strip`, which silently DELETES a key it does not recognise. The
// same object is then rendered to JSON Schema for `tools/list`, where it
// publishes `"additionalProperties": false` — a promise that an unknown key is
// an ERROR.
//
// So the advertised contract and the runtime disagreed by construction, for
// every tool, and the direction of the disagreement was the harmful one: a card
// filed with `description` instead of `descriptionMd` lost its whole body and
// the caller was told `Patched: nothing` under a SUCCESS result. Three bug
// cards (MOTIR-3283 / MOTIR-3313 / MOTIR-3334) were filed with long,
// evidence-carrying bodies and landed as titles only.
//
// ── The fix ────────────────────────────────────────────────────────────────
// One seam, all tools: a Proxy over `McpServer` that rewrites each tool's
// `inputSchema` before it reaches the SDK, turning every `strip` object in the
// tree into a `strict` one. The published `additionalProperties: false` then
// describes what actually happens, and an unknown key is refused with a
// JSON-RPC `-32602` that NAMES it (and the nearest valid field, when there is
// one) instead of vanishing.
//
// This is deliberately a REGISTRATION-time transform rather than a check in the
// tool callback: by the time a callback runs the SDK has already parsed — and
// stripped — the arguments, so the unknown key is no longer observable there.
// It is also why the rule cannot be per-tool: the class is per-TOOL, not
// per-field, so special-casing `description` would leave `linkType` and every
// future rename open.
//
// ── What it deliberately does NOT touch ────────────────────────────────────
// A `.passthrough()` object keeps passing keys through, and a `.catchall()`
// object keeps its catchall. Those are DECISIONS someone made — `authorPlan`'s
// `patchSchema` is `.passthrough()` precisely so "this schema can never become
// the reason a field the service already understands stops arriving"
// (MOTIR-3111). Only `strip` — the default nobody chose — becomes `strict`.

/** The Zod first-party kinds this transform descends through. Anything else is
 * returned untouched: the goal is to close the silent-strip hole, not to
 * re-author schemas. */
type AnySchema = z.ZodTypeAny;

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Levenshtein distance, bounded by the shorter of the two words' length + 1.
 * Small inputs (argument names), so the plain DP table is the right shape. */
function editDistance(a: string, b: string): number {
  const row: number[] = [];
  for (let j = 0; j <= b.length; j += 1) row[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j] as number;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(above + 1, (row[j - 1] as number) + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return row[b.length] as number;
}

/**
 * The valid field `unknown` was most likely meant to be, or `null` when nothing
 * is close enough to name. A PREFIX relationship wins outright — that is the
 * shape of the failure this bug is about (`description` → `descriptionMd`) —
 * and otherwise a small edit distance, scaled to the word's length so short
 * names don't match everything.
 *
 * Exported for the unit test: the suggestion is the half a caller actually
 * reads, so it is asserted directly rather than only through a tool call.
 */
export function nearestField(unknown: string, valid: readonly string[]): string | null {
  const needle = unknown.toLowerCase();
  let best: { key: string; distance: number } | null = null;
  for (const key of valid) {
    const candidate = key.toLowerCase();
    const prefix = candidate.startsWith(needle) || needle.startsWith(candidate);
    const distance = prefix ? 0 : editDistance(needle, candidate);
    const limit = Math.max(2, Math.floor(Math.max(needle.length, candidate.length) / 3));
    if (distance > limit) continue;
    if (!best || distance < best.distance) best = { key, distance };
  }
  return best?.key ?? null;
}

/**
 * The message an `unrecognized_keys` rejection carries. It names every offending
 * key, the nearest valid field for each one that has a plausible neighbour, and
 * the full accepted set — so a caller self-corrects in one hop instead of
 * re-reading the tool's schema.
 */
export function unknownKeyMessage(keys: readonly string[], valid: readonly string[]): string {
  const named = keys
    .map((key) => {
      const near = nearestField(key, valid);
      return near ? `"${key}" (did you mean "${near}"?)` : `"${key}"`;
    })
    .join(', ');
  const noun = keys.length === 1 ? 'argument' : 'arguments';
  return (
    `Unknown ${noun} ${named}. This tool accepts only: ${valid.join(', ')}. ` +
    'Unknown arguments are refused rather than dropped, so a value sent under the wrong ' +
    'name is never silently lost.'
  );
}

/** A schema-level error map that replaces Zod's terse `Unrecognized key(s)…`
 * with {@link unknownKeyMessage}, and leaves every other issue alone. */
function unknownKeyErrorMap(valid: readonly string[]): z.ZodErrorMap {
  return (issue, ctx) => {
    if (issue.code === z.ZodIssueCode.unrecognized_keys) {
      return { message: unknownKeyMessage(issue.keys, valid) };
    }
    return { message: ctx.defaultError };
  };
}

/**
 * Rewrite `schema` so every `strip` object in it becomes `strict`, recursing
 * through the wrappers our tool schemas actually use. Rebuilt through each
 * class's own `_def` so descriptions, refinements, array bounds and defaults
 * survive the transform untouched.
 *
 * Exported for the unit test — the transform is the whole fix, so it is
 * exercised directly as well as through the wired server.
 */
export function strictifyUnknownKeys(schema: AnySchema): AnySchema {
  const def = schema._def as any;
  switch (def?.typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = def.shape() as z.ZodRawShape;
      const nextShape: z.ZodRawShape = {};
      for (const [key, value] of Object.entries(shape)) {
        nextShape[key] = strictifyUnknownKeys(value);
      }
      // A catchall or an explicit `.passthrough()` is a decision; only the
      // default `strip` — which nobody chose — is promoted to `strict`.
      const chosen = !(def.catchall instanceof z.ZodNever) || def.unknownKeys !== 'strip';
      return new z.ZodObject({
        ...def,
        shape: () => nextShape,
        unknownKeys: chosen ? def.unknownKeys : 'strict',
        errorMap: def.errorMap ?? unknownKeyErrorMap(Object.keys(shape)),
      });
    }
    case z.ZodFirstPartyTypeKind.ZodArray:
      return new z.ZodArray({ ...def, type: strictifyUnknownKeys(def.type) });
    case z.ZodFirstPartyTypeKind.ZodOptional:
      return new z.ZodOptional({ ...def, innerType: strictifyUnknownKeys(def.innerType) });
    case z.ZodFirstPartyTypeKind.ZodNullable:
      return new z.ZodNullable({ ...def, innerType: strictifyUnknownKeys(def.innerType) });
    case z.ZodFirstPartyTypeKind.ZodDefault:
      return new z.ZodDefault({ ...def, innerType: strictifyUnknownKeys(def.innerType) });
    case z.ZodFirstPartyTypeKind.ZodUnion:
      return new z.ZodUnion({
        ...def,
        options: (def.options as AnySchema[]).map(strictifyUnknownKeys),
      });
    default:
      return schema;
  }
}

/** True when `value` is a Zod RAW SHAPE — the `{ field: zodSchema }` record the
 * tools declare — rather than an already-constructed schema. An EMPTY record is
 * a raw shape too (`whoami` / `list_projects` take no arguments). */
function isRawShape(value: unknown): value is z.ZodRawShape {
  if (typeof value !== 'object' || value === null) return false;
  if ((value as any)._def !== undefined || (value as any)._zod !== undefined) return false;
  return Object.values(value).every((member) => member instanceof z.ZodType);
}

/**
 * Turn a tool's declared `inputSchema` into one that REFUSES an unknown
 * argument instead of dropping it. Raw shapes (what every tool declares) are
 * wrapped into a strict object; an already-constructed schema is strictified in
 * place; anything unrecognised is returned untouched so a future tool shape can
 * never be broken by this seam.
 */
export function strictInputSchema(inputSchema: unknown): unknown {
  if (isRawShape(inputSchema)) {
    const keys = Object.keys(inputSchema);
    const nextShape: z.ZodRawShape = {};
    for (const [key, value] of Object.entries(inputSchema)) {
      nextShape[key] = strictifyUnknownKeys(value);
    }
    return z.object(nextShape, { errorMap: unknownKeyErrorMap(keys) }).strict();
  }
  if (inputSchema instanceof z.ZodType) return strictifyUnknownKeys(inputSchema);
  return inputSchema;
}

/**
 * Wrap `server` so every `registerTool` call gets the strict input schema
 * above. Applied UNCONDITIONALLY in `registerMcpTools` — unlike the permission
 * and rate-limit gates, this is not a policy that some servers opt out of: a
 * tool that publishes `additionalProperties: false` and then strips is wrong on
 * every deployment, including the in-process tool tests.
 *
 * Every other `McpServer` member passes through untouched.
 */
export function strictInputServer(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'registerTool' || typeof value !== 'function') return value;
      const register = value as (...registerArgs: unknown[]) => unknown;
      // `registerTool(name, config, callback)` — rewrite the config's schema
      // (the second argument); the name and the callback pass through.
      return (...registerArgs: unknown[]) => {
        const config = registerArgs[1] as { inputSchema?: unknown } | undefined;
        if (!config || !('inputSchema' in config)) return register.apply(target, registerArgs);
        const next = [...registerArgs];
        next[1] = { ...config, inputSchema: strictInputSchema(config.inputSchema) };
        return register.apply(target, next);
      };
    },
  });
}

/* eslint-enable @typescript-eslint/no-explicit-any */
