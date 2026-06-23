'use client';

import { Fragment, useState } from 'react';
import {
  BarChart3,
  BookOpen,
  ChevronsUpDown,
  CircleDot,
  Columns3,
  LayoutDashboard,
  MessageSquareOff,
  Plus,
  Send,
  Settings,
  Sparkles,
  Users,
} from 'lucide-react';
import { useTheme } from '@/lib/contexts/theme-context';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { ISSUE_TYPES } from '@/lib/issues/parentRules';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import {
  BarChart,
  LineChart,
  DonutChart,
  DifferenceAreaChart,
  chartColor,
} from '@/components/ui/charts';
import { Card } from '@/components/ui/Card';
import { CommandPalette, type CommandGroup } from '@/components/ui/CommandPalette';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { Sidebar, type SidebarSection } from '@/components/ui/Sidebar';
import { SidebarDrawer } from '@/components/ui/SidebarDrawer';
import { SidebarToggle } from '@/components/ui/SidebarToggle';
import { Spinner } from '@/components/ui/Spinner';
import { Textarea } from '@/components/ui/Textarea';
import { Tooltip } from '@/components/ui/Tooltip';
import type { ThemePattern } from '@/lib/theme/types';
import { STYLE_DIMENSIONS, STYLE_REGISTRY, STYLE_IDS } from '@/lib/theme/styles';
import { StyleVignette } from '@/components/theme/StyleVignette';

// Identity hues (MOTIR-1274 · 1266.3) — the dedicated --el-* families that
// un-collapsed the shared --el-tint-* pool (roles / org-roles / privacy / labels
// / avatars) plus the decoupled --el-notif-* / --el-model-* tokens. Each row is a
// [token, label]; the specimen renders the resolved hue so a palette swap is
// visible here. design/design-system/design-notes.md §D.
const IDENTITY_HUE_GROUPS: { heading: string; tokens: [string, string][] }[] = [
  {
    heading: 'Roles · org-roles · privacy',
    tokens: [
      ['--el-role-admin', 'role admin'],
      ['--el-role-member', 'role member'],
      ['--el-role-viewer', 'role viewer'],
      ['--el-org-role-owner', 'org owner'],
      ['--el-org-role-admin', 'org admin'],
      ['--el-org-role-member', 'org member'],
      ['--el-privacy-private', 'privacy private'],
      ['--el-privacy-public', 'privacy public'],
    ],
  },
  {
    heading: 'Label ramp',
    tokens: [1, 2, 3, 4, 5, 6].map((n) => [`--el-label-${n}`, `label ${n}`] as [string, string]),
  },
  {
    heading: 'Avatar ramp',
    tokens: [
      ['--el-avatar-peach', 'avatar peach'],
      ['--el-avatar-rose', 'avatar rose'],
      ['--el-avatar-mint', 'avatar mint'],
      ['--el-avatar-lavender', 'avatar lavender'],
      ['--el-avatar-sky', 'avatar sky'],
      ['--el-avatar-yellow', 'avatar yellow'],
      ['--el-avatar-fallback', 'avatar fallback'],
    ],
  },
  {
    heading: 'Notification badges · AI model dots',
    tokens: [
      ['--el-notif-mentioned', 'notif mentioned'],
      ['--el-notif-commented', 'notif commented'],
      ['--el-notif-assigned', 'notif assigned'],
      ['--el-notif-transitioned', 'notif transitioned'],
      ['--el-model-opus', 'model opus'],
      ['--el-model-sonnet', 'model sonnet'],
      ['--el-model-haiku', 'model haiku'],
      ['--el-model-deepseek', 'model deepseek'],
    ],
  },
];

// Interaction / agile surfaces (MOTIR-1276 · 1266.5) — the dedicated --el-*
// families that un-collapsed the dnd / selection / overdue / accent meanings
// off the shared --el-tint-lavender / --el-accent pool. Each row is a
// [token, label]; the specimen renders the resolved hue so a palette swap is
// visible here. design/design-system/design-notes.md §G.
const INTERACTION_AGILE_GROUPS: { heading: string; tokens: [string, string][] }[] = [
  {
    heading: 'Drag · drop · selection',
    tokens: [
      ['--el-selection-bg', 'selection bg'],
      ['--el-droptarget-bg', 'drop-target bg'],
      ['--el-board-column-accent', 'column accent'],
    ],
  },
  {
    heading: 'Due dates',
    tokens: [
      ['--el-overdue', 'overdue'],
      ['--el-due-soon', 'due soon'],
    ],
  },
  {
    heading: 'Agile accents',
    tokens: [
      ['--el-sprint-accent', 'sprint accent'],
      ['--el-epic-accent', 'epic accent'],
      ['--el-archived-pill-bg', 'archived pill bg'],
      ['--el-archived-pill-text', 'archived pill text'],
    ],
  },
  {
    heading: 'Tab nav · auth wash · card icon · vote',
    tokens: [
      ['--el-tabnav-track', 'tabnav track'],
      ['--el-tabnav-active', 'tabnav active'],
      ['--el-auth-wash', 'auth wash'],
      ['--el-card-icon-bg', 'card-icon bg'],
      ['--el-card-icon-fg', 'card-icon fg'],
      ['--el-vote-bg', 'vote bg'],
    ],
  },
];

/**
 * /tokens — the design system reference route.
 *
 * Renders every token category (colors, typography, radius, shadow,
 * spacing) as visual swatches/specimens. Interactive theme + style
 * toggles at the top so reviewers can flip and verify the system responds
 * correctly via CSS variables only — no React re-render on toggle.
 *
 * This route is the "living spec" of the design system. Future Subtasks
 * (1.0.5.2 primitives) will extend it with component examples.
 */

