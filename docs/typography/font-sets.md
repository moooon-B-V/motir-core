# Font sets — which faces each locale is shown in

> The research record for MOTIR-7841, under the story _Per-language font sets in
> `@motir/design-system`_ (MOTIR-7733). It fixes **which fonts** belong to each
> locale's set. It decides nothing about **how** they are composed or loaded.
> The registry (`packages/design-system/src/theme/fontSets.ts`, MOTIR-7843) is
> built from the tables below. It may rename set ids, but it takes its members
> and defaults from this file.

**Summary.** dooooWeb maps each language to a **script group** and offers a flat,
untyped list of web fonts per group, with **System Default** preselected. The
four groups that cover Motir's eleven locales are `latin`, `chinese-simplified`,
`japanese` and `korean`. dooooWeb has no sans / serif / mono roles, so this
document places each of its faces in a role and fills the empty roles from cited
references. Every face below is loadable through `next/font/google` and licensed
under OFL-1.1. One finding changes the plan's assumptions: **dooooWeb's
calligraphic Chinese face, LXGW WenKai TC, draws Traditional (inherited) glyph
forms**, so it is a non-default member of the `zh-Hans` serif role, never its
default.

## Provenance

| What                    | Value                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| dooooWeb commit         | `225af77140fede78ce72e2ff5fc7cfb95f129ef0` (committed 2026-06-05), read 2026-10-08                        |
| Mapping                 | `src/lib/font-config.ts @ 225af77` — `LANGUAGE_SCRIPT_MAP` (L25–81), `SCRIPT_FONTS` (L319–337)            |
| Default and picker      | `src/lib/contexts/font-context.tsx @ 225af77` — `resolveFont` (L114–126), `applyFontToDocument` (L68–82)  |
| Picker UI               | `src/pages/settings/FontSettingsPage.tsx @ 225af77` — `FontFamilySection` (L30–97)                        |
| motir-core              | `origin/main` at `959708288509c00a88efa98a1f7dde9a98da2281` (`app/fonts.ts`, `lib/i18n/locales.ts`)       |
| next/font font data     | `next@16.2.6`, `dist/compiled/@next/font/dist/google/font-data.json` (the version this repo pins)         |
| next/font file handling | same package, `google/loader.js` L101–124 and `google/find-font-files-in-css.js` L5–28                    |
| Slice counts            | `https://fonts.googleapis.com/css2?family=<Family>:wght@400` with a desktop Chrome user agent, 2026-10-08 |
| Licences                | `github.com/google/fonts` `ofl/<family>/METADATA.pb` (`license: "OFL"`), read 2026-10-08                  |

### How dooooWeb works, in its own terms

- **One script group per language.** `LANGUAGE_SCRIPT_MAP` maps each of its 57
  language codes to one `ScriptGroup` (`font-config.ts` L25–81).
- **A flat list of faces per group, not roles.** `SCRIPT_FONTS[group]` is an
  ordered list whose first entry is always `systemDefault` (L319–337). A face
  carries `id`, `displayName`, `cssFamily` and `googleFontsFamily`, which is
  always `wght@400;700` (L86–92, L105–314). There is no sans / serif / mono
  distinction.
- **The default is the system font.** `resolveFont` returns the stored pick for
  the language if it is still in the list, otherwise `fontId: 'system'`
  (`font-context.tsx` L114–126). The system default removes the inline
  `font-family`, so the page falls back to the browser's stack (L76–77).
- **A pick replaces the whole document's font.** `applyFontToDocument` puts the
  picked `cssFamily` inline on `<html>` (L68–82). Every element, headings and
  code included, uses that one face. Picks are stored per language
  (`selectFont`, L162–176), and the settings page previews every face of the
  current language (`FontSettingsPage.tsx` L30–97).

### What this document does differently, and why

- **Roles.** Motir's Type axis has three roles (`--font-sans`, `--font-serif`,
  `--font-mono`), so each dooooWeb face is placed in the role its design
  belongs to. A role dooooWeb has no face for is filled in step 3 below and
  tagged `added (not in dooooWeb)`.
- **No system default.** The story requires each locale to render in its set's
  face, not the operating system's. So every role's default is a web face. For
  the Latin set, the default is the active Type pairing's own face, which is
  Motir's equivalent of dooooWeb's "nothing extra".

## Locale → set

