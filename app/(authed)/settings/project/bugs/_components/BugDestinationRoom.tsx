'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Bug, ExternalLink, Folder } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { FolderPickerPanel } from '@/app/(authed)/items/_components/FolderPicker';
import type { FolderPickerNodeDto } from '@/lib/dto/folders';
import type { BugDestinationDto } from '@/lib/dto/projects';
import { setAdvancedParam } from '@/lib/issues/issueListAdvancedFilter';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';
import { buildIssueListHref } from '@/lib/issues/issueListView';

// The BUG DESTINATION card (Story MOTIR-4927 · Subtask MOTIR-4938), built to
// `design/projects/bug-destination.mock.html` panels 0–3 as amended by MOTIR-5536,
// with the copy from `design/projects/design-notes.md` § Bugs §5.
//
// THREE NAMED CHOICES, and the third is a choice: `Project root` has its own title
// and sentence, never an empty select — the stored value is a null pointer and null
// MEANS the root. The first choice NAMES this project's Bugs folder and links to
// it; the second opens the SHIPPED folder picker (`FolderPicker.tsx`'s panel, the
// one `/items` uses) over this project's folders only, whose root option selects
// the third choice. There is no second folder chooser to drift from the first.
//
// SAVES EXPLICITLY, the Estimation card's grammar: a choice makes the card dirty,
// `Cancel` puts the stored choice back, and `Save changes` PATCHes
// `/api/projects/[key]/bug-destination`. The card renders the write's own response
// and never refreshes the page (CLAUDE.md § Page state after a mutation, case 1).
//
// ⚠️ INK. Titles `--el-text`; descriptions `--el-text-secondary`, never
// `--el-text-muted` (§8 raises the shipped choice card's ink so it clears AA on
// every surface it lands on).

type Choice = 'bugs' | 'another' | 'root';

interface Draft {
  choice: Choice;
  folderId: string | null;
  path: string[] | null;
}

const PATH_SEPARATOR = ' ▸ ';

/** The draft a stored destination reads as — the choice that NAMES it. */
export function draftFor(value: BugDestinationDto): Draft {
  if (value.folder === null) return { choice: 'root', folderId: null, path: null };
  const choice = value.bugsFolder?.id === value.folder.id ? 'bugs' : 'another';
  return { choice, folderId: value.folder.id, path: value.folder.path };
}

/** Where a folder's Open link lands: the /items tree filtered to what is filed in it. */
function folderHref(folderId: string): string {
  return buildIssueListHref('/items', {
    view: 'tree',
    filter: setAdvancedParam(EMPTY_FILTER, {
      combinator: 'and',
      conditions: [{ field: 'folder', operator: 'is_any_of', value: [folderId] }],
    }),
  });
}

export interface BugDestinationRoomProps {
  /** The project's `MOTIR`-style identifier — the key the route is addressed by. */
  projectKey: string;
  initial: BugDestinationDto;
  /** Every folder of the project in tree order, for the folder picker. */
  folders: FolderPickerNodeDto[];
  truncated: boolean;
}

