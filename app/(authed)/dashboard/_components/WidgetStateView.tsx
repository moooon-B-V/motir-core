'use client';

import { AlertTriangle, Inbox, Lock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';

// The per-widget body states (Subtask 6.3.5, design panel 5): loading
// skeleton · empty · error (+ Retry) · no-access (the 6.4 per-viewer lock,
// leaking no counts/rows/chart shape) · stale (the INHERITED 6.2.2 "filter
// missing" card + the in-grid Choose-a-filter reconfigure action). Each
// renderer wraps its body in one of these so a single failing widget never
// takes the grid down. State is carried by TEXT (serif headline + one-line
// cause), never colour alone (finding #35).

const ICON_BY_STATE = { empty: Inbox, error: AlertTriangle, no_access: Lock, stale: AlertTriangle };

function StateShell({
  state,
  title,
  body,
  action,
}: {
  state: keyof typeof ICON_BY_STATE;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  const Icon = ICON_BY_STATE[state];
  const tone =
    state === 'error'
      ? 'text-(--el-danger)'
      : state === 'no_access'
        ? 'text-(--el-text-muted)'
        : state === 'stale'
          ? 'text-(--el-warning)'
          : 'text-(--el-text-faint)';
  return (
    <div className="flex min-h-[176px] flex-col items-center justify-center gap-2 px-4 py-8 text-center">
      <Icon className={`size-7 ${tone}`} aria-hidden />
      <h5 className="font-serif text-sm font-semibold text-(--el-text-strong)">{title}</h5>
      <p className="max-w-[34ch] text-xs leading-relaxed text-(--el-text-muted)">{body}</p>
      {action ? <div className="mt-1.5">{action}</div> : null}
    </div>
  );
}

/** Loading skeleton — `chart` (a block) or `table` (rows), matching the body
 * shape to come (the design's per-type skeleton). */
export function WidgetLoading({ shape }: { shape: 'table' | 'chart' }) {
  const t = useTranslations('dashboards');
  return (
    <div
      className="flex min-h-[176px] flex-col gap-2.5 px-3.5 py-5"
      role="status"
      aria-label={t('states.loadingAria')}
    >
      {shape === 'table' ? (
        <>
          {['90%', '96%', '80%', '88%', '72%'].map((w, i) => (
            <span
              key={i}
              className="block h-3 animate-pulse rounded-(--radius-control) bg-(--el-muted)"
              style={{ width: w }}
            />
          ))}
        </>
      ) : (
        <span className="block h-[120px] animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
      )}
    </div>
  );
}

export function WidgetEmpty() {
  const t = useTranslations('dashboards');
  return <StateShell state="empty" title={t('states.emptyTitle')} body={t('states.emptyBody')} />;
}

export function WidgetError({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('dashboards');
  return (
    <StateShell
      state="error"
      title={t('states.errorTitle')}
      body={t('states.errorBody')}
      action={
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {t('states.retry')}
        </Button>
      }
    />
  );
}

export function WidgetNoAccess() {
  const t = useTranslations('dashboards');
  return (
    <StateShell
      state="no_access"
      title={t('states.noAccessTitle')}
      body={t('states.noAccessBody')}
    />
  );
}

/** The stale "filter missing" body — inherited from 6.2.2; the in-grid
 * `Choose a filter` action only renders for the owner in edit context. */
export function WidgetStale({ onReconfigure }: { onReconfigure?: () => void }) {
  const t = useTranslations('dashboards');
  return (
    <StateShell
      state="stale"
      title={t('states.staleTitle')}
      body={t('states.staleBody')}
      action={
        onReconfigure ? (
          <Button variant="secondary" size="sm" onClick={onReconfigure}>
            {t('states.chooseFilter')}
          </Button>
        ) : undefined
      }
    />
  );
}
