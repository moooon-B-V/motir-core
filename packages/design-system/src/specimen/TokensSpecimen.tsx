'use client';

// A minimal, self-contained render of the extracted design system — the
// package's answer to motir-core's `/tokens` route, so the extraction is
// VERIFIABLE IN ISOLATION (the card's acceptance criterion). It composes the
// real primitives, the live `StyleVignette` preview, and a swatch grid of the
// `--el-*` element tokens, all under a `ThemeProvider`, so a consumer (or a
// screenshot / unit render) can confirm the tokens + components behave without
// wiring the package into an app first.
//
// It reads the axis registries directly to render one scoped `StyleVignette`
// per style / palette — the same pattern motir-core's tokens route + onboarding
// galleries use — proving the `[data-style]` / `[data-palette]` swap layers in
// `theme.css` are intact.

import { ThemeProvider } from '../contexts/theme-context';
import { STYLE_IDS } from '../theme/styles';
import { PALETTE_IDS } from '../theme/palettes';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { Pill } from '../components/ui/Pill';
import { SectionLabel } from '../components/ui/SectionLabel';
import { StyleVignette } from '../components/theme/StyleVignette';

/** The `--el-*` element tokens the swatch grid samples (a representative slice). */
const SWATCH_TOKENS = [
  '--el-accent',
  '--el-surface',
  '--el-text',
  '--el-text-muted',
  '--el-border',
  '--el-success',
  '--el-warning',
  '--el-danger',
  '--el-info',
  '--el-type-story',
] as const;

function Swatches() {
  return (
    <div className="flex flex-wrap gap-2">
      {SWATCH_TOKENS.map((token) => (
        <div key={token} className="flex flex-col items-center gap-1">
          <span
            className="size-10 rounded-(--radius-control) border border-(--el-border)"
            style={{ background: `var(${token})` }}
            aria-hidden
          />
          <span className="text-[10px] text-(--el-text-muted)">{token.replace('--el-', '')}</span>
        </div>
      ))}
    </div>
  );
}

export interface TokensSpecimenProps {
  className?: string;
}

/**
 * The design-system isolation specimen. Wrap-free: it mounts its own
 * `ThemeProvider`, so it can be dropped into any route (or a headless render)
 * to see the whole system at once.
 */
export function TokensSpecimen({ className }: TokensSpecimenProps) {
  return (
    <ThemeProvider>
      <div className={className} data-surface="page">
        <div className="mx-auto flex max-w-[64rem] flex-col gap-8 p-8">
          <header className="flex flex-col gap-1">
            <h1 className="font-serif text-2xl font-semibold text-(--el-text)">
              @motir/design-system
            </h1>
            <p className="text-sm text-(--el-text-muted)">
              Colour · Style · Type — the extracted 3-axis system, rendered in isolation.
            </p>
          </header>

          <section className="flex flex-col gap-3">
            <SectionLabel>Element tokens</SectionLabel>
            <Swatches />
          </section>

          <section className="flex flex-col gap-3">
            <SectionLabel>Primitives</SectionLabel>
            <Card className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary">Primary</Button>
                <Button variant="secondary">Secondary</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="danger">Danger</Button>
                <Pill status="in-progress">In progress</Pill>
              </div>
              <Input label="Work item title" placeholder="Ship the billing flow" />
            </Card>
          </section>

          <section className="flex flex-col gap-3">
            <SectionLabel>Style axis (data-style)</SectionLabel>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {STYLE_IDS.map((styleId) => (
                <StyleVignette key={styleId} styleId={styleId} label={`Style: ${styleId}`} />
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <SectionLabel>Palette axis (data-palette)</SectionLabel>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {PALETTE_IDS.map((palette) => (
                <StyleVignette key={palette} palette={palette} label={`Palette: ${palette}`} />
              ))}
            </div>
          </section>
        </div>
      </div>
    </ThemeProvider>
  );
}

export default TokensSpecimen;
