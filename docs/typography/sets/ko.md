# Font set — Korean (`ko`)

> One of the four font sets in the registry
> [`packages/design-system/src/theme/fontSets.ts`](../../../packages/design-system/src/theme/fontSets.ts)
> (MOTIR-7843). The research behind it is
> [`docs/typography/font-sets.md`](../font-sets.md) (MOTIR-7841).

**Covers:** Hangul and Hanja in Korean forms, drawn behind the active Type
pairing's Latin faces.

## Locales

| Locale | Language |
| ------ | -------- |
| `ko`   | Korean   |

The set's `:lang()` rule matches `ko`, which also matches `ko-KR`.

## Members per role

| Role  | Member id       | Family        | Source                             | Licence | CSS variable                        | dooooWeb                | Default |
| ----- | --------------- | ------------- | ---------------------------------- | ------- | ----------------------------------- | ----------------------- | ------- |
| sans  | `noto-sans-kr`  | Noto Sans KR  | `next/font/google` `Noto_Sans_KR`  | OFL-1.1 | `--font-set-ko-sans-noto-sans-kr`   | in dooooWeb             | ✓       |
| sans  | `nanum-gothic`  | Nanum Gothic  | `next/font/google` `Nanum_Gothic`  | OFL-1.1 | `--font-set-ko-sans-nanum-gothic`   | in dooooWeb             |         |
| serif | `noto-serif-kr` | Noto Serif KR | `next/font/google` `Noto_Serif_KR` | OFL-1.1 | `--font-set-ko-serif-noto-serif-kr` | added (not in dooooWeb) | ✓       |
| mono  | `noto-sans-kr`  | Noto Sans KR  | `next/font/google` `Noto_Sans_KR`  | OFL-1.1 | `--font-set-ko-sans-noto-sans-kr`   | added (not in dooooWeb) | ✓       |

The mono member re-uses the sans face (`sameFaceAs: 'sans'` in the registry),
so `fontSetMemberVar` returns the sans variable for it and the face is loaded
once. Nanum Gothic offers only the `latin` named subset to `next/font`; its
Hangul is in the numbered slices like every CJK face, and the pairing face in
front of it draws all Latin text.

## How it composes with the Type pairings

The active pairing keeps its Latin faces in every role, and this set supplies
the Hangul and Hanja behind them, under any of the six pairings. The mechanism
is the _FONT SETS_ section of
[`packages/design-system/theme.css`](../../../packages/design-system/theme.css);
the app's `next/font` loader assigns the variables above.

## Region forms

The default faces, Noto Sans KR and Noto Serif KR, are Noto CJK's
region-specific Korean fonts, so the Hanja they draw take Korean forms. 直 and
骨, which differ between regions, draw in their Korean forms on a `ko` page. See
`font-sets.md` § _Region forms_.

## Applying a member by name

A stored pick names a member id. `resolveFontSetMember` returns that member when
the role has it, and the role's default for an unknown or missing id, never
another set's face:

```ts
import { resolveFontSetMember } from '@motir/design-system';

resolveFontSetMember('ko', 'sans', 'nanum-gothic').family; // 'Nanum Gothic'
resolveFontSetMember('ko', 'sans', 'not-a-member').id; // 'noto-sans-kr' (the default)
```

In the page, the same pick is the attribute `data-font-set-sans="nanum-gothic"`
on the element (or an ancestor) whose language is `ko`.

## Provenance

Written from motir-core branch `claude/project-thread-xgmdqw`, on top of
`origin/main` `959708288509c00a88efa98a1f7dde9a98da2281`:

- the registry at `a8083dda25642bfa23016a48e0649558f90e55d2`
  (`packages/design-system/src/theme/fontSets.ts`, MOTIR-7843);
- the research at `144b53826935cf4b01228d6ef3474b4938dfc6ef`
  ([`docs/typography/font-sets.md`](../font-sets.md), MOTIR-7841), which read
  dooooWeb at `225af77140fede78ce72e2ff5fc7cfb95f129ef0`
  (`src/lib/font-config.ts @ 225af77`).

dooooWeb maps `ko` to its `korean` group (`font-config.ts` L61), whose list
holds Noto Sans KR (L187–192) and Nanum Gothic (L194–199).

The two **added (not in dooooWeb)** members, with the references `font-sets.md`
cites:

- **Noto Serif KR (serif).** Noto Serif CJK's Korean region font
  (`github.com/notofonts/noto-cjk`, `Serif/README.md`, "Subset Variable Korean
  (한국어)").
- **Noto Sans KR (mono).** The Noto Sans Mono CJK practice: those fonts are the
  Noto Sans CJK fonts with half-width ASCII (`Sans/README.md`,
  "Language-specific Variable Fonts"), so their Han glyphs are the sans glyphs.
  The pairing's mono face already supplies the Latin and ASCII glyphs.
