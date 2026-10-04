'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowUpRight, Notebook, Plus, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import type { PageListItemDto } from '@/lib/dto/pages';

// THE CONFIRM PORT'S PAGE RECORD (Story MOTIR-5761 · MOTIR-7444;
// `design/approvals/confirm-port--page-record.mock.html`, delta 4). A person who can edit a
// human decision card points at a page as its WRITTEN RECORD. Choosing one is a PUBLISH —
// `POST /api/work-items/<key>/decision-page`, the door an agent's `publish_decision_page`
// shares — so the seal and the record behave the same on both shapes. The newest choice
// wins; Confirm then freezes that version.

export interface DecisionRecordPagePickerProps {
  /** The card's `KEY-<n>` — the publish door's segment, and its prefix the project. */
  itemIdentifier: string;
  /** The page record chosen so far, or null. */
  chosen: { pageId: string; title: string; versionNumber: number } | null;
  /** After a publish lands: re-read the card so the record reads the new version. */
  onChosen: () => void;
}

type Refusal = 'empty' | 'otherProject' | 'archived' | 'noAccess';

const REFUSAL_BY_CODE: Record<string, Refusal> = {
  PAGE_IS_EMPTY: 'empty',
  PAGE_IN_ANOTHER_PROJECT: 'otherProject',
  PAGE_ARCHIVED: 'archived',
  PAGE_NOT_FOUND: 'noAccess',
};

const bold = (chunks: ReactNode) => <b>{chunks}</b>;

export function DecisionRecordPagePicker({
  itemIdentifier,
  chosen,
  onChosen,
}: DecisionRecordPagePickerProps) {
  const t = useTranslations('approvalGate.decisionConfirm.record');
  const tPages = useTranslations('pages');
  const [choosing, setChoosing] = useState(chosen === null);
  const [pages, setPages] = useState<PageListItemDto[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ kind: Refusal; title: string } | null>(null);
  const projectKey = itemIdentifier.split('-')[0] ?? '';

  useEffect(() => {
    if (!choosing) return;
    let live = true;
    fetch(`/api/pages?projectKey=${encodeURIComponent(projectKey)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { items?: PageListItemDto[] } | null;
        if (!Array.isArray(body?.items)) throw new Error('Unexpected page list');
        if (live) setPages(body.items);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [choosing, projectKey]);

  async function choose(pageId: string) {
    const title = pages?.find((p) => p.id === pageId)?.title ?? '';
    setBusy(true);
    setRefusal(null);
    try {
      const res = await fetch(
        `/api/work-items/${encodeURIComponent(itemIdentifier)}/decision-page`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pageId }),
        },
      );
      if (res.ok) {
        setChoosing(false);
        onChosen();
        return;
      }
      const body = (await res.json().catch(() => null)) as { code?: string } | null;
      setRefusal({ kind: REFUSAL_BY_CODE[body?.code ?? ''] ?? 'noAccess', title });
    } catch {
      setRefusal({ kind: 'noAccess', title });
    } finally {
      setBusy(false);
    }
  }

  if (!choosing && chosen) {
    return (
      <p
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]"
        data-testid="decision-record-page"
      >
        <span className="text-(--el-text-secondary)">{t('link')}</span>
        <Notebook className="h-3.5 w-3.5 flex-none text-(--el-text-secondary)" aria-hidden />
        <span className="text-(--el-text)">
          {t.rich('page', { title: chosen.title, number: chosen.versionNumber, b: bold })}
        </span>
        <Link
          href={`/pages/${encodeURIComponent(chosen.pageId)}?version=${chosen.versionNumber}`}
          className="inline-flex items-center gap-1 font-semibold text-(--el-link) hover:text-(--el-link-pressed)"
        >
          {t('open')}
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
        <Button variant="ghost" size="sm" onClick={() => setChoosing(true)}>
          {t('change')}
        </Button>
      </p>
    );
  }

  const options: ComboboxOption<string>[] = (pages ?? []).map((page) => ({
    value: page.id,
    label: page.title || tPages('untitled'),
    icon: <Notebook className="h-3.5 w-3.5 text-(--el-text-secondary)" aria-hidden />,
  }));

  return (
    <div className="flex flex-col gap-1.5" data-testid="decision-record-picker">
      <span className="text-xs text-(--el-text-secondary)">{t('link')}</span>
      <Combobox
        options={options}
        value={null}
        onChange={(pageId) => void choose(pageId)}
        label={t('link')}
        placeholder={t('choose')}
        searchable
        searchPlaceholder={t('search')}
        loading={pages === null && !failed}
        loadingText={t('loading')}
        emptyText={failed ? t('loadFailed') : t('empty')}
        disabled={busy}
        footer={
          pages !== null && pages.length === 0 ? (
            <Link
              href="/pages"
              className="inline-flex items-center gap-1 text-[13px] font-semibold text-(--el-link) hover:text-(--el-link-pressed)"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              {tPages('index.newPage')}
            </Link>
          ) : undefined
        }
      />
      <span className="text-xs text-(--el-text-secondary)">{t('chooseHelper')}</span>
      {refusal ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-danger) bg-(--el-danger-surface) px-(--spacing-control-x) py-(--spacing-control-y) text-[13px] text-(--el-danger-surface-text)"
        >
          <TriangleAlert
            className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger-on-surface)"
            aria-hidden
          />
          <span>{t.rich(`refusal.${refusal.kind}`, { title: refusal.title, b: bold })}</span>
        </div>
      ) : null}
    </div>
  );
}
