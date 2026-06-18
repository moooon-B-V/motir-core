# Type — Motir Sans (`data-type="motir-sans"`)

> A base-face variant registered in
> [`lib/theme/typography.ts`](../../lib/theme/typography.ts); its
> `[data-type='motir-sans']` block lives in
> [`app/globals.css`](../../app/globals.css). Built from the already-loaded
> faces — **zero new font payload**.

**Tagline:** All-sans — Inter for headlines and body; structural, no serif.
**Faces:** Inter headlines + body · JetBrains Mono meta.

## Role mapping

| Role              | `--font-*` token | Motir Sans face                            |
| ----------------- | ---------------- | ------------------------------------------ |
| Headlines (xl+)   | `--font-serif`   | Inter (re-pointed off the editorial serif) |
| Body / UI         | `--font-sans`    | Inter                                      |
| Meta / code / IDs | `--font-mono`    | JetBrains Mono                             |

## Why it exists

This pairing reproduces the all-sans headline treatment the **Swiss /
Minimal-Flat** style used to set inside its own `[data-style]` block. Type is
the independent `data-type` axis now, so that override moved here, and
`swiss-minimal-flat` ships `defaultTypeId: 'motir-sans'` — the out-of-the-box
Swiss look is unchanged, and any style can now opt into an all-sans pairing.

The `[data-type='motir-sans']` block re-points ONLY `--font-serif` (the headline
role) at the sans stack — no colour or shape token is touched (the disjointness
guard in `tests/theme/typographyRegistry.test.ts`).
