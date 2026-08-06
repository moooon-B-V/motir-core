import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import standaloneCode from 'ajv/dist/standalone';
import openapiTS, { astToString } from 'openapi-typescript';
import { emitOpenApiDocument, V1_API_MAJOR, V1_CONTRACT_VERSION } from '@/lib/api/v1/openapi/emit';

// The `@motir/cli` v1 client GENERATOR (Story 11.5 · Subtask 11.5.2 —
// MOTIR-2210), implementing `docs/decisions/cli-v1-client.md` Q1 and Q2.
//
// It turns ONE input — `emitOpenApiDocument()`, the same value the published
// `/api/openapi/v1.json` serves — into the three artifacts `packages/cli`
// compiles against:
//
//   packages/cli/src/api/schema.d.ts    the `paths` / `components` type tree
//   packages/cli/src/api/validators.js  Ajv validators, precompiled to plain JS
//   packages/cli/src/api/operations.ts  operationId → method, path, scope, …
//
// ── Why this script lives at the ROOT and not in `packages/cli` ─────────────
// Its input is app code behind the `@/` alias. A script inside `packages/cli`
// cannot resolve that, and a workspace package cannot depend on the app that
// depends on it without a cycle. `packages/cli` keeps a `generate:api` script
// that delegates here, so the command is discoverable from the package a reader
// is standing in. The ADR records this; the output still lands only under
// `packages/cli/src/api/`.
//
// ── Why it reads the EMITTER and not the URL ────────────────────────────────
// ADR Amendment 4's consequences list said 11.5 would generate "from the Q3
// URL". That sentence was written for an EXTERNAL generator, which has no other
// input. Ours would make `pnpm build` depend on a running Next server — in CI,
// and on a fresh clone. `cli-v1-client.md` Q2 narrows it, and pairs the
// narrowing with a guard (`tests/api/v1/openapi-spec-route.test.ts` asserts the
// served route's bytes equal the emitter's), so the public URL stays exactly
// what an integrator generates from.
//
// ── No network, no server, no database ─────────────────────────────────────
// `emitOpenApiDocument()` assembles the document from compile-time declarations.
// Running this twice produces byte-identical output, which is what makes the CI
// freshness guard (`tests/cli/generated-api-freshness.test.ts`) a real signal
// rather than a source of churn.

/** A JSON value, as the emitted document is made of. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/**
 * Where every generated artifact lands, relative to the repository root.
 * Nothing is written outside it.
 */
export const CLI_API_DIR = join('packages', 'cli', 'src', 'api');

/**
 * The base URI every generated schema is registered under.
 *
 * Ajv resolves `$ref` against registered `$id`s, and the document's own refs are
 * document-relative (`#/components/schemas/X`). Rather than rely on Ajv walking
 * a JSON pointer into a keyword it does not know (`components`), this generator
 * registers each component as its OWN schema under an absolute id and rewrites
 * every `$ref` to match. Explicit, and it cannot break on an Ajv internals
 * change.
 */
const SCHEMA_BASE = 'motir://v1/';

/** The absolute id a named component schema is registered under. */
function componentId(name: string): string {
  return `${SCHEMA_BASE}components/${name}`;
}

/** The absolute id an operation's SUCCESS body schema is registered under. */
function operationId(name: string): string {
  return `${SCHEMA_BASE}operations/${name}`;
}

/**
 * Rewrite every document-relative `$ref` to its absolute registered id.
 *
 * Deep, and structural rather than textual: a string that merely looks like a
 * ref (a description quoting one, say) is left alone because only the value of a
 * `$ref` key is touched.
 */
function absolutizeRefs(node: Json): Json {
  if (Array.isArray(node)) return node.map(absolutizeRefs);
  if (node === null || typeof node !== 'object') return node;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith('#/components/schemas/')) {
      out[key] = componentId(value.slice('#/components/schemas/'.length));
      continue;
    }
    out[key] = absolutizeRefs(value);
  }
  return out;
}

