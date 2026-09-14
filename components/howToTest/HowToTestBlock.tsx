'use client';

import { useState, type ComponentType, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  Ban,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleEllipsis,
  CircleMinus,
  CircleSlash,
  CircleX,
  Clock,
  CornerLeftUp,
  ExternalLink,
  FileQuestionMark,
  FolderGit2,
  Globe,
  History,
  ListChecks,
  Terminal,
} from 'lucide-react';
import { Pill, type PillProps } from '@/components/ui/Pill';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { CopyableCodeBlock } from '@/components/markdown/CopyableCodeBlock';
import { formatRunInstant } from '@/lib/runs/runClock';
import { repoNameKey } from '@/lib/workItems/repoName';
import type {
  HowToTestCheckDto,
  HowToTestCiDto,
  HowToTestDeploymentState,
  HowToTestDto,
  HowToTestPreviewDto,
  HowToTestRepoDto,
  HowToTestRunDto,
} from '@/lib/dto/howToTest';

// HOW TO TEST — the approve-to-merge gate's EVIDENCE (Story MOTIR-4906 · Subtask
// MOTIR-5336), built to `design/github/design-notes.md` §20 · Panels 12a–12o.
//
// ⚠️ IT IS A PART OF THE DEVELOPMENT CARD, NEVER A SECTION OF ITS OWN. It renders
// below the pull-request rows under an `h4`, inside the same card, and when the
// approve-and-merge gate awaits it is band 2 of that ONE frame alongside the
// rows. It carries no verb, no gate and no approval (Yue: *"they are the same
// gate, not 2 separated things"*).
//
// WHAT IS WHOSE: the body is the agent's `bodyMd`, verbatim, through the ONE
// Markdown pipeline with copyable fences; the bordered per-repository sub-blocks
// (In the preview · Locally · What CI proved) are what Motir DERIVES, so a fact
// the agent never typed cannot be mistyped.
//
// ⚠️ NO LINK TO THE DIFF. Each row above keeps its own link-out; the only URL
// this block draws is a preview's, which opens the APP (ADR §9).
//
// INKS: `--el-text` / `--el-text-secondary` / `--el-text-identifier` only — the
// block renders on the card AND on the frame's `--el-surface` port, where
// `--el-text-muted` measures 4.17:1 and fails AA.

type Glyph = ComponentType<{ className?: string }>;
type Tone = Pick<PillProps, 'status' | 'severity' | 'tone'>;

/** A pull-request row the card draws above — what a sub-block is matched to. */
export interface HowToTestRowRef {
  id: string;
  repo: string;
  number: number;
}

export interface HowToTestBlockProps {
  howToTest: HowToTestDto;
  /** The Development card's pull-request rows, in their drawn order. */
  pullRequestRows: HowToTestRowRef[];
}

function PillWith({
  tone,
  icon: Icon,
  children,
}: {
  tone: Tone;
  icon: Glyph;
  children: ReactNode;
}) {
  return (
    <Pill {...tone}>
      <Icon className="h-3 w-3" aria-hidden />
      {children}
    </Pill>
  );
}

/** The part's frame: the soft rule and the column below the rows. */
function Part({ children }: { children: ReactNode }) {
  const t = useTranslations('github.development.howToTest');
  return (
    <div
      role="group"
      aria-label={t('title')}
      data-testid="how-to-test"
      className="mt-4 flex min-w-0 flex-col gap-3 border-t border-(--el-border-soft) pt-4"
    >
      {children}
    </div>
  );
}

function PartHead({ children }: { children?: ReactNode }) {
  const t = useTranslations('github.development.howToTest');
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <h4 className="text-[13px] font-semibold text-(--el-text)">{t('title')}</h4>
      {children}
    </div>
  );
}

const bold = (chunks: ReactNode) => <b className="font-medium text-(--el-text)">{chunks}</b>;
const sha = (chunks: ReactNode) => <span className="font-mono text-xs">{chunks}</span>;