| Locale | dooooWeb script group (`font-config.ts`)                 | Set id for the registry | Source line |
| ------ | -------------------------------------------------------- | ----------------------- | ----------- |
| en     | `latin`                                                  | `latin`                 | L26         |
| de     | `latin`                                                  | `latin`                 | L29         |
| fr     | `latin`                                                  | `latin`                 | L28         |
| es     | `latin`                                                  | `latin`                 | L27         |
| it     | `latin`                                                  | `latin`                 | L32         |
| nl     | `latin`                                                  | `latin`                 | L35         |
| pl     | `latin`                                                  | `latin`                 | L34         |
| pt     | `latin` (dooooWeb has `pt-BR` and `pt-PT`, both `latin`) | `latin`                 | L30, L31    |
| zh     | `chinese-simplified`                                     | `zh-Hans`               | L58         |
| ja     | `japanese`                                               | `ja`                    | L60         |
| ko     | `korean`                                                 | `ko`                    | L61         |

zh, ja and ko map to three different sets. dooooWeb's `chinese-traditional`
group (`zh-Hant`, L59) has no Motir locale, so no `zh-Hant` set is proposed.

The ids `zh-Hans`, `ja` and `ko` are BCP 47 tags, so each can serve as both the
registry id and its `:lang()` selector. dooooWeb's group names
(`chinese-simplified`, `japanese`, `korean`) are recorded here for traceability
only.

## The sets

How to read the member rows:

- **Source** is the `next/font/google` export name, which is the family name
  with spaces replaced by `_`.
- **Weights / axes** come from `font-data.json` in `next@16.2.6`. A `variable`
  face takes one `@font-face` per slice for the whole `wght` range. A static
  face needs a `weight` array, and dooooWeb uses `400` and `700` (L110–313).
- **next/font subsets** are the only subsets `next/font` will **preload**.
  Google Fonts does not expose CJK glyphs as a named subset. It serves them as
  numbered `unicode-range` slices (`[0]`…`[119]`). `next/font` downloads and
  self-hosts **every** slice of the CSS it fetches, at build time
  (`loader.js` L101–124), and uses `subsets` only to choose which files to
  preload (`find-font-files-in-css.js` L28). So a CJK member is declared with
  `preload: false`. Its CJK slices are then fetched only when a rendered
  character falls inside one of them.
- **Slices @400** is the number of `@font-face` blocks Google Fonts returns for
  that family at `wght@400`. Each is a separate file a page may request.
- **Licence**: every face below is OFL-1.1 (`ofl/` in `google/fonts`, with
  `license: "OFL"` in `METADATA.pb`).

### `latin`: en, de, fr, es, it, nl, pl, pt

| Role  | Member id      | Face                                   | Default | Tag                     |
| ----- | -------------- | -------------------------------------- | ------- | ----------------------- |
| sans  | `type-pairing` | the active Type pairing's `sans` face  | ✓       | added (not in dooooWeb) |
| serif | `type-pairing` | the active Type pairing's `serif` face | ✓       | added (not in dooooWeb) |
| mono  | `type-pairing` | the active Type pairing's `mono` face  | ✓       | added (not in dooooWeb) |

- **Source:** `type-pairing`. The faces are the six already in `app/fonts.ts`
  (Inter, Source Serif 4, JetBrains Mono, IBM Plex Mono, Space Grotesk,
  Fraunces). The set adds no face of its own and copies none of them.
- **Why not dooooWeb's Latin faces.** dooooWeb's `latin` list is System
  Default, Noto Sans, Jost, Quicksand, Exo 2, Saira Stencil One and Bitcount
  Prop Single (L320). In dooooWeb a pick **replaces** the document's whole font
  (`font-context.tsx` L78–79). In Motir the script face sits **behind** the
  pairing's Latin face, so a Latin "script" face would never draw a glyph: the
  pairing face already covers every Latin character. Whether a Latin pick
  should instead replace a pairing role is a product question. It is recorded
  under Open points and belongs to the picker story. dooooWeb's own default for
  this group, the system font, is the nearest equivalent of "the pairing
  unchanged".
- For the record, every dooooWeb Latin face is loadable with `next/font/google`
  and offers `latin-ext` (`font-data.json`): Noto Sans, Jost, Quicksand, Exo 2,
  Saira Stencil One (static, `400` only), Bitcount Prop Single (variable,
  `wght` 100–900 plus `CRSV`, `ELSH`, `ELXP` and `slnt`).

