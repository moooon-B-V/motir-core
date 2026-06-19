# Type — Motir Mono (`data-type="motir-mono"`)

> A base-face variant registered in
> [`lib/theme/typography.ts`](../../lib/theme/typography.ts); its
> `[data-type='motir-mono']` block lives in
> [`app/globals.css`](../../app/globals.css). Built from the already-loaded
> faces — **zero new font payload**.

**Tagline:** Monospace throughout — a code-native UI, headlines, body and all.
**Faces:** JetBrains Mono headlines + body/UI + meta.

## Role mapping

| Role              | `--font-*` token | Motir Mono face                                     |
| ----------------- | ---------------- | --------------------------------------------------- |
| Headlines (xl+)   | `--font-serif`   | JetBrains Mono (re-pointed off the editorial serif) |
| Body / UI         | `--font-sans`    | JetBrains Mono                                      |
| Meta / code / IDs | `--font-mono`    | JetBrains Mono                                      |

## Why it exists

This pairing reproduces the monospace headline treatment the **Neo-Brutalism**
and **Cybercore / Y2K** styles used to set inside their own `[data-style]`
blocks. Type is the independent `data-type` axis now, so those overrides moved
here, and both styles ship `defaultTypeId: 'motir-mono'` — their out-of-the-box
looks are unchanged, and any style can now opt into mono headlines.

The `[data-type='motir-mono']` block re-points ONLY `--font-serif` (the headline
role) at the mono stack — no colour or shape token is touched (the disjointness
guard in `tests/theme/typographyRegistry.test.ts`).