/** The HTTP methods an operation can be declared under. */
const HTTP_METHODS = ['get', 'post', 'patch', 'put', 'delete'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

/** One row of the generated operation table. */
interface OperationRow {
  operationId: string;
  method: Uppercase<HttpMethod>;
  path: string;
  scope: string;
  successStatus: number;
  /** The component name the success body is, when it is a plain component. */
  responseComponent: string | undefined;
}

/**
 * Walk the document's `paths` into a flat, SORTED operation table.
 *
 * Sorted by `operationId` so the emitted file is stable under any future change
 * to the registry's own ordering — the generator's determinism must not depend
 * on the input's incidental key order.
 */
function collectOperations(doc: JsonObject): {
  rows: OperationRow[];
  successSchemas: Map<string, Json>;
} {
  const rows: OperationRow[] = [];
  const successSchemas = new Map<string, Json>();
  const paths = (doc['paths'] ?? {}) as Record<string, Record<string, JsonObject>>;

  for (const [path, item] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!operation) continue;

      const id = operation['operationId'];
      const scope = operation['x-motir-scope'];
      if (typeof id !== 'string' || typeof scope !== 'string') {
        throw new Error(`${method.toUpperCase()} ${path}: missing operationId or x-motir-scope`);
      }

      const responses = (operation['responses'] ?? {}) as Record<string, JsonObject>;
      const successEntry = Object.entries(responses).find(([status]) => status.startsWith('2'));
      if (!successEntry) throw new Error(`${id}: no 2xx response declared`);
      const [successStatus, response] = successEntry;

      // A 204 declares no body at all (`deleteWorkItemLink`). That is a real
      // shape, not a gap: there is nothing to validate, so the operation gets a
      // row and no validator, and the transport must not look for one.
      const schema = (
        (response['content'] as JsonObject | undefined)?.['application/json'] as
          | JsonObject
          | undefined
      )?.['schema'];

      const ref = schema === undefined ? undefined : (schema as JsonObject)['$ref'];
      rows.push({
        operationId: id,
        method: method.toUpperCase() as Uppercase<HttpMethod>,
        path,
        scope,
        successStatus: Number(successStatus),
        responseComponent:
          typeof ref === 'string' && ref.startsWith('#/components/schemas/')
            ? ref.slice('#/components/schemas/'.length)
            : undefined,
      });
      if (schema !== undefined) successSchemas.set(id, schema);
    }
  }

  rows.sort((a, b) => a.operationId.localeCompare(b.operationId));
  return { rows, successSchemas };
}

/**
 * Compile every validator into ONE standalone ESM module.
 *
 * ⚠️ All schemas go onto ONE `Ajv2020` instance before anything is compiled.
 * The emitter composes a paged response as
 * `allOf: [$ref PageEnvelope, { items: … }]`, so a validator compiled against
 * only its own schema cannot resolve its envelope. One instance, everything
 * registered, then a single `standaloneCode` call.
 *
 * ⚠️ `ajv-formats` is deliberately NOT installed (ADR Q1). Unknown `format`
 * keywords are annotations Ajv ignores — and it costs nothing here, because
 * `z.toJSONSchema()` emits a `pattern` ALONGSIDE every `format` it produces
 * (see `Sprint.startDate`), so the shape is enforced by the pattern either way.
 */
function compileValidators(
  components: Record<string, Json>,
  successSchemas: Map<string, Json>,
): string {
  const ajv = new Ajv2020({
    // Emit source instead of evaluating: this is what "standalone" means, and
    // it is why the published tarball ships no validator library.
    code: { source: true, esm: true },
    // The document is OpenAPI, not pure JSON Schema: it carries annotation
    // keywords (`example`, `x-motir-scope`) that are not validation keywords.
    // Strict mode would reject the document for describing itself.
    strictSchema: false,
    // FIRST failure only (Ajv's default), stated explicitly because it is a
    // size decision: `allErrors` roughly triples the generated source, and the
    // CLI's shape error names ONE field. The first field that does not match is
    // the field to report.
    allErrors: false,
    // `date-time` is the only `format` the document uses, and `z.toJSONSchema()`
    // emits a `pattern` beside it that enforces the same shape (see
    // `Sprint.startDate`). Registering it as a no-op keeps ADR Q1's "ignored,
    // explicitly" decision visible in code AND silences Ajv's per-occurrence
    // warning, which would otherwise be the loudest thing this script prints.
    formats: { 'date-time': true },
  });

  for (const [name, schema] of Object.entries(components)) {
    ajv.addSchema({ ...(absolutizeRefs(schema) as JsonObject), $id: componentId(name) });
  }
  for (const [id, schema] of successSchemas) {
    ajv.addSchema({ ...(absolutizeRefs(schema) as JsonObject), $id: operationId(id) });
  }

  // ⚠️ Only the OPERATION schemas are exported as validators, not the components
  // as well. The components are registered so `$ref` resolves, and every one of
  // them IS some operation's success body — exporting both would compile each
  // shape twice and double a file that is already the largest thing this
  // generator writes. The transport validates by `operationId`, which is what it
  // has at the call site anyway.
  const exports: Record<string, string> = {};
  for (const id of [...successSchemas.keys()].sort()) exports[`operation_${id}`] = operationId(id);

  return standaloneCode(ajv, exports);
}