### `zh-Hans`: zh

| Role  | Member id        | Face           | Default | Tag                                                                          |
| ----- | ---------------- | -------------- | ------- | ---------------------------------------------------------------------------- |
| sans  | `noto-sans-sc`   | Noto Sans SC   | ✓       | added (not in dooooWeb), see the reference below                             |
| serif | `noto-serif-sc`  | Noto Serif SC  | ✓       | in dooooWeb (`font-config.ts` L149–154, L321)                                |
| serif | `lxgw-wenkai-tc` | LXGW WenKai TC |         | in dooooWeb (L156–161, L321). Draws **Traditional** forms; see Region forms. |
| mono  | `noto-sans-sc`   | Noto Sans SC   | ✓       | added (not in dooooWeb). Reuses the sans face; see the reference below.      |

| Face           | `next/font/google` source | Weights / axes            | next/font subsets                                                            | Slices @400 | Licence |
| -------------- | ------------------------- | ------------------------- | ---------------------------------------------------------------------------- | ----------- | ------- |
| Noto Sans SC   | `Noto_Sans_SC`            | variable, `wght` 100–900  | cyrillic, latin, latin-ext, vietnamese                                       | 101         | OFL-1.1 |
| Noto Serif SC  | `Noto_Serif_SC`           | variable, `wght` 200–900  | cyrillic, latin, latin-ext, vietnamese                                       | 101         | OFL-1.1 |
| LXGW WenKai TC | `LXGW_WenKai_TC`          | static, `300` `400` `700` | cyrillic, cyrillic-ext, greek, greek-ext, latin, latin-ext, lisu, vietnamese | 115         | OFL-1.1 |

