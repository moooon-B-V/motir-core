import { InvalidRequestError } from '@/lib/api/v1/errors';
import { FILTER_PARAM, decodeFilterParam } from '@/lib/filters/ast';
import type { FilterAst } from '@/lib/filters/ast';

// The `?filter=` decode, shared by the work-item COLLECTION and its COUNT
// (ADR Amendment 11 · MOTIR-2318).
//
// It lived inside the collection route until the count arrived beside it. Two
// routes that must narrow by the same filter cannot each own a copy of the
// decode: the codes below are contract — a client branches on
// `UNSUPPORTED_FILTER_VERSION` to know it should upgrade rather than re-encode —
// and a second copy is a second place for one of them to drift or be forgotten.
//
// The count's whole promise is that it counts what the collection would page,
// and that promise starts here, at the point where a filter becomes an AST.

/**
 * Decode `?filter=` into the AST the service takes, or `{}` when absent.
 *
 * A decode failure is a **422 with a stable code**, distinguishing the two
 * causes a client can actually act on differently: a param that is not a filter
 * at all (`INVALID_FILTER`) versus one written against a version this API does
 * not speak (`UNSUPPORTED_FILTER_VERSION` — the signal to upgrade, not to
 * re-encode). Deeper failures (unknown field, unknown operator, bad value, over
 * the row cap) are raised by `validateFilterAst` beneath the service and carry
 * their own codes into `DOMAIN_ERROR_STATUS`.
 */
export function parseFilterParam(req: Request): { filter?: { ast: FilterAst } } {
  const raw = new URL(req.url).searchParams.get(FILTER_PARAM);
  if (raw === null || raw === '') return {};

  const decoded = decodeFilterParam(raw);
  if (!decoded.ok) {
    if (decoded.reason === 'unsupported-version') {
      throw new InvalidRequestError(
        'UNSUPPORTED_FILTER_VERSION',
        `The \`filter\` parameter uses an unsupported version: ${decoded.detail}.`,
      );
    }
    if (decoded.reason === 'too-large') {
      // The SAME code the registry's `FilterTooLargeError` maps to, so an
      // over-cap filter reports identically whether the codec catches it (the
      // URL carrier) or `validateFilterAst` does (any other path).
      throw new InvalidRequestError(
        'FILTER_TOO_LARGE',
        `The \`filter\` parameter is ${decoded.detail}.`,
      );
    }
    throw new InvalidRequestError(
      'INVALID_FILTER',
      'The `filter` parameter is not a valid encoded filter.',
    );
  }
  return { filter: { ast: decoded.ast } };
}
