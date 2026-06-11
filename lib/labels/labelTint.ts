// Label chip tint (Story 5.4 · Subtask 5.4.8) — the recorded justified
// deviation from Jira's colourless labels (product owner, 2026-06-10): label
// chips are COLOURED, the tint auto-assigned deterministically from the label
// name. FNV-1a over the lowercased name, mod 6, into the existing
// `--el-tint-*` pastel family — the seed-loader hash family, so the same
// label renders the same colour on every surface (rail card, picker chips,
// option-row swatches, future board/filter chips) with NO colour column, NO
// picker, NO admin. `--el-text-strong` text on the tint background keeps AA
// (finding #35). User-PICKED colours are the documented extension (a `color`
// column + picker would override this default additively).
//
// Pure + dependency-free so the Epic-6 facet surfaces (filter chips, saved
// views) can reuse it beside the MultiSelectPicker.

export const LABEL_TINTS = ['peach', 'rose', 'mint', 'lavender', 'sky', 'yellow'] as const;

/** One of the six `--el-tint-*` pastel token names. */
export type LabelTint = (typeof LABEL_TINTS)[number];

/** FNV-1a — the seed-loader's deterministic string hash (32-bit). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The tint for a label name. Hashes the LOWERCASED name (the server's
 * case-insensitive identity, `nameLower`) so 'PERF-Q3' and 'perf-q3' — the
 * same label — always share a colour.
 */
export function labelTint(name: string): LabelTint {
  // The modulo keeps the index in range; `?? 'peach'` only satisfies
  // noUncheckedIndexedAccess.
  return LABEL_TINTS[fnv1a(name.toLowerCase()) % LABEL_TINTS.length] ?? 'peach';
}
