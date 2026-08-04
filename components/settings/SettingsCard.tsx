import type { ReactNode } from 'react';

// The settings-card grammar shared by the project-settings panes (Story 7.13 ·
// MOTIR-919, extracted here by Story MOTIR-1615 · MOTIR-1622 when it gained its
// second consumer).
//
// A full-bleed head divider + an optional `--el-surface-soft` footer band, which
// the `Card` primitive's uniform `--spacing-card-padding` box cannot express;
// every token (radius, padding, border, shadow) is still the element-semantic
// one. Lives in `components/settings/` rather than a route's `_components/`
// because two different routes render it — `settings/project/ai-planning` and
// `settings/project/workflow` — and a copy in each is exactly the drift the
// design notes asked us to avoid.

export function SettingsCard({
  icon,
  title,
  subtitle,
  footer,
  testId,
  children,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  footer?: ReactNode;
  /** Optional `data-testid` on the section — the E2E's stable handle. */
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section
      data-surface="card"
      {...(testId ? { 'data-testid': testId } : {})}
      className="bg-(--el-card) border-(--el-border) shadow-(--shadow-card) overflow-hidden rounded-(--radius-card) border"
    >
      <div className="border-(--el-border-soft) flex items-start gap-2.5 border-b px-(--spacing-card-padding) py-4">
        <span className="text-(--el-icon-heading) mt-px shrink-0">{icon}</span>
        <div>
          <h2 className="text-sm font-semibold text-(--el-text)">{title}</h2>
          <p className="text-(--el-text-muted) mt-0.5 max-w-[58ch] text-xs">{subtitle}</p>
        </div>
      </div>
      <div className="flex flex-col gap-5 px-(--spacing-card-padding) py-5">{children}</div>
      {footer}
    </section>
  );
}
