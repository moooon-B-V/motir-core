# Font set — Japanese (`ja`)

> One of the four font sets in the registry
> [`packages/design-system/src/theme/fontSets.ts`](../../../packages/design-system/src/theme/fontSets.ts)
> (MOTIR-7843). The research behind it is
> [`docs/typography/font-sets.md`](../font-sets.md) (MOTIR-7841).

**Covers:** kana and kanji in Japanese forms, drawn behind the active Type
pairing's Latin faces.

## Locales

| Locale | Language |
| ------ | -------- |
| `ja`   | Japanese |

The set's `:lang()` rule matches `ja`, which also matches `ja-JP`.

## Members per role

| Role  | Member id           | Family            | Source                                 | Licence | CSS variable                           | dooooWeb                | Default |
| ----- | ------------------- | ----------------- | -------------------------------------- | ------- | -------------------------------------- | ----------------------- | ------- |
| sans  | `noto-sans-jp`      | Noto Sans JP      | `next/font/google` `Noto_Sans_JP`      | OFL-1.1 | `--font-set-ja-sans-noto-sans-jp`      | in dooooWeb             | ✓       |
| sans  | `m-plus-rounded-1c` | M PLUS Rounded 1c | `next/font/google` `M_PLUS_Rounded_1c` | OFL-1.1 | `--font-set-ja-sans-m-plus-rounded-1c` | in dooooWeb             |         |
| serif | `noto-serif-jp`     | Noto Serif JP     | `next/font/google` `Noto_Serif_JP`     | OFL-1.1 | `--font-set-ja-serif-noto-serif-jp`    | added (not in dooooWeb) | ✓       |
| mono  | `noto-sans-jp`      | Noto Sans JP      | `next/font/google` `Noto_Sans_JP`      | OFL-1.1 | `--font-set-ja-sans-noto-sans-jp`      | added (not in dooooWeb) | ✓       |

The mono member re-uses the sans face (`sameFaceAs: 'sans'` in the registry),
so `fontSetMemberVar` returns the sans variable for it and the face is loaded
once.

## How it composes with the Type pairings

The active pairing keeps its Latin faces in every role, and this set supplies
the kana and kanji behind them: on `<html lang="ja" data-type="editorial">` the
serif role draws Latin letters in Fraunces and Japanese in Noto Serif JP. The
mechanism is the _FONT SETS_ section of
[`packages/design-system/theme.css`](../../../packages/design-system/theme.css);
the app's `next/font` loader assigns the variables above.

## Region forms

The default faces, Noto Sans JP and Noto Serif JP, are Noto CJK's
region-specific Japanese fonts, so they draw Japanese forms. 直 and 骨 have
different regional forms, and on a `ja` page they draw the Japanese ones, not
the Simplified Chinese ones a `zh` page draws. M PLUS Rounded 1c is a Japanese
design and draws Japanese forms too. See `font-sets.md` § _Region forms_.

## Applying a member by name

A stored pick names a member id. `resolveFontSetMember` returns that member when
the role has it, and the role's default for an unknown or missing id, never
another set's face:

```ts
import { resolveFontSetMember } from '@motir/design-system';

resolveFontSetMember('ja', 'sans', 'm-plus-rounded-1c').family; // 'M PLUS Rounded 1c'
resolveFontSetMember('ja', 'sans', 'nanum-gothic').id; // 'noto-sans-jp' (a ko member is not borrowed)
```

In the page, the same pick is the attribute
`data-font-set-sans="m-plus-rounded-1c"` on the element (or an ancestor) whose
language is `ja`.

## Provenance

Written from motir-core branch `claude/project-thread-xgmdqw`, on top of
`origin/main` `959708288509c00a88efa98a1f7dde9a98da2281`:

- the registry at `a8083dda25642bfa23016a48e0649558f90e55d2`
  (`packages/design-system/src/theme/fontSets.ts`, MOTIR-7843);
- the research at `144b53826935cf4b01228d6ef3474b4938dfc6ef`
  ([`docs/typography/font-sets.md`](../font-sets.md), MOTIR-7841), which read
  dooooWeb at `225af77140fede78ce72e2ff5fc7cfb95f129ef0`
  (`src/lib/font-config.ts @ 225af77`).

dooooWeb maps `ja` to its `japanese` group (`font-config.ts` L60), whose list
holds Noto Sans JP (L172–177) and M PLUS Rounded 1c (L179–184).

The two **added (not in dooooWeb)** members, with the references `font-sets.md`
cites:

- **Noto Serif JP (serif).** Noto Serif CJK's Japanese region font
  (`github.com/notofonts/noto-cjk`, `Serif/README.md`, "Region-specific Subset
  Variable Fonts", "Subset Variable Japanese (日本語)"). dooooWeb uses the same
  family's regional font for Chinese serif.
- **Noto Sans JP (mono).** The Noto Sans Mono CJK practice: those fonts are the
  Noto Sans CJK fonts with half-width ASCII (`Sans/README.md`,
  "Language-specific Variable Fonts"), so their Han glyphs are the sans glyphs.
  The pairing's mono face already supplies the Latin and ASCII glyphs.