const COLOR_TOKENS = [
  // Brand & primary
  { name: 'primary', label: 'Primary (CTA)' },
  { name: 'primary-foreground', label: 'On Primary' },
  // Surfaces
  { name: 'background', label: 'Background' },
  { name: 'foreground', label: 'Foreground' },
  { name: 'surface', label: 'Surface' },
  { name: 'surface-soft', label: 'Surface Soft' },
  // Text scale
  { name: 'ink', label: 'Ink' },
  { name: 'charcoal', label: 'Charcoal' },
  { name: 'slate', label: 'Slate' },
  { name: 'steel', label: 'Steel' },
  { name: 'stone', label: 'Stone' },
  { name: 'muted-foreground', label: 'Muted Foreground' },
  // Hairlines
  { name: 'hairline', label: 'Hairline' },
  { name: 'hairline-strong', label: 'Hairline Strong' },
  { name: 'border', label: 'Border' },
  // Accents
  { name: 'accent', label: 'Accent (Pink)' },
  { name: 'accent-orange', label: 'Accent Orange' },
  { name: 'accent-teal', label: 'Accent Teal' },
  { name: 'accent-green', label: 'Accent Green' },
  // Tints
  { name: 'tint-peach', label: 'Tint Peach' },
  { name: 'tint-rose', label: 'Tint Rose' },
  { name: 'tint-mint', label: 'Tint Mint' },
  { name: 'tint-lavender', label: 'Tint Lavender' },
  { name: 'tint-sky', label: 'Tint Sky' },
  { name: 'tint-yellow', label: 'Tint Yellow' },
  // Semantic
  { name: 'success', label: 'Success' },
  { name: 'warning', label: 'Warning' },
  { name: 'destructive', label: 'Destructive' },
  { name: 'info', label: 'Info' },
  { name: 'link', label: 'Link' },
] as const;

const TYPE_SCALE = [
  { token: '--font-size-xs', label: 'xs / 12px', value: '0.75rem' },
  { token: '--font-size-sm', label: 'sm / 14px', value: '0.875rem' },
  { token: '--font-size-base', label: 'base / 16px', value: '1rem' },
  { token: '--font-size-lg', label: 'lg / 20px', value: '1.25rem' },
  { token: '--font-size-xl', label: 'xl / 24px', value: '1.5rem' },
  { token: '--font-size-2xl', label: '2xl / 32px', value: '2rem' },
  { token: '--font-size-3xl', label: '3xl / 48px', value: '3rem' },
  { token: '--font-size-display', label: 'display / 80px', value: '5rem' },
] as const;

const RADIUS_TOKENS = [
  { name: '--radius-xs', label: 'xs' },
  { name: '--radius-sm', label: 'sm' },
  { name: '--radius-md', label: 'md' },
  { name: '--radius-lg', label: 'lg' },
  { name: '--radius-xl', label: 'xl' },
  { name: '--radius-pill', label: 'pill' },
  { name: '--radius-btn', label: 'btn (semantic)' },
  { name: '--radius-card', label: 'card (semantic)' },
] as const;

const SHADOW_TOKENS = [
  { name: '--shadow-subtle', label: 'Subtle' },
  { name: '--shadow-card', label: 'Card' },
  { name: '--shadow-elevated', label: 'Elevated' },
  { name: '--shadow-modal', label: 'Modal' },
  { name: '--shadow-hero-mockup', label: 'Hero Mockup' },
] as const;

const SPACING_TOKENS = [
  { name: '--spacing-xxs', label: 'xxs / 4px' },
  { name: '--spacing-xs', label: 'xs / 8px' },
  { name: '--spacing-sm', label: 'sm / 12px' },
  { name: '--spacing-md', label: 'md / 16px' },
  { name: '--spacing-lg', label: 'lg / 20px' },
  { name: '--spacing-xl', label: 'xl / 24px' },
  { name: '--spacing-2xl', label: '2xl / 32px' },
  { name: '--spacing-3xl', label: '3xl / 40px' },
] as const;

const PATTERN_OPTIONS: { value: ThemePattern; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

// Style options are derived from the named-style registry (lib/theme/styles.ts)
// so a newly-registered style appears here automatically.
const STYLE_OPTIONS = STYLE_IDS.map((id) => ({
  value: id,
  label: STYLE_REGISTRY[id].name,
}));

/**
 * The 7.3.37 preview vignette — the composed mini-surface that makes a style's
 * FEEL legible (not a swatch table). One LIVE vignette that follows the toggles
 * above, plus a SCOPED row showing every registered style at once (each pinned
 * via `styleId`, all inheriting the active palette + type) — the exact pattern
 * the onboarding Style gallery (7.3.27) and the Appearance pane (7.3.58) reuse.
 */
function StylePreview() {
  return (
    <section
      style={{
        marginBottom: 'var(--spacing-section)',
        scrollMarginTop: 'var(--spacing-xl)',
      }}
    >
      <h2
        className="font-serif text-2xl font-semibold"
        style={{ marginBottom: 'var(--spacing-sm)' }}
      >
        Style preview vignette
      </h2>
      <p
        className="text-sm"
        style={{
          color: 'var(--el-page-text-muted)',
          marginBottom: 'var(--spacing-lg)',
          maxWidth: '64ch',
          lineHeight: 1.5,
        }}
      >
        A composed mini-surface — nav, work-item card, search input, button row, and a floating
        modal — rendered live under the design tokens. The first follows the toggles above (live);
        the gallery row pins each registered style so you can compare the whole feel side by side,
        not a colour chip.
      </p>
      <div style={{ maxWidth: '520px', marginBottom: 'var(--spacing-2xl)' }}>
        <StyleVignette label="Live preview — follows the active style, palette, and type" />
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
          gap: 'var(--spacing-lg)',
        }}
      >
        {STYLE_IDS.map((id) => (
          <div
            key={id}
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}
          >
            <div className="font-mono text-xs" style={{ color: 'var(--el-page-text-muted)' }}>
              {STYLE_REGISTRY[id].name}
            </div>
            <StyleVignette styleId={id} label={`${STYLE_REGISTRY[id].name} style preview`} />
          </div>
        ))}
      </div>
    </section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  // Slug id so each specimen section is directly addressable (deep links, and a
  // scoped axe sweep — e.g. the Pill-matrix color-contrast assertion in
  // shell-a11y.spec.ts can target `#primitives-pill`).
  const id = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return (
    <section
      id={id}
      style={{
        marginBottom: 'var(--spacing-section)',
        paddingBottom: 'var(--spacing-xl)',
        borderBottom: '1px solid var(--el-border)',
      }}
    >
      <h2
        className="font-serif text-2xl font-semibold"
        style={{ marginBottom: 'var(--spacing-lg)' }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function Swatch({ name, label }: { name: string; label: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--spacing-xs)',
        padding: 'var(--spacing-md)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--el-border)',
      }}
    >
      {/* Decorative swatch — the label is rendered as visible text below, so
          no aria-label here (a bare <div> can't carry one; axe flags
          aria-prohibited-attr). aria-hidden keeps the empty chip out of the
          a11y tree entirely. */}
      <div
        aria-hidden
        style={{
          width: '100%',
          height: '64px',
          borderRadius: 'var(--radius-sm)',
          backgroundColor: `var(--color-${name})`,
          border: '1px solid var(--el-border)',
        }}
      />
      <div className="font-mono text-xs">
        <div className="font-medium">{label}</div>
        <div style={{ color: 'var(--el-page-text-muted)' }}>--color-{name}</div>
      </div>
    </div>
  );
}

