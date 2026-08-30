import { unstable_isUnrecognizedActionError } from 'next/navigation';

// What a REJECTED Server Action means to the person who was editing (MOTIR-3948).
//
// A write through a Server Action can end THREE ways, and the two optimistic
// write surfaces (`QuickViewRailEdit`, `IssueInlineEdit`) were built for two of
// them: the server ACCEPTED it (`{ ok: true }`) or the server REFUSED it
// (`{ ok: false, error }`). The third is that the call never reached a server
// that recognised it, and then the action PROMISE REJECTS — no result to read,
// nothing to route through the refusal path.
//
// The dominant cause is not a network blip, which is why the two arms below are
// worth separating. Next salts every Server Action id with the build's own
// encryption key, so a tab loaded before a deploy posts ids the new build does
// not have; the server answers `404` with `x-nextjs-action-not-found` and Next's
// client turns that into an `UnrecognizedActionError`. Nothing is wrong with the
// page except its AGE, and the only repair is a reload — so telling that reader
// to "check your connection and try again" sends them to retry a write that
// cannot succeed until they reload.
//
// `unstable_isUnrecognizedActionError` is Next's own predicate for exactly this
// (`next/navigation`); it is deliberately not re-derived from the error's `name`,
// which would drift the moment Next renames the class.
export type ServerActionRejectionKey = 'actionSkewError' | 'actionTransportError';

/**
 * The `issueViews` message key a rejected Server Action earns: the RELOAD
 * message when the build no longer knows the action, else the generic
 * try-again one.
 */
export function serverActionRejectionKey(err: unknown): ServerActionRejectionKey {
  return unstable_isUnrecognizedActionError(err) ? 'actionSkewError' : 'actionTransportError';
}
