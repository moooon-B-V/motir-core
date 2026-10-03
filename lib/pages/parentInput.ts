import type { PageParentInput } from '@/lib/dto/pages';

// Parsing a page PARENT off the wire (Story MOTIR-5753 · MOTIR-7372) — the one
// place the `/api/pages` doors turn a request's parent into the service's
// `PageParentInput`, so the query form (`?parent=page:<id>`) and the body form
// (`{ kind, id }`) cannot disagree. Pure: no I/O.
//
// A SHAPE problem (not a string, a `folder`/`page` with no id) is `null` and the
// route answers 400. A kind the package does not know — `work_item:<id>` — is
// NOT a shape problem: it passes through so the package refuses it as
// `PAGE_PARENT_NOT_ALLOWED` (422), the one place that rule lives.

/** `root`, or `<kind>:<id>` → the parent, or `null` when malformed. */
export function parseParentParam(raw: string | null): PageParentInput | null {
  if (raw === null) return null;
  if (raw === 'root') return { kind: 'root' };
  const at = raw.indexOf(':');
  if (at <= 0) return null;
  const kind = raw.slice(0, at);
  const id = raw.slice(at + 1);
  if (id === '') return null;
  return { kind, id };
}

/** A body's `{ kind, id? }` → the parent, or `null` when malformed. */
export function parseParentBody(raw: unknown): PageParentInput | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { kind, id } = raw as { kind?: unknown; id?: unknown };
  if (typeof kind !== 'string' || kind === '') return null;
  if (kind === 'root') return { kind };
  if (typeof id !== 'string' || id === '') return null;
  return { kind, id };
}