export function BugDestinationRoom({
  projectKey,
  initial,
  folders,
  truncated,
}: BugDestinationRoomProps) {
  const t = useTranslations('settings.bugs');
  const tc = useTranslations('common');
  const { toast } = useToast();
  const [committed, setCommitted] = useState<BugDestinationDto>(initial);
  const [draft, setDraft] = useState<Draft>(() => draftFor(initial));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const committedFolderId = committed.folder?.id ?? null;
  const bugsFolder = committed.bugsFolder;
  const complete = draft.choice !== 'another' || draft.folderId !== null;
  const dirty = draft.folderId !== committedFolderId;
  const canSave = dirty && complete && !saving;

  const choose = (choice: Choice) => {
    if (saving) return;
    if (choice === 'another') {
      setDraft((d) => (d.choice === 'another' ? d : { choice, folderId: null, path: null }));
      setPickerOpen(true);
      return;
    }
    setPickerOpen(false);
    if (choice === 'bugs' && bugsFolder) {
      setDraft({ choice, folderId: bugsFolder.id, path: bugsFolder.path });
    } else if (choice === 'root') {
      setDraft({ choice, folderId: null, path: null });
    }
  };

  const pick = (folderId: string | null) => {
    setPickerOpen(false);
    if (folderId === null) {
      setDraft({ choice: 'root', folderId: null, path: null });
    } else if (folderId === bugsFolder?.id) {
      setDraft({ choice: 'bugs', folderId, path: bugsFolder.path });
    } else {
      const path = folders.find((f) => f.id === folderId)?.path ?? null;
      setDraft({ choice: 'another', folderId, path });
    }
  };

  // Closing the picker without a folder leaves nothing chosen: back to the stored choice.
  const dismissPicker = () => {
    setPickerOpen(false);
    setDraft((d) => (d.choice === 'another' && d.folderId === null ? draftFor(committed) : d));
  };

  const cancel = () => {
    setPickerOpen(false);
    setDraft(draftFor(committed));
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setPickerOpen(false);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectKey)}/bug-destination`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folderId: draft.folderId }),
      });
      if (!res.ok) {
        const refusal = (await res.json().catch(() => ({}))) as { code?: string };
        toast({
          variant: 'error',
          title: t('saveErrorTitle'),
          description:
            refusal.code === 'FOLDER_NOT_FOUND'
              ? t('folderGone')
              : res.status === 403
                ? t('saveForbidden')
                : t('saveError'),
        });
        return;
      }
      const next = (await res.json()) as BugDestinationDto;
      setCommitted(next);
      setDraft(draftFor(next));
      toast({
        variant: 'success',
        title: t('savedTitle'),
        description:
          next.folder === null
            ? t('savedRoot')
            : t('savedFolder', { path: next.folder.path.join(PATH_SEPARATOR) }),
      });
    } catch {
      toast({ variant: 'error', title: t('saveErrorTitle'), description: t('saveError') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      icon={<Bug className="size-4" aria-hidden />}
      title={t('cardTitle')}
      subtitle={t('cardDescription')}
      testId="bug-destination-card"
      footer={
        <div className="bg-(--el-surface-soft) border-(--el-border-soft) flex items-center justify-end gap-2.5 border-t px-(--spacing-card-padding) py-3.5">
          <Button variant="secondary" onClick={cancel} disabled={!dirty || saving}>
            {tc('cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            loading={saving}
            disabled={!canSave}
          >
            {saving ? t('saving') : t('save')}
          </Button>
        </div>
      }
    >
      <div role="radiogroup" aria-label={t('cardTitle')} className="flex flex-col gap-2">
        {bugsFolder ? (
          <ChoiceCard
            selected={draft.choice === 'bugs'}
            disabled={saving}
            title={t('bugsFolderTitle')}
            description={t('bugsFolderDescription')}
            onSelect={() => choose('bugs')}
          >
            <FolderLine
              path={bugsFolder.path}
              action={
                <Link
                  href={folderHref(bugsFolder.id)}
                  aria-label={t('openAria', { name: bugsFolder.name })}
                  className="inline-flex items-center gap-1 rounded-(--radius-control) font-sans text-[13px] text-(--el-link) hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
                >
                  {t('open')}
                  <ExternalLink className="size-3.5" aria-hidden />
                </Link>
              }
            />
          </ChoiceCard>
        ) : null}

        <ChoiceCard
          selected={draft.choice === 'another'}
          disabled={saving}
          title={t('anotherFolderTitle')}
          description={t('anotherFolderDescription')}
          onSelect={() => choose('another')}
        >
          {pickerOpen ? (
            <div className="rounded-(--radius-card) border border-(--el-border) bg-(--el-card) p-1 shadow-(--shadow-elevated)">
              <FolderPickerPanel
                mode="move"
                title={t('cardTitle')}
                folders={folders}
                truncated={truncated}
                currentFolderId={committedFolderId}
                refusal={null}
                onPick={pick}
                onDismiss={dismissPicker}
              />
            </div>
          ) : draft.choice === 'another' && draft.path ? (
            <FolderLine path={draft.path} />
          ) : null}
        </ChoiceCard>

        <ChoiceCard
          selected={draft.choice === 'root'}
          disabled={saving}
          title={t('projectRootTitle')}
          description={t('projectRootDescription')}
          onSelect={() => choose('root')}
        />
      </div>
    </SettingsCard>
  );
}

/** One of the three choices: a radio with its title and sentence, and an optional slot below. */
function ChoiceCard({
  selected,
  disabled,
  title,
  description,
  onSelect,
  children,
}: {
  selected: boolean;
  disabled: boolean;
  title: string;
  description: string;
  onSelect: () => void;
  children?: ReactNode;
}) {
  return (
    <div
      className={`rounded-(--radius-card) border p-(--spacing-card-padding) ${
        selected ? 'border-(--el-accent)' : 'border-(--el-border)'
      }`}
    >
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        disabled={disabled}
        onClick={onSelect}
        className="flex w-full items-start gap-3 rounded-(--radius-control) text-left focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:cursor-default"
      >
        <span
          className={`mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full border-2 ${
            selected ? 'border-(--el-accent)' : 'border-(--el-border-strong)'
          }`}
          aria-hidden
        >
          {selected ? <span className="size-1.5 rounded-full bg-(--el-accent)" /> : null}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-sans text-sm font-semibold text-(--el-text)">{title}</span>
          <span className="font-sans text-[13px] text-(--el-text-secondary)">{description}</span>
        </span>
      </button>
      {children ? <div className="mt-2 pl-7">{children}</div> : null}
    </div>
  );
}

/** A folder as the card names it: the tree's folder glyph, its path, and an optional action. */
function FolderLine({ path, action }: { path: string[]; action?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2 font-sans text-sm text-(--el-text)">
      <Folder className="size-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
      <span className="min-w-0 truncate">{path.join(PATH_SEPARATOR)}</span>
      {action ? <span className="ml-auto shrink-0">{action}</span> : null}
    </div>
  );
}
