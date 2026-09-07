'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { FolderGit2, TriangleAlert } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { buttonVariants } from '@/components/ui/Button';
import { connectedNotInSet, splitSetRowsByOrigin } from '@/lib/projectRepos/roomSections';
import { TakeoverRow } from './TakeoverRow';
import { TakeoverModal } from './TakeoverModal';
import { ConnectedRepositories } from './ConnectedRepositories';
import { OrganizationRepositories } from './OrganizationRepositories';
import { AddRepositoryButton, AddRepositoryPicker } from './AddRepositoryPicker';
import type { OrgRepoOptionDto } from '@/lib/dto/organizationRepos';
import type {
  ProjectRepoConnectCandidateDto,
  ProjectRepoConnectedDto,
  ProjectRepoDto,
  ProjectRepoRoomViewDto,
} from '@/lib/dto/projectRepos';

// The TAKE-IT-OVER room's ROWS — the client island of
// `/settings/project/repositories` (Story MOTIR-1775 · MOTIR-1939).
//
// ⚠️ THE PAGE-STATE CONTRACT, ROUTED PER SURFACE (`CLAUDE.md`; design §14.10). A
// takeover changes surfaces that do NOT refresh the same way, and assuming
// `router.refresh()` covers all of them is the recurring bug:
//
//   1. THE ROW THAT WAS ACTED ON — the mutation's response IS the confirmation.
//      Its returned row is applied locally and deliberately NOT re-read; a
//      refresh here would re-read stale data and cause a visible revert.
//   2. THE HEADER SUMMARY + THE PAUSED BANNER — server-rendered from the room
//      read, so `router.refresh()` is what updates them. It is called after
//      every mutation for exactly that reason, and for nothing else.
//   3. THIS ISLAND — seeded from server props via `useState`, so
//      `router.refresh()` CANNOT reach it (the initializer runs once at mount).
//      It owns an explicit refetch, which is what `Check again` and the poll use.
//
// ⚠️ ROWS ARE INDEPENDENT (MOTIR-711: "taking over one row of three is
// legitimate and must not wedge the others"). `busyRowId` is a single row's id,
// never a set-level flag — one row's in-flight request leaves its siblings
// rendering and pressable.
//
// ⚠️ TWO REGISTRIES, TWO SECTIONS (MOTIR-3126 · design §16). The room renders the
// project's whole repository DOMAIN: the Motir-hosted set (these rows) and the
// workspace-CONNECTED repositories, which have no `project_repository` row, no
// takeover and no action of any kind. They are never merged into one list —
// half its rows would carry an action that means nothing for them.
//
// ⚠️ AND THE REFETCH KEEPS BOTH HALVES TRUE. The establish-view payload this
// island already re-reads carries `connectCandidates` — the installation's
// repositories — and it used to read `set.rows` and throw the rest away, which is
// how a section fed by the server render alone would go stale beside the rows it
// sits next to (`router.refresh()` cannot reach this island; contract surface 3).
// WHETHER the section exists is still the SERVER's answer (`connectedInDomain`,
// from the ladder in `lib/projectRepos/effectiveDomain.ts`) and is never
// re-derived here: the client re-reads the LIST, it does not re-decide the
// domain.

/** How often an in-flight hand-off re-probes. `transfer_pending` and
 *  `awaiting_reinstall` resolve OUT OF BAND — a webhook, or an installation
 *  landing on GitHub — so neither is something a click on this page settles;
 *  the row is a polled async job, and this is that poll. Slow on purpose: the
 *  waits are measured in hours and days, and `Check again` is always there for a
 *  user who does not want to wait for the next tick. */
const POLL_MS = 20_000;

/** The takeover states that are still waiting on something to happen. */
const IN_FLIGHT = new Set(['requested', 'transfer_pending', 'awaiting_reinstall']);

/** The hosted section's accessible name — the two lists differ by NAME, not by
 *  order, which is the whole a11y content of drawing them apart (design §16.9). */
const HOSTED_HEADING_ID = 'project-repositories-hosted';

export interface RepositoriesRoomProps {
  projectKey: string;
  view: ProjectRepoRoomViewDto;
  /** Where the connect prompt hands off — the shipped 7.10 Git-settings pane. */
  connectHref: string;
  /**
   * Whether the actor administers the ORGANISATION (Story MOTIR-4669 ·
   * MOTIR-4681). Decides whether the room draws its add door or the sentence
   * that says who can — NOT whether an add succeeds, which
   * `organizationRepoService` asserts inside the transaction that performs it.
   * A gate on a button is a gate one caller away from being missing.
   */
  canAddRepositories: boolean;
  /** The organisation's display name, for the section heading and the picker. */
  organizationName: string;
  /** `See every repository in <org>` — the org's own inventory. */
  organizationInventoryHref: string;
  /** The request's `now`, stamped once on the server (see `TakeoverRow`). */
  nowIso: string;
}

