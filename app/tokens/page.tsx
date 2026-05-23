'use client';

import { useState } from 'react';
import { MessageSquareOff, Plus, Send, Sparkles } from 'lucide-react';
import { useTheme } from '@/lib/contexts/theme-context';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import { Spinner } from '@/components/ui/Spinner';
import { Textarea } from '@/components/ui/Textarea';
import { Tooltip } from '@/components/ui/Tooltip';
import type { DisplayStyle, ThemePattern } from '@/lib/theme/types';

/**
 * /tokens — the design system reference route.
 *
 * Renders every token category (colors, typography, radius, shadow,
 * spacing) as visual swatches/specimens. Interactive theme + display-style
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

const DISPLAY_STYLE_OPTIONS: { value: DisplayStyle; label: string }[] = [
  { value: 'default', label: 'Default (Notion-sober)' },
  { value: 'soft', label: 'Soft (Figma-pill)' },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
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
      <div
        aria-label={label}
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
  const { pattern, displayStyle, setPattern, setDisplayStyle } = useTheme();
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
          Display style
        </div>
        <div style={{ display: 'flex', gap: 'var(--spacing-xs)' }}>
          {DISPLAY_STYLE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setDisplayStyle(opt.value)}
              aria-pressed={displayStyle === opt.value}
              style={{
                paddingInline: 'var(--spacing-md)',
                paddingBlock: 'var(--spacing-xs)',
                borderRadius: 'var(--radius-pill)',
                border: `1px solid ${displayStyle === opt.value ? 'var(--color-primary)' : 'var(--el-border)'}`,
                backgroundColor:
                  displayStyle === opt.value ? 'var(--color-primary)' : 'transparent',
                color:
                  displayStyle === opt.value
                    ? 'var(--color-primary-foreground)'
                    : 'var(--el-page-text)',
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
          Prodect design system
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
          Live reference for every design token. Toggle the theme + display-style below and watch
          the system respond via CSS variables only — no React re-renders on toggle.
        </p>
      </header>

      <ThemeControls />

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
                <div style={{ fontSize: `var(${t.token})`, lineHeight: 1.2 }}>Prodect</div>
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
          Variant × size grid. Toggle <code className="font-mono text-xs">display-style</code> to
          see shapes flip — CSS only.
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
            placeholder="prodect"
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
    </main>
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