/** The banner every generated file carries. */
function banner(kind: string): string {
  return [
    '/**',
    ` * ${kind}`,
    ' *',
    ' * ⚠️ GENERATED FILE — DO NOT EDIT BY HAND.',
    ' *',
    ' * Regenerate with `pnpm generate:cli-api` from the repository root (or',
    ' * `pnpm --filter @motir/cli generate:api`, which delegates to it). CI',
    ' * regenerates and fails on any diff, so a hand edit cannot survive a PR.',
    ' *',
    ' * Source: `emitOpenApiDocument()` in `lib/api/v1/openapi/emit.ts` — the same',
    ' * value `/api/openapi/v1.json` serves. See `docs/decisions/cli-v1-client.md`.',
    ' */',
    '',
  ].join('\n');
}

/** Render `operations.ts`, the hand-readable half of the generated set. */
function renderOperations(rows: OperationRow[]): string {
  const rowSource = rows
    .map((row) => {
      const component =
        row.responseComponent === undefined ? 'undefined' : JSON.stringify(row.responseComponent);
      return [
        `  ${JSON.stringify(row.operationId)}: {`,
        `    method: ${JSON.stringify(row.method)},`,
        `    path: ${JSON.stringify(row.path)},`,
        `    scope: ${JSON.stringify(row.scope)},`,
        `    successStatus: ${row.successStatus},`,
        `    responseComponent: ${component},`,
        `  },`,
      ].join('\n');
    })
    .join('\n');

  return [
    banner('The `/api/v1` operation table, as `@motir/cli` sees it.'),
    '/** One declared operation: how to call it, and what it answers with. */',
    'export interface V1OperationRow {',
    '  /** The HTTP verb. */',
    "  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';",
    '  /** The path template, dynamic segments as `{name}`. */',
    '  readonly path: string;',
    '  /**',
    '   * The token scope this operation requires.',
    '   *',
    "   * Read off the document's `x-motir-scope` extension, which the server",
    "   * emits from `lib/mcp/scopes.ts`. This is where the CLI's 403 message gets",
    "   * the scope name — never by parsing the server's English sentence.",
    '   */',
    '  readonly scope: string;',
    '  /** The 2xx status the happy path returns. */',
    '  readonly successStatus: number;',
    '  /**',
    '   * The component the success body IS, when it is a plain resource.',
    '   * `undefined` for a paged response, whose body is an envelope composition',
    '   * rather than one named component.',
    '   */',
    '  readonly responseComponent: string | undefined;',
    '}',
    '',
    '/**',
    ' * The API MAJOR this client was generated against — the path version.',
    ' *',
    ' * A server serving a different major serves a different document at a',
    ' * different URL (ADR Amendment 4 Q6), so a mismatch here is not a degraded',
    ' * mode, it is a different API.',
    ' */',
    `export const API_MAJOR = ${V1_API_MAJOR};`,
    '',
    '/**',
    " * The contract version this client was generated against — `info.version`'s",
    " * `MAJOR.MINOR.PATCH`, NOT the deployment's release number.",
    ' *',
    " * The version-skew gate compares a server's number against THIS. Within a",
    ' * major, ADR §8 promises additive-only, so a server at or above this is',
    ' * compatible by construction and only a server BELOW it can be missing',
    ' * something this client was generated to expect.',
    ' */',
    `export const GENERATED_AGAINST = ${JSON.stringify(V1_CONTRACT_VERSION)};`,
    '',
    '/** Every declared operation, keyed by `operationId`. */',
    'export const V1_OPERATIONS = {',
    rowSource,
    '} as const satisfies Record<string, V1OperationRow>;',
    '',
    '/** The `operationId`s, as a union. */',
    'export type V1OperationId = keyof typeof V1_OPERATIONS;',
    '',
  ].join('\n');
}

