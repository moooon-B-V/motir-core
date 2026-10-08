# Font set — Simplified Chinese (`zh-Hans`)

> One of the four font sets in the registry
> [`packages/design-system/src/theme/fontSets.ts`](../../../packages/design-system/src/theme/fontSets.ts)
> (MOTIR-7843). The research behind it is
> [`docs/typography/font-sets.md`](../font-sets.md) (MOTIR-7841).

**Covers:** Han characters in Simplified Chinese forms, drawn behind the active
Type pairing's Latin faces.

## Locales

| Locale | Language |
| ------ | -------- |
| `zh`   | Chinese  |

The set's `:lang()` rule matches `zh`, the tag the app renders on `<html lang>`.
`:lang(zh)` also matches `zh-Hans` and `zh-CN`, while `:lang(zh-Hans)` would not
match `zh`. The set covers **Simplified Chinese only**. Traditional Chinese is
excluded by the requirement: Motir has no Traditional Chinese locale, so no
`zh-Hant` set exists (`font-sets.md`, _Open points_).

## Members per role

| Role  | Member id        | Family         | Source                              | Licence | CSS variable                              | dooooWeb                | Default |
| ----- | ---------------- | -------------- | ----------------------------------- | ------- | ----------------------------------------- | ----------------------- | ------- |
| sans  | `noto-sans-sc`   | Noto Sans SC   | `next/font/google` `Noto_Sans_SC`   | OFL-1.1 | `--font-set-zh-Hans-sans-noto-sans-sc`    | added (not in dooooWeb) | ✓       |
| serif | `noto-serif-sc`  | Noto Serif SC  | `next/font/google` `Noto_Serif_SC`  | OFL-1.1 | `--font-set-zh-Hans-serif-noto-serif-sc`  | in dooooWeb             | ✓       |
| serif | `lxgw-wenkai-tc` | LXGW WenKai TC | `next/font/google` `LXGW_WenKai_TC` | OFL-1.1 | `--font-set-zh-Hans-serif-lxgw-wenkai-tc` | in dooooWeb             |         |
| mono  | `noto-sans-sc`   | Noto Sans SC   | `next/font/google` `Noto_Sans_SC`   | OFL-1.1 | `--font-set-zh-Hans-sans-noto-sans-sc`    | added (not in dooooWeb) | ✓       |

The mono member re-uses the sans face (`sameFaceAs: 'sans'` in the registry),
so `fontSetMemberVar` returns the sans variable for it and the face is loaded
once.

## How it composes with the Type pairings

The active pairing keeps its Latin faces in every role, and this set supplies
the Han glyphs behind them: on a `zh` page a heading draws its Latin letters in
the pairing's serif face and its Chinese characters in Noto Serif SC, under any
of the six pairings. The mechanism is the _FONT SETS_ section of
[`packages/design-system/theme.css`](../../../packages/design-system/theme.css);
the app's `next/font` loader assigns the variables above.

## Region forms

The default faces, Noto Sans SC and Noto Serif SC, are Noto CJK's
region-specific Simplified Chinese fonts, so they draw Mainland China forms. 直
and 骨 have different regional forms, and on a `zh` page they draw the
Simplified Chinese ones, not the Japanese ones a `ja` page draws.

**LXGW WenKai TC draws Traditional / inherited forms** (傳承字形) for the
characters it covers, and merges some variant code points (真 to 眞, 為 to 爲).
That is why it is a non-default member: available to pick by name, never the
default. See `font-sets.md` § _Region forms_.

## Applying a member by name

A stored pick names a member id. `resolveFontSetMember` returns that member when
the role has it, and the role's default for an unknown or missing id, never
another set's face:

```ts
import { resolveFontSetMember } from '@motir/design-system';

resolveFontSetMember('zh-Hans', 'serif', 'lxgw-wenkai-tc').family; // 'LXGW WenKai TC'
resolveFontSetMember('zh-Hans', 'serif', 'not-a-member').id; // 'noto-serif-sc' (the default)
```

In the page, the same pick is the attribute `data-font-set-serif="lxgw-wenkai-tc"`
on the element (or an ancestor) whose language is `zh`.

## Provenance

Written from motir-core branch `claude/project-thread-xgmdqw`, on top of
`origin/main` `959708288509c00a88efa98a1f7dde9a98da2281`:

- the registry at `a8083dda25642bfa23016a48e0649558f90e55d2`
  (`packages/design-system/src/theme/fontSets.ts`, MOTIR-7843);
- the research at `144b53826935cf4b01228d6ef3474b4938dfc6ef`
  ([`docs/typography/font-sets.md`](../font-sets.md), MOTIR-7841), which read
  dooooWeb at `225af77140fede78ce72e2ff5fc7cfb95f129ef0`
  (`src/lib/font-config.ts @ 225af77`).

dooooWeb maps `zh` to its `chinese-simplified` group (`font-config.ts` L58),
whose list holds Noto Serif SC (L149–154) and LXGW WenKai TC (L156–161).

The two **added (not in dooooWeb)** members, with the references `font-sets.md`
cites:

- **Noto Sans SC (sans).** Noto Sans CJK's Simplified Chinese region font,
  listed as the region subset for 简体中文 in `github.com/notofonts/noto-cjk`,
  `Sans/README.md`, "Region-specific Subset Variable Fonts". dooooWeb uses the
  same family's regional fonts for ja and ko sans.
- **Noto Sans SC (mono).** The Noto Sans Mono CJK practice: those fonts are the
  Noto Sans CJK fonts with half-width ASCII (`Sans/README.md`,
  "Language-specific Variable Fonts"), so their Han glyphs are the sans glyphs.
  The pairing's mono face already supplies the Latin and ASCII glyphs.