function ThemeControls() {
  const { pattern, styleId, setPattern, setStyleId } = useTheme();
  const activeStyle = STYLE_REGISTRY[styleId];
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--spacing-xl)',
        padding: 'var(--spacing-lg)',
        marginBottom: 'var(--spacing-section)',
        borderRadius: 'var(--radius-card)',
        backgroundColor: 'var(--el-surface)',
        border: '1px solid var(--el-border)',
      }}
    >
      <div>
        <div
          className="font-mono text-xs"
          style={{
            color: 'var(--el-page-text-muted)',
            marginBottom: 'var(--spacing-xs)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          Theme pattern
        </div>
        <div style={{ display: 'flex', gap: 'var(--spacing-xs)' }}>
          {PATTERN_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setPattern(opt.value)}
              aria-pressed={pattern === opt.value}
              style={{
                paddingInline: 'var(--spacing-md)',
                paddingBlock: 'var(--spacing-xs)',
                borderRadius: 'var(--radius-pill)',
                border: `1px solid ${pattern === opt.value ? 'var(--color-primary)' : 'var(--el-border)'}`,
                backgroundColor: pattern === opt.value ? 'var(--color-primary)' : 'transparent',
                color:
                  pattern === opt.value ? 'var(--color-primary-foreground)' : 'var(--el-page-text)',
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--font-size-sm)',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <div
          className="font-mono text-xs"
          style={{
            color: 'var(--el-page-text-muted)',
            marginBottom: 'var(--spacing-xs)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          Style
        </div>
        <div style={{ display: 'flex', gap: 'var(--spacing-xs)' }}>
          {STYLE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setStyleId(opt.value)}
              aria-pressed={styleId === opt.value}
              style={{
                paddingInline: 'var(--spacing-md)',
                paddingBlock: 'var(--spacing-xs)',
                borderRadius: 'var(--radius-pill)',
                border: `1px solid ${styleId === opt.value ? 'var(--color-primary)' : 'var(--el-border)'}`,
                backgroundColor: styleId === opt.value ? 'var(--color-primary)' : 'transparent',
                color:
                  styleId === opt.value ? 'var(--color-primary-foreground)' : 'var(--el-page-text)',
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--font-size-sm)',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      {/* The active style's identity: tagline, its DESIGN.md mapping, and the
          feel-bearing dimensions a token-only swap would miss (7.3.32). The
          /tokens composer (7.3.30) builds on this mapping. */}
      <div style={{ flexBasis: '100%' }}>
        <div
          className="font-mono text-xs"
          style={{
            color: 'var(--el-page-text-muted)',
            marginBottom: 'var(--spacing-xs)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          Active style → DESIGN.md
        </div>
        <p
          className="text-sm"
          style={{ color: 'var(--el-page-text)', marginBottom: 'var(--spacing-xs)' }}
        >
          <strong>{activeStyle.name}</strong> — {activeStyle.tagline}
        </p>
        <p className="font-mono text-xs" style={{ color: 'var(--el-page-text-muted)' }}>
          {activeStyle.designDoc}
        </p>
        <dl
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            columnGap: 'var(--spacing-md)',
            rowGap: 'var(--spacing-xxs)',
            marginTop: 'var(--spacing-sm)',
          }}
        >
          {STYLE_DIMENSIONS.map((dim) => (
            <Fragment key={dim.key}>
              <dt
                className="font-mono text-xs"
                style={{ color: 'var(--el-page-text-muted)', whiteSpace: 'nowrap' }}
              >
                {dim.label}
              </dt>
              <dd className="text-xs" style={{ color: 'var(--el-page-text)', margin: 0 }}>
                {activeStyle.dimensions[dim.key]}
              </dd>
            </Fragment>
          ))}
        </dl>
      </div>
    </div>
  );
}

export default function TokensPage() {
  return (
    <main
      style={{
        maxWidth: '1100px',
        margin: '0 auto',
        padding: 'var(--spacing-3xl) var(--spacing-xl)',
      }}
    >
      <header style={{ marginBottom: 'var(--spacing-section)' }}>
        <p
          className="font-mono text-xs"
          style={{
            color: 'var(--el-page-text-muted)',
            marginBottom: 'var(--spacing-xs)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          Motir design system
        </p>
        <h1 className="font-serif text-4xl font-semibold tracking-tight">Tokens</h1>
        <p
          className="text-base"
          style={{
            color: 'var(--el-page-text-muted)',
            marginTop: 'var(--spacing-sm)',
            maxWidth: '60ch',
            lineHeight: 1.5,
          }}
        >
          Live reference for every design token. Toggle the theme + style below and watch the system
          respond via CSS variables only — no React re-renders on toggle.
        </p>
      </header>

      <ThemeControls />

      <StylePreview />

      <Section title="Typography">
        <div style={{ marginBottom: 'var(--spacing-2xl)' }}>
          <p
            className="font-mono text-xs"
            style={{
              color: 'var(--el-page-text-muted)',
              marginBottom: 'var(--spacing-md)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            Font families
          </p>
          <div style={{ display: 'grid', gap: 'var(--spacing-md)' }}>
            <div>
              <div className="font-mono text-xs" style={{ color: 'var(--el-page-text-muted)' }}>
                font-sans · Inter
              </div>
              <div className="font-sans text-xl">The quick brown fox jumps over the lazy dog.</div>
            </div>
            <div>
              <div className="font-mono text-xs" style={{ color: 'var(--el-page-text-muted)' }}>
                font-serif · Source Serif 4
              </div>
              <div className="font-serif text-xl">The quick brown fox jumps over the lazy dog.</div>
            </div>
            <div>
              <div className="font-mono text-xs" style={{ color: 'var(--el-page-text-muted)' }}>
                font-mono · JetBrains Mono
              </div>
              <div className="font-mono text-xl">The quick brown fox jumps over the lazy dog.</div>
            </div>
          </div>
        </div>
        <div>
          <p
            className="font-mono text-xs"
            style={{
              color: 'var(--el-page-text-muted)',
              marginBottom: 'var(--spacing-md)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            Type scale
          </p>
          <div style={{ display: 'grid', gap: 'var(--spacing-md)' }}>
            {TYPE_SCALE.map((t) => (
              <div
                key={t.token}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '140px 1fr',
                  alignItems: 'baseline',
                  gap: 'var(--spacing-md)',
                }}
              >
                <div className="font-mono text-xs" style={{ color: 'var(--el-page-text-muted)' }}>
                  {t.label}
                </div>
                <div style={{ fontSize: `var(${t.token})`, lineHeight: 1.2 }}>Motir</div>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section title="Color">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: 'var(--spacing-md)',
          }}
        >
          {COLOR_TOKENS.map((c) => (
            <Swatch key={c.name} name={c.name} label={c.label} />
          ))}
        </div>
      </Section>

      <Section title="Issue type colours (--el-type-*)">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: 'var(--spacing-md)',
          }}
        >
          {ISSUE_TYPES.map((t) => (
            <div
              key={t}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--spacing-sm)',
                padding: 'var(--spacing-sm)',
                border: '1px solid var(--el-border)',
                borderRadius: 'var(--radius-card)',
              }}
            >
              <IssueTypeIcon type={t} className="h-5 w-5" />
              <div className="font-mono text-xs">
                <div style={{ color: 'var(--el-page-text)', textTransform: 'capitalize' }}>{t}</div>
                <div style={{ color: 'var(--el-page-text-muted)' }}>--el-type-{t}</div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Identity hues (--el-role-* / --el-org-role-* / --el-privacy-* / --el-label-* / --el-avatar-* / --el-notif-* / --el-model-*)">
        {IDENTITY_HUE_GROUPS.map((group) => (
          <div key={group.heading} style={{ marginBottom: 'var(--spacing-md)' }}>
            <div
              className="font-mono text-xs"
              style={{ color: 'var(--el-page-text-muted)', marginBottom: 'var(--spacing-sm)' }}
            >
              {group.heading}
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: 'var(--spacing-md)',
              }}
            >
              {group.tokens.map(([token, label]) => (
                <div
                  key={token}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--spacing-sm)',
                    padding: 'var(--spacing-sm)',
                    border: '1px solid var(--el-border)',
                    borderRadius: 'var(--radius-card)',
                  }}
                >
                  {/* Decorative resolved-hue chip; the token name is visible text
                      below, so no aria-label (axe aria-prohibited-attr). */}
                  <div
                    aria-hidden
                    style={{
                      width: '20px',
                      height: '20px',
                      flex: 'none',
                      borderRadius: 'var(--radius-badge)',
                      backgroundColor: `var(${token})`,
                      border: '1px solid var(--el-border)',
                    }}
                  />
                  <div className="font-mono text-xs">
                    <div style={{ color: 'var(--el-page-text)' }}>{label}</div>
                    <div style={{ color: 'var(--el-page-text-muted)' }}>{token}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </Section>

      <Section title="Interaction / agile (--el-selection-bg / --el-droptarget-bg / --el-overdue / --el-sprint-accent / --el-tabnav-* / --el-card-icon-* …)">
        {INTERACTION_AGILE_GROUPS.map((group) => (
          <div key={group.heading} style={{ marginBottom: 'var(--spacing-md)' }}>
            <div
              className="font-mono text-xs"
              style={{ color: 'var(--el-page-text-muted)', marginBottom: 'var(--spacing-sm)' }}
            >
              {group.heading}
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: 'var(--spacing-md)',
              }}
            >
              {group.tokens.map(([token, label]) => (
                <div
                  key={token}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--spacing-sm)',
                    padding: 'var(--spacing-sm)',
                    border: '1px solid var(--el-border)',
                    borderRadius: 'var(--radius-card)',
                  }}
                >
                  {/* Decorative resolved-hue chip; the token name is visible text
                      below, so no aria-label (axe aria-prohibited-attr). */}
                  <div
                    aria-hidden
                    style={{
                      width: '20px',
                      height: '20px',
                      flex: 'none',
                      borderRadius: 'var(--radius-badge)',
                      backgroundColor: `var(${token})`,
                      border: '1px solid var(--el-border)',
                    }}
                  />
                  <div className="font-mono text-xs">
                    <div style={{ color: 'var(--el-page-text)' }}>{label}</div>
                    <div style={{ color: 'var(--el-page-text-muted)' }}>{token}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </Section>

      <Section title="Radius">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
            gap: 'var(--spacing-md)',
          }}
        >
          {RADIUS_TOKENS.map((r) => (
            <div
              key={r.name}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--spacing-xs)',
                padding: 'var(--spacing-md)',
                border: '1px solid var(--el-border)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <div
                style={{
                  width: '100%',
                  height: '64px',
                  borderRadius: `var(${r.name})`,
                  backgroundColor: 'var(--color-surface)',
                  border: '1px solid var(--el-border-strong)',
                }}
              />
              <div className="font-mono text-xs">
                <div className="font-medium">{r.label}</div>
                <div style={{ color: 'var(--el-page-text-muted)' }}>{r.name}</div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Shadow">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 'var(--spacing-xl)',
          }}
        >
          {SHADOW_TOKENS.map((s) => (
            <div key={s.name} style={{ padding: 'var(--spacing-md)' }}>
              <div
                style={{
                  width: '100%',
                  height: '80px',
                  borderRadius: 'var(--radius-md)',
                  backgroundColor: 'var(--color-surface)',
                  boxShadow: `var(${s.name})`,
                  marginBottom: 'var(--spacing-sm)',
                }}
              />
              <div className="font-mono text-xs">
                <div className="font-medium">{s.label}</div>
                <div style={{ color: 'var(--el-page-text-muted)' }}>{s.name}</div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Spacing">
        <div style={{ display: 'grid', gap: 'var(--spacing-xs)' }}>
          {SPACING_TOKENS.map((s) => (
            <div
              key={s.name}
              style={{
                display: 'grid',
                gridTemplateColumns: '160px 1fr',
                alignItems: 'center',
                gap: 'var(--spacing-md)',
              }}
            >
              <div className="font-mono text-xs">{s.label}</div>
              <div
                style={{
                  height: '16px',
                  width: `var(${s.name})`,
                  backgroundColor: 'var(--color-primary)',
                  borderRadius: 'var(--radius-xs)',
                }}
              />
            </div>
          ))}
        </div>
      </Section>

      <Section title="Primitives — Button">
        <p
          className="text-sm"
          style={{ color: 'var(--el-page-text-muted)', marginBottom: 'var(--spacing-md)' }}
        >
          Variant × size grid. Toggle <code className="font-mono text-xs">data-style</code> to see
          shapes flip — CSS only.
        </p>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto repeat(3, 1fr)',
            gap: 'var(--spacing-md)',
            alignItems: 'center',
          }}
        >
          <div />
          <div className="font-mono text-xs">sm</div>
          <div className="font-mono text-xs">md</div>
          <div className="font-mono text-xs">lg</div>
          {(['primary', 'secondary', 'ghost', 'danger'] as const).map((variant) => (
            <div key={variant} style={{ display: 'contents' }}>
              <div className="font-mono text-xs">{variant}</div>
              <Button variant={variant} size="sm">
                Action
              </Button>
              <Button variant={variant} size="md">
                Action
              </Button>
              <Button variant={variant} size="lg">
                Action
              </Button>
            </div>
          ))}
        </div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--spacing-md)',
            marginTop: 'var(--spacing-lg)',
          }}
        >
          <Button leftIcon={<Plus className="h-4 w-4" />}>With left icon</Button>
          <Button rightIcon={<Sparkles className="h-4 w-4" />} variant="secondary">
            With right icon
          </Button>
          <Button loading>Loading</Button>
          <Button disabled>Disabled</Button>
        </div>
      </Section>

      <Section title="Primitives — Spinner">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--spacing-lg)',
            color: 'var(--color-primary)',
          }}
        >
          <Spinner size="sm" />
          <Spinner size="md" />
          <Spinner size="lg" />
          <span className="font-mono text-xs" style={{ color: 'var(--el-page-text-muted)' }}>
            sm · md · lg (inherits color from parent)
          </span>
        </div>
      </Section>

      <Section title="Primitives — Input + Textarea">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: 'var(--spacing-lg)',
          }}
        >
          <Input label="Email" type="email" placeholder="you@example.com" />
          <Input
            label="With helper text"
            placeholder="Type something"
            helperText="We'll never share it."
          />
          <Input label="Error state" placeholder="bad value" error="That email isn't valid." />
          <Input
            label="With addons"
            placeholder="motir"
            addonStart={<span className="font-mono text-xs">https://</span>}
            addonEnd={<span className="font-mono text-xs">.dev</span>}
          />
          <Input label="Disabled" placeholder="Can't edit" disabled />
          <Textarea label="Textarea" placeholder="Multi-line input…" rows={3} />
        </div>
      </Section>

      <Section title="Primitives — Card">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: 'var(--spacing-md)',
          }}
        >
          <Card header={<h3 className="font-serif text-lg font-semibold">Default card</h3>}>
            <p className="text-sm" style={{ color: 'var(--el-page-text-muted)' }}>
              Canvas background, hairline border.
            </p>
          </Card>
          <Card tint="lavender">
            <p className="text-sm">Lavender tint</p>
          </Card>
          <Card tint="mint">
            <p className="text-sm">Mint tint</p>
          </Card>
          <Card tint="peach">
            <p className="text-sm">Peach tint</p>
          </Card>
          <Card
            tint="sky"
            footer={
              <p className="font-mono text-xs" style={{ color: 'var(--el-page-text-muted)' }}>
                with footer slot
              </p>
            }
          >
            <p className="text-sm">Sky tint + footer</p>
          </Card>
          <Card clickable onClick={() => undefined}>
            <p className="text-sm">Clickable (hover for shadow)</p>
          </Card>
        </div>
      </Section>

      <Section title="Primitives — Pill">
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--spacing-sm)',
            alignItems: 'center',
          }}
        >
          <div
            className="font-mono text-xs"
            style={{ color: 'var(--el-page-text-muted)', marginRight: 'var(--spacing-sm)' }}
          >
            status
          </div>
          <Pill status="planned">Planned</Pill>
          <Pill status="in-progress">In progress</Pill>
          <Pill status="done">Done</Pill>
        </div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--spacing-sm)',
            alignItems: 'center',
            marginTop: 'var(--spacing-md)',
          }}
        >
          <div
            className="font-mono text-xs"
            style={{ color: 'var(--el-page-text-muted)', marginRight: 'var(--spacing-sm)' }}
          >
            severity
          </div>
          <Pill severity="info">Info</Pill>
          <Pill severity="success">Success</Pill>
          <Pill severity="warning">Warning</Pill>
          <Pill severity="danger">Danger</Pill>
        </div>
      </Section>

      <Section title="Primitives — Tooltip">
        <div style={{ display: 'flex', gap: 'var(--spacing-md)', flexWrap: 'wrap' }}>
          <Tooltip content="Tooltip on top">
            <Button variant="secondary">Hover or focus me (top)</Button>
          </Tooltip>
          <Tooltip content="Tooltip on right" side="right">
            <Button variant="secondary">Right</Button>
          </Tooltip>
          <Tooltip content="Tooltip on bottom" side="bottom">
            <Button variant="secondary">Bottom</Button>
          </Tooltip>
        </div>
      </Section>

      <Section title="Primitives — Modal">
        <ModalDemo />
      </Section>

      <Section title="Primitives — Toast">
        <ToastDemo />
      </Section>

      <Section title="Primitives — CommandPalette">
        <p
          className="text-sm"
          style={{ color: 'var(--el-page-text-muted)', marginBottom: 'var(--spacing-md)' }}
        >
          The generic ⌘K launcher (Subtask 1.5.4). Open it, then exercise the variant matrix live:
          an <strong>empty query</strong> shows all actions grouped by heading; typing narrows by
          substring (try <code className="font-mono text-xs">iss</code> for the{' '}
          <strong>filtered</strong> state, or <code className="font-mono text-xs">zzz</code> for the{' '}
          <strong>empty-results</strong> state). ↑↓ navigate, ↵ selects, esc closes.
        </p>
        <CommandPaletteDemo />
      </Section>

      <Section title="Patterns — EmptyState">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: 'var(--spacing-md)',
          }}
        >
          <EmptyState
            title="No projects yet"
            description="Create your first project to get started — projects group related tasks, threads, and decisions."
            action={<Button leftIcon={<Plus className="h-4 w-4" />}>New project</Button>}
          />
          <EmptyState
            icon={<MessageSquareOff className="h-12 w-12" aria-hidden />}
            title="No comments"
            description="Be the first to comment on this task."
            action={<Button variant="secondary">Add comment</Button>}
          />
        </div>
      </Section>

      <Section title="Patterns — ErrorState">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: 'var(--spacing-md)',
          }}
        >
          <ErrorState
            title="Couldn't load workspace"
            description="We couldn't reach the server. Check your connection and try again."
            retry={() => console.warn('[tokens] retry pressed')}
          />
          <ErrorState
            title="Webhook failed"
            description="Failed to deliver GitHub webhook event."
            error={new Error('POST /hooks/github → 502 Bad Gateway')}
            retry={() => console.warn('[tokens] webhook retry pressed')}
          />
        </div>
      </Section>

      <Section title="App shell">
        <p
          className="text-sm"
          style={{ color: 'var(--el-page-text-muted)', marginBottom: 'var(--spacing-lg)' }}
        >
          The navigation rail (Subtask 1.5.2). Expanded (240px) and collapsed (56px, icon-only with
          hover tooltips) share the <code className="font-mono text-xs">useSidebarCollapsed</code>{' '}
          store; the mobile drawer slides in over a scrim. The active row uses{' '}
          <code className="font-mono text-xs">--el-sidebar-item-bg-active</code>; hover any other
          row for <code className="font-mono text-xs">--el-sidebar-item-bg-hover</code>.
        </p>
        <AppShellDemo />
      </Section>

      <Section title="Charts — viz primitives (Stories 4.6 + 6.3)">
        <p
          className="text-sm"
          style={{ color: 'var(--el-page-text-muted)', marginBottom: 'var(--spacing-lg)' }}
        >
          The reusable token-aware SVG chart layer — a{' '}
          <code className="font-mono text-xs">LineChart</code> (the burndown) and a grouped{' '}
          <code className="font-mono text-xs">BarChart</code> (the velocity) from Subtask 4.6.2,
          plus the <code className="font-mono text-xs">DonutChart</code> (distribution) and{' '}
          <code className="font-mono text-xs">DifferenceAreaChart</code> (created-vs-resolved) Story
          6.3 (Subtask 6.3.4) grows into the same layer. No charting library: hand-rolled SVG
          consuming the <code className="font-mono text-xs">--el-chart-*</code> tokens (incl. the
          new <code className="font-mono text-xs">--el-chart-cat-*</code> ramp +{' '}
          <code className="font-mono text-xs">--el-chart-deficit/surplus</code> fills). Every chart
          ships a visible legend, a <code className="font-mono text-xs">role=&quot;img&quot;</code>{' '}
          <code className="font-mono text-xs">&lt;desc&gt;</code> summary, and a data-table fallback
          (open &ldquo;View data table&rdquo;) so the series read as text+number, never colour alone
          (finding #35). Toggle the theme above to confirm dark-mode parity.
        </p>
        <ChartsSpecimen />
      </Section>
    </main>
  );
}