/** Render `validators.d.ts` — the types over Ajv's untyped standalone output. */
function renderValidatorTypes(operations: string[]): string {
  const declare = (name: string) => `export declare const ${name}: ValidateFunction;`;
  return [
    banner('Types for the precompiled Ajv validators.'),
    '/** One error Ajv reports. `instancePath` is the field the CLI names. */',
    'export interface ValidationError {',
    '  readonly instancePath: string;',
    '  readonly schemaPath: string;',
    '  readonly keyword: string;',
    '  readonly message?: string;',
    '  readonly params: Record<string, unknown>;',
    '}',
    '',
    '/** A precompiled validator: a type guard carrying its own errors. */',
    'export interface ValidateFunction {',
    '  (data: unknown): boolean;',
    '  errors?: ValidationError[] | null;',
    '}',
    '',
    "/** Validators for each operation's 2xx response body, keyed by operationId. */",
    ...operations.map((id) => declare(`operation_${id}`)),
    '',
  ].join('\n');
}

/** Render `index.ts` — the ONE module boundary the rest of the CLI imports. */
function renderIndex(): string {
  return [
    banner('The generated v1 client surface — the one boundary the CLI imports.'),
    '/**',
    ' * Everything generated is re-exported HERE, so no file outside this',
    ' * directory reaches into a generated internal. `docs/decisions/cli-v1-client.md`',
    ' * Q4 adds the other half of the rule: only `src/transport.ts` and',
    ' * `src/adapters/` may import from this directory at all.',
    ' */',
    "export type { components, operations, paths } from './schema';",
    "export * from './operations';",
    "export * as validators from './validators';",
    "export type { ValidateFunction, ValidationError } from './validators';",
    '',
  ].join('\n');
}

/** The generated artifacts, keyed by their file name within `CLI_API_DIR`. */
export type GeneratedArtifacts = Record<string, string>;

/**
 * Produce every generated artifact IN MEMORY, from the emitter alone.
 *
 * Pure with respect to the filesystem: it reads nothing and writes nothing, so
 * the freshness guard can call it and compare, and `scripts/generate-cli-api.ts`
 * can call it and write. No network, no server, no database — the whole input is
 * `emitOpenApiDocument()`, which assembles the document from compile-time
 * declarations, so two calls produce byte-identical output.
 */
export async function generateCliApi(): Promise<GeneratedArtifacts> {
  const doc = emitOpenApiDocument() as unknown as JsonObject;
  const components = ((doc['components'] as JsonObject | undefined)?.['schemas'] ?? {}) as Record<
    string,
    Json
  >;
  const { rows, successSchemas } = collectOperations(doc);

  const types = astToString(await openapiTS(doc as never));
  const validators = compileValidators(components, successSchemas);

  return {
    'schema.d.ts': `${banner('The `/api/v1` wire types.')}${types}`,
    'validators.js': `${banner('Precompiled Ajv validators.')}${validators}`,
    'validators.d.ts': renderValidatorTypes([...successSchemas.keys()].sort()),
    'operations.ts': renderOperations(rows),
    'index.ts': renderIndex(),
  };
}

/**
 * The names of the artifacts whose COMMITTED bytes differ from freshly
 * generated ones — sorted, and empty when the checkout is fresh.
 *
 * This is the freshness guard's whole judgement, exposed as a function so the
 * guard can be driven with a deliberately stale artifact rather than trusted.
 * A file the generator produces and the repository does not have counts as
 * stale, which is what makes "someone deleted it" fail rather than pass.
 */
export function staleArtifacts(
  generated: GeneratedArtifacts,
  committed: GeneratedArtifacts,
): string[] {
  return Object.keys(generated)
    .filter((name) => committed[name] !== generated[name])
    .sort();
}

/** Read the committed artifacts from a checkout, for `staleArtifacts`. */
export async function readCommittedArtifacts(
  repoRoot: string,
  names: readonly string[],
): Promise<GeneratedArtifacts> {
  const entries = await Promise.all(
    names.map(async (name) => {
      try {
        return [name, await readFile(join(repoRoot, CLI_API_DIR, name), 'utf8')] as const;
      } catch {
        // Absent counts as stale, not as an error to swallow: a missing
        // artifact must fail the guard the same way a stale one does.
        return [name, undefined] as const;
      }
    }),
  );
  return Object.fromEntries(
    entries.filter((e): e is readonly [string, string] => e[1] !== undefined),
  );
}
