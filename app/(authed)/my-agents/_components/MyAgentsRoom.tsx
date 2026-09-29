'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, SquareTerminal, TriangleAlert } from 'lucide-react';
import { RunTonePill } from '@/components/runs/RunTonePill';
import { Button } from '@/components/ui/Button';
import {
  AGENT_STATES_IN_MOTION,
  AGENT_STATE_TONE,
  formatMachineTime,
  MY_AGENTS_PAGE_SIZE,
  type AgentMove,
} from '@/lib/agentInstances/presentation';
import type { AgentInstanceListItemDto, AgentInstanceListPageDto } from '@/lib/dto/agentInstances';
import { AgentRowMenu } from './AgentRowMenu';
import { CreateAgentDialog, type OfferedProfile } from './CreateAgentDialog';
import { DeleteAgentDialog } from './DeleteAgentDialog';
import { RefusalBox, useAgentRefusal, type AgentRefusal } from './agentRefusal';

// THE MY AGENTS ROOM (Story MOTIR-6860 · MOTIR-6874) — the client island behind
// `design/my-agents/my-agents.mock.html` (MOTIR-6868 revision 3).
//
// ⚠️ IT OWNS ITS LIST, SO IT REFETCHES ITSELF (the page-state-after-mutation
// contract, case 3). It is seeded from the server's first read and never relies on
// `router.refresh()`, which cannot reach a `useState` seed: every create, wake,
// hibernate and delete re-reads the page it is on, and while any row is in motion
// (starting, hibernating, waking, deleting) it polls until that row settles, so a
// transition resolves on screen without a reload. Reads are sequence-guarded, so an
// older response never overwrites a newer one.

/** How often a row in motion is re-read. */
const POLL_MS = 2_000;

type Action = { kind: 'create' } | { kind: 'move'; id: string } | { kind: 'delete'; id: string };

