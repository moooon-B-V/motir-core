import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { FolderGit2, TriangleAlert } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import { EmptyState } from '@/components/ui/EmptyState';
import { GithubMark } from '@/components/icons/GithubMark';
import { GitlabMark } from '@/components/icons/GitlabMark';
import type { CodeContextRepoDTO } from '@/lib/dto/codeContext';

// THE REPOSITORIES SECTION (Story MOTIR-1754 · MOTIR-1768).
//
// The project's configured repository set, one read-only row each, carrying the
// answer to the one question people come here with: *can Motir read this, and is
// what it read current?*
//
// ⚠️ IT READS THE PROJECT'S SET, NEVER THE WORKSPACE'S GRANT LIST
// (design/code-context §1). The rows come from `resolveCodeContextState`, which
// resolves `project_repository`. A repository absent from a project is absent
// because nobody configured it there — NOT because it is hidden, and there is no
// privacy boundary between projects of one org. The copy never implies one.
//
// ⚠️ AND THE SECTION HAS NO ACTION OF ITS OWN (design/code-context §3, as
// amended by MOTIR-4866). Configuring which repositories a project works on is
// an ORG-ADMIN act and lives at Settings → Project → Repositories; connecting
// YOUR OWN account is a per-member act — `GithubIdentity` is `userId @unique` —
// and lives at Settings → Account → Git. Both ship today. This section links to
// the first and draws neither, which is what keeps the collapse a change of door
// rather than a loss of capability (§3.1).

/** The verdict chip — the SAME four tones the org inventory draws (§4.2). */
function VerdictPill({
  indexState,
  labels,
}: {
  indexState: CodeContextRepoDTO['indexState'];
  labels: { indexed: string; stale: string; indexing: string; never: string };
}) {
  // ⚠️ FOUR STATES, DERIVED IN ONE PLACE. `lib/codeGraph/indexState.ts` is the
  // only thing that decides which of these a repository is in; this renders the
  // answer and computes nothing. `indexed` reads `Indexed`, never `Current`
  // (§4.1, MOTIR-4817) — the state claims a graph EXISTS and that nothing has
  // said it is behind, which is weaker than claiming it matches your code.
  if (indexState === 'indexing') return <Pill severity="info">{labels.indexing}</Pill>;
  if (indexState === 'stale') return <Pill severity="warning">{labels.stale}</Pill>;
  if (indexState === 'indexed') return <Pill severity="success">{labels.indexed}</Pill>;
  return <Pill tone="neutral">{labels.never}</Pill>;
}

/**
 * The drift, in COMMITS — never as an age (§9).
 *
 * ⚠️ AGE AND DRIFT DISAGREE ABOUT THE ANSWER, which is why this is not a
 * softer version of "indexed 3 days ago" but a different verdict. A graph built
 * three weeks ago on a repository nobody has pushed to is CURRENT; one built two
 * hours ago on a repository that took 300 commits since is badly stale. An
 * age-led reading gets both backwards.
 *
 * ⚠️ `null` IS A FIRST-CLASS ANSWER AND IS NOT ZERO (panel D3, MOTIR-4644). The
 * pair was never counted, has since moved, or has no common ancestor — all of
 * which mean *behind by an unknown number of commits*, and none of which mean
 * *matching*. It renders as its own sentence rather than being omitted, because
 * an omitted drift reads as no drift.
 */
function driftLine(
  indexState: CodeContextRepoDTO['indexState'],
  commitsBehind: number | null,
  t: (k: string, v?: Record<string, string | number | Date>) => string,
): string | null {
  // Only a `stale` repository is behind anything. `never` has no graph to be
  // behind with, and `indexing` is the one state that is actually moving (§10.1).
  if (indexState !== 'stale') return null;
  if (commitsBehind === null) return t('drift.unknown');
  return t('drift.commits', { count: commitsBehind });
}