/** The 4.6.2 chart primitives rendered with the `charts.mock.html` sample data. */
function ChartsSpecimen() {
  return (
    <div style={{ display: 'grid', gap: 'var(--spacing-xl)', maxWidth: 640 }}>
      <Card header={<h3 className="font-serif text-lg font-semibold">Burndown — Sprint 6</h3>}>
        <LineChart
          width={600}
          height={300}
          margin={{ top: 24, right: 24, bottom: 46, left: 44 }}
          x={{
            domain: [0, 10],
            title: 'Sprint day',
            ticks: Array.from({ length: 11 }, (_, d) => ({ value: d, label: String(d) })),
          }}
          y={{
            domain: [0, 42],
            title: 'Points remaining',
            ticks: [0, 10, 20, 30, 40].map((v) => ({ value: v, label: String(v) })),
          }}
          description="Burndown for Sprint 6, a completed 10-day sprint. Guideline falls from 42 committed on day 0 to 0 on day 10. Actual remaining steps down to 35 by day 2, rises to 39 on day 3 when 4 points of scope were added, then falls to 13 remaining at completion."
          ariaLabel="Sprint 6 burndown"
          series={[
            {
              id: 'guideline',
              label: 'Guideline (ideal)',
              color: chartColor.guideline,
              dashed: true,
              strokeWidth: 2,
              points: [
                { x: 0, y: 42 },
                { x: 10, y: 0 },
              ],
            },
            {
              id: 'actual',
              label: 'Remaining (actual)',
              color: chartColor.actual,
              interpolation: 'step',
              strokeWidth: 2.75,
              points: [
                { x: 0, y: 42 },
                { x: 2, y: 35 },
                { x: 3, y: 39 },
                { x: 5, y: 31 },
                { x: 8, y: 20 },
                { x: 10, y: 13 },
              ],
            },
          ]}
          annotations={[
            { x: 0, y: 42, color: chartColor.actual, shape: 'circle', label: '42 committed' },
            { x: 3, y: 39, color: chartColor.scope, shape: 'diamond', label: '+4 scope' },
            {
              x: 10,
              y: 13,
              color: chartColor.actual,
              shape: 'circle',
              label: '13 left',
              labelAnchor: 'end',
              labelDy: 16,
            },
          ]}
          legend={[
            { label: 'Guideline (ideal)', color: chartColor.guideline, kind: 'dash' },
            { label: 'Remaining (actual)', color: chartColor.actual, kind: 'line', emphasis: true },
            { label: 'Scope added', color: chartColor.scope, kind: 'swatch' },
          ]}
          dataTable={{
            caption: 'Sprint 6 burndown — points remaining by day (end-of-day).',
            columns: ['Day', 'Guideline', 'Remaining'],
            rows: [
              {
                header: '0',
                cells: [
                  { value: 42, numeric: true },
                  { value: 42, numeric: true },
                ],
              },
              {
                header: '2',
                cells: [
                  { value: 34, numeric: true },
                  { value: 35, numeric: true },
                ],
              },
              {
                header: '3',
                cells: [
                  { value: 29, numeric: true },
                  { value: 39, numeric: true },
                ],
              },
              {
                header: '5',
                cells: [
                  { value: 21, numeric: true },
                  { value: 31, numeric: true },
                ],
              },
              {
                header: '8',
                cells: [
                  { value: 8, numeric: true },
                  { value: 20, numeric: true },
                ],
              },
              {
                header: '10',
                cells: [
                  { value: 0, numeric: true },
                  { value: 13, numeric: true },
                ],
              },
            ],
          }}
        />
      </Card>

      <Card header={<h3 className="font-serif text-lg font-semibold">Velocity</h3>}>
        <BarChart
          width={600}
          height={300}
          xTitle="Completed sprint (oldest → newest)"
          yTitle="Story points"
          yTicks={[0, 15, 30, 45].map((v) => ({ value: v, label: String(v) }))}
          description="Velocity over the last 7 completed sprints. Committed vs completed points per sprint: Sprint 18 30/24, Sprint 19 28/30, Sprint 20 32/22, Sprint 21 26/26, Sprint 22 34/28, Sprint 23 30/25, Sprint 24 42/29. Average completed is 26."
          ariaLabel="Velocity over the last 7 completed sprints"
          series={[
            { label: 'Committed', color: chartColor.committed },
            { label: 'Completed', color: chartColor.completed },
          ]}
          groups={[
            { label: 'S18', values: [30, 24] },
            { label: 'S19', values: [28, 30] },
            { label: 'S20', values: [32, 22] },
            { label: 'S21', values: [26, 26] },
            { label: 'S22', values: [34, 28] },
            { label: 'S23', values: [30, 25] },
            { label: 'S24', values: [42, 29] },
          ]}
          referenceLine={{
            value: 26,
            color: chartColor.average,
            label: 'avg 26',
            legendLabel: 'Average completed',
          }}
        />
      </Card>

      <Card
        header={<h3 className="font-serif text-lg font-semibold">Status distribution — donut</h3>}
      >
        <DonutChart
          size={220}
          totalNoun="issues"
          statisticLabel="Status"
          description="Donut of 80 issues by status: To Do 30 (37.5%), In Progress 16 (20%), Done 22 (27.5%), In Review 8 (10%), Blocked 4 (5%)."
          ariaLabel="Issues by status"
          data={[
            { label: 'To Do', value: 30 },
            { label: 'In Progress', value: 16 },
            { label: 'Done', value: 22 },
            { label: 'In Review', value: 8 },
            { label: 'Blocked', value: 4 },
          ]}
        />
      </Card>

      <Card
        header={
          <h3 className="font-serif text-lg font-semibold">
            Created vs Resolved — difference/area
          </h3>
        }
      >
        <DifferenceAreaChart
          width={600}
          height={300}
          x={{
            domain: [1, 12],
            title: 'Week',
            ticks: [1, 4, 8, 12].map((v) => ({ value: v, label: `W${v}` })),
          }}
          y={{
            domain: [0, 20],
            title: 'Issues / week',
            ticks: [0, 5, 10, 15, 20].map((v) => ({ value: v, label: String(v) })),
          }}
          description="Created vs resolved per week over 12 weeks. Created outpaces resolved through week 4 (backlog growing, shaded red), the lines meet at week 5, then resolved overtakes created (catching up, shaded green)."
          ariaLabel="Created vs resolved over 12 weeks"
          created={[
            { x: 1, y: 14 },
            { x: 2, y: 16 },
            { x: 3, y: 13 },
            { x: 4, y: 18 },
            { x: 5, y: 15 },
            { x: 6, y: 11 },
            { x: 7, y: 9 },
            { x: 8, y: 8 },
            { x: 9, y: 10 },
            { x: 10, y: 7 },
            { x: 11, y: 6 },
            { x: 12, y: 5 },
          ]}
          resolved={[
            { x: 1, y: 6 },
            { x: 2, y: 8 },
            { x: 3, y: 10 },
            { x: 4, y: 9 },
            { x: 5, y: 15 },
            { x: 6, y: 14 },
            { x: 7, y: 13 },
            { x: 8, y: 12 },
            { x: 9, y: 14 },
            { x: 10, y: 11 },
            { x: 11, y: 9 },
            { x: 12, y: 8 },
          ]}
        />
      </Card>
    </div>
  );
}

