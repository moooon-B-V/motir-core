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

## The OG card's fonts

The package also ships the three Inter faces Motir's social cards are set in,
under `fonts/`, exposed as `@motir/brand/fonts/*` and listed in `files`:

```
Inter-Regular.ttf (400)   Inter-Bold.ttf (700)   Inter-ExtraBold.ttf (800)
```

`next/og` renders through satori, **outside** the CSS tree — it cannot read
`--font-sans-source`, cannot see `next/font`'s output, and has no system stack to
fall back on. The only way a card gets a typeface is `ImageResponse`'s `fonts`
option, and the only thing that option accepts is font BYTES. A template that
sets `fontFamily: 'sans-serif'` does not error; it silently ships whatever face
the build container happens to have.

**Resolving the paths — read this before writing the consumer.** This package
deliberately exports a MANIFEST (`OG_FONT_FAMILY`, `OG_FONT_FACES`) and never a
resolved path or a path-returning helper:

```ts
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { OG_FONT_FAMILY } from '@motir/brand';

// ⚠️ EVERY SEGMENT A LITERAL — this is what Turbopack's tracer can follow.
const FONT_DIR = path.join(process.cwd(), 'node_modules', '@motir', 'brand', 'fonts');
const FACES = [{ file: 'Inter-Regular.ttf', weight: 400 as const } /* … */];
```

**⚠️ AND THE LITERAL IS NOT THE SAME IN A WORKSPACE CONSUMER.** The line above is
right for an INSTALLED consumer (motir-marketing): both
`node_modules/.pnpm/@motir+brand@…/…/fonts/` and the top-level
`node_modules/@motir/brand/fonts/` reach `.next/standalone`. Inside motir-core's
own monorepo, `node_modules/@motir/brand` is a symlink to `../../packages/brand`
— it points OUTSIDE `node_modules`, and `copyTracedFiles` reproduces traced files
at their RESOLVED path without re-creating that symlink. So a workspace consumer
reads `path.join(process.cwd(), 'packages', 'brand', 'fonts')`; the node_modules
spelling resolves in dev, in test and in CI, and ENOENTs only in the deployed
image. Both were measured on their own repository's build (MOTIR-3848), and the
check to repeat is `find .next/standalone -path '*brand*fonts*'` — never a
reading of the resolver's rules.

Turbopack traces a `readFile` **only** when the path is statically analysable —
an inline `process.env` or a literal `path.join`, never a value returned from a
function call. Its fallback for an unresolvable read is to trace the ENTIRE
project into that entry's `.nft.json` (MOTIR-3219: 4510 files, a 464 MB
standalone image). So a `resolveOgFontPath()` export would be the one shape that
breaks every consumer at once, silently and in either direction — the fonts
missing from the deployed function, or the whole repository in it.

Each consumer therefore keeps its own literal join and its own `FACES` array,
and pins them against `OG_FONT_FACES` in a test. `motir-core`'s
`tests/brand/opengraphImages.test.tsx` is the reference for that guard.

**Verify by grepping the built trace, never by reading the config.**
`outputFileTracingIncludes` is inert under a Turbopack build, and a dead include
reads exactly like a delivered asset:

```bash
grep -o 'Inter-[A-Za-z]*\.ttf' .next/server/app/**/opengraph-image*/route.js.nft.json
```

The faces are Inter v20 under the SIL Open Font License 1.1, redistributed
unmodified — see `NOTICE`.

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

> ✅ **Both bootstrap steps are DONE** (MOTIR-3802, 2026-08-28): `0.1.0` was
> hand-published and the Trusted Publisher is configured — org `moooon-B-V`,
> repo `motir-core`, workflow `release-brand.yml`, **Environment name blank**
> (the lane declares no `environment:`, so a value there would demand a claim
> its token cannot produce) and **Allowed actions = `npm publish` only**. The
> paragraph below is kept as the record of why the first one was different.
>
> ⚠️ **The first publish (`0.1.0`) had to be cut BY HAND** — OIDC Trusted
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