- **Why Noto Sans SC fills the sans role.** dooooWeb's Chinese list has no sans
  face (L321). For Japanese and Korean, dooooWeb's sans face is the Noto Sans
  CJK regional font (`Noto Sans JP`, L172–177; `Noto Sans KR`, L187–192).
  Noto Sans SC is the same family's Simplified Chinese region font. It is
  listed as the region subset for 简体中文 in the Noto CJK download guide
  (`github.com/notofonts/noto-cjk`, `Sans/README.md`, "Region-specific Subset
  Variable Fonts").
- **Why the mono role reuses the sans face.** Google Fonts has no Simplified
  Chinese monospace face. The reference practice is Noto's own: the Noto Sans
  Mono CJK fonts are the Noto Sans CJK fonts with half-width ASCII ("Font
  resources that include 'Mono' in their names use half-width glyphs for ASCII
  by default", `Sans/README.md`, "Language-specific Variable Fonts"). Their Han
  glyphs are the sans glyphs. In Motir the Latin and ASCII glyphs of the mono
  role already come from the pairing's mono face, which sits first in the
  stack, so the set only needs to supply the Han glyphs, and those are the
  sans face's.

### `ja`: ja

| Role  | Member id           | Face              | Default | Tag                                                            |
| ----- | ------------------- | ----------------- | ------- | -------------------------------------------------------------- |
| sans  | `noto-sans-jp`      | Noto Sans JP      | ✓       | in dooooWeb (`font-config.ts` L172–177, L323)                  |
| sans  | `m-plus-rounded-1c` | M PLUS Rounded 1c |         | in dooooWeb (L179–184, L323)                                   |
| serif | `noto-serif-jp`     | Noto Serif JP     | ✓       | added (not in dooooWeb), see the reference below               |
| mono  | `noto-sans-jp`      | Noto Sans JP      | ✓       | added (not in dooooWeb). Reuses the sans face, as for zh-Hans. |

| Face              | `next/font/google` source | Weights / axes                                    | next/font subsets                                                              | Slices @400 | Licence |
| ----------------- | ------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------ | ----------- | ------- |
| Noto Sans JP      | `Noto_Sans_JP`            | variable, `wght` 100–900                          | cyrillic, latin, latin-ext, vietnamese                                         | 124         | OFL-1.1 |
| M PLUS Rounded 1c | `M_PLUS_Rounded_1c`       | static, `100` `300` `400` `500` `700` `800` `900` | cyrillic, cyrillic-ext, greek, greek-ext, hebrew, latin, latin-ext, vietnamese | 126         | OFL-1.1 |
| Noto Serif JP     | `Noto_Serif_JP`           | variable, `wght` 200–900                          | cyrillic, latin, latin-ext, vietnamese                                         | 124         | OFL-1.1 |

- **Why Noto Serif JP fills the serif role.** dooooWeb's Japanese list has no
  serif (L323). For Chinese it uses the Noto Serif CJK regional font
  (`Noto Serif SC`, L149–154). Noto Serif JP is the same family's Japanese
  region font (`Serif/README.md`, "Region-specific Subset Variable Fonts",
  "Subset Variable Japanese (日本語)").

### `ko`: ko

| Role  | Member id       | Face          | Default | Tag                                                            |
| ----- | --------------- | ------------- | ------- | -------------------------------------------------------------- |
| sans  | `noto-sans-kr`  | Noto Sans KR  | ✓       | in dooooWeb (`font-config.ts` L187–192, L324)                  |
| sans  | `nanum-gothic`  | Nanum Gothic  |         | in dooooWeb (L194–199, L324)                                   |
| serif | `noto-serif-kr` | Noto Serif KR | ✓       | added (not in dooooWeb), see the reference below               |
| mono  | `noto-sans-kr`  | Noto Sans KR  | ✓       | added (not in dooooWeb). Reuses the sans face, as for zh-Hans. |

| Face          | `next/font/google` source | Weights / axes            | next/font subsets                      | Slices @400 | Licence |
| ------------- | ------------------------- | ------------------------- | -------------------------------------- | ----------- | ------- |
| Noto Sans KR  | `Noto_Sans_KR`            | variable, `wght` 100–900  | cyrillic, latin, latin-ext, vietnamese | 124         | OFL-1.1 |
| Nanum Gothic  | `Nanum_Gothic`            | static, `400` `700` `800` | latin                                  | 92          | OFL-1.1 |
| Noto Serif KR | `Noto_Serif_KR`           | variable, `wght` 200–900  | cyrillic, latin, latin-ext, vietnamese | 124         | OFL-1.1 |

- **Why Noto Serif KR fills the serif role.** This follows the same reasoning as
  for ja: it is Noto Serif CJK's Korean region font (`Serif/README.md`,
  "Subset Variable Korean (한국어)").
- **Nanum Gothic offers only the `latin` subset** to next/font. Its Hangul is in
  the numbered slices, like every CJK face, so this does not affect Korean
  coverage. It does mean Nanum Gothic must not be used for Latin text, and in
  Motir it never is, because the pairing face sits in front of it.

### Loadability

Every member above is in `font-data.json` for `next@16.2.6` and can be loaded
with `next/font/google`. No member is **not loadable**.

Two costs follow from how `next/font` handles CJK. They belong to the loading
card (MOTIR-7847) to measure, and are recorded here so it starts from the
numbers:

- **Every slice is a build-time download.** The six CJK faces declared at
  `wght@400` are about 690 files. A variable face takes one file per slice for
  the whole `wght` range. A static face takes one file per slice **per weight**,
  so Nanum Gothic, M PLUS Rounded 1c and LXGW WenKai TC at dooooWeb's `400` and
  `700` are about 2× their slice count.
- **Every declared member adds its `@font-face` rules to every page's CSS**,
  because `app/fonts.ts` is in the root layout. The member list above is
  therefore kept to dooooWeb's faces plus one face per empty role. The
  monospace candidates under Open points are not added for this reason.

## Region forms

Each CJK set's default faces come from Noto CJK's **region-specific** fonts.
These carry only the glyphs for one region's standard, so the same code point
draws that region's form ("Select this deployment format if … you need only the
glyphs for characters for a particular region", `notofonts/noto-cjk`
`Sans/README.md` and `Serif/README.md`, "Region-specific Subset Variable
Fonts"; the Google Fonts names map `SC` to Simplified Chinese, `JP` to Japanese
and `KR` to Korean, root `README.md`).

| Set       | Default sans / serif         | Han forms drawn                           |
| --------- | ---------------------------- | ----------------------------------------- |
| `zh-Hans` | Noto Sans SC / Noto Serif SC | Simplified Chinese (Mainland China) forms |
| `ja`      | Noto Sans JP / Noto Serif JP | Japanese forms                            |
| `ko`      | Noto Sans KR / Noto Serif KR | Korean forms                              |

So 骨 and 直, which have different regional forms, draw differently on a zh
page and a ja page. The E2E card (MOTIR-7851) proves this in a browser.