export function RepositoriesRoom({
  projectKey,
  view,
  connectHref,
  canAddRepositories,
  organizationName,
  organizationInventoryHref,
  nowIso,
}: RepositoriesRoomProps) {
  const t = useTranslations('repositoryTakeover');
  const router = useRouter();

  const [rows, setRows] = useState<ProjectRepoDto[]>(view.rows);
  const [connected, setConnected] = useState<ProjectRepoConnectedDto[]>(view.connected);
  const [busyRowId, setBusyRowId] = useState<string | null>(null);
  // Mirrors `busyRowId` for the poll to read without re-creating the interval on
  // every busy flip. Written from EVENT handlers only — never during render.
  const busyRef = useRef(false);
  // Mirrors `rows` for the refetch, which needs the CURRENT rows to split the
  // connected list against them and must not do that inside a state updater. Same
  // idiom (and same discipline) as `busyRef`: written from event handlers only.
  const rowsRef = useRef(view.rows);
  const [failed, setFailed] = useState(false);
  const [modalRow, setModalRow] = useState<ProjectRepoDto | null>(null);
  // The PICKER's own state. Its list is fetched when the modal opens rather than
  // on every room render: it is an ORG-scoped read across workspaces, and a room
  // that never opens the picker should not pay for it.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [options, setOptions] = useState<OrgRepoOptionDto[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsFailed, setOptionsFailed] = useState(false);

  const takeoverUrl = (rowId: string) =>
    `/api/projects/${encodeURIComponent(projectKey)}/repositories/${encodeURIComponent(rowId)}/takeover`;

  /** The ONE writer of the rows — keeps the mirror and the state in step. */
  const putRows = useCallback((next: ProjectRepoDto[]) => {
    rowsRef.current = next;
    setRows(next);
  }, []);

  /** Surface 1 — keep what the mutation returned. Never re-read it. */
  const applyRow = useCallback(
    (row: ProjectRepoDto) => {
      putRows(rowsRef.current.map((r) => (r.id === row.id ? row : r)));
    },
    [putRows],
  );

  /** The picker's list — the ORGANISATION's repositories this project does not
   *  hold. Fetched on OPEN, so a room nobody adds from pays nothing for it. */
  const loadOptions = useCallback(async () => {
    setOptionsLoading(true);
    setOptionsFailed(false);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectKey)}/repositories/available`,
        { cache: 'no-store' },
      );
      if (!res.ok) {
        setOptionsFailed(true);
        return;
      }
      setOptions((await res.json()) as OrgRepoOptionDto[]);
    } catch {
      setOptionsFailed(true);
    } finally {
      setOptionsLoading(false);
    }
  }, [projectKey]);

  const openPicker = useCallback(() => {
    setPickerOpen(true);
    void loadOptions();
  }, [loadOptions]);

  /**
   * PICK — link an organisation repository into this project.
   *
   * ⚠️ BOTH SURFACES OF THE PAGE-STATE CONTRACT, and the room's own comment says
   * getting this split wrong is the recurring bug. The new row is inserted into
   * THIS ISLAND optimistically (surface 3 — `router.refresh()` provably cannot
   * reach a `useState`-seeded list), and `router.refresh()` is called for the
   * server-rendered HEADER SUMMARY (surface 2), which counts over both registries
   * and would otherwise keep reporting the pre-add total beside a list that grew.
   */
  const onPick = useCallback(
    async (option: OrgRepoOptionDto) => {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectKey)}/repositories/add`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ githubRepoId: option.id, role: 'other' }),
      });
      if (!res.ok) {
        setFailed(true);
        return;
      }
      const row = (await res.json()) as ProjectRepoDto;
      putRows([...rowsRef.current, row]);
      setOptions((prev) => prev.filter((o) => o.id !== option.id));
      setPickerOpen(false);
      router.refresh();
    },
    [projectKey, putRows, router],
  );

  /** REMOVE FROM THIS PROJECT — one row, and nothing else. Same two surfaces. */
  const onRemoveFromProject = useCallback(
    async (row: ProjectRepoDto) => {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectKey)}/repositories/${encodeURIComponent(row.id)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        setFailed(true);
        return;
      }
      putRows(rowsRef.current.filter((r) => r.id !== row.id));
      router.refresh();
    },
    [projectKey, putRows, router],
  );

  /** Surface 3 — the island's own refetch. Silent: a background re-read must not
   *  flash the rows the user is looking at. */
  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectKey)}/repositories`, {
        cache: 'no-store',
      });
      if (!res.ok) return;
      const body = (await res.json()) as {
        set?: { rows?: ProjectRepoDto[] };
        connectCandidates?: ProjectRepoConnectCandidateDto[];
      };
      const nextRows = body.set?.rows ?? null;
      if (nextRows) putRows(nextRows);
      // ⚠️ THE REST OF THE PAYLOAD IS NOT THROWN AWAY ANY MORE (MOTIR-3126). The
      // establish view has always carried the installation's repositories beside
      // the set; reading only `set.rows` is what left the connected section frozen
      // at whatever the server render said, on an island `router.refresh()` cannot
      // reach.
      //
      // Gated on the SERVER's `connectedInDomain`, never on the payload: a project
      // answered by its set alone does not own this section, and
      // `connectCandidates` is the picker's grant-2 list, which is populated for it
      // too. `claimed` is dropped for the same reason `connectedNotInSet` drops a
      // name a row already holds — a repository that backs a row belongs to the
      // section above.
      if (view.connectedInDomain && body.connectCandidates) {
        const candidates = body.connectCandidates
          .filter((candidate) => !candidate.claimed)
          .map((candidate) => ({
            name: candidate.name,
            repoRef: candidate.repoRef,
            defaultBranch: candidate.defaultBranch,
          }));
        setConnected(connectedNotInSet(nextRows ?? rowsRef.current, candidates));
      }
    } catch {
      // A failed background read leaves the rendered rows alone — they are the
      // last thing the server actually said, which beats an error banner over
      // state that is still correct.
    }
  }, [projectKey, putRows, view.connectedInDomain]);

  /**
   * The two writes, which are the same endpoint at two moments: naming a target
   * STARTS the saga; naming none re-probes whether the re-install has landed.
   * Re-running any step is a no-op (MOTIR-711), so the probe is always safe.
   */
  const call = useCallback(
    async (row: ProjectRepoDto, body: { newOwner?: string }) => {
      setBusyRowId(row.id);
      busyRef.current = true;
      setFailed(false);
      try {
        const res = await fetch(takeoverUrl(row.id), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          setFailed(true);
          // The row may still have MOVED (a refused transfer records `failed` on
          // it), so re-read rather than leaving the surface asserting a state the
          // server has since contradicted.
          await refetch();
          return;
        }
        const payload = (await res.json()) as ProjectRepoDto | { row: ProjectRepoDto };
        applyRow('row' in payload ? payload.row : payload);
        // Surface 2 — the server-rendered header summary + paused banner.
        router.refresh();
      } catch {
        setFailed(true);
      } finally {
        busyRef.current = false;
        setBusyRowId(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyRow, refetch, router, projectKey],
  );

  const onConfirm = useCallback(
    (row: ProjectRepoDto, newOwner: string) => {
      setModalRow(null);
      void call(row, { newOwner });
    },
    [call],
  );

  const onCheckAgain = useCallback((row: ProjectRepoDto) => void call(row, {}), [call]);

  // The poll. Keyed on WHETHER anything is in flight rather than on the rows
  // themselves, so a re-render that only changed copy does not restart the
  // interval; and it never ticks while a row is busy, so a user's own click and
  // the tick cannot race for the same row.
  //
  // ONE quiet re-read of the SET beats N per-row probes: the set read already
  // carries every row's fresh takeover state. `Check again` stays the per-row,
  // user-driven probe — the one that can also SETTLE `awaiting_reinstall`.
  const inFlight = rows.some((row) => row.takeover && IN_FLIGHT.has(row.takeover.state));

  useEffect(() => {
    if (!inFlight) return;
    const id = setInterval(() => {
      if (busyRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refetch();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [inFlight, refetch]);

  const showConnected = view.connectedInDomain && connected.length > 0;
  // ⚠️ ONE SPLIT, ONE PLACE (MOTIR-4681). A repository PICKED from the
  // organisation gets a `project_repository` row, so it enters `rows` — and
  // `rows` was rendered wholesale as Motir-hosted takeover rows. The discriminator
  // is the row's own `seedSource`, a FACT the write records rather than a
  // heuristic the reader infers, and it lives in `roomSections` beside the other
  // split so the server and this island cannot disagree.
  const { fromOrganization, motirHosted } = splitSetRowsByOrigin(rows);

  // ⚠️ THE EMPTY STATE IS FOR A PROJECT WITH NEITHER REGISTRY — nothing else.
  // Reading it off `rows.length` alone is the defect MOTIR-3126 fixed: it told a
  // project holding five connected repositories that it had none. A project whose
  // repositories are workspace-connected has a complete, correct page; only a
  // project with no set AND nothing connected has nothing to show.
  //
  // ⚠️ AND IT DOES NOT APPLY TO SOMEBODY WHO CAN ADD (MOTIR-4669 · MOTIR-4685).
  // This empty state is a SIGNPOST — a panel whose one action is a link to another
  // page — and `design/repository-set/design-notes.md` §17.4 forbids exactly that
  // shape for exactly this moment: *"'Nothing to pick' must never render as a
  // message whose job is to send somebody to another page: that turns one intent
  // into two errands."*
  //
  // It survived MOTIR-4681 because that card added the org section BELOW this
  // early return, so a project with nothing never reached it — the room offered a
  // link to `/settings/account/git`, a page that cannot connect an organisation's
  // repository at all. THE ACCEPTANCE WALK IS WHAT FOUND IT (MOTIR-4685, chapter
  // 1), which is the whole argument for walking a story in a browser.
  //
  // So the early return now applies only when there is genuinely nothing to
  // offer. An actor who may add falls through to the section below, whose own
  // zero case is the PICKER.
  if (rows.length === 0 && !showConnected && !canAddRepositories) {
    return (
      <EmptyState
        icon={<FolderGit2 className="h-12 w-12" aria-hidden />}
        title={t('title')}
        description={t('empty')}
        action={
          <Link href={connectHref} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
            {t('emptyAction')}
          </Link>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {failed ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-danger-surface) p-(--spacing-card-padding) text-sm text-(--el-danger-surface-text)"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{t('actionError')}</span>
        </p>
      ) : null}

      {/* FROM YOUR ORGANISATION (MOTIR-4681) — the repositories this project uses
          because somebody added them, and the room's ONE add door.
          ⚠️ It renders when the project HOLDS one OR when the actor may add:
          without the second arm a project with nothing yet would have no way to
          get its first repository, which is the two-errands shape §17.4 forbids. */}
      {fromOrganization.length > 0 || canAddRepositories ? (
        <OrganizationRepositories
          rows={fromOrganization}
          organizationName={organizationName}
          inventoryHref={organizationInventoryHref}
          canAdd={canAddRepositories}
          onRemove={onRemoveFromProject}
          addButton={<AddRepositoryButton onClick={openPicker} />}
        />
      ) : null}

      {/* THE MOTIR-HOSTED SET. Absent — not empty-stated — when the project has
          no rows: an empty section asserts an absence, and for a project whose
          repositories are all its own there is no such absence to assert.
          ⚠️ `motirHosted`, not `rows` (MOTIR-4681): a repository PICKED from the
          organisation has a set row too, and rendering it here would offer
          **Take it over** for something the organisation already owns. */}
      {motirHosted.length > 0 ? (
        <section aria-labelledby={HOSTED_HEADING_ID} className="flex flex-col gap-2">
          <SectionLabel id={HOSTED_HEADING_ID}>{t('hostedHeading')}</SectionLabel>
          <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">
            {t('hostedHint')}
          </p>
          <div className="flex flex-col gap-3">
            {motirHosted.map((row) => (
              <TakeoverRow
                key={row.id}
                row={row}
                githubLogin={view.githubLogin}
                installHref={view.installHref}
                nowIso={nowIso}
                busy={busyRowId === row.id}
                onMove={setModalRow}
                onCheckAgain={onCheckAgain}
                onRetry={setModalRow}
              />
            ))}
          </div>
        </section>
      ) : null}

      {/* THE WORKSPACE-CONNECTED REGISTRY. No action on any row, deliberately: the
          user already owns these, so there is nothing to move and a control would
          be a promise this room cannot keep. */}
      {showConnected ? <ConnectedRepositories repos={connected} manageHref={connectHref} /> : null}

      <AddRepositoryPicker
        options={options}
        alreadyHeld={[]}
        organizationName={organizationName}
        installHref={view.installHref}
        loading={optionsLoading}
        error={optionsFailed}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={onPick}
      />

      {modalRow ? (
        <TakeoverModal
          row={modalRow}
          githubLogin={view.githubLogin}
          connectHref={connectHref}
          busy={busyRowId === modalRow.id}
          onClose={() => setModalRow(null)}
          onConfirm={onConfirm}
        />
      ) : null}
    </div>
  );
}