/**
 * ⚠️ THE REFRESH IS DEAD, AND THE ROW SAYS SO (Story MOTIR-1754 · MOTIR-2105).
 *
 * `design/code-context` §10.1 settles the copy, and it is a rule about what may
 * NOT be said: *panel D promises nothing*. No "catching up", no "shortly", no
 * "check back", no "this will resolve" — because a refresh can be paused,
 * failing, or impossible for the provider, and **a stale repository may sit
 * stale for ever**. It states the drift, states the consequence, and says
 * **"This index is not updating."**
 *
 * ⚠️ WITHOUT THIS LINE THE WHOLE STATE IS INDISTINGUISHABLE FROM A QUEUE. A
 * graph whose refresh dead-lettered rendered exactly like one with a refresh
 * pending: `Stale`, N commits behind, still answering every tool call. The only
 * surface that knew was the job-runs tab, where 35 dead-letters over 48 hours
 * read as background and nobody acted for three days.
 *
 * It renders for the reasons that will not resolve themselves and for no
 * others — `refreshIsStuck` is the one place that judgement is made.
 */
function notUpdatingLine(repo: CodeContextRepoDTO, t: (k: string) => string): string | null {
  // Only a graph that EXISTS can fail to update. `never` has its own chip and
  // its own answer — the first index is the connect path's, not a refresh.
  if (repo.indexState === 'never' || repo.indexState === 'indexing') return null;
  if (!repo.refreshFailing) return null;
  return t('notUpdating');
}

export async function CodeRepositories({ repos }: { repos: CodeContextRepoDTO[] }) {
  const t = await getTranslations('code.repositories');
  const labels = {
    indexed: t('index.indexed'),
    stale: t('index.stale'),
    indexing: t('index.indexing'),
    never: t('index.never'),
  };

  if (repos.length === 0) {
    // ⚠️ NOT A FAILURE, AND THE COPY SAYS SO. A project with no configured
    // repository is an ordinary state — it is how every project starts — so this
    // names where the set is configured rather than reporting an absence.
    return (
      <EmptyState
        title={t('emptyTitle')}
        description={t('emptyDescription')}
        action={
          <Link
            href="/settings/project/repositories"
            className="text-sm text-(--el-link) underline-offset-2 hover:underline"
          >
            {t('manageLink')}
          </Link>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2" aria-label={t('listLabel')}>
        {repos.map((repo) => {
          const drift = driftLine(repo.indexState, repo.commitsBehind, t);
          const notUpdating = notUpdatingLine(repo, t);
          return (
            <li
              key={repo.repoRef}
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-(--radius-card) border border-(--el-border) bg-(--el-card) px-(--spacing-card-padding) py-3"
            >
              <span className="flex min-w-0 items-center gap-2">
                <FolderGit2 className="h-4 w-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
                <span className="truncate font-medium text-(--el-text-strong)">{repo.repoRef}</span>
              </span>

              <span className="flex shrink-0 items-center gap-1.5 font-sans text-xs text-(--el-text-secondary)">
                {repo.provider === 'gitlab' ? (
                  <GitlabMark className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <GithubMark className="h-3.5 w-3.5" aria-hidden />
                )}
                {t(`provider.${repo.provider === 'gitlab' ? 'gitlab' : 'github'}`)}
              </span>

              <VerdictPill indexState={repo.indexState} labels={labels} />

              {/* The drift sits BESIDE the verdict, never inside it — the chip
                  says which state, the line says how far. A chip reading the
                  count would collapse two facts a reader needs separately. */}
              {drift !== null ? (
                <span className="shrink-0 font-sans text-sm text-(--el-text-secondary)">
                  {drift}
                </span>
              ) : null}

              {/* ⚠️ THE CONSEQUENCE, on the row it is about (MOTIR-2105). It is
                  drawn in the WARNING ink rather than the secondary one because
                  §10 puts this state one register up from the invitation
                  grammar: it reports that plans are being produced against code
                  that is not the code, which is a defect in the output rather
                  than an optional improvement to it. Still not alarming — no
                  red, no destructive family, no blocking. */}
              {notUpdating !== null ? (
                <span className="flex shrink-0 items-center gap-1.5 font-sans text-sm text-(--el-warning-text)">
                  <TriangleAlert className="h-3.5 w-3.5 text-(--el-warning)" aria-hidden />
                  {notUpdating}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>

      {/* The section's ONLY affordance (§3, as amended by MOTIR-4866). */}
      <p className="text-sm text-(--el-text-secondary)">
        <Link
          href="/settings/project/repositories"
          className="text-(--el-link) underline-offset-2 hover:underline"
        >
          {t('manageLink')}
        </Link>
      </p>
    </div>
  );
}
