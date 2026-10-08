# Font set — Latin (`latin`)

> One of the four font sets in the registry
> [`packages/design-system/src/theme/fontSets.ts`](../../../packages/design-system/src/theme/fontSets.ts)
> (MOTIR-7843). The research behind it is
> [`docs/typography/font-sets.md`](../font-sets.md) (MOTIR-7841).

**Covers:** the Latin script, including the Latin Extended-A letters Polish
needs. The set adds no face of its own: it **is** the active Type pairing's
faces.

## Locales

| Locale | Language   |
| ------ | ---------- |
| `en`   | English    |
| `de`   | German     |
| `fr`   | French     |
| `es`   | Spanish    |
| `it`   | Italian    |
| `nl`   | Dutch      |
| `pl`   | Polish     |
| `pt`   | Portuguese |

The set's `lang` is `null`: no single `:lang()` rule matches it. `theme.css`
matches it by listing each of the eight locales above. A page whose language
none of the four sets lists also renders in this set, because `resolveFontSet`
falls back to `latin`.

## Members per role

| Role  | Member id      | Family                                 | Source         | Licence                              | CSS variable | dooooWeb                | Default |
| ----- | -------------- | -------------------------------------- | -------------- | ------------------------------------ | ------------ | ----------------------- | ------- |
| sans  | `type-pairing` | the active Type pairing's `sans` face  | `type-pairing` | the pairing face's own (all OFL-1.1) | none         | added (not in dooooWeb) | ✓       |
| serif | `type-pairing` | the active Type pairing's `serif` face | `type-pairing` | the pairing face's own (all OFL-1.1) | none         | added (not in dooooWeb) | ✓       |
| mono  | `type-pairing` | the active Type pairing's `mono` face  | `type-pairing` | the pairing face's own (all OFL-1.1) | none         | added (not in dooooWeb) | ✓       |

`fontSetMemberVar('latin', role, 'type-pairing')` returns `null`: the member
loads nothing and has no variable. The faces it stands for are the six
`app/fonts.ts` already loads (Inter, Source Serif 4, JetBrains Mono, IBM Plex
Mono, Space Grotesk, Fraunces); see the pairing docs beside this folder, such as
[`motir.md`](../motir.md) and [`editorial.md`](../editorial.md).

## How it composes with the Type pairings

The active pairing keeps its Latin faces in every role, and this set puts
nothing behind them: the role stack is the pairing's faces followed by the
pairing's generic tail, exactly as before font sets existed. The six pairing
faces already ship `latin-ext` (`font-sets.md`, _Latin coverage_), so Polish
ą ę ł ś ź ż draw in the pairing's face. The mechanism is the _FONT SETS_
section of [`packages/design-system/theme.css`](../../../packages/design-system/theme.css),
which resets the set's script tokens on each Latin locale so that a Latin
passage nested in a CJK page returns to the pairing's stack.

## Applying a member by name

The Latin set has one member per role, so a pick by name always resolves to the
pairing. An unknown id resolves to the role's default, which is the same member:

```ts
import { resolveFontSetMember } from '@motir/design-system';

resolveFontSetMember('latin', 'serif', 'type-pairing').id; // 'type-pairing'
resolveFontSetMember('latin', 'serif', 'noto-sans').id; // 'type-pairing' (unknown id → default)
```

## Provenance

Written from motir-core branch `claude/project-thread-xgmdqw`, on top of
`origin/main` `959708288509c00a88efa98a1f7dde9a98da2281`:

- the registry at `a8083dda25642bfa23016a48e0649558f90e55d2`
  (`packages/design-system/src/theme/fontSets.ts`, MOTIR-7843);
- the research at `144b53826935cf4b01228d6ef3474b4938dfc6ef`
  ([`docs/typography/font-sets.md`](../font-sets.md), MOTIR-7841), which read
  dooooWeb at `225af77140fede78ce72e2ff5fc7cfb95f129ef0`
  (`src/lib/font-config.ts @ 225af77`, `LANGUAGE_SCRIPT_MAP` L25–81 and
  `SCRIPT_FONTS` L319–337).

dooooWeb maps all eight locales to its `latin` group (`font-config.ts` L26–35).
The `type-pairing` member is **added (not in dooooWeb)**: dooooWeb's Latin list
(System Default, Noto Sans, Jost, Quicksand, Exo 2, Saira Stencil One, Bitcount
Prop Single, L320) is a whole-document replacement, while a Motir set sits
behind the pairing, where a Latin face would never draw a glyph. The reference
is `font-sets.md` § _`latin`_; whether a Latin pick should instead replace a
pairing role is its first open point.