export function MyAgentsRoom({
  projectKey,
  projectName,
  initial,
  profiles,
  maxPerUser,
}: {
  projectKey: string;
  projectName: string;
  /** The server's first read; `null` when it failed (panel 7's failure face). */
  initial: AgentInstanceListPageDto | null;
  profiles: readonly OfferedProfile[];
  maxPerUser: number;
}) {
  const t = useTranslations('myAgents');
  const refusalFor = useAgentRefusal(maxPerUser);
  const [data, setData] = useState<AgentInstanceListPageDto | null>(initial);
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AgentInstanceListItemDto | null>(null);
  const [pending, setPending] = useState<Action | null>(null);
  const [createRefusal, setCreateRefusal] = useState<AgentRefusal | null>(null);
  const [deleteRefusal, setDeleteRefusal] = useState<AgentRefusal | null>(null);
  const [listRefusal, setListRefusal] = useState<AgentRefusal | null>(null);
  const seq = useRef(0);
  const base = `/api/projects/${encodeURIComponent(projectKey)}/instances`;

  const load = useCallback(
    async (target: number) => {
      const mine = ++seq.current;
      try {
        const res = await fetch(`${base}?page=${target}&limit=${MY_AGENTS_PAGE_SIZE}`, {
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as AgentInstanceListPageDto;
        if (mine === seq.current) setData(body);
      } catch {
        // A failed re-read keeps the last good list on screen; only a failed FIRST
        // read shows the failure face.
      }
    },
    [base],
  );

  const rows = data?.instances ?? [];
  const inMotion = rows.some((r) => AGENT_STATES_IN_MOTION.has(r.state));
  useEffect(() => {
    if (!inMotion) return;
    const id = setInterval(() => void load(page), POLL_MS);
    return () => clearInterval(id);
  }, [inMotion, load, page]);

  async function send(
    url: string,
    init: RequestInit,
  ): Promise<{ ok: true } | { ok: false; body: { code?: string; reason?: string } | null }> {
    try {
      const res = await fetch(url, init);
      if (res.ok) return { ok: true };
      return { ok: false, body: (await res.json().catch(() => null)) as never };
    } catch {
      return { ok: false, body: null };
    }
  }

  async function onCreate(input: { name: string; profileId: string }) {
    setPending({ kind: 'create' });
    setCreateRefusal(null);
    const result = await send(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    setPending(null);
    if (!result.ok) {
      setCreateRefusal(refusalFor(result.body, input.name));
      return;
    }
    setCreateOpen(false);
    setPage(1);
    await load(1);
  }

  async function onMove(row: AgentInstanceListItemDto, move: AgentMove) {
    setListRefusal(null);
    if (move === 'delete') {
      setDeleteRefusal(null);
      setDeleteTarget(row);
      return;
    }
    setPending({ kind: 'move', id: row.id });
    const result = await send(`${base}/${encodeURIComponent(row.id)}/${move}`, { method: 'POST' });
    setPending(null);
    if (!result.ok) setListRefusal(refusalFor(result.body, row.name));
    await load(page);
  }

  async function onConfirmDelete() {
    if (!deleteTarget) return;
    setPending({ kind: 'delete', id: deleteTarget.id });
    const result = await send(`${base}/${encodeURIComponent(deleteTarget.id)}`, {
      method: 'DELETE',
    });
    setPending(null);
    if (!result.ok) {
      setDeleteRefusal(refusalFor(result.body, deleteTarget.name));
      return;
    }
    setDeleteTarget(null);
    await load(page);
  }

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / MY_AGENTS_PAGE_SIZE));
  const newAgent = (
    <Button
      leftIcon={<Plus aria-hidden="true" />}
      onClick={() => {
        setCreateRefusal(null);
        setCreateOpen(true);
      }}
    >
      {t('newAgent')}
    </Button>
  );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('title')}</h1>
          <p className="text-sm text-(--el-text-secondary)">
            <span className="hidden sm:inline">{t('subtitle', { project: projectName })}</span>
            <span className="sm:hidden">{t('subtitleNarrow', { project: projectName })}</span>
          </p>
        </div>
        <div className="self-start sm:self-auto">{newAgent}</div>
      </header>

      {listRefusal ? <RefusalBox refusal={listRefusal} /> : null}

      {data === null ? (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-(--radius-card) bg-(--el-tint-rose) px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text-strong)"
        >
          <TriangleAlert className="size-4 flex-none" aria-hidden="true" />
          {t('loadFailed')}
        </div>
      ) : total === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-(--radius-card) border border-(--el-border) px-(--spacing-card-padding) py-10 text-center">
          <SquareTerminal className="size-7 text-(--el-text-secondary)" aria-hidden="true" />
          <h2 className="m-0 font-serif text-lg font-semibold text-(--el-text)">
            {t('emptyTitle')}
          </h2>
          <p className="m-0 max-w-xl text-sm text-(--el-text-secondary)">{t('emptyBody')}</p>
          {newAgent}
        </div>
      ) : (
        <>
          <AgentTable rows={rows} projectName={projectName} pending={pending} onMove={onMove} />
          <AgentCards rows={rows} projectName={projectName} onMove={onMove} />
          <div className="flex items-center justify-between gap-3 text-sm text-(--el-text-secondary)">
            <span>{t('count', { count: total })}</span>
            <div className="flex items-center gap-2">
              {pages > 1 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => {
                    setPage(page - 1);
                    void load(page - 1);
                  }}
                >
                  {t('previous')}
                </Button>
              ) : null}
              <span>{t('page', { page, pages })}</span>
              {pages > 1 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={page >= pages}
                  onClick={() => {
                    setPage(page + 1);
                    void load(page + 1);
                  }}
                >
                  {t('next')}
                </Button>
              ) : null}
            </div>
          </div>
        </>
      )}

      <CreateAgentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectName={projectName}
        profiles={profiles}
        pending={pending?.kind === 'create'}
        refusal={createRefusal}
        onCreate={(input) => void onCreate(input)}
      />
      <DeleteAgentDialog
        name={deleteTarget?.name ?? null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        pending={pending?.kind === 'delete'}
        refusal={deleteRefusal}
        onConfirm={() => void onConfirmDelete()}
      />
    </div>
  );
}

/** The line under a row's name: progress in motion, the failure, or why Motir stopped it. */
function useRowLine() {
  const t = useTranslations('myAgents');
  return (row: AgentInstanceListItemDto): { text: string; danger: boolean } | null => {
    if (row.state === 'failed') {
      const reason = row.failureReason ?? '';
      const wayOut = t('failedWayOut');
      return {
        text: reason.includes(wayOut) ? reason : `${reason} ${wayOut}`.trim(),
        danger: true,
      };
    }
    if (row.state === 'hibernated' && row.stopReason) {
      return { text: t(`stop.${row.stopReason}`), danger: false };
    }
    if (
      row.state === 'starting' ||
      row.state === 'hibernating' ||
      row.state === 'waking' ||
      row.state === 'deleting'
    ) {
      return { text: t(`progress.${row.state}`), danger: false };
    }
    return null;
  };
}

