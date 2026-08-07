// The ONE escape used anywhere a literal string is interpolated into a
// `new RegExp(...)` (MOTIR-2418). Before this file the codebase carried seven
// hand-rolled character classes, each enumerating the metacharacters its own
// author happened to think of — `[()/.]` for a file path, `[-]` for a CSS
// token, `\/` for a URL path. Every one of them omitted the backslash, which is
// the first character an escaper has to handle: an unescaped `\` re-arms
// whatever follows it, so `a\d` stops being a literal and starts matching a
// digit. CodeQL flags exactly that (`js/incomplete-sanitization`), and the
// alerts sat open on `main` long enough to be attributed to unrelated PRs.
//
// The class below is the complete set of ECMAScript regex metacharacters, plus
// `/` — which needs no escape inside a `RegExp` constructor string but is
// harmless there (`\/` matches `/`) and keeps the output identical to what the
// call sites produced before. `$&` is the whole match, so each metacharacter is
// replaced by itself preceded by a backslash.

/**
 * Escape `value` so it matches itself literally when interpolated into a
 * `new RegExp(...)` pattern.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