const SHELL_DEMO_SECTIONS: SidebarSection[] = [
  {
    id: 'primary',
    items: [
      { icon: <LayoutDashboard />, label: 'Dashboard', href: '#dashboard' },
      { icon: <CircleDot />, label: 'Issues', href: '#issues', active: true },
      { icon: <Columns3 />, label: 'Boards', href: '#boards' },
      { icon: <BarChart3 />, label: 'Reports', href: '#reports' },
    ],
  },
  {
    id: 'meta',
    items: [
      { icon: <Settings />, label: 'Settings', href: '#settings' },
      { icon: <BookOpen />, label: 'Docs', href: '#docs' },
    ],
  },
];

/** A ProjectSwitcher-shaped header specimen — collapsed shows just the avatar. */
function DemoProjectHeader({ collapsed }: { collapsed: boolean }) {
  if (collapsed) {
    return (
      <div
        aria-hidden
        className="mx-auto flex h-8 w-8 items-center justify-center rounded-(--radius-sm) bg-primary font-sans text-sm font-semibold text-primary-foreground"
      >
        M
      </div>
    );
  }
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-(--radius-sm) border border-(--el-sidebar-border) bg-background px-2 py-1.5 text-left"
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-(--radius-xs) bg-primary text-xs font-semibold text-primary-foreground">
        M
      </span>
      <span className="min-w-0 flex-1">
        <SectionLabel label="Project" />
        <span className="block truncate font-sans text-sm font-medium text-foreground">
          Mobile App
        </span>
      </span>
      <ChevronsUpDown className="h-4 w-4 shrink-0 text-(--color-muted-foreground)" aria-hidden />
    </button>
  );
}