export function HowToTestBlock({ howToTest, pullRequestRows }: HowToTestBlockProps) {
  const t = useTranslations('github.development.howToTest');
  const state = howToTest.state;
  switch (state) {
    case 'record':
      return howToTest.record ? (
        <RecordPart howToTest={howToTest} pullRequestRows={pullRequestRows} />
      ) : (
        <MissingPart owedBy={howToTest.owedBy} />
      );
    case 'record_missing':
      return <MissingPart owedBy={howToTest.owedBy} />;
    case 'tested_via_ancestor':
      return <ChildPointer targetKey={howToTest.runTarget?.key ?? null} />;
    default: {
      // A state this build does not know — the raw value, never a blank.
      const raw: string = state satisfies never;
      return (
        <Part>
          <PartHead />
          <p className="text-[13px] text-(--el-text-secondary)">
            {t('unknownState', { value: String(raw) })}
          </p>
        </Part>
      );
    }
  }
}

/** Panel 12i — no run has written one: a lavender callout at the head of the part. */
function MissingPart({ owedBy }: { owedBy: HowToTestRunDto | null }) {
  const t = useTranslations('github.development.howToTest');
  return (
    <Part>
      <PartHead />
      <div
        role="status"
        className="flex items-start gap-2.5 rounded-(--radius-card) bg-(--el-callout-bg) px-3 py-2.5 text-[13px] leading-normal text-(--el-callout-text)"
      >
        <FileQuestionMark className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>
          <b className="font-semibold">{t('missing.title')}</b>{' '}
          {owedBy ? t('missing.owedByRun', { run: owedBy.label }) : t('missing.noRun')}
        </span>
      </div>
    </Part>
  );
}

/** Panel 12m — a child of a container run: ONE line, the target BY KEY. */
function ChildPointer({ targetKey }: { targetKey: string | null }) {
  const t = useTranslations('github.development.howToTest');
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-(--el-border-soft) pt-3 text-[13px] text-(--el-text-secondary)">
      <CornerLeftUp className="h-4 w-4 shrink-0 text-(--el-icon-muted)" aria-hidden />
      <span>
        {t.rich('child.pointer', {
          key: targetKey ?? '',
          link: (chunks) =>
            targetKey ? (
              <Link
                href={`/items/${targetKey}`}
                className="font-mono text-[12.5px] text-(--el-link) underline"
              >
                {chunks}
              </Link>
            ) : (
              <span className="font-mono text-[12.5px]">{chunks}</span>
            ),
        })}
      </span>
    </div>
  );
}

/** One sub-block to draw: a record section, or a row's repository the record skipped. */
type SubBlock =
  | { kind: 'section'; heading: string; repo: HowToTestRepoDto }
  | { kind: 'no_section'; heading: string; repoName: string };

/**
 * The derived sub-blocks, in the record's order, then one per pull-request row
 * whose repository the record has no section for (Panel 12k) — a repository the
 * run forgot is SAID, not silently absent from the evidence for a gate that
 * merges it. Headed by the SAME string the row's meta line carries.
 */
export function deriveSubBlocks(
  repos: readonly HowToTestRepoDto[],
  rows: readonly HowToTestRowRef[],
): SubBlock[] {
  const blocks: SubBlock[] = [];
  const covered = new Set<string>();
  for (const repo of repos) {
    const key = repoNameKey(repo.repoName);
    if (key !== null) covered.add(key);
    const row =
      (repo.pullRequest ? rows.find((r) => r.id === repo.pullRequest!.id) : undefined) ??
      rows.find((r) => key !== null && repoNameKey(r.repo) === key);
    blocks.push({
      kind: 'section',
      heading: row ? `${row.repo} · #${row.number}` : repo.repoName,
      repo,
    });
  }
  for (const row of rows) {
    const key = repoNameKey(row.repo);
    if (key === null || covered.has(key)) continue;
    covered.add(key);
    blocks.push({
      kind: 'no_section',
      heading: `${row.repo} · #${row.number}`,
      repoName: row.repo,
    });
  }
  return blocks;
}

