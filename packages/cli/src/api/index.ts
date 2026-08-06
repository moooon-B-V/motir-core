/**
 * The generated v1 client surface — the one boundary the CLI imports.
 *
 * ⚠️ GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Regenerate with `pnpm generate:cli-api` from the repository root (or
 * `pnpm --filter @motir/cli generate:api`, which delegates to it). CI
 * regenerates and fails on any diff, so a hand edit cannot survive a PR.
 *
 * Source: `emitOpenApiDocument()` in `lib/api/v1/openapi/emit.ts` — the same
 * value `/api/openapi/v1.json` serves. See `docs/decisions/cli-v1-client.md`.
 */

/**
 * Everything generated is re-exported HERE, so no file outside this
 * directory reaches into a generated internal. `docs/decisions/cli-v1-client.md`
 * Q4 adds the other half of the rule: only `src/transport.ts` and
 * `src/adapters/` may import from this directory at all.
 */
export type { components, operations, paths } from './schema';
export * from './operations';
export * as validators from './validators';
export type { ValidateFunction, ValidationError } from './validators';