function AppShellDemo() {
  const [collapsedPreview, setCollapsedPreview] = useState(false);

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2xl)' }}>
      {/* (a) Expanded */}
      <div>
        <div
          className="font-mono text-xs"
          style={{ color: 'var(--el-page-text-muted)', marginBottom: 'var(--spacing-sm)' }}
        >
          Expanded · 240px
        </div>
        <div
          style={{ width: 240, height: 420 }}
          className="overflow-hidden rounded-(--radius-card) border border-(--el-sidebar-border)"
        >
          <Sidebar
            collapsed={false}
            header={<DemoProjectHeader collapsed={false} />}
            sections={SHELL_DEMO_SECTIONS}
            footer={<SidebarToggle variant="footer" />}
          />
        </div>
      </div>

      {/* (b) Collapsed — driven by a local useState boolean */}
      <div>
        <div
          className="font-mono text-xs"
          style={{ color: 'var(--el-page-text-muted)', marginBottom: 'var(--spacing-sm)' }}
        >
          Collapsed · {collapsedPreview ? '56px' : '240px'} (local toggle)
        </div>
        <div
          style={{ width: collapsedPreview ? 56 : 240, height: 420 }}
          className="overflow-hidden rounded-(--radius-card) border border-(--el-sidebar-border)"
        >
          <Sidebar
            collapsed={collapsedPreview}
            header={<DemoProjectHeader collapsed={collapsedPreview} />}
            sections={SHELL_DEMO_SECTIONS}
            footer={
              <Button
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={() => setCollapsedPreview((c) => !c)}
              >
                {collapsedPreview ? '»' : '« Collapse'}
              </Button>
            }
          />
        </div>
      </div>

      {/* (c) Mobile drawer — button opens the off-canvas drawer over a scrim */}
      <div>
        <div
          className="font-mono text-xs"
          style={{ color: 'var(--el-page-text-muted)', marginBottom: 'var(--spacing-sm)' }}
        >
          Mobile drawer · 300px
        </div>
        <SidebarToggle variant="hamburger" />
        <SidebarDrawer
          header={
            <div className="flex items-center gap-2">
              <span className="h-5 w-5 rounded-(--radius-xs) border border-(--el-sidebar-border)" />
              <span className="font-sans text-sm font-semibold text-foreground">Acme Inc.</span>
            </div>
          }
        >
          <Sidebar
            collapsed={false}
            header={<DemoProjectHeader collapsed={false} />}
            sections={SHELL_DEMO_SECTIONS}
          />
        </SidebarDrawer>
      </div>
    </div>
  );
}