function RecordPart({ howToTest, pullRequestRows }: HowToTestBlockProps) {
  const t = useTranslations('github.development.howToTest');
  const record = howToTest.record!;
  const runLabel = record.run?.label ?? '';
  const blocks = deriveSubBlocks(howToTest.repos, pullRequestRows);
  const headed = blocks.length > 1;
  const stale = howToTest.repos.filter((r) => r.stale);

  return (
    <Part>
      <PartHead>
        {record.run ? (
          <span className="text-xs text-(--el-text-secondary)">
            {t.rich('writtenBy', {
              run: record.run.label,
              time: formatRunInstant(record.createdAt),
              b: bold,
            })}
          </span>
        ) : null}
      </PartHead>

      {stale.map((repo) => (
        <div
          key={`stale-${repo.repoId}`}
          role="status"
          className="flex items-start gap-2.5 rounded-(--radius-card) bg-(--el-warning-surface) px-3 py-2.5 text-[13px] leading-normal text-(--el-text-strong)"
        >
          <History className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            <b className="font-semibold">
              {t.rich('stale.title', {
                recordSha: repo.commitSha.slice(0, 7),
                repo: repo.repoName,
                headSha: (repo.pullRequest?.headSha ?? '').slice(0, 7),
                sha,
              })}
            </b>{' '}
            {t('stale.body')}
          </span>
        </div>
      ))}

      {record.bodyMd.trim() ? (
        <MarkdownView
          value={record.bodyMd}
          copyableCode
          // `motir-how-to-test` scales the agent's `##` sections down to sub-headings
          // of the card — in `markdown-editor.css`, because the unlayered prose
          // rules there would beat a layered utility here.
          className="motir-how-to-test min-w-0"
        />
      ) : null}

      {blocks.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-2">
          {blocks.map((block) =>
            block.kind === 'section' ? (
              <RepoSubBlock
                key={`s-${block.repo.repoId}`}
                heading={block.heading}
                headed={headed || block.repo.stale}
                repo={block.repo}
              />
            ) : (
              <NoSectionSubBlock
                key={`n-${block.repoName}`}
                heading={block.heading}
                headed={headed}
                runLabel={runLabel}
              />
            ),
          )}
        </div>
      ) : null}

      <EarlierRuns history={howToTest.history} />
    </Part>
  );
}