function RowLine({ line }: { line: { text: string; danger: boolean } | null }) {
  if (!line) return null;
  return (
    <span
      className={`block text-xs ${line.danger ? 'text-(--el-danger-on-surface)' : 'text-(--el-text-secondary)'}`}
    >
      {line.text}
    </span>
  );
}

function AgentTable({
  rows,
  projectName,
  pending,
  onMove,
}: {
  rows: AgentInstanceListItemDto[];
  projectName: string;
  pending: Action | null;
  onMove: (row: AgentInstanceListItemDto, move: AgentMove) => void;
}) {
  const t = useTranslations('myAgents');
  const lineFor = useRowLine();
  const th =
    'px-(--spacing-control-x) py-(--spacing-control-y) text-left text-xs font-semibold whitespace-nowrap text-(--el-text-secondary)';
  const td = 'px-(--spacing-control-x) py-(--spacing-control-y) align-middle';
  return (
    <div className="hidden overflow-x-auto rounded-(--radius-card) border border-(--el-border) md:block">
      <table className="w-full border-collapse">
        <thead className="border-b border-(--el-border) bg-(--el-surface)">
          <tr>
            <th scope="col" className={th}>
              {t('col.name')}
            </th>
            <th scope="col" className={th}>
              {t('col.codingAgent')}
            </th>
            <th scope="col" className={th}>
              {t('col.project')}
            </th>
            <th scope="col" className={th}>
              {t('col.state')}
            </th>
            <th scope="col" className={`${th} text-right`}>
              {t('col.machineTime')}
            </th>
            <th scope="col" className={`${th} text-right`}>
              {t('col.credits')}
            </th>
            <th scope="col" className={th}>
              <span className="sr-only">{t('col.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              data-testid="agent-row"
              data-state={row.state}
              aria-busy={pending?.kind !== 'create' && pending?.id === row.id ? true : undefined}
              className="border-b border-(--el-border-soft) last:border-b-0"
            >
              <td className={td}>
                <strong className="text-sm text-(--el-text)">{row.name}</strong>
                <RowLine line={lineFor(row)} />
              </td>
              <td className={`${td} text-sm whitespace-nowrap text-(--el-text)`}>
                {row.profileName}
              </td>
              <td className={`${td} text-sm whitespace-nowrap text-(--el-text-secondary)`}>
                {projectName}
              </td>
              <td className={`${td} whitespace-nowrap`}>
                <RunTonePill tone={AGENT_STATE_TONE[row.state]}>
                  {t(`state.${row.state}`)}
                </RunTonePill>
              </td>
              <td
                className={`${td} text-right text-sm whitespace-nowrap text-(--el-text) tabular-nums`}
              >
                {formatMachineTime(row.machineSecondsThisMonth)}
              </td>
              <td
                className={`${td} text-right text-sm whitespace-nowrap text-(--el-text) tabular-nums`}
              >
                {row.creditsThisMonth}
              </td>
              <td className={`${td} text-right`}>
                <AgentRowMenu name={row.name} state={row.state} onMove={(m) => onMove(row, m)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Panel 8: below the table's width each agent is a card. */
function AgentCards({
  rows,
  projectName,
  onMove,
}: {
  rows: AgentInstanceListItemDto[];
  projectName: string;
  onMove: (row: AgentInstanceListItemDto, move: AgentMove) => void;
}) {
  const t = useTranslations('myAgents');
  const lineFor = useRowLine();
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0 md:hidden">
      {rows.map((row) => (
        <li
          key={row.id}
          className="flex flex-col gap-1 rounded-(--radius-card) border border-(--el-border) px-(--spacing-control-x) py-(--spacing-control-y)"
        >
          <div className="flex items-center justify-between gap-2">
            <strong className="text-sm text-(--el-text)">{row.name}</strong>
            <AgentRowMenu name={row.name} state={row.state} onMove={(m) => onMove(row, m)} />
          </div>
          <div className="flex items-center justify-between gap-2 text-sm text-(--el-text-secondary)">
            <span>
              {row.profileName} · {projectName}
            </span>
            <RunTonePill tone={AGENT_STATE_TONE[row.state]}>{t(`state.${row.state}`)}</RunTonePill>
          </div>
          <div className="flex items-center justify-between gap-2 text-sm text-(--el-text-secondary)">
            <span>{t('thisMonth', { time: formatMachineTime(row.machineSecondsThisMonth) })}</span>
            <span>{t('creditsCount', { count: row.creditsThisMonth })}</span>
          </div>
          <RowLine line={lineFor(row)} />
        </li>
      ))}
    </ul>
  );
}