function CommandPaletteDemo() {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();

  const pick = (label: string) => () =>
    toast({ variant: 'info', title: 'Action selected', description: label });

  const groups: CommandGroup[] = [
    {
      heading: 'Navigation',
      actions: [
        {
          id: 'd-dashboard',
          label: 'Go to Dashboard',
          icon: <LayoutDashboard />,
          onSelect: pick('Go to Dashboard'),
        },
        {
          id: 'd-issues',
          label: 'Go to Issues',
          icon: <CircleDot />,
          onSelect: pick('Go to Issues'),
        },
        {
          id: 'd-boards',
          label: 'Go to Boards',
          icon: <Columns3 />,
          onSelect: pick('Go to Boards'),
        },
        {
          id: 'd-reports',
          label: 'Go to Reports',
          icon: <BarChart3 />,
          onSelect: pick('Go to Reports'),
        },
        {
          id: 'd-settings',
          label: 'Go to Settings',
          icon: <Settings />,
          onSelect: pick('Go to Settings'),
        },
      ],
    },
    {
      heading: 'Workspace',
      actions: [
        {
          id: 'd-ws-current',
          label: 'Acme Inc.',
          icon: <Users />,
          badge: 'Current',
          onSelect: () => {},
        },
        {
          id: 'd-ws-other',
          label: 'Switch to Beta Labs',
          icon: <Users />,
          onSelect: pick('Switch to Beta Labs'),
        },
      ],
    },
    {
      heading: 'Account',
      actions: [
        {
          id: 'd-theme',
          label: 'Toggle theme',
          icon: <Sparkles />,
          onSelect: pick('Toggle theme'),
        },
      ],
    },
  ];

  return (
    <>
      <Button onClick={() => setOpen(true)} leftIcon={<Send className="h-4 w-4" />}>
        Open command palette
      </Button>
      <CommandPalette open={open} onOpenChange={setOpen} groups={groups} />
    </>
  );
}

function ModalDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)} leftIcon={<Send className="h-4 w-4" />}>
        Open modal
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Confirm action"
        description="This modal demonstrates focus trap, ESC-to-close, and click-outside dismissal."
      >
        <p className="text-sm" style={{ color: 'var(--el-page-text-muted)' }}>
          Try pressing <code className="font-mono text-xs">Esc</code>, clicking outside, or tabbing
          to confirm Radix&apos;s a11y primitives are working.
        </p>
        <Modal.Footer>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={() => setOpen(false)}>Confirm</Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}

function ToastDemo() {
  const { toast } = useToast();
  return (
    <div style={{ display: 'flex', gap: 'var(--spacing-md)', flexWrap: 'wrap' }}>
      <Button
        variant="secondary"
        onClick={() =>
          toast({ variant: 'info', title: 'Heads up', description: 'Just a friendly note.' })
        }
      >
        Info toast
      </Button>
      <Button
        variant="secondary"
        onClick={() =>
          toast({
            variant: 'success',
            title: 'Saved',
            description: 'Your changes have been synced.',
          })
        }
      >
        Success toast
      </Button>
      <Button
        variant="secondary"
        onClick={() =>
          toast({
            variant: 'warning',
            title: 'Heads up',
            description: 'Approaching API rate limit.',
          })
        }
      >
        Warning toast
      </Button>
      <Button
        variant="secondary"
        onClick={() =>
          toast({ variant: 'error', title: 'Failed', description: 'Could not save changes.' })
        }
      >
        Error toast
      </Button>
    </div>
  );
}