function SubBlockFrame({
  heading,
  headed,
  end,
  children,
}: {
  heading: string;
  headed: boolean;
  end?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={heading}
      className="min-w-0 rounded-(--radius-control) border border-(--el-border) bg-(--el-card) px-(--spacing-control-x) py-(--spacing-control-y)"
    >
      {headed ? (
        <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1 pb-1">
          <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-(--el-icon-muted)" aria-hidden />
          <span className="font-sans text-xs font-medium text-(--el-text-identifier)">
            {heading}
          </span>
          {end ? <span className="ml-auto">{end}</span> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

function Fact({
  icon: Icon,
  label,
  value,
  children,
}: {
  icon: Glyph;
  label: string;
  value?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="border-t border-(--el-border-soft) py-1.5 first:border-t-0">
      <div className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap text-(--el-text)">
          <Icon className="h-3.5 w-3.5 shrink-0 text-(--el-icon-muted)" aria-hidden />
          {label}
        </span>
        {value ? (
          <span className="ml-auto inline-flex flex-wrap items-center justify-end gap-1.5 text-xs text-(--el-text-secondary)">
            {value}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function FactBody({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1 pl-5 text-[12.5px] leading-normal text-(--el-text-secondary)">{children}</p>
  );
}

function RepoSubBlock({
  heading,
  headed,
  repo,
}: {
  heading: string;
  headed: boolean;
  repo: HowToTestRepoDto;
}) {
  const t = useTranslations('github.development.howToTest');
  return (
    <SubBlockFrame
      heading={heading}
      headed={headed}
      end={
        repo.stale ? (
          <PillWith tone={{ severity: 'warning' }} icon={History}>
            {t('stale.pill')}
          </PillWith>
        ) : null
      }
    >
      <PreviewFact preview={repo.preview} />
      <Fact
        icon={Terminal}
        label={t('local.title')}
        value={
          repo.fetchCommand === null ? (
            <PillWith tone={{ tone: 'neutral' }} icon={CircleDashed}>
              {t('local.noBranch')}
            </PillWith>
          ) : null
        }
      >
        {repo.fetchCommand === null ? (
          <FactBody>{t('local.noBranchBody')}</FactBody>
        ) : (
          <div className="ml-5">
            <CopyableCodeBlock language="shell" code={repo.fetchCommand} />
          </div>
        )}
      </Fact>
      <CiFact ci={repo.ci} />
    </SubBlockFrame>
  );
}

function NoSectionSubBlock({
  heading,
  headed,
  runLabel,
}: {
  heading: string;
  headed: boolean;
  runLabel: string;
}) {
  const t = useTranslations('github.development.howToTest');
  return (
    <SubBlockFrame heading={heading} headed={headed}>
      <Fact
        icon={CircleMinus}
        label={t('noSection.title')}
        value={
          <PillWith tone={{ tone: 'neutral' }} icon={CircleMinus}>
            {t('noSection.pill')}
          </PillWith>
        }
      >
        <FactBody>{t('noSection.body', { run: runLabel })}</FactBody>
      </Fact>
    </SubBlockFrame>
  );
}

/** The tone table's preview arm (§20): state → pill tone + glyph. */
const PREVIEW_STATE_META: Record<HowToTestDeploymentState, { tone: Tone; icon: Glyph }> = {
  success: { tone: { severity: 'success' }, icon: CircleCheck },
  queued: { tone: { severity: 'warning' }, icon: Clock },
  pending: { tone: { severity: 'warning' }, icon: Clock },
  in_progress: { tone: { severity: 'warning' }, icon: CircleEllipsis },
  failure: { tone: { severity: 'danger' }, icon: CircleX },
  error: { tone: { severity: 'danger' }, icon: CircleX },
  inactive: { tone: { tone: 'neutral' }, icon: CircleSlash },
  canceled: { tone: { tone: 'neutral' }, icon: Ban },
  unknown: { tone: { tone: 'neutral' }, icon: CircleDashed },
};

function PreviewFact({ preview }: { preview: HowToTestPreviewDto }) {
  const t = useTranslations('github.development.howToTest');
  const status = preview.status;
  switch (status) {
    case 'available':
      return (
        <Fact
          icon={Globe}
          label={t('preview.title')}
          value={
            <>
              <span>{preview.environment}</span>
              <PillWith tone={{ severity: 'success' }} icon={CircleCheck}>
                {t('preview.state.success')}
              </PillWith>
            </>
          }
        >
          <a
            href={preview.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 ml-5 flex min-w-0 items-center gap-1 text-[12.5px] text-(--el-link) underline"
          >
            <span className="min-w-0 truncate">{preview.url}</span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
          </a>
        </Fact>
      );
    case 'deployment_not_ready': {
      const s = preview.state;
      const meta = PREVIEW_STATE_META[s] ?? PREVIEW_STATE_META.unknown;
      const label = s === 'unknown' ? (preview.rawState ?? s) : t(`preview.state.${s}`);
      const env = preview.environment;
      let body: string;
      switch (s) {
        case 'failure':
        case 'error':
          body = t('preview.failed', { environment: env });
          break;
        case 'inactive':
          body = t('preview.inactive', { environment: env });
          break;
        case 'canceled':
          body = t('preview.canceled', { environment: env });
          break;
        case 'queued':
        case 'pending':
        case 'in_progress':
        case 'success':
        case 'unknown':
          body = t('preview.notReady', { environment: env, state: label.toLowerCase() });
          break;
        default: {
          const raw: string = s satisfies never;
          body = t('preview.notReady', { environment: env, state: String(raw) });
        }
      }
      return (
        <Fact
          icon={Globe}
          label={t('preview.title')}
          value={
            <>
              <span>{env}</span>
              <PillWith tone={meta.tone} icon={meta.icon}>
                {label}
              </PillWith>
            </>
          }
        >
          <FactBody>{body}</FactBody>
        </Fact>
      );
    }
    case 'no_deployment_reported':
      return (
        <Fact
          icon={Globe}
          label={t('preview.title')}
          value={
            <PillWith tone={{ tone: 'neutral' }} icon={CircleDashed}>
              {t('preview.none')}
            </PillWith>
          }
        >
          <FactBody>{t('preview.noneBody')}</FactBody>
        </Fact>
      );
    default: {
      const raw: string = status satisfies never;
      return (
        <Fact
          icon={Globe}
          label={t('preview.title')}
          value={
            <PillWith tone={{ tone: 'neutral' }} icon={CircleDashed}>
              {String(raw)}
            </PillWith>
          }
        />
      );
    }
  }
}

const CHECK_META: Record<HowToTestCheckDto['conclusion'], { tone: Tone; icon: Glyph }> = {
  success: { tone: { severity: 'success' }, icon: CircleCheck },
  failure: { tone: { severity: 'danger' }, icon: CircleX },
  pending: { tone: { severity: 'warning' }, icon: CircleEllipsis },
  neutral: { tone: { tone: 'neutral' }, icon: CircleMinus },
  unknown: { tone: { tone: 'neutral' }, icon: CircleDashed },
};

function checkLabel(
  check: HowToTestCheckDto,
  t: ReturnType<typeof useTranslations<'github.development.howToTest'>>,
): string {
  const c = check.conclusion;
  switch (c) {
    case 'success':
    case 'failure':
    case 'pending':
    case 'neutral':
      return t(`ci.conclusion.${c}`);
    case 'unknown':
      return check.rawConclusion ?? c;
    default: {
      const raw: string = c satisfies never;
      return String(raw);
    }
  }
}

function CiFact({ ci }: { ci: HowToTestCiDto }) {
  const t = useTranslations('github.development.howToTest');
  const status = ci.status;
  switch (status) {
    case 'available': {
      // `neutral` is listed and not counted — it neither passed nor failed.
      const counted = ci.checks.filter((c) => c.conclusion !== 'neutral');
      const passed = counted.filter((c) => c.conclusion === 'success').length;
      return (
        <Fact
          icon={ListChecks}
          label={t('ci.title')}
          value={<span>{t('ci.summary', { passed, total: counted.length })}</span>}
        >
          <ul className="mt-1 ml-5 flex list-none flex-col gap-1">
            {ci.checks.map((check, i) => {
              const meta = CHECK_META[check.conclusion] ?? CHECK_META.unknown;
              return (
                <li key={`${check.name}-${i}`} className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-(--el-text-identifier)">
                    {check.name}
                  </span>
                  <PillWith tone={meta.tone} icon={meta.icon}>
                    {checkLabel(check, t)}
                  </PillWith>
                </li>
              );
            })}
          </ul>
        </Fact>
      );
    }
    case 'no_checks_reported':
      return (
        <Fact
          icon={ListChecks}
          label={t('ci.title')}
          value={
            <PillWith tone={{ tone: 'neutral' }} icon={CircleDashed}>
              {t('ci.none')}
            </PillWith>
          }
        >
          <FactBody>{t('ci.noneBody')}</FactBody>
        </Fact>
      );
    default: {
      const raw: string = status satisfies never;
      return (
        <Fact
          icon={ListChecks}
          label={t('ci.title')}
          value={
            <PillWith tone={{ tone: 'neutral' }} icon={CircleDashed}>
              {String(raw)}
            </PillWith>
          }
        />
      );
    }
  }
}

/** Panel 12j — a collapsed disclosure at the foot of the part. */
function EarlierRuns({ history }: { history: HowToTestDto['history'] }) {
  const t = useTranslations('github.development.howToTest');
  const [open, setOpen] = useState(false);
  if (history.length === 0) return null;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-(--radius-control) p-1 text-left text-xs font-medium text-(--el-text-secondary) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        <Chevron className="h-3.5 w-3.5 shrink-0 text-(--el-icon-muted)" aria-hidden />
        {t('earlier.toggle', { count: history.length })}
      </button>
      {open ? (
        <ul className="mt-1 flex list-none flex-col gap-1 pl-6">
          {history.map((entry) => (
            <li key={entry.recordId} className="text-xs text-(--el-text-secondary)">
              {entry.run ? (
                t.rich('writtenBy', {
                  run: entry.run.label,
                  time: formatRunInstant(entry.createdAt),
                  b: bold,
                })
              ) : (
                <span>{formatRunInstant(entry.createdAt)}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
