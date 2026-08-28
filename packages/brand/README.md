# `@motir/brand`

Motir's own brand chrome: the wave-band glyph geometry, the `BrandMark` lockup,
and the `.brand-*` presentation CSS.

**This package is not part of the design system, deliberately.** The split is
fixed by [`docs/decisions/brand-asset-distribution.md`](../../docs/decisions/brand-asset-distribution.md)
(MOTIR-3724): `@motir/design-system` is a neutral kit that scaffolded and
third-party products install, and Motir's identity does not travel with it. The
test is not what a file imports — it is **who installs the artifact**.

## Install

```bash
pnpm add @motir/brand @motir/design-system
```

`@motir/design-system` is a **required peer**. Every colour the brand CSS paints
is a Tier-3 `--el-*` token and the wordmark's face is `--font-sans-source`; all
of them are defined by the design system's `theme.css`. It is a peer rather than
a dependency so a consumer resolves exactly one copy of that token layer — the
one their own stylesheet imports — instead of a second nested copy that would be
inert for CSS and confusing to read.

## Use

```css
/* globals.css — ORDER MATTERS */
@import 'tailwindcss';
@import '@motir/design-system/theme.css'; /* defines the tokens … */
@import '@motir/brand/brand.css'; /* … which these rules read */
```

```tsx
import { BrandMark } from '@motir/brand';

<BrandMark />                                  {/* lockup, 32px */}
<BrandMark variant="mark" size={20} />         {/* glyph only */}
<BrandMark variant="stacked" tone="quiet" />
```

**Accessible names are the caller's job.** The glyph is always `aria-hidden`, so
where the wordmark is visible beside it the link takes its name from the text —
do not add an `aria-label` as well. Only the `mark` variant, which renders no
text, needs its wrapping link to carry a name.

`waveBand` also exports the mark's **baked colour literals** and the email-mark
constants. `currentColor` resolves to black through an `<img src>`, as a
favicon, and inside `next/og`, so those surfaces need the value baked — and this
package is where that bake happens once, each literal naming the token it came
from. `EMAIL_MARK_PATH` is a convention about a file the consumer serves from
its own origin, not an asset this package ships.

## Releasing

Same shape as `@motir/design-system` — a package-scoped tag, OIDC Trusted
Publishing, no `NPM_TOKEN` secret.

1. Bump `version` in `packages/brand/package.json`. **The semver surface is the
   exported API _and_ the `.brand-*` class names**, since a consumer's markup
   binds to them.
2. Open + merge the PR with the bump.
3. Tag and push — the tag version MUST equal the `package.json` version (the
   workflow guards it and fails fast otherwise):

   ```bash
   git tag brand-v<x.y.z>
   git push origin brand-v<x.y.z>
   ```

**Dry run:** run `.github/workflows/release-brand.yml` from the Actions tab with
**dry run** checked to build + pack without publishing.

> ⚠️ **The first publish (`0.1.0`) must be cut BY HAND** — OIDC Trusted
> Publishing cannot bootstrap a package that does not exist yet, because the
> Trusted Publisher config lives on the package's own settings page on npmjs.com.
> `@motir/design-system@0.1.0` was cut the same way. Configure the Trusted
> Publisher (org `moooon-B-V` / repo `motir-core` / workflow
> `release-brand.yml`) immediately after, and every release from `0.1.1` on flows
> through the workflow token-free.

## Tests

`pnpm --filter @motir/brand test`. Like `@motir/design-system` and `@motir/cli`,
`packages/` is excluded from the root `tsconfig` and the root CI lanes, so this
suite is verified locally rather than in CI.