**LXGW WenKai TC is the exception, and is in dooooWeb's Simplified Chinese
list.** Its README describes it as "The Traditional Chinese Version of LXGW
WenKai". Its glyphs follow the 一點字坊 inherited-glyph standard (傳承字形), and
it merges variant code points (for example 真 to 眞, 為 to 爲)
(`github.com/lxgw/LxgwWenkaiTC`, `README.md`, 重要說明). On a `zh-Hans` page it
draws Traditional / inherited forms for the characters it covers. It is
therefore a **non-default** serif member, available to pick by name but never
the default. Google Fonts carries only the TC version of LXGW WenKai.

## Latin coverage — `latin-ext` for the six pairing faces

`app/fonts.ts` at `origin/main` `959708288509c00a88efa98a1f7dde9a98da2281` loads
all six faces with `subsets: ['latin']` (L18–67). `next/font` offers
`latin-ext` for all six (`font-data.json`, `next@16.2.6`):

| Face (`app/fonts.ts`) | `latin-ext` offered | All subsets offered                                                    |
| --------------------- | ------------------- | ---------------------------------------------------------------------- |
| Inter                 | yes                 | cyrillic, cyrillic-ext, greek, greek-ext, latin, latin-ext, vietnamese |
| Source Serif 4        | yes                 | cyrillic, cyrillic-ext, greek, latin, latin-ext, vietnamese            |
| JetBrains Mono        | yes                 | cyrillic, cyrillic-ext, greek, latin, latin-ext, vietnamese            |
| IBM Plex Mono         | yes                 | cyrillic, cyrillic-ext, latin, latin-ext, vietnamese                   |
| Space Grotesk         | yes                 | latin, latin-ext, vietnamese                                           |
| Fraunces              | yes                 | latin, latin-ext, vietnamese                                           |

Which Motir locales actually need `latin-ext`: Google's `latin` slice ends at
U+00FF, and `latin-ext` covers U+0100–024F. Polish ą ę ł ń ś ź ż (and Ć) are in
`latin-ext`. Polish ó, and the de / fr / es / it / pt accents, are in `latin`.
Dutch uses `latin-ext` only for the ĳ ligature (U+0133). In practice
**pl is the locale that needs it**. The latin-ext card (MOTIR-7842) does the
change.

dooooWeb's Latin set adds faces of its own (Noto Sans, Jost, Quicksand, Exo 2,
Saira Stencil One, Bitcount Prop Single, L320), while Motir's Latin set uses the
pairing's faces. See the `latin` section for why.

## Open points

| Point                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Decided by                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Should a Latin pick (dooooWeb's Noto Sans, Jost, …) replace a pairing role, as in dooooWeb, rather than sit behind it? If so, those faces become Latin members.                                                                                                                                                                                                                                                                                                             | the per-language picker story (_Pick your font per language_)      |
| The CJK mono default reuses the sans face's file. The registry gives each role its own variable name (`--font-set-<set>-mono-<member>`). Should that variable alias the sans variable, or should the face be declared twice?                                                                                                                                                                                                                                                | the registry card (MOTIR-7843), with the loading card (MOTIR-7847) |
| True CJK monospace candidates, not added: **M PLUS 1 Code** for ja (`M_PLUS_1_Code`, variable `wght` 100–700, 119 slices, OFL; "supporting 5,700+ Kanjis", `google/fonts` `ofl/mplus1code/DESCRIPTION.en_us.html`) and **Nanum Gothic Coding** for ko (`Nanum_Gothic_Coding`, static `400` `700`, 93 slices, OFL; "a contemporary monospaced sans-serif", `ofl/nanumgothiccoding/DESCRIPTION.en_us.html`). Each would add about 100 `@font-face` rules to every page's CSS. | the picker story, once the loading card has measured the CSS cost  |
| Which static weights to declare for Nanum Gothic, M PLUS Rounded 1c and LXGW WenKai TC. dooooWeb uses `400` and `700`, and each weight multiplies the slice count.                                                                                                                                                                                                                                                                                                          | the loading card (MOTIR-7847)                                      |
| A `zh-Hant` set, for dooooWeb's `chinese-traditional` group (Noto Serif TC, LXGW WenKai TC), if Motir ever adds a Traditional Chinese locale.                                                                                                                                                                                                                                                                                                                               | a future locale story; nothing in MOTIR-7733                       |
